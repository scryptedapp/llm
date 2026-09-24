import { createAsyncQueue } from '@scrypted/deferred';
import sdk, { ChatCompletion, DeviceCreator, DeviceCreatorSettings, DeviceProvider, HttpRequest, HttpRequestHandler, HttpResponse, MixinProvider, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, ScryptedNativeId, Setting, Settings, SettingValue, WritableDeviceState } from '@scrypted/sdk';
import { checkUserId } from '@scrypted/sdk/acl';
import { StorageSettings } from '@scrypted/sdk/storage-settings';
import path from 'path';
import { fork, LlamaCPP } from './llama-cpp';
import { AppleFM } from './apple-fm';
import { LLMUserMixin } from './llm-user';
import { MCPServer } from './mcp-server';
import { OpenAIEndpoint } from './openai-endpoint';
import { Database, UserDatabase } from './user-database';
import { WebTools } from './web-tools';

export { fork };

const WebToolsNativeId = 'search-tools';

export default class LLMPlugin extends ScryptedDeviceBase implements DeviceProvider, DeviceCreator, UserDatabase, HttpRequestHandler, MixinProvider, Settings {
    devices = new Map<ScryptedNativeId, ScryptedDeviceBase>();
    userDatabases = new Map<string, {
        token: string,
        database: Database,
    }>();

    storageSettings = new StorageSettings(this, {
        clearModelStorage: {
            title: 'Clear Model Storage',
            description: 'Clear the llama.cpp storage used by models. Enter DELETE to clear model storage on all workers.',
            mapGet(value) {
                return undefined;
            },
            onPut: async(ov, nv) => {
                if (nv !== 'DELETE')
                    return;

                for (const device of this.devices.values()) {
                    if (!device.nativeId?.startsWith('llama-'))
                        continue;

                    const llamaDevice = device as LlamaCPP;
                    await llamaDevice.stopLlamaServer();
                }

                const workers = await sdk.clusterManager.getClusterWorkers();
                for (const worker of Object.values(workers)) {
                    const forked = sdk.fork<Awaited<ReturnType<typeof fork>>>({
                        runtime: 'node',
                        clusterWorkerId: worker.id,
                    });

                    forked.result.then(async r => {
                        await r.clearModelStorage();
                    })
                    .finally(() => {
                        forked.worker.terminate();
                    });
                }
            }
        }
    });

    constructor(nativeId?: string) {
        super(nativeId);

        // legacy, these are now built into chat. providing this here
        // is a potential privilege escalation.
        // the chat site can use the same code but it will only
        // be able to access the logged in user's devices.
        if (sdk.deviceManager.getNativeIds().includes('tools'))
            sdk.deviceManager.onDeviceRemoved('tools');
        if (sdk.deviceManager.getNativeIds().includes('switch-tools'))
            sdk.deviceManager.onDeviceRemoved('switch-tools');
        if (sdk.deviceManager.getNativeIds().includes('camera-tools'))
            sdk.deviceManager.onDeviceRemoved('camera-tools');

        sdk.deviceManager.onDeviceDiscovered({
            nativeId: WebToolsNativeId,
            name: 'Web Tools',
            type: 'LLMTools',
            interfaces: [
                ScryptedInterface.LLMTools,
            ],
        });

        this.updateCors();
    }

    getSettings(): Promise<Setting[]> {
        return this.storageSettings.getSettings();
    }

    putSetting(key: string, value: SettingValue): Promise<void> {
        return this.storageSettings.putSetting(key, value);
    }

    async getMixin(mixinDevice: any, mixinDeviceInterfaces: ScryptedInterface[], mixinDeviceState: WritableDeviceState): Promise<any> {
        return new LLMUserMixin(this, {
            group: 'LLM Permissions',
            groupKey: 'llm',
            mixinProviderNativeId: this.nativeId,
            mixinDevice,
            mixinDeviceState,
            mixinDeviceInterfaces
        });
    }

    async canMixin(type: ScryptedDeviceType | string, interfaces: string[]): Promise<string[] | null | undefined | void> {
        if (type === ScryptedDeviceType.Person && interfaces.includes(ScryptedInterface.ScryptedUser)) {
            return [
                ScryptedInterface.ScryptedUser,
                ScryptedInterface.Settings,
            ];
        }
    }

    async releaseMixin(id: string, mixinDevice: any): Promise<void> {

    }

    async openDatabase(token: string): Promise<Database> {
        // enumerate and find database
        const userDatabase = [...this.userDatabases.values()].find(db => db.token === token);
        if (!userDatabase) {
            throw new Error('User database not found for token: ' + token);
        }
        return userDatabase.database;
    }

    async onOpenAIEndpointRequest(request: HttpRequest, response: HttpResponse): Promise<void> {
        const body = JSON.parse(request.body?.toString()!);
        const { model } = body;
        // the model field routes the request to the ChatCompletion device.
        // remove it from the body so the device does not forward the device id
        // to the upstream provider as the model name: each device will fill in
        // its own configured model.
        delete body.model;
        if (!request.username || (request.aclId && !await checkUserId(model, request.aclId))) {
            return response.send('', {
                code: 401,
            });
        }

        const chatCompletion = sdk.systemManager.getDeviceById<ChatCompletion>(model);
        if (!chatCompletion.interfaces.includes(ScryptedInterface.ChatCompletion)) {
            return response.send('', {
                code: 404,
            });
        }

if (body.stream) {
            // the server pulls the sendStream iterator one rpc round trip per item,
            // which paces delivery. merge all pending buffers with each new buffer
            // so a pull grabs everything available in a single round trip. deltas
            // are routed through the streaming callback, which is pushed via one
            // way rpc events rather than pulled.
            const queue = createAsyncQueue<Buffer>();
            const submitMerged = (buffer: Buffer) => {
                const pending = queue.clear();
                queue.submit(Buffer.concat([...pending, buffer]));
            };
            const stream = await chatCompletion.streamChatCompletion(body, undefined, (chunk) => {
                submitMerged(Buffer.from(`data: ${JSON.stringify(chunk)}\n\n`));
                return Promise.resolve(true);
            });
            (async () => {
                try {
                    for await (const message of stream) {
                        // with a callback provided, the wrapper only yields
                        // non-delta messages, e.g. the usage chunk and the
                        // final chat completion.
                        if (message?.object === 'chat.completion') {
                            submitMerged(Buffer.from(`data: [DONE]\n\n`));
                        }
                        else if (message) {
                            submitMerged(Buffer.from(`data: ${JSON.stringify(message)}\n\n`));
                        }
                    }
                }
                catch (e) {
                    queue.end(e instanceof Error ? e : new Error(String(e)));
                    return;
                }
                queue.end();
            })();
            response.sendStream(queue.queue, {
                headers: {
                    'Content-Type': 'text/event-stream; charset=utf-8',
                },
            });
            return;
        }

        const completion = await chatCompletion.getChatCompletion(body);
        response.send(JSON.stringify(completion), {
            headers: {
                'Content-Type': 'application/json',
            },
        });
    }

    async onRequest(request: HttpRequest, response: HttpResponse): Promise<void> {
        if (!request.username) {
            return response.send('', {
                code: 401,
            });
        }

        if (request.url?.startsWith('/endpoint/@scrypted/llm/api/openai/v1/chat/completions')) {
            return await this.onOpenAIEndpointRequest(request, response);
        }

        if (!request.url?.startsWith('/endpoint/@scrypted/llm/token')) {
            return response.send('', {
                code: 404,
            });
        }

        let userDatabase = this.userDatabases.get(request.username);
        if (!userDatabase) {
            const token = Math.random().toString(16).slice(2, 10);
            const sha256Username = require('crypto').createHash('sha256').update(request.username).digest('hex');
            const { Level } = await import("level");

            class UserLevel extends Level {
                constructor(userId: string) {
                    super(path.join(process.env.SCRYPTED_PLUGIN_VOLUME!, userId));
                }
            }

            userDatabase = {
                token,
                database: new Database(new UserLevel(sha256Username)),
            };
            this.userDatabases.set(request.username, userDatabase);
            try {
                await userDatabase.database.level.open();
            }
            catch (e) {
                if (this.userDatabases.get(request.username) === userDatabase) {
                    this.userDatabases.delete(request.username);
                }
                return response.send('', {
                    code: 500,
                });
            }
        }

        response.send(JSON.stringify({
            token: userDatabase.token,
        }), {
            headers: {
                'Content-Type': 'application/json',
            },
        });
    }

    async updateCors() {
        try {
            await sdk.endpointManager.setAccessControlAllowOrigin({
                origins: [
                    'https://chat.scrypted.app',
                ],
            });
        }
        catch (e) {
            this.console.error('error updating cors, is your scrypted server up to date?', e);
        }
    }

    async reportDevice(nativeId: ScryptedNativeId, name: string) {
        const interfaces = [
            ScryptedInterface.ChatCompletion,
            ScryptedInterface.TTY,
            ScryptedInterface.StreamService,
            ScryptedInterface.Settings,
        ];
        if (nativeId?.startsWith('llama-') || nativeId?.startsWith('fm-'))
            interfaces.push(ScryptedInterface.OnOff);

        return await sdk.deviceManager.onDeviceDiscovered({
            name,
            type: 'LLM',
            nativeId,
            interfaces,
        });
    }

    async createDevice(settings: DeviceCreatorSettings): Promise<string> {
        const randomHex = Math.random().toString(16).slice(2, 10);
        if (!settings.type)
            throw new Error('Type is required to create a device.');
        if (settings.type === 'OpenAI Server') {
            return await this.reportDevice('openai-' + randomHex, settings.name as string);
        }
        else if (settings.type === 'MCP Server') {
            const nativeId = 'mcp-' + randomHex;
            const device = new MCPServer(nativeId);
            this.devices.set(nativeId, device);
            const id = await sdk.deviceManager.onDeviceDiscovered({
                nativeId,
                name: settings.name as string,
                type: 'LLM',
                interfaces: [
                    ScryptedInterface.LLMTools,
                    ScryptedInterface.Settings,
                ],
            });
            return id;
        }
        else if (settings.type === 'llama.cpp') {
            const nativeId = 'llama-' + randomHex;
            const id = await this.reportDevice(nativeId, settings.name as string);
            const device = await this.getDevice(nativeId) as LlamaCPP;
            device.on = true;
            return id;
        }
        else if (settings.type === 'Apple Foundation Model') {
            const nativeId = 'fm-' + randomHex;
            const id = await this.reportDevice(nativeId, settings.name as string);
            const device = await this.getDevice(nativeId) as AppleFM;
            device.on = true;
            return id;
        }
        throw new Error('Unknown type: ' + settings.type);
    }

    async releaseDevice(id: string, nativeId: ScryptedNativeId): Promise<void> {
        const device = this.devices.get(nativeId);
        this.devices.delete(nativeId);
        if (device instanceof LlamaCPP) {
            await device.turnOff();
            await device.stopLlamaServer();
        }
        if (device instanceof AppleFM) {
            await device.turnOff();
        }
    }

    async getCreateDeviceSettings(): Promise<Setting[]> {
        const storageSettings = new StorageSettings(this, {
            name: {
                title: 'Name',
                description: 'The friendly name of the LLM provider or local model.',
                placeholder: 'OpenAI',
            },
            type: {
                title: 'Type',
                type: 'radiobutton',
                choices: [
                    'OpenAI Server',
                    'llama.cpp',
                    'Apple Foundation Model',
                    'MCP Server',
                ],
            },
        });

        return storageSettings.getSettings();
    }

    async getDevice(nativeId: ScryptedNativeId): Promise<any> {
        let found = this.devices.get(nativeId);
        if (found)
            return found;

        if (nativeId === WebToolsNativeId) {
            return new WebTools(nativeId);
        }

        if (nativeId?.startsWith('openai-')) {
            found = new OpenAIEndpoint(nativeId);
            this.devices.set(nativeId, found);
            this.reportDevice(nativeId, found.name!);
            return found;
        }
        if (nativeId?.startsWith('llama-')) {
            found = new LlamaCPP(nativeId);
            this.devices.set(nativeId, found);
            this.reportDevice(nativeId, found.name!);
            return found;
        }
        if (nativeId?.startsWith('fm-')) {
            found = new AppleFM(nativeId);
            this.devices.set(nativeId, found);
            this.reportDevice(nativeId, found.name!);
            return found;
        }
        if (nativeId?.startsWith('mcp-')) {
            found = this.devices.get(nativeId);
            if (!found) {
                found = new MCPServer(nativeId);
                this.devices.set(nativeId, found);
            }
            return found;
        }
    }
}
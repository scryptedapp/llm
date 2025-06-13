import { Deferred } from '@scrypted/deferred';
import sdk, { DeviceCreator, DeviceCreatorSettings, DeviceProvider, OnOff, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, ScryptedNativeId, Setting, Settings, StreamService, TTY } from '@scrypted/sdk';
import { StorageSettings } from '@scrypted/sdk/storage-settings';
import child_process from 'child_process';
import path from 'path';
import { connectStreamInternal } from './connect';
import { downloadLLama } from './download-llama';
import { CameraTools } from './tools';
import { once } from 'events';

abstract class BaseLLM extends ScryptedDeviceBase implements StreamService<Buffer>, TTY {
    storageSettings = new StorageSettings(this, {
        systemPrompt: {
            title: 'System Prompt',
            description: 'The system prompt to use for the OpenAI compatible endpoint.',
            type: 'textarea',
            placeholder: 'You are a helpful assistant.',
        },
        tools: {
            title: 'Tools',
            description: 'The tools available to this LLM.',
            type: 'device',
            deviceFilter: ({ interfaces, ScryptedInterface }) => {
                return interfaces.includes("LLMTools");
            },
            multiple: true,
            defaultValue: [],
        }
    });

    abstract connectStreamInternal(input: AsyncGenerator<Buffer>, options: {
        systemPrompt?: string,
    }): AsyncGenerator<Buffer>;

    async connectStream(input?: AsyncGenerator<Buffer> | undefined, options?: any): Promise<AsyncGenerator<Buffer>> {
        return this.connectStreamInternal(input!, {
            systemPrompt: this.storageSettings.values.systemPrompt,
        });
    }
}

class OpenAIEndpoint extends BaseLLM implements Settings {
    openaiSettings = new StorageSettings(this, {
        model: {
            title: 'Model',
            description: 'The model to use for the OpenAI compatible endpoint.',
            placeholder: 'o4-mini',
        },
        baseURL: {
            title: 'Base URL',
            description: 'The base URL of the OpenAI compatible endpoint.',
            placeholder: 'https://api.openai.com/v1',
        },
        apiKey: {
            title: 'API Key',
            description: 'The API key for the OpenAI compatible endpoint.',
            type: 'password',
        },
    });

    async * connectStreamInternal(input: AsyncGenerator<Buffer>, options: {
        systemPrompt?: string,
    }): AsyncGenerator<Buffer> {
        yield* connectStreamInternal(input, {
            name: this.name!,
            baseURL: this.openaiSettings.values.baseURL,
            apiKey: this.openaiSettings.values.apiKey,
            systemPrompt: this.storageSettings.values.systemPrompt,
            model: this.openaiSettings.values.model,
            tools: this.storageSettings.values.tools,
        });
    }

    async getSettings(): Promise<Setting[]> {
        return [
            ...await this.openaiSettings.getSettings(),
            ...await this.storageSettings.getSettings()];
    }

    async putSetting(key: string, value: any): Promise<void> {
        if (key in this.openaiSettings.keys) {
            await this.openaiSettings.putSetting(key, value);
            return;
        }
        await this.storageSettings.putSetting(key, value);
    }
}

async function llamaFork(model: string) {
    if (process.platform !== 'win32') {
        // super hacky but need to clean up dangling processes.
        await once(child_process.spawn('killall', ['llama-server']), 'exit').catch(() => {});
    }
    else {
        // windows doesn't have killall, so just kill the process by name.
        await once(child_process.spawn('taskkill', ['/F', '/IM', 'llama-server.exe']), 'exit').catch(() => {});
    }

    // ./llama-server -hf unsloth/gemma-3-4b-it-GGUF:UD-Q4_K_XL -ngl 99 --host 0.0.0.0 --port 8000
    const llamaBinary = await downloadLLama();

    const cp = child_process.spawn(llamaBinary,
        [
            '-hf', model,
            '-ngl', '999',
            '--port', '0',
            '--jinja',
        ],
        {
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: path.dirname(llamaBinary),
            env: {
                ...process.env,
                LLAMA_CACHE: path.join(process.env.SCRYPTED_PLUGIN_VOLUME!, 'llama-cache'),
            }
        }
    );

    // When parent exits, kill the child
    process.on('exit', () => {
        cp.kill();
    });

    process.on('SIGINT', () => {
        cp.kill();
        process.exit();
    });

    const port = new Deferred<number>();

    cp.stdout.on('data', (data: Buffer) => {
        const str = data.toString();
        console.log(str);
    });

    cp.stderr.on('data', (data: Buffer) => {
        const str = data.toString();
        console.error(str);
        // main: server is listening on http://127.0.0.1:56369 - starting the main loop
        if (str.includes('server is listening on')) {
            // parse out the port
            const match = str.match(/http:\/\/127\.0\.0\.1:(\d+)/);
            const portNumber = match?.[1];
            if (!portNumber) {
                console.error('Failed to parse port from llama server output:', str);
                cp.kill();
                return;
            }
            port.resolve(parseInt(portNumber, 10));
        }
    });

    cp.on('error', () => {
        console.error('Failed to start llama server.');
        setTimeout(() => {
            process.exit();
        }, 5000);
    });

    cp.on('exit', () => {
        console.log('Llama server exited.');
        setTimeout(() => {
            process.exit();
        }, 5000);
    });

    return port.promise;
}

async function* llamaConnect(input: AsyncGenerator<Buffer>, options: {
    name: string,
    port: number,
    systemPrompt?: string,
    tools: string[],
}) {
    yield* connectStreamInternal(input, {
        baseURL: `http://127.0.0.1:${options.port}/v1`,
        name: options.name,
        systemPrompt: options.systemPrompt,
        tools: options.tools,
    });
}

class LlamaCPP extends BaseLLM implements OnOff {
    forked: ReturnType<typeof sdk.fork<ReturnType<typeof fork>>> | undefined;
    llamaPort: Promise<number> | undefined;

    llamaSettings = new StorageSettings(this, {
        model: {
            title: 'Model',
            description: 'The hugging face model to use for the llama.cpp server. Optional: may include a tag of a specific quantization.',
            placeholder: 'unsloth/gemma-3-4b-it-GGUF',
            defaultValue: 'unsloth/gemma-3-4b-it-GGUF',
            choices: [
                'unsloth/gemma-3-4b-it-GGUF',
                'unsloth/gemma-3-12b-it-GGUF',
                'unsloth/gemma-3-27b-it-GGUF',
                'unsloth/Qwen2.5-VL-32B-Instruct-GGUF',
                'unsloth/Qwen2.5-VL-7B-Instruct-GGUF',
                'unsloth/Qwen2.5-VL-3B-Instruct-GGUF',
            ],
            onPut: () => {
                this.stopLlamaServer();
            }
        },
        clusterWorkerLabels: {
            title: 'Cluster Worker Labels',
            description: 'The labels to use for the cluster worker. This is used to determine which worker to run the llama server on.',
            type: 'string',
            multiple: true,
            combobox: true,
            choices: [
                '@scrypted/coreml',
                '@scrypted/openvino',
                '@scrypted/onnx',
                'compute',
                'llm',
            ],
            onPut: () => {
                this.stopLlamaServer();
            },
            defaultValue: [
                'compute',
            ],
            async onGet() {
                return {
                    hide: !sdk.clusterManager?.getClusterMode(),
                }
            },
        }
    });

    async stopLlamaServer() {
        if (this.forked) {
            try {
                const result = await this.forked.result;
                await result.terminate();
            }
            catch (e) {
                this.forked.worker.terminate();
            }
            this.console.warn('Terminated llama server fork.');
        }
    }

    async turnOn() {
        this.on = true;
    }

    async turnOff() {
        this.on = false;
        this.stopLlamaServer();
    }

    async getSettings(): Promise<Setting[]> {
        return [
            ...await this.llamaSettings.getSettings(),
            ...await this.storageSettings.getSettings()];
    }

    async putSetting(key: string, value: any): Promise<void> {
        if (key in this.llamaSettings.keys) {
            await this.llamaSettings.putSetting(key, value);
            return;
        }
        await this.storageSettings.putSetting(key, value);
    }

    async startLlamaServer() {
        if (!this.on) {
            this.stopLlamaServer();
            return;
        }
        if (!this.forked) {
            let labels: string[] | undefined = this.llamaSettings.values.clusterWorkerLabels;
            if (!labels?.length)
                labels = undefined;
            this.forked = sdk.fork<ReturnType<typeof fork>>({
                runtime: 'node',
                labels: labels ? {
                    require: labels,
                } : undefined,
                id: this.id,
            });
            this.llamaPort = (async () => {
                const result = await this.forked!.result;
                return result.llamaFork(this.llamaSettings.values.model);
            })();
            this.forked.worker.on('exit', () => {
                this.forked = undefined;
            });
        }
        return this.forked!;
    }

    async * connectStreamInternal(input: AsyncGenerator<Buffer>, options: {
        systemPrompt?: string,
    }): AsyncGenerator<Buffer> {
        const forked = await this.startLlamaServer();
        if (!forked) {
            yield Buffer.from('Llama server is not running.\n');
            return;
        }

        const result = await forked.result;
        const port = await this.llamaPort!;
        this.console.log('port', port);
        const connect = await result.llamaConnect(input, {
            name: this.name!,
            port,
            systemPrompt: options.systemPrompt,
            tools: this.storageSettings.values.tools,
        });
        yield* connect;
    }
}

class LLMPlugin extends ScryptedDeviceBase implements DeviceProvider, DeviceCreator {
    devices = new Map<ScryptedNativeId, BaseLLM>();

    constructor(nativeId?: string) {
        super(nativeId);

        sdk.deviceManager.onDeviceDiscovered({
            nativeId: 'tools',
            name: 'Camera Tools',
            type: ScryptedDeviceType.API,
            interfaces: [
                ScryptedInterface.Settings,
                ScryptedInterface.LLMTools,
            ],
        });
    }

    async createDevice(settings: DeviceCreatorSettings): Promise<string> {
        const randomHex = Math.random().toString(16).slice(2, 10);
        if (!settings.type)
            throw new Error('Type is required to create a device.');
        if (settings.type === 'OpenAI Compatible Endpoint') {
            return await sdk.deviceManager.onDeviceDiscovered({
                name: settings.name as string,
                type: 'LLM',
                nativeId: 'openai-' + randomHex,
                interfaces: [
                    ScryptedInterface.TTY,
                    ScryptedInterface.StreamService,
                    ScryptedInterface.Settings,
                ]
            });
        }
        else if (settings.type === 'llama.cpp') {
            const nativeId = 'llama-' + randomHex;
            const id = await sdk.deviceManager.onDeviceDiscovered({
                name: settings.name as string,
                type: 'LLM',
                nativeId,
                interfaces: [
                    ScryptedInterface.TTY,
                    ScryptedInterface.StreamService,
                    ScryptedInterface.Settings,
                    ScryptedInterface.OnOff,
                ]
            });
            const device = await this.getDevice(nativeId) as LlamaCPP;
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
                type: 'radiopanel',
                choices: [
                    'OpenAI Endpoint',
                    'llama.cpp',
                ],
            },
            model: {
                title: 'Model',
                description: 'The hugging face model to use for the llama.cpp server. Optional: may include a tag of a specific quantization.',
                placeholder: 'unsloth/gemma-3-4b-it-GGUF',
                defaultValue: 'unsloth/gemma-3-4b-it-GGUF',
                radioGroups: [
                    'llama.cpp',
                ],
                choices: [
                    'unsloth/gemma-3-4b-it-GGUF',
                    'unsloth/gemma-3-12b-it-GGUF',
                    'unsloth/gemma-3-27b-it-GGUF',
                    'unsloth/Qwen2.5-VL-32B-Instruct-GGUF',
                    'unsloth/Qwen2.5-VL-7B-Instruct-GGUF',
                    'unsloth/Qwen2.5-VL-3B-Instruct-GGUF',
                ],
            },
            clusterWorkerLabels: {
                title: 'Cluster Worker Labels',
                description: 'The labels to use for the cluster worker. This is used to determine which worker to run the llama server on.',
                type: 'string',
                multiple: true,
                combobox: true,
                radioGroups: [
                    'llama.cpp',
                ],
                choices: [
                    '@scrypted/coreml',
                    '@scrypted/openvino',
                    '@scrypted/onnx',
                    'compute',
                    'llm',
                ],
                async onGet() {
                    return {
                        hide: !sdk.clusterManager?.getClusterMode(),
                    }
                },
                defaultValue: [
                    'compute',
                ],
            }
        });

        return storageSettings.getSettings();
    }

    async getDevice(nativeId: ScryptedNativeId): Promise<any> {
        if (nativeId === 'tools')
            return new CameraTools(nativeId);

        let found = this.devices.get(nativeId);
        if (found)
            return found;

        if (nativeId?.startsWith('openai-')) {
            found = new OpenAIEndpoint(nativeId);
            this.devices.set(nativeId, found);
            return found;
        }
        if (nativeId?.startsWith('llama-')) {
            const llama = new LlamaCPP(nativeId);
            this.devices.set(nativeId, llama);
            llama.startLlamaServer();
            return llama;
        }
    }
}

export default LLMPlugin;

export async function fork() {
    return {
        llamaFork,
        async llamaConnect(input: AsyncGenerator<Buffer>, options: {
            name: string,
            port: number,
            systemPrompt?: string,
            tools: string[],
        }) {
            return llamaConnect(input, options);
        },
        async terminate() {
            process.exit(0);
        }
    }
}

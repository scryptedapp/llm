import sdk, { PluginFork, DeviceCreator, DeviceCreatorSettings, DeviceProvider, OnOff, ScryptedDeviceBase, ScryptedInterface, ScryptedNativeId, Setting, Settings, StreamService, TTY } from '@scrypted/sdk';
import { StorageSettings } from '@scrypted/sdk/storage-settings';
import { OpenAI } from 'openai';
import child_process from 'child_process';

async function llamaFork(model: string) {
    // ./llama-server -hf unsloth/gemma-3-4b-it-GGUF:UD-Q4_K_XL -ngl 99 --host 0.0.0.0 --port 8000
}

async function* connectStreamInternal(input: AsyncGenerator<Buffer>, options: {
    name: string,
    baseURL: string,
    apiKey?: string,
    systemPrompt?: string,
    model?: string
}): AsyncGenerator<Buffer> {
    const client = new OpenAI({
        baseURL: options.baseURL,
        apiKey: options.apiKey || 'api requires must not be empty',
    });

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

    if (options.systemPrompt) {
        messages.push({
            role: 'system',
            content: options.systemPrompt,
        });
    }

    yield Buffer.from('> ');
    let curline = '';
    for await (const chunk of input) {
        if (!(chunk instanceof Buffer))
            continue;
        for (const c of chunk.toString()) {
            if (c === '\r') {
                messages.push({
                    role: 'user',
                    content: curline,
                });
                curline = '';

                const stream = client.chat.completions.stream({
                    model: options.model!,
                    messages,
                });

                yield Buffer.from(`\n\n${options.name}:\n\n`);

                for await (const token of stream) {
                    yield token.choices[0].delta.content ? Buffer.from(token.choices[0].delta.content) : Buffer.from('');
                }

                yield Buffer.from('\n\n> ');
                continue;
            }
            if (c.charCodeAt(0) === 127) {
                if (curline.length === 0)
                    continue;
                curline = curline.slice(0, -1);
                yield Buffer.from('\b \b');
                continue;
            }
            curline += c;
            yield Buffer.from(c);
        }
    }
}

abstract class BaseLLM extends ScryptedDeviceBase implements StreamService<Buffer>, TTY {
    storageSettings = new StorageSettings(this, {
        systemPrompt: {
            title: 'System Prompt',
            description: 'The system prompt to use for the OpenAI compatible endpoint.',
            type: 'textarea',
            placeholder: 'You are a helpful assistant.',
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

class LlamaCPP extends BaseLLM implements OnOff {
    forked: ReturnType<typeof sdk.fork<typeof fork>> | undefined;
    llamaSettings = new StorageSettings(this, {
        model: {
            title: 'Model',
            description: 'The hugging face model to use for the llama.cpp server.',
            placeholder: 'unsloth/gemma-3-4b-it-GGUF',
            defaultValue: 'unsloth/gemma-3-4b-it-GGUF',
            onPut: () => {
                this.stopLlamaServer();
            }
        }
    });

    async stopLlamaServer() {
        if (this.forked) {
            this.forked.worker.terminate();
            this.forked = undefined;
        }
    }

    async turnOn() {
        this.on = true;
    }

    async turnOff() {
        this.on = false;
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
        if (this.forked)
            return;
    }

    async * connectStreamInternal(input: AsyncGenerator<Buffer>, options: {
        systemPrompt?: string,
    }): AsyncGenerator<Buffer> {
        // yield* connectStreamInternal(input, {
        //     name: this.name!,
        //     baseURL: this.openaiSettings.values.baseURL,
        //     apiKey: this.openaiSettings.values.apiKey,
        //     systemPrompt: this.storageSettings.values.systemPrompt,
        //     model: this.openaiSettings.values.model,
        // });
    }
}

class LLMPlugin extends ScryptedDeviceBase implements DeviceProvider, DeviceCreator {
    constructor(nativeId?: string) {
        super(nativeId);
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
            return await sdk.deviceManager.onDeviceDiscovered({
                name: settings.name as string,
                type: 'LLM',
                nativeId: 'llama-' + randomHex,
                interfaces: [
                    ScryptedInterface.TTY,
                    ScryptedInterface.StreamService,
                    ScryptedInterface.Settings,
                    ScryptedInterface.OnOff,
                ]
            });
        }
        throw new Error('Unknown type: ' + settings.type);
    }

    async releaseDevice(device: any) {

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
                    'OpenAI Compatible Endpoint',
                    'llama.cpp',
                ],
            },
        });

        return storageSettings.getSettings();
    }

    async getDevice(nativeId: ScryptedNativeId): Promise<any> {
        if (nativeId?.startsWith('openai-'))
            return new OpenAIEndpoint(nativeId);
    }
}

export default LLMPlugin;

export async function fork() {
    return {
        llamaFork,
    }
}

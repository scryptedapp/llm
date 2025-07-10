import { createAsyncQueue, Deferred } from '@scrypted/deferred';
import type { ChatCompletion, DeviceCreator, DeviceCreatorSettings, DeviceProvider, LLMTools, OnOff, ScryptedNativeId, Setting, Settings, StreamService, TTY } from '@scrypted/sdk';
import sdk, { ScryptedDeviceBase, ScryptedInterface } from '@scrypted/sdk';
import { StorageSettings } from '@scrypted/sdk/storage-settings';
import child_process from 'child_process';
import { once } from 'events';
import { OpenAI } from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources';
import type { ChatCompletionStreamParams, ParsedChatCompletion } from 'openai/resources/chat/completions';
import path from 'path';
import { createInterface } from 'readline';
import { PassThrough } from 'stream';
import { downloadLLama } from './download-llama';
import { handleToolCalls, prepareTools } from './tool-calls';
import { WebSearchTools } from './web-search-tools';

abstract class BaseLLM extends ScryptedDeviceBase implements StreamService<Buffer>, TTY, ChatCompletion {
    storageSettings = new StorageSettings(this, {
        systemPrompt: {
            title: 'System Prompt',
            description: 'The system prompt to use for the OpenAI compatible endpoint.',
            type: 'textarea',
            placeholder: 'You are a helpful assistant.',
        },
        terminalTools: {
            title: 'Terminal Tools',
            description: 'Enable terminal tools for the assistant. This allows the assistant to execute commands on the system. The LLM and users that have access to this LLM will be able to view cameras and operate all home automation devices.',
            type: 'boolean',
        }
    });

    abstract getChatCompletion(body: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming): Promise<OpenAI.Chat.Completions.ChatCompletion>;
    abstract streamChatCompletionInternal(body: ChatCompletionStreamParams): AsyncGenerator<OpenAI.Chat.Completions.ChatCompletionChunk | OpenAI.Chat.Completions.ChatCompletion>;
    abstract get functionCalls(): boolean;

    async * streamChatCompletionWrapper(body: ChatCompletionStreamParams, userMessages?: AsyncGenerator<ChatCompletionMessageParam[]>, callback?: null | ((chunk: OpenAI.ChatCompletionChunk) => Promise<boolean>)): AsyncGenerator<OpenAI.Chat.Completions.ChatCompletionChunk | OpenAI.Chat.Completions.ChatCompletion> {
        const lastMessage = body.messages[body.messages.length - 1];
        if (lastMessage?.role !== 'user' && lastMessage?.role !== 'tool') {
            if (!userMessages)
                throw new Error('Last message must not be from the assistant.');
            const userMessage = await userMessages.next();
            if (userMessage.done)
                throw new Error('No user message provided for last message.');
            body.messages.push(...userMessage.value);
        }

        let error: Error | undefined;
        let done = false;
        while (true) {
            for await (const message of this.streamChatCompletionInternal(body)) {
                if (done)
                    return;
                if (error)
                    throw error;
                if ('delta' in message.choices[0]) {
                    // this is a streaming chunk, yield it.
                    if (callback)
                        callback(message as OpenAI.ChatCompletionChunk).then(more => done = !more).catch(e => error = e);
                    else if (callback !== null)
                        yield message;
                    continue;
                }

                body.messages.push(message.choices[0].message);
                // vllm freaks out if arguments is an empty string.
                for (const tc of message.choices[0].message.tool_calls || []) {
                    if (tc.function)
                        tc.function.arguments ||= '{}';
                }

                yield message;
            }

            // need user message
            if (!userMessages)
                return;

            const userMessage = await userMessages.next();
            if (userMessage.done)
                break;
            body.messages.push(...userMessage.value);
            if (body.messages[body.messages.length - 1].role === 'assistant')
                throw new Error('Last message must be from the user or a tool.');
        }
    }

    async streamChatCompletion(body: ChatCompletionStreamParams, userMessages?: undefined | AsyncGenerator<ChatCompletionMessageParam[]>, callback?: null | ((chunk: OpenAI.ChatCompletionChunk) => Promise<boolean>)): Promise<any> {
        return this.streamChatCompletionWrapper(body, userMessages, callback);
    }

    async* connectStreamService(input: AsyncGenerator<Buffer>): AsyncGenerator<Buffer> {
        const llmTools = this.storageSettings.values.terminalTools ? [new WebSearchTools()] : [];
        const tools = await prepareTools(llmTools);

        const i = new PassThrough();
        const o = new PassThrough();
        const q = createAsyncQueue<Buffer>();
        o.on('data', (chunk) => {
            q.submit(chunk);
        });

        const rl = createInterface({
            input: i,
            output: o,
            terminal: true,
            prompt: '> ',
        });
        rl.prompt();

        let processing = false;

        (async () => {
            try {
                for await (const chunk of input) {
                    // terminal message are json
                    if (!(chunk instanceof Buffer))
                        continue;
                    i.push(chunk);
                }
            }
            catch (e) {
            }
            finally {
                i.destroy();
                o.destroy();
                rl.close();
            }
        })();

        using userMessageQueue = createAsyncQueue<ChatCompletionMessageParam[]>();
        let printedName = false;

        (async () => {
            try {

                let lastAssistantMessage: ParsedChatCompletion<null> | undefined;
                for await (const token of await this.streamChatCompletion({
                    messages: this.storageSettings.values.systemPrompt ? [{
                        role: 'system',
                        content: this.storageSettings.values.systemPrompt,
                    }] : [],
                    tools: tools.tools,
                    model: undefined as any,
                }, userMessageQueue.queue)) {
                    lastAssistantMessage = token as any;
                    if (token.object === 'chat.completion.chunk') {
                        if (token.choices[0].delta.content) {
                            if (!printedName) {
                                printedName = true;
                                q.submit(Buffer.from(`\n\n${this.name}:\n\n`));
                            }
                            q.submit(Buffer.from(token.choices[0].delta.content));
                        }
                        continue;
                    }

                    q.submit(Buffer.from('\n\n'));
                    console.log(lastAssistantMessage);
                    const message = lastAssistantMessage!.choices[0].message!;

                    if (!message.tool_calls) {
                        processing = false;
                        rl.prompt();
                        continue;
                    }

                    const messages = await handleToolCalls(tools, message, this.functionCalls, tc => {
                        q.submit(Buffer.from(`\n\n${this.name}:\n\nCalling tool: ${tc.function.name} - ${tc.function.arguments}\n\n`));
                    });

                    userMessageQueue.submit(messages);
                }
            }
            catch (e) {
                q.submit(Buffer.from(`\n\nChat error (restarting):\n\n${e}\n\n`));
                return;
            }
        })();

        rl.on('line', async (line) => {
            if (!line) {
                rl.prompt();
                return;
            }
            if (processing)
                return;
            processing = true;
            printedName = false;
            userMessageQueue.submit([{
                role: 'user',
                content: line,
            }]);
        });

        yield* q.queue;
    }

    async connectStream(input: AsyncGenerator<Buffer>, options?: any): Promise<AsyncGenerator<Buffer>> {
        return this.connectStreamService(input);
    }
}

class OpenAIEndpoint extends BaseLLM implements Settings, ChatCompletion {
    openaiSettings = new StorageSettings(this, {
        model: {
            title: 'Model',
            description: 'The model to use for the OpenAI compatible endpoint.',
            placeholder: 'o4-mini',
        },
        baseURL: {
            title: 'Base URL',
            description: 'The base URL of the OpenAI compatible endpoint. Common base URLs for cloud providers and local LLM servers are provided as examples.',
            placeholder: 'https://api.openai.com/v1',
            combobox: true,
            choices: [
                'https://api.openai.com/v1',
                'https://generativelanguage.googleapis.com/v1beta/openai/',
                'https://api.anthropic.com/v1/',
                'http://llama-cpp.localdomain:8080/v1',
                'http://lmstudio.localdomain:1234/v1',
            ]
        },
        apiKey: {
            title: 'API Key',
            description: 'The API key for the OpenAI compatible endpoint.',
            type: 'password',
        },
        functionCalls: {
            title: 'Legacy Function Calls',
            description: 'Use function calls rather than tool calls for legacy providers like LMStudio.',
            type: 'boolean',
        },
    });

    get functionCalls(): boolean {
        return this.openaiSettings.values.functionCalls || false;
    }

    async * streamChatCompletionInternal(body: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming): AsyncGenerator<OpenAI.Chat.Completions.ChatCompletionChunk | OpenAI.Chat.Completions.ChatCompletion> {
        const client = new OpenAI({
            baseURL: this.openaiSettings.values.baseURL,
            apiKey: this.openaiSettings.values.apiKey || 'no-key',
        });

        body.model ||= this.openaiSettings.values.model;
        const stream = client.chat.completions.stream(body);
        for await (const chunk of stream) {
            yield chunk;
        }
        const last = await stream.finalChatCompletion();
        yield last;
    }

    async getChatCompletion(body: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming): Promise<OpenAI.Chat.Completions.ChatCompletion> {
        const client = new OpenAI({
            baseURL: this.openaiSettings.values.baseURL,
            apiKey: this.openaiSettings.values.apiKey || 'no-key',
        });

        body.model ||= this.openaiSettings.values.model;

        const completion = await client.chat.completions.create(body);
        return completion;
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

async function llamaFork(providedPort: number, apiKey: string, model: string, additionalArguments: string[]) {
    if (process.platform !== 'win32') {
        // super hacky but need to clean up dangling processes.
        await once(child_process.spawn('killall', ['llama-server']), 'exit').catch(() => { });
    }
    else {
        // windows doesn't have killall, so just kill the process by name.
        await once(child_process.spawn('taskkill', ['/F', '/IM', 'llama-server.exe']), 'exit').catch(() => { });
    }

    // ./llama-server -hf unsloth/gemma-3-4b-it-GGUF:UD-Q4_K_XL -ngl 99 --host 0.0.0.0 --port 8000
    const llamaBinary = await downloadLLama();

    const host = apiKey ? '0.0.0.0' : '127.0.0.1';
    providedPort ||= 0;

    const args = [
        '-hf', model,
        '--host', host,
        '--port', providedPort.toString(),
        ...additionalArguments.map(arg => arg.split(' ')).flat().map(arg => arg.trim()).filter(arg => arg),
    ];

    if (apiKey)
        args.push('--api-key', apiKey);

    console.log('Starting llama server with args:', ...args);

    const cp = child_process.spawn(llamaBinary,
        args,
        {
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: path.dirname(llamaBinary),
            env: {
                ...process.env,
                LLAMA_CACHE: path.join(process.env.SCRYPTED_PLUGIN_VOLUME!, 'llama-cache'),
            }
        }
    );

    const cpKill = () => {
        cp.kill();
        process.exit();
    };
    // When parent exits, kill the child
    ['exit', 'SIGINT', 'SIGTERM', 'SIGHUP', 'SIGUSR1', 'SIGUSR2'].forEach((signal) => {
        process.on(signal, cpKill);
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
            const match = str.match(/http:\/\/\d+\.\d+\.\d+\.\d+:(\d+)/);
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

    const p = await port.promise;
    const address = sdk.clusterManager.getClusterAddress() || '127.0.0.1';
    return `http://${address}:${p}/v1`;
}

class LlamaCPP extends BaseLLM implements OnOff, ChatCompletion {
    forked: ReturnType<typeof sdk.fork<ReturnType<typeof fork>>> | undefined;
    llamaBaseUrl: Promise<string> | undefined;

    llamaSettings = new StorageSettings(this, {
        model: {
            title: 'Model',
            description: 'The hugging face model to use for the llama.cpp server. Optional: may include a tag of a specific quantization.',
            placeholder: 'unsloth/gemma-3-4b-it-GGUF',
            defaultValue: 'unsloth/gemma-3-4b-it-GGUF',
            combobox: true,
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
        additionalArguments: {
            title: 'Additional Arguments',
            description: 'Additional arguments to pass to the llama server. Vision models require the --jinja argument. Language only models may not work correctly with --jinja.',
            type: 'string',
            multiple: true,
            combobox: true,
            defaultValue: [
                '-ngl 999',
                '--jinja',
            ],
            choices: [
                '-ngl 999',
                '--jinja',
            ],
            onPut: () => {
                this.stopLlamaServer();
            },
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
        },
        apiKey: {
            group: 'Network',
            title: 'API Key',
            type: 'password',
            description: 'Provide an API Key will allow llama.cpp to be usable by other services on your network that have the entered credentials.',
            onPut: () => {
                this.stopLlamaServer();
            },
        },
        port: {
            group: 'Network',
            title: 'Port',
            type: 'number',
            description: 'The port to run the llama server on. If not specified, a random port will be used.',
            onPut: () => {
                this.stopLlamaServer();
            },
        }
    });

    get functionCalls(): boolean {
        return false;
    }

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
        if (!this.llamaSettings.values.apiKey)
            this.llamaSettings.values.apiKey = Math.random().toString(16).slice(2, 10);
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
            this.llamaBaseUrl = (async () => {
                const result = await this.forked!.result;
                return result.llamaFork(this.llamaSettings.values.port, this.llamaSettings.values.apiKey, this.llamaSettings.values.model, this.llamaSettings.values.additionalArguments);
            })();
            this.forked.worker.on('exit', () => {
                this.forked = undefined;
            });
        }
        return this.forked!;
    }

    async getChatCompletion(body: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming): Promise<OpenAI.Chat.Completions.ChatCompletion> {
        const forked = await this.startLlamaServer();
        if (!forked)
            throw new Error('Llama server is not running.\n');

        await forked.result;
        const baseURL = await this.llamaBaseUrl!;


        const client = new OpenAI({
            baseURL,
            apiKey: this.llamaSettings.values.apiKey || 'no-key',
        });

        const completion = await client.chat.completions.create(body);
        return completion;
    }

    async * streamChatCompletionInternal(body: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming): AsyncGenerator<OpenAI.Chat.Completions.ChatCompletionChunk | OpenAI.Chat.Completions.ChatCompletion> {
        const forked = await this.startLlamaServer();
        if (!forked)
            throw new Error('Llama server is not running.\n');

        await forked.result;
        const baseURL = await this.llamaBaseUrl!;


        const client = new OpenAI({
            baseURL,
            apiKey: this.llamaSettings.values.apiKey || 'no-key',
        });

        const stream = client.chat.completions.stream(body);
        for await (const chunk of stream) {
            yield chunk;
        }
        const last = await stream.finalChatCompletion();
        yield last;
    }
}

class LLMPlugin extends ScryptedDeviceBase implements DeviceProvider, DeviceCreator {
    devices = new Map<ScryptedNativeId, BaseLLM>();

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
            nativeId: 'search-tools',
            name: 'Search Tools',
            type: 'LLMTools',
            interfaces: [
                ScryptedInterface.LLMTools,
                ScryptedInterface.Settings,
            ],
        });

        this.updateCors();
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
        if (nativeId?.startsWith('llama-'))
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
        if (settings.type === 'OpenAI Endpoint') {
            return await this.reportDevice('openai-' + randomHex, settings.name as string);
        }
        else if (settings.type === 'llama.cpp') {
            const nativeId = 'llama-' + randomHex;
            const id = await this.reportDevice(nativeId, settings.name as string);
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
                combobox: true,
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
        let found = this.devices.get(nativeId);
        if (found)
            return found;

        if (nativeId === 'search-tools') {
            return new WebSearchTools(nativeId);
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
    }
}

export default LLMPlugin;

export async function fork() {
    return {
        llamaFork,
        async terminate() {
            process.exit(0);
        }
    }
}

import { createAsyncQueue, Deferred } from '@scrypted/deferred';
import sdk, { CallToolResult, ChatCompletion, ChatCompletionCapabilities, ChatCompletionStreamParams, DeviceCreator, DeviceCreatorSettings, DeviceProvider, HttpRequest, HttpRequestHandler, HttpResponse, LLMTools, MixinProvider, OnOff, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, ScryptedNativeId, Setting, Settings, StreamService, TTY, WritableDeviceState } from '@scrypted/sdk';
import { StorageSettings } from '@scrypted/sdk/storage-settings';
import child_process from 'child_process';
import { once } from 'events';
import { OpenAI } from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources';
import type { ChatCompletionAssistantMessageParam, ParsedChatCompletion, ParsedChatCompletionMessage } from 'openai/resources/chat/completions';
import path from 'path';
import { createInterface } from 'readline';
import { PassThrough } from 'stream';
import { downloadLLama, llamaVersion } from './download-llama';
import { LLMUserMixin } from './llm-user';
import { MCPServer } from './mcp-server';
import { handleToolCalls, prepareTools } from './tool-calls';
import { ScryptedTools } from './scrypted-tools';
import { Database, UserDatabase } from './user-database';
import { WebSearchTools } from './web-search-tools';
import { checkUserId } from '@scrypted/sdk/acl';

const WebSearchToolsNativeId = 'search-tools';

const modelSetting = {
    title: 'Model',
    description: 'The hugging face model to use for the llama.cpp server. Optional: may include a tag of a specific quantization.',
    placeholder: 'unsloth/Qwen3-VL-4B-Instruct-GGUF',
    defaultValue: 'unsloth/Qwen3-VL-4B-Instruct-GGUF',
    combobox: true,
    choices: [
        'unsloth/gemma-3-4b-it-GGUF',
        'unsloth/gemma-3-12b-it-GGUF',
        'unsloth/gemma-3-27b-it-GGUF',
        'unsloth/Qwen3-VL-30B-A3B-Instruct-GGUF',
        'unsloth/Qwen3-VL-8B-Instruct-GGUF',
        'unsloth/Qwen3-VL-4B-Instruct-GGUF',
        'unsloth/Qwen3-VL-2B-Instruct-GGUF',
    ],
};

abstract class BaseLLM extends ScryptedDeviceBase implements StreamService<Buffer>, TTY, ChatCompletion {
    storageSettings = new StorageSettings(this, {
        chatCompletionCapabilities: {
            title: 'Capabilities',
            description: 'The capabilities of the model. This is used to determine which features are available.',
            type: 'string',
            defaultValue: ['image'],
            multiple: true,
            choices: [
                'image',
                'imageGeneration',
                'audio',
                'audioGeneration',
            ],
            onPut: () => {
                const capabilities: ChatCompletionCapabilities = {};
                for (const capability of this.storageSettings.values.chatCompletionCapabilities || []) {
                    capabilities[capability as keyof ChatCompletionCapabilities] = true;
                }
                this.chatCompletionCapabilities = capabilities;
            }
        },
        systemPrompt: {
            title: 'Terminal System Prompt',
            description: 'The system prompt to use inside the terminal session.',
            type: 'textarea',
            placeholder: 'You are a helpful assistant.',
        },
        terminalTools: {
            title: 'Scrypted Terminal Tools',
            description: 'Enable scrypted tools for usage in this terminal. Will grant the LLM full access to all devices in Scrypted.',
            type: 'boolean',
        },
        additionalTools: {
            title: 'Additional Terminal Tools',
            description: 'Enable additional tools for usage in this terminal.',
            type: 'device',
            multiple: true,
            deviceFilter: ({ interfaces, ScryptedInterface }) => {
                return interfaces.includes(ScryptedInterface.LLMTools);
            },
        }
    });

    constructor(nativeId?: string) {
        super(nativeId);
        const defaultCapabilities: ChatCompletionCapabilities = {
            image: true,
        };
        this.chatCompletionCapabilities ||= defaultCapabilities;
        this.storageSettings.values.chatCompletionCapabilities = Object.entries(this.chatCompletionCapabilities).filter(([key, value]) => value).map(([key]) => key) as any;
    };

    abstract getChatCompletion(body: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming): Promise<OpenAI.Chat.Completions.ChatCompletion>;
    abstract streamChatCompletionInternal(body: ChatCompletionStreamParams): AsyncGenerator<OpenAI.Chat.Completions.ChatCompletionChunk | OpenAI.Chat.Completions.ChatCompletion>;
    abstract get functionCalls(): boolean;

    async * streamChatCompletionWrapper(body: ChatCompletionStreamParams, userMessages?: AsyncGenerator<ChatCompletionMessageParam[]>, callback?: null | ((chunk: OpenAI.ChatCompletionChunk) => Promise<boolean>)): AsyncGenerator<OpenAI.Chat.Completions.ChatCompletionChunk | OpenAI.Chat.Completions.ChatCompletion> {
        const ensureLastMessageIsUserOrToolMessage = async () => {
            while (true) {
                const lastMessage = body.messages[body.messages.length - 1];
                if (lastMessage?.role === 'user' || lastMessage?.role === 'tool')
                    break;
                if (!userMessages)
                    throw new Error('Last message must not be from the assistant.');
                if (!body.continue_final_message) {
                    const userMessage = await userMessages.next();
                    if (userMessage.done)
                        throw new Error('No user message provided for last message.');
                    body.messages.push(...userMessage.value);
                }
            }
        };

        await ensureLastMessageIsUserOrToolMessage();

        while (true) {
            let error: Error | undefined;
            let done = false;
            for await (const message of this.streamChatCompletionInternal(body)) {
                if (done) {
                    yield undefined as any;
                    if (userMessages) {
                        const userMessage = await userMessages.next();
                        if (userMessage.done)
                            throw new Error('No assistant message provided for aborted message.');
                        body.messages.push(...userMessage.value);
                    }
                    break;
                }
                if (error)
                    throw error;
                if (message.choices[0]) {
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
                        if (tc.type === 'custom')
                            throw new Error('Custom tool calls are not supported.');
                        if (tc.function)
                            tc.function.arguments ||= '{}';
                    }
                }

                yield message;
            }

            // request is not two way streaming, so exit.
            if (!userMessages)
                return;

            await ensureLastMessageIsUserOrToolMessage();
        }


    }

    async streamChatCompletion(body: ChatCompletionStreamParams, userMessages?: undefined | AsyncGenerator<ChatCompletionMessageParam[]>, callback?: null | ((chunk: OpenAI.ChatCompletionChunk) => Promise<boolean>)): Promise<any> {
        return this.streamChatCompletionWrapper(body, userMessages, callback);
    }

    async* connectStreamService(input: AsyncGenerator<Buffer>): AsyncGenerator<Buffer> {
        const llmTools: LLMTools[] = this.storageSettings.values.terminalTools ? [new ScryptedTools(sdk)] : [];
        for (const tool of this.storageSettings.values.additionalTools || []) {
            llmTools.push(sdk.systemManager.getDeviceById<LLMTools>(tool));
        }
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
        const toolHistory: CallToolResult[] = [];

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
                        const content = token.choices[0].delta.content || token.choices[0].delta.reasoning_content;
                        if (content) {
                            if (!printedName) {
                                printedName = true;
                                q.submit(Buffer.from(`\n\n${this.name}:\n\n`));
                            }
                            q.submit(Buffer.from(content));
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

                    const allMessages = await handleToolCalls(tools, message, toolHistory, this.functionCalls, this.chatCompletionCapabilities, tc => {
                        q.submit(Buffer.from(`\n\n${this.name}:\n\nCalling tool: ${tc.function.name} - ${tc.function.arguments}\n\n`));
                    });

                    for (const toolMessage of allMessages) {
                        if (toolMessage.callToolResult)
                            toolHistory.push(toolMessage.callToolResult);
                        userMessageQueue.submit(toolMessage.messages);
                    }
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
        for (const message of body.messages) {
            // some apis may send null values across, which chokes gemini up.
            for (const k in message) {
                // @ts-expect-error
                if (message[k] === undefined || message[k] === null) {
                    // @ts-expect-error
                    delete message[k];
                }
            }
        }
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

async function llamaFork(providedPort: number, apiKey: string, model: string, additionalArguments: string[], backend?: string, version?: string) {
    if (process.platform !== 'win32') {
        // super hacky but need to clean up dangling processes.
        await once(child_process.spawn('killall', ['llama-server']), 'exit').catch(() => { });
    }
    else {
        // windows doesn't have killall, so just kill the process by name.
        await once(child_process.spawn('taskkill', ['/F', '/IM', 'llama-server.exe']), 'exit').catch(() => { });
    }

    const env = process.env.SCRYPTED_INSTALL_ENVIRONMENT;
    if (env?.includes('docker')) {
        const flavor = process.env.SCRYPTED_DOCKER_FLAVOR;
        if (!flavor?.includes('intel') && !flavor?.includes('nvidia')) {
            sdk.log!.a('The llama.cpp server requires the intel or nvidia docker image. There may be stability and performance issues running on this image.');
        }
    }

    // ./llama-server -hf unsloth/gemma-3-4b-it-GGUF:UD-Q4_K_XL -ngl 99 --host 0.0.0.0 --port 8000
    const llamaBinary = await downloadLLama(backend, version);

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
            ...modelSetting,
            onPut: () => {
                this.stopLlamaServer();
            }
        },
        backend: {
            title: 'Backend',
            description: 'The runtime backend to use for the llama.cpp server.',
            type: 'string',
            defaultValue: 'Default',
            combobox: true,
            choices: [
                'Default',
                'cpu',
                'cuda',
                'sycl',
                'vulkan',
            ],
            onPut: () => {
                this.stopLlamaServer();
            },
        },
        version: {
            title: 'Version',
            description: 'The llama.cpp version to use.',
            type: 'string',
            defaultValue: llamaVersion,
            combobox: true,
            choices: [
                llamaVersion,
            ],
            onPut: () => {
                this.stopLlamaServer();
            },
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
                '-fa on',
            ],
            choices: [
                '-ngl 999',
                '--jinja',
                '-fa on',
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
                return result.llamaFork(this.llamaSettings.values.port, this.llamaSettings.values.apiKey, this.llamaSettings.values.model, this.llamaSettings.values.additionalArguments, this.llamaSettings.values.backend, this.llamaSettings.values.version);
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

export default class LLMPlugin extends ScryptedDeviceBase implements DeviceProvider, DeviceCreator, UserDatabase, HttpRequestHandler, MixinProvider {
    devices = new Map<ScryptedNativeId, any>();
    userDatabases = new Map<string, {
        token: string,
        database: Database,
    }>();

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
            nativeId: WebSearchToolsNativeId,
            name: 'Search Tools',
            type: 'LLMTools',
            interfaces: [
                ScryptedInterface.LLMTools,
                ScryptedInterface.Settings,
            ],
        });

        this.updateCors();
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
            response.sendStream((async function* () {
                const stream = await chatCompletion.streamChatCompletion(body);
                for await (const chunk of stream) {
                    if (chunk.object === 'chat.completion') {
                        yield Buffer.from(`data: [DONE]\n\n`);
                    }
                    else {
                        yield Buffer.from(`data: ${JSON.stringify(chunk)}\n\n`);
                    }
                }
            })(), {
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
                    'OpenAI Server',
                    'llama.cpp',
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

        if (nativeId === WebSearchToolsNativeId) {
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

export async function fork() {
    return {
        llamaFork,
        async terminate() {
            process.exit(0);
        }
    }
}

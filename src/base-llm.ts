import { createAsyncQueue } from '@scrypted/deferred';
import sdk, { CallToolResult, ChatCompletion, ChatCompletionCapabilities, ChatCompletionStreamParams, LLMTools, ScryptedDeviceBase, StreamService, TTY } from '@scrypted/sdk';
import { StorageSettings } from '@scrypted/sdk/storage-settings';
import { OpenAI } from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources';
import type { ParsedChatCompletion } from 'openai/resources/chat/completions';
import { createInterface } from 'readline';
import { PassThrough } from 'stream';
import { ScryptedTools } from './scrypted-tools';
import { handleToolCalls, prepareTools } from './tool-calls';

export abstract class BaseLLM extends ScryptedDeviceBase implements StreamService<Buffer>, TTY, ChatCompletion {
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
                'reasoning',
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
                // continuing the final assistant message is valid in one way
                // streaming mode (no userMessages) as well.
                if (body.continue_final_message)
                    break;
                if (!userMessages)
                    throw new Error('Last message must not be from the assistant.');
                const userMessage = await userMessages.next();
                if (userMessage.done)
                    throw new Error('No user message provided for last message.');
                body.messages.push(...userMessage.value);
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
                q.end();
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
                    tools: tools.tools?.length ? tools.tools : undefined,
                    model: undefined as any,
                }, userMessageQueue.queue)) {
                    lastAssistantMessage = token as any;
                    if (token.object === 'chat.completion.chunk') {
                        const content = token.choices[0]?.delta.content || token.choices[0]?.delta.reasoning_content;
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
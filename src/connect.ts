import sdk, { LLMToolDefinition, LLMTools } from '@scrypted/sdk';
import { OpenAI } from 'openai';
import type { ChatCompletionContentPartImage } from 'openai/resources';
import type { ParsedChatCompletion } from 'openai/resources/chat/completions.mjs';

export async function prepareTools(toolIds: string[]) {
    const toolsPromises = toolIds.map(async tool => {
        const llmTools = sdk.systemManager.getDeviceById<LLMTools>(tool);
        const availableTools = await llmTools.getLLMTools();
        return availableTools.map(tool => {
            tool.parameters ||= {
                "type": "object",
                "properties": {
                },
                "required": [
                ],
                "additionalProperties": false
            };
            return {
                llmTools,
                tool,
            };
        });
    });

    const tools = (await Promise.allSettled(toolsPromises)).map(r => r.status === 'fulfilled' ? r.value : []).flat();
    const map: Record<string, string> = {};
    for (const entry of tools) {
        map[entry.tool.name] = entry.llmTools.id;
    }

    return {
        map,
        tools: tools.map(t => t.tool),
    };
}

// this method is called on the cluster worker to connect to a localhost only socket that is inaccessible to the cluster server.
export async function* connectStreamInternal(options: {
    baseURL: string,
    apiKey?: string,
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    model?: string,
    tools: LLMToolDefinition[],
}): AsyncGenerator<OpenAI.Chat.Completions.ChatCompletionChunk | ParsedChatCompletion<null>> {
    const client = new OpenAI({
        baseURL: options.baseURL,
        apiKey: options.apiKey || 'api requires must not be empty',
    });

    const stream = client.chat.completions.stream({
        model: options.model!,
        messages: options.messages,
        tools: options.tools.map(tool => ({
            type: 'function',
            function: tool,
        })),
    });
    for await (const chunk of stream) {
        yield chunk;
    }
    const last = await stream.finalChatCompletion();
    yield last;
}

export async function* connectStreamService(input: AsyncGenerator<Buffer>, options: {
    name: string,
    systemPrompt?: string,
    functionCalls: boolean,
}, toolcall: (tool: OpenAI.Chat.Completions.ChatCompletionMessageToolCall) => Promise<string>, cs: (messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]) => AsyncGenerator<OpenAI.Chat.Completions.ChatCompletionChunk | ParsedChatCompletion<null>>): AsyncGenerator<Buffer> {
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

                let printedName = false;

                while (true) {
                    let lastAssistantMessage: ParsedChatCompletion<null> | undefined;
                    for await (const token of cs(messages)) {
                        lastAssistantMessage = token as any;
                        if ('delta' in token.choices[0]) {
                            if (token.choices[0].delta.content) {
                                if (!printedName) {
                                    printedName = true;
                                    yield Buffer.from(`\n\n${options.name}:\n\n`);
                                }
                                yield Buffer.from(token.choices[0].delta.content);
                            }
                        }
                        else {
                            yield Buffer.from('');
                        }
                    }
                    console.log(lastAssistantMessage);
                    const message = lastAssistantMessage!.choices[0].message!;
                    messages.push(message);

                    if (!message.tool_calls)
                        break;

                    for (const tc of message.tool_calls) {
                        yield Buffer.from(`\n\n>${options.name}:\n\nCalling tool: ${tc.function.name} - ${tc.function.arguments}\n\n`);
                        const response = await toolcall(tc);
                        // tool calls cant return images, so fake it out by having the tool respond
                        // that the next user message will include the image and the assistant respond ok.
                        if (response.startsWith('data:')) {
                            messages.push({
                                role: 'tool',
                                tool_call_id: tc.id,
                                content: 'The next user message will include the image.',
                            });
                            messages.push({
                                role: 'assistant',
                                content: 'Ok.',
                            });

                            const image: ChatCompletionContentPartImage = {
                                type: 'image_url',
                                image_url: {
                                    url: response,
                                },
                            };
                            messages.push({
                                role: 'user',
                                content: [
                                    image,
                                ],
                            });
                        }
                        else {
                            messages.push({
                                role: 'tool',
                                tool_call_id: tc.id,
                                content: response,
                            });
                        }

                        if (options.functionCalls) {
                            message.function_call = {
                                name: tc.function.name,
                                arguments: tc.function.arguments!,
                            }
                        }
                    }

                    if (options.functionCalls) {
                        delete message.tool_calls;
                    }
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

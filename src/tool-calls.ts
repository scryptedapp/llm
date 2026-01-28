import type { CallToolResult, ChatCompletionCapabilities, LLMTools, TextResourceContents } from "@scrypted/types";
import type { OpenAI } from 'openai';
import { partialParse } from 'openai/_vendor/partial-json-parser/parser.mjs';
import type { ChatCompletionContentPartImage, ChatCompletionTool } from 'openai/resources';
import type { ChatCompletionFunctionTool, ParsedChatCompletionMessage, ParsedFunctionToolCall } from "openai/resources/chat/completions";
import { generate } from 'random-words';
import { callGetTimeTool, TimeToolFunctionName } from "./time-tool";

export async function prepareTools(allLLMTools: LLMTools[]) {
    const toolsPromises = allLLMTools.map(async llmTools => {
        const availableTools = await llmTools.getLLMTools();
        return availableTools.map(tool => {
            tool.function.parameters ||= {
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

    const toolTuples = (await Promise.allSettled(toolsPromises)).map(r => r.status === 'fulfilled' ? r.value : []).flat();
    const map: Record<string, LLMTools> = {};
    // Used to deduplciate tools that are provided by multiple LLMTools implementations like get_time.
    const toolMap: Record<string, ChatCompletionTool> = {};
    const originalNames = new Map<string, string>();
    for (const entry of toolTuples) {
        const noDashName = entry.tool.function.name.replace('-', '_');
        originalNames.set(noDashName, entry.tool.function.name);
        entry.tool.function.name = noDashName;
        map[noDashName] = entry.llmTools;
        toolMap[noDashName] = entry.tool;
    }

    const tools = Object.values(toolMap);

    const toolCall = async (toolCall: OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall) => {
        const tool = map[toolCall.function.name];
        const originalName = originalNames.get(toolCall.function.name);
        if (!tool || !originalName)
            throw new Error(`Tool ${toolCall} not found.`);
        // intercept time tool calls to provide a user locale time.
        if (originalName === TimeToolFunctionName)
            return callGetTimeTool();
        const result = await tool.callLLMTool(toolCall.id, originalName, partialParse(toolCall.function.arguments));
        return result;
    }

    return {
        map,
        tools,
        toolCall,
    };
}

class InvalidBlobMimeTypeError extends Error {
    constructor(expected: string, actual: string) {
        super(`Tool call failed. The tool expected url with mime type ${expected}, but got ${actual}`);
    }
}

export function findChatBlob(token: string, history: CallToolResult[], requiredMimeType?: string) {
    // find the tool call that has a meta with the chat url
    let mutableValue: any;

    for (const message of history) {
        const meta = (message._meta?.['chat.scrypted.app/'] as any);
        if (!meta)
            continue;

        // Check images
        const images = meta.images;
        if (images) {
            for (const image of images) {
                if (image.token === token) {
                    mutableValue = image.src;
                    continue;
                }
            }
        }

        // Check audio
        const audio = meta.audio;
        if (audio) {
            for (const audioFile of audio) {
                if (audioFile.token === token) {
                    mutableValue = audioFile.src;
                    continue;
                }
            }
        }

        const resources = meta.resources;
        if (resources) {
            for (const resource of resources) {
                if (resource.token === token) {
                    const text = resource.text;
                    if (requiredMimeType && resource.mimeType !== requiredMimeType) {
                        throw new InvalidBlobMimeTypeError(requiredMimeType, resource.mimeType);
                    }
                    if (resource.mimeType === 'application/json') {
                        try {
                            mutableValue = JSON.parse(text);
                            continue;
                        }
                        catch (e) {
                        }
                    }
                    mutableValue = text;
                    continue;
                }
            }
        }
    }

    return mutableValue;
}

export async function handleToolCalls(tools: Awaited<ReturnType<typeof prepareTools>>, message: ParsedChatCompletionMessage<null>, toolHistory: CallToolResult[], assistantUsesFunctionCalls: boolean, capabilities?: ChatCompletionCapabilities, callingTool?: (tc: ParsedFunctionToolCall) => void) {
    if (!message.tool_calls)
        throw new Error('Message does not contain tool calls.');

    type ToolCallData = {
        toolCall: ParsedFunctionToolCall;
        callToolResult: CallToolResult;
        messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
    };
    const allMessages: ToolCallData[] = [];

    for (const _tc of message.tool_calls) {
        let tc = JSON.parse(JSON.stringify(_tc)) as ParsedFunctionToolCall;

        const tool = tools.tools.find(t => t.type === 'function' && t.function.name === tc.function.name) as ChatCompletionFunctionTool;
        const chatUrls = new Map<string, string>();

        try {
            if (tool && tc.function.arguments && tool.function.parameters) {
                const parsed = partialParse(tc.function.arguments);
                for (const [param, paramType] of Object.entries(tool.function.parameters.properties as any)) {
                    const value = parsed[param];
                    if (typeof value !== 'string')
                        continue;
                    const schemaValue = paramType as any;
                    if (schemaValue.type === 'string' && schemaValue.format === 'uri') {
                        if (value.startsWith('chat://')) {
                            const src = findChatBlob(new URL(value).host, toolHistory, schemaValue.mimeType);
                            if (src) {
                                chatUrls.set(param, value.substring(7));
                                parsed[param] = src;
                                tc.function.arguments = JSON.stringify(parsed);
                            }
                        }
                    }
                }
            }
        }
        catch (e) {
        }

        callingTool?.(tc);
        const response = await tools.toolCall(tc);

        const messages: ToolCallData = {
            toolCall: tc,
            messages: [],
            callToolResult: response,
        };
        allMessages.push(messages);

        // tool calls cant return images, so fake it out by having the tool respond
        // that the next user message will include the image and the assistant respond ok.

        const messageStrings: string[] = [];
        const responseMessage: OpenAI.Chat.Completions.ChatCompletionToolMessageParam = {
            role: 'tool',
            tool_call_id: tc.id,
            content: '',
        };

        messages.messages.push(responseMessage);

        for (const content of response.content) {
            if (content.type === 'image') {
                const url = `data:${content.mimeType};base64,${content.data}`;
                if (capabilities?.image) {
                    messageStrings.push('The next user message will include the image.');
                    messages.messages.push({
                        role: 'assistant',
                        content: 'Ok.',
                    });

                    // create a base 64 data url
                    const image: ChatCompletionContentPartImage = {
                        type: 'image_url',
                        image_url: {
                            url,
                        },
                    };
                    messages.messages.push({
                        role: 'user',
                        content: [
                            {
                                type: 'text',
                                text: `Image file from tool call id ${tc.id}:`,
                            },
                            image,
                        ],
                    });
                }
                else {
                    const token = (generate({ exactly: 4, maxLength: 5 }) as string[]).join('-');
                    messageStrings.push(`The image was presented to the user. The image can be used in other tools using the following URL: \`chat://${token}\`.`);
                    messages.callToolResult._meta ||= {};
                    const meta: any = messages.callToolResult._meta['chat.scrypted.app/'] ||= {};
                    meta.images ||= [];
                    meta.images.push({
                        token,
                        src: url,
                        width: '100%',
                        height: 'auto',
                    });
                }
            }
            else if (content.type === 'audio') {
                const url = `data:${content.mimeType};base64,${content.data}`;
                if (capabilities?.audio) {
                    messageStrings.push('The next user message will include the audio.');
                    messages.messages.push({
                        role: 'assistant',
                        content: 'Ok.',
                    });

                    // Note: OpenAI doesn't have ChatCompletionContentPartAudio type yet,
                    // so we'll handle this similarly to when audio capability is not available
                    const token = (generate({ exactly: 4, maxLength: 5 }) as string[]).join('-');
                    messages.messages.push({
                        role: 'user',
                        content: `Audio file is available at: \`chat://${token}\``,
                    });

                    messages.callToolResult._meta ||= {};
                    const meta: any = messages.callToolResult._meta['chat.scrypted.app/'] ||= {};
                    meta.audio ||= [];
                    meta.audio.push({
                        token,
                        src: url,
                    });
                }
                else {
                    const token = (generate({ exactly: 4, maxLength: 5 }) as string[]).join('-');
                    messageStrings.push(`The audio was presented to the user. The audio can be used in other tools using the following URL: \`chat://${token}\`.`);
                    messages.callToolResult._meta ||= {};
                    const meta: any = messages.callToolResult._meta['chat.scrypted.app/'] ||= {};
                    meta.audio ||= [];
                    meta.audio.push({
                        token,
                        src: url,
                    });
                }
            }
            else if (content.type === 'text') {
                messageStrings.push(content.text);
            }
            else if (content.type === 'resource') {
                let token: string | undefined;
                const mutable = (content._meta?.['chat.scrypted.app/'] as any)?.mutable;
                if (mutable && tool.function.parameters) {
                    const property = Object.entries(tool.function.parameters.properties as any).find(([k, v]) => k === mutable);
                    if (property) {
                        token = chatUrls.get(property[0]);
                    }
                }
                token ||= (generate({ exactly: 4, maxLength: 5 }) as string[]).join('-');
                messageStrings.push(`The tool resource was returned. You MUST use the readChatUrl(url: string) function within the evaluate-js tool to query this data using the following URL: \`chat://${token}\`.`);
                messages.callToolResult._meta ||= {};
                const meta: any = messages.callToolResult._meta['chat.scrypted.app/'] ||= {};
                meta.resources ||= [];
                meta.resources.push({
                    token,
                    text: (content.resource as TextResourceContents).text,
                    mimeType: (content.resource as TextResourceContents).mimeType,
                });
            }
            else {
                throw new Error(`Unsupported content type ${content.type} in tool call response.`);
            }
        }

        responseMessage.content = messageStrings.join('\n');

        if (assistantUsesFunctionCalls) {
            message.function_call = {
                name: tc.function.name,
                arguments: tc.function.arguments!,
            }
        }
    }

    if (assistantUsesFunctionCalls) {
        delete message.tool_calls;
    }

    message.function_call = null;

    return allMessages;
}

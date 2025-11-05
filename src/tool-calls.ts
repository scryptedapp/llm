import type { CallToolResult, ChatCompletionCapabilities, LLMTools } from "@scrypted/types";
import type { OpenAI } from 'openai';
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
    // Used to deduplciate tools that are provided by multiple LLMTools implementations like get-time.
    const toolMap: Record<string, ChatCompletionTool> = {};
    for (const entry of toolTuples) {
        map[entry.tool.function.name] = entry.llmTools;
        toolMap[entry.tool.function.name] = entry.tool;
    }

    const tools = Object.values(toolMap);

    const toolCall = async (toolCall: OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall) => {
        const tool = map[toolCall.function.name];
        if (!tool)
            throw new Error(`Tool ${toolCall} not found.`);
        // intercept time tool calls to provide a user locale time.
        if (toolCall.function.name === TimeToolFunctionName)
            return callGetTimeTool();
        const result = await tool.callLLMTool(toolCall.function.name, JSON.parse(toolCall.function.arguments));
        return result;
    }

    return {
        tools,
        toolCall,
    };
}

function findChatBlob(token: string, history: CallToolResult[]) {
    // find the tool call that has a meta with the chat url
    for (const message of history) {
        const images = (message._meta?.['chat.scrypted.app/'] as any)?.images;
        if (!images)
            continue;
        for (const image of images) {
            if (image.token === token) {
                return image.src;
            }
        }
    }
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
        try {
            if (tool && tc.function.arguments && tool.function.parameters) {
                const parsed = JSON.parse(tc.function.arguments);
                for (const [param, paramType] of Object.entries(tool.function.parameters.properties as any)) {
                    const value = parsed[param];
                    if (typeof value !== 'string')
                        continue;
                    const schemaValue = paramType as any;
                    if (schemaValue.type === 'string' && schemaValue.format === 'uri') {
                        if (value.startsWith('chat://')) {
                            const src = findChatBlob(new URL(value).host, toolHistory);
                            if (src) {
                               parsed[param] = src;
                               tc.function.arguments = JSON.stringify(parsed);
                            }
                        }
                    }
                }
            }
        }
        catch (e){ 
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

        for (const content of response.content) {
            if (content.type === 'image') {
                const url = `data:${content.mimeType};base64,${content.data}`;
                if (capabilities?.image) {
                    messages.messages.push({
                        role: 'tool',
                        tool_call_id: tc.id,
                        content: 'The next user message will include the image.',
                    });
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
                            image,
                        ],
                    });
                }
                else {
                    const token = (generate({ exactly: 4, maxLength: 5 }) as string[]).join('-');
                    messages.messages.push({
                        role: 'tool',
                        tool_call_id: tc.id,
                        content: `The image was presented to the user. The image can be used in other tools using the following URL: \`chat://${token}\`.`,
                    });
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
            else if (content.type === 'text') {
                messages.messages.push({
                    role: 'tool',
                    tool_call_id: tc.id,
                    content: content.text,
                });
            }
            else {
                throw new Error(`Unsupported content type ${content.type} in tool call response.`);
            }
        }

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

import type { CallToolResult, LLMTools } from "@scrypted/types";
import type { OpenAI } from 'openai';
import type { ChatCompletionTool, ChatCompletionContentPartImage } from 'openai/resources';
import type { ParsedChatCompletionMessage, ParsedFunctionToolCall } from "openai/resources/chat/completions";
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

    const toolCall = async (toolCall: OpenAI.Chat.Completions.ChatCompletionMessageToolCall) => {
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

export async function handleToolCalls(tools: Awaited<ReturnType<typeof prepareTools>>, message: ParsedChatCompletionMessage<null>, assistantUsesFunctionCalls: boolean, callingTool?: (tc: ParsedFunctionToolCall) => void) {
    if (!message.tool_calls)
        throw new Error('Message does not contain tool calls.');

    type ToolCallData = {
        toolCall: ParsedFunctionToolCall;
        callToolResult: CallToolResult;
        messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
    };
    const allMessages: ToolCallData[] = [];

    for (const tc of message.tool_calls) {
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
                const url = `data:${content.mimeType};base64,${content.data}`;
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

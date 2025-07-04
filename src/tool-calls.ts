import { ScryptedInterface, type LLMTools, type ScryptedStatic } from "@scrypted/types";
import type { OpenAI } from 'openai';
import type { ChatCompletionContentPartImage } from 'openai/resources';
import type { ParsedChatCompletionMessage, ParsedFunctionToolCall } from "openai/resources/chat/completions";

export async function prepareTools(sdk: ScryptedStatic, toolIds: string[]) {
    const toolsPromises = toolIds.map(async tool => {
        const llmTools = sdk.systemManager.getDeviceById<LLMTools>(tool);
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
    const map: Record<string, string> = {};
    for (const entry of toolTuples) {
        map[entry.tool.function.name] = entry.llmTools.id;
    }

    const tools = toolTuples.map(t => t.tool);

    const toolCall = async (toolCall: OpenAI.Chat.Completions.ChatCompletionMessageToolCall) => {
        const toolId = map[toolCall.function.name];
        if (!toolId)
            throw new Error(`Tool ${toolCall} not found.`);

        const tool = sdk.systemManager.getDeviceById<LLMTools>(toolId);
        if (!tool)
            throw new Error(`Tool ${toolCall} not found.`);
        if (!tool.interfaces.includes(ScryptedInterface.LLMTools))
            throw new Error(`Tool ${toolCall} does not implement LLMTools interface.`);
        const result = await tool.callLLMTool(toolCall.function.name, JSON.parse(toolCall.function.arguments || '{}'));
        return result;
    }


    return {
        map,
        tools,
        toolCall,
    };
}

export async function handleToolCalls(tools: Awaited<ReturnType<typeof prepareTools>>, message: ParsedChatCompletionMessage<null>, assistantUsesFunctionCalls: boolean, callingTool?: (tc: ParsedFunctionToolCall) => void) {
    if (!message.tool_calls)
        throw new Error('Message does not contain tool calls.');

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

    for (const tc of message.tool_calls) {
        callingTool?.(tc);
        const response = await tools.toolCall(tc);
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

    return messages;
}

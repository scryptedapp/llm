import type { CallToolResult, ChatCompletionFunctionTool, LLMTools } from '@scrypted/types';
import { createToolTextResult, createUnknownToolError } from './tools-common';

export const EvaluateJsToolFunctionName = 'evaluate_js';

// Evaluates JavaScript code in a restricted browser context
async function evaluateJs(code: string, findChatBlob: (token: string) => any): Promise<CallToolResult> {
    try {
        // next line marks it as in use.
        function readChatUrl(url: string) {
            const token = url.replace('chat://', '');
            return findChatBlob(token);
        }
        readChatUrl;

        const result = await eval(code);
        if (typeof result === 'string') {
            return createToolTextResult(result);
        }
        let text = JSON.stringify(result, null, 2);
        if (text.length > 10000) {
            text = 'The evaluate_js result was too large to return in full and has been truncated significantly. Modify your script to return less data. If the script returned the result of readChatUrl directly, assign it to a variable, process it within the script, and return only the relevant data. Truncated output:\n\n' + text.substring(0, 500) + '\n\n...[truncated]';
        }
        const ret: CallToolResult = {
            content: [
                {
                    type: 'text',
                    text,
                },
            ],
            structuredContent: {
                result,
            }
        }
        return ret;
    } catch (e: any) {
        return createToolTextResult(`Error evaluating code: ${e.message}`);
    }
}

export function getEvaluateJsToolFunction(): ChatCompletionFunctionTool {
    return {
        type: 'function',
        function: {
            name: EvaluateJsToolFunctionName,
            description: 'Evaluates JavaScript in the browser using the standard eval function. This tool MUST be used for calculations and checking the current time. You can also use it to determine the user locale. The readChatUrl(url: string) function is available within the script to retrieve data referenced by chat:// urls. The readChatUrl return value MUST be assigned to a variable and processed within the script to extract only the relevant data, e.g. `const data = readChatUrl(url); return data.someProperty;`. The readChatUrl return value MUST NOT be returned directly as the script result.',
            parameters: {
                type: 'object',
                properties: {
                    code: {
                        type: 'string',
                        description: 'The JavaScript code to evaluate. It MUST be wrapped in an IIFE block and MUST be multiple lines and properly indented so it is human readable.',
                    },
                },
                required: ['code'],
                additionalProperties: false,
            },
        },
    };
}

export class JavascriptTools implements LLMTools {
    constructor(public readChatBlob: (token: string) => any) {
    }

    async getLLMTools(): Promise<ChatCompletionFunctionTool[]> {
        return [getEvaluateJsToolFunction()];
    }

    async callLLMTool(toolCallId: string, name: string, parameters: Record<string, any>) {
        if (name === EvaluateJsToolFunctionName) {
            const { code } = parameters;
            return await evaluateJs(code, this.readChatBlob);
        }
        throw createUnknownToolError(name);
    }
}

import type { CallToolResult, LLMTools, ChatCompletionTool } from '@scrypted/types';
import { createToolTextResult, createUnknownToolError } from './tools-common';

export const EvaluateJsToolFunctionName = 'evaluate-js';

// Evaluates JavaScript code in a restricted browser context
export function evaluateJs(code: string): CallToolResult {
    try {
        const result = eval(code);
        if (typeof result === 'string') {
            return createToolTextResult(result);
        }
        const ret: CallToolResult = {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify(result, null, 2),
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

export function getEvaluateJsToolFunction(): ChatCompletionTool {
    return {
        type: 'function',
        function: {
            name: EvaluateJsToolFunctionName,
            description: 'Evaluates JavaScript in the browser using the standard eval function. This tool MUST be used for calculations and checking the current time. You can also use it to determine the user locale.',
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
    async getLLMTools(): Promise<ChatCompletionTool[]> {
        return [getEvaluateJsToolFunction()];
    }

    async callLLMTool(name: string, parameters: Record<string, any>) {
        if (name === EvaluateJsToolFunctionName) {
            const { code } = parameters;
            return evaluateJs(code);
        }
        throw createUnknownToolError(name);
    }
}

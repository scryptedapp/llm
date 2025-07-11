import type { LLMTools, ChatCompletionTool } from '@scrypted/types';

export const EvaluateJsToolFunctionName = 'evaluate-js';

// Evaluates JavaScript code in a restricted browser context
export function evaluateJs(code: string): string {
    try {
        const result = eval(code);
        return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    } catch (e: any) {
        return `Error: ${e.message}`;
    }
}

export function getEvaluateJsToolFunction(): ChatCompletionTool {
    return {
        type: 'function',
        function: {
            name: EvaluateJsToolFunctionName,
            description: 'Evaluates JavaScript in the browser using the standard eval function. This tool MUST be used for calculations.',
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

    async callLLMTool(name: string, parameters: Record<string, any>): Promise<string> {
        if (name === EvaluateJsToolFunctionName) {
            const { code } = parameters;
            return evaluateJs(code) || '';
        }
        throw new Error(`Unknown tool: ${name}`);
    }
}

import type { ChatCompletionTool } from '@scrypted/types';

export const TimeToolFunctionName = 'get-time';

export function callGetTimeTool() {
    return new Date().toLocaleString() + ' ' + Intl.DateTimeFormat().resolvedOptions().timeZone;
}
export function getTimeToolFunction(): ChatCompletionTool {
    return {
        type: 'function',
        function: {
            name: TimeToolFunctionName,
            description: `Gets the current time.\nToday's date is: ${new Date().toLocaleDateString()}.\nTime Zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
            parameters: {
                "type": "object",
                "properties": {},
                "required": [],
                "additionalProperties": false
            },
        },
    };
}

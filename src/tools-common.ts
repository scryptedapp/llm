import { CallToolResult } from "@scrypted/sdk";

export function createUnknownToolError(name: string): CallToolResult {
    return {
        content: [
            {
                type: 'text',
                text: 'Unknown tool: ' + name,
            }
        ],
        isError: true,
    };
}

export function createToolTextResult(text: string): CallToolResult {
    return {
        content: [
            {
                type: 'text',
                text,
            }
        ],
    };
}

export function createToolTextImageResult(base64Data: string, mimeType = 'image/jpeg'): CallToolResult {
    return {
        content: [
            {
                type: 'image',
                data: base64Data,
                mimeType,
            },
        ],
    };
}
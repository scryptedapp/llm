import { LLMToolDefinition, LLMTools, ScryptedDeviceBase } from "@scrypted/sdk";

export class CameraTools extends ScryptedDeviceBase implements LLMTools {
    async getLLMTools(): Promise<LLMToolDefinition[]> {
        return [
            {
                name: 'list-cameras',
                description: 'List the cameras available to view.',
            },
            {
                name: 'take-picture',
                description: 'Takes a picture on a given camera and provides the response as base64 encoded jpeg.'
            },
        ];
    }

    async callLLMTool(name: string, parameters: Record<string, any>): Promise<string> {
        return 'hello';
    }
}

import type { ChatCompletionTool, LLMTools, } from "@scrypted/sdk";
import sdk, { Camera, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface } from '@scrypted/sdk';

export class CameraTools extends ScryptedDeviceBase implements LLMTools {
    async getLLMTools(): Promise<ChatCompletionTool[]> {
        return [
            {
                type: 'function',
                function: {
                    name: 'list-cameras',
                    description: 'List the cameras available to view.',
                },
            },
            {
                type: 'function',
                function: {
                    name: 'take-picture',
                    description: 'Get an image from the requested camera to present it to a user answer or use it to answer a user query. The picture will be returned as a base64 encoded JPEG image.',
                    parameters: {
                        "type": "object",
                        "properties": {
                            "camera": {
                                "type": "string",
                                "description": "The name of the camera to take a picture from. Use the list-cameras tool to get a list of available cameras.",
                            },
                        },
                        "required": [
                            "camera",
                        ],
                        "additionalProperties": false
                    },
                },
            },
        ];
    }

    listCameras() {
        const ids = Object.keys(sdk.systemManager.getSystemState());
        const cameraIds = ids.filter(id => {
            const device = sdk.systemManager.getDeviceById(id);
            return device.interfaces.includes(ScryptedInterface.Camera) && (device.type === ScryptedDeviceType.Camera || device.type === ScryptedDeviceType.Doorbell);
        });
        return cameraIds.map(id => sdk.systemManager.getDeviceById(id).name).join('\n');
    }

    async callLLMTool(name: string, parameters: Record<string, any>): Promise<string> {
        if (name === 'list-cameras') {
            return this.listCameras();
        }

        if (name === 'take-picture') {
            const cameraName = parameters.camera;
            if (!cameraName)
                return `"camera" parameter is required for take-picture tool. Valid camera names are: ${this.listCameras()}`;
            const camera = sdk.systemManager.getDeviceByName<Camera>(cameraName);
            if (!camera || !camera.interfaces.includes(ScryptedInterface.Camera))
                return `${cameraName} is not a valid camera. Valid camera names are: ${this.listCameras()}`;
            const picture = await camera.takePicture();
            const buffer = await sdk.mediaManager.convertMediaObjectToBuffer(picture, 'image/jpeg');
            return 'data:image/jpeg;base64,' + buffer.toString('base64');
        }
        return 'Unknown tool: ' + name;
    }
}

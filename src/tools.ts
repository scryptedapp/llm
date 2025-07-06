import type { Brightness, ChatCompletionTool, LLMTools, OnOff, } from "@scrypted/sdk";
import sdk, { Camera, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface } from '@scrypted/sdk';

export class CameraTools extends ScryptedDeviceBase implements LLMTools {
    async getLLMTools(): Promise<ChatCompletionTool[]> {
        const listCameras = this.listCameras();
        return [
            {
                type: 'function',
                function: {
                    name: 'take-picture',
                    description: `Get an image from the requested camera to present it to a user answer or use it to answer a user query. The picture will be returned as a base64 encoded JPEG image. The camera list is:\n${listCameras}`,
                    parameters: {
                        "type": "object",
                        "properties": {
                            "camera": {
                                "type": "string",
                                "description": "The name of the camera to take a picture from.",
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

export class LightTools extends ScryptedDeviceBase implements LLMTools {
    async getLLMTools(): Promise<ChatCompletionTool[]> {
        const listLights = this.listLights();
        const listFans = this.listFans();
        return [

            {
                type: 'function',
                function: {
                    name: 'turn-light-on',
                    description: `Turn on the requested light. The light list is:\n${listLights}`,
                    parameters: {
                        "type": "object",
                        "properties": {
                            "light": {
                                "type": "string",
                                "description": "The name of the light to turn on.",
                            },
                        },
                        "required": [
                            "light",
                        ],
                        "additionalProperties": false
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name: 'turn-light-off',
                    description: 'Turn off the requested light.',
                    parameters: {
                        "type": "object",
                        "properties": {
                            "light": {
                                "type": "string",
                                "description": "The name of the light to turn off.",
                            },
                        },
                        "required": [
                            "light",
                        ],
                        "additionalProperties": false
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name: 'set-light-brightness',
                    description: 'Set the brightness of the requested light.',
                    parameters: {
                        "type": "object",
                        "properties": {
                            "light": {
                                "type": "string",
                                "description": "The name of the light to set the brightness for.",
                            },
                            "brightness": {
                                "type": "number",
                                "description": "The brightness level to set (0-100).",
                            },
                        },
                        "required": [
                            "light",
                            "brightness",
                        ],
                        "additionalProperties": false
                    },
                },
            },

            {
                type: 'function',
                function: {
                    name: 'turn-fan-on',
                    description: `Turn on the requested fan. The fan list is:\n${listFans}`,
                    parameters: {
                        "type": "object",
                        "properties": {
                            "fan": {
                                "type": "string",
                                "description": "The name of the fan to turn on.",
                            },
                        },
                        "required": [
                            "fan",
                        ],
                        "additionalProperties": false
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name: 'turn-fan-off',
                    description: 'Turn off the requested fan.',
                    parameters: {
                        "type": "object",
                        "properties": {
                            "fan": {
                                "type": "string",
                                "description": "The name of the fan to turn off.",
                            },
                        },
                        "required": [
                            "fan",
                        ],
                        "additionalProperties": false
                    },
                },
            },
        ];
    }

    listLights() {
        const ids = Object.keys(sdk.systemManager.getSystemState());
        const lightIds = ids.filter(id => {
            const device = sdk.systemManager.getDeviceById(id);
            return device.interfaces.includes(ScryptedInterface.OnOff) && (device.type === ScryptedDeviceType.Light || device.type === ScryptedDeviceType.Switch);
        });
        return lightIds.map(id => {
            const device = sdk.systemManager.getDeviceById(id);
            if (!device.interfaces.includes(ScryptedInterface.Brightness))
                return sdk.systemManager.getDeviceById(id).name
            return `${sdk.systemManager.getDeviceById(id).name}\n  - brightness control available`;
        }).join('\n');
    }

    async callLLMTool(name: string, parameters: Record<string, any>): Promise<string> {
        if (name === 'turn-light-on' || name === 'turn-light-off') {
            const lightName = parameters.light;
            if (!lightName)
                return `"light" parameter is required for ${name} tool. Valid light names are: ${this.listLights()}`;
            const light = sdk.systemManager.getDeviceByName<OnOff>(lightName);
            if (!light)
                return `${lightName} is not a valid light. Valid light names are: ${this.listLights()}`;
            if (!light.interfaces.includes(ScryptedInterface.OnOff))
                return `${lightName} does not support on/off control.`;
            if (name === 'turn-light-on') {
                await light.turnOn();
                return `${lightName} turned on.`;
            }
            else if (name === 'turn-light-off') {
                await light.turnOff();
                return `${lightName} turned off.`;
            }
        }
        else if (name === 'turn-fan-on' || name === 'turn-fan-off') {
            const fanName = parameters.fan;
            if (!fanName)
                return `"fan" parameter is required for ${name} tool. Valid fan names are: ${this.listFans()}`;
            const fan = sdk.systemManager.getDeviceByName<OnOff>(fanName);
            if (!fan)
                return `${fanName} is not a valid fan. Valid fan names are: ${this.listFans()}`;
            if (!fan.interfaces.includes(ScryptedInterface.OnOff))
                return `${fanName} does not support on/off control.`;
            if (name === 'turn-fan-on') {
                await fan.turnOn();
                return `${fanName} turned on.`;
            }
            else if (name === 'turn-fan-off') {
                await fan.turnOff();
                return `${fanName} turned off.`;
            }
        }
        else if (name === 'set-light-brightness') {
            const lightName = parameters.light;
            const brightness = parameters.brightness;
            if (!lightName || brightness === undefined)
                return `"light" and "brightness" parameters are required for ${name} tool. Valid light names are: ${this.listLights()}`;
            const light = sdk.systemManager.getDeviceByName<Brightness>(lightName);
            if (!light)
                return `${lightName} is not a valid light. Valid light names are: ${this.listLights()}`;
            if (!light.interfaces.includes(ScryptedInterface.Brightness))
                return `${lightName} does not support brightness control.`;
            await light.setBrightness(brightness);
            return `${lightName} brightness set to ${brightness}.`;
        }
        return 'Unknown tool: ' + name;
    }


    listFans() {
        const ids = Object.keys(sdk.systemManager.getSystemState());
        const fanIds = ids.filter(id => {
            const device = sdk.systemManager.getDeviceById(id);
            return device.interfaces.includes(ScryptedInterface.OnOff) && device.type === ScryptedDeviceType.Fan;
        });
        return fanIds.map(id => sdk.systemManager.getDeviceById(id).name).join('\n');
    }

}
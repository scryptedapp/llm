import type { Brightness, Camera, ChatCompletionTool, LLMTools, Notifier, OnOff, ScryptedStatic } from "@scrypted/sdk";
import { ScryptedDeviceType, ScryptedInterface } from '@scrypted/types';
import { callGetTimeTool, getTimeToolFunction, TimeToolFunctionName } from "./time-tool";
import { createToolTextImageResult, createToolTextResult, createUnknownToolError } from "./tools-common";

export class ScryptedTools implements LLMTools {
    constructor(public sdk: ScryptedStatic) {
    }

    async getLLMTools(): Promise<ChatCompletionTool[]> {
        const listCameras = this.listCameras();
        const listLights = this.listLights();
        const listFans = this.listFans();
        const listNotifiers = this.listNotifiers();

        const cams: ChatCompletionTool[] = [];
        if (listCameras.length) {
            cams.push({
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
            });
        }

        const lights: ChatCompletionTool[] = [];
        if (listLights.length) {
            lights.push(
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

            );
        }

        const fans: ChatCompletionTool[] = [];
        if (listFans.length) {
            fans.push(
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
            );
        }

        const notifiers: ChatCompletionTool[] = [];
        if (listNotifiers.length) {
            notifiers.push(
                {
                    type: 'function',
                    function: {
                        name: 'list-notifiers',
                        description: 'List available notifiers. Notifiers can be used to send notifications to users.',
                        parameters: {
                            "type": "object",
                            "properties": {},
                            "required": [],
                            "additionalProperties": false
                        },
                    },
                },
                {
                    type: 'function',
                    function: {
                        name: 'send-notification',
                        description: `Send a notification using the requested notifier. If the user does not specify which device should receive a notification, send it to their iPhone or Android. If there is any ambiguity you MUST ask the user where to send it.`,
                        parameters: {
                            "type": "object",
                            "properties": {
                                "notifier": {
                                    "type": "string",
                                    "description": "The id of the notifier to send a notification with.",
                                },
                                "message": {
                                    "type": "string",
                                    "description": "The message to send in the notification.",
                                },
                            },
                            "required": [
                                "notifier",
                                "message",
                            ],
                            "additionalProperties": false
                        },
                    },
                });
        }

        return [...cams, ...lights, ...fans, ...notifiers, getTimeToolFunction()];
    }

    listLights() {
        const { sdk } = this;
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

    listFans() {
        const { sdk } = this;
        const ids = Object.keys(sdk.systemManager.getSystemState());
        const fanIds = ids.filter(id => {
            const device = sdk.systemManager.getDeviceById(id);
            return device.interfaces.includes(ScryptedInterface.OnOff) && device.type === ScryptedDeviceType.Fan;
        });
        return fanIds.map(id => sdk.systemManager.getDeviceById(id).name).join('\n');
    }

    listCameras() {
        const { sdk } = this;
        const ids = Object.keys(sdk.systemManager.getSystemState());
        const cameraIds = ids.filter(id => {
            const device = sdk.systemManager.getDeviceById(id);
            return device.interfaces.includes(ScryptedInterface.Camera) && (device.type === ScryptedDeviceType.Camera || device.type === ScryptedDeviceType.Doorbell);
        });
        return cameraIds.map(id => sdk.systemManager.getDeviceById(id).name).join('\n');
    }

    listNotifiers() {
        const { sdk } = this;
        const ids = Object.keys(sdk.systemManager.getSystemState());
        const notifierIds = ids.filter(id => {
            const device = sdk.systemManager.getDeviceById(id);
            return device.interfaces.includes(ScryptedInterface.Notifier);
        });
        return notifierIds.map(id => {
            const d = sdk.systemManager.getDeviceById(id);
            return d.id + '\n' + '  - ' + d.name;
        }).join('\n');
    }

    async callLLMTool(name: string, parameters: Record<string, any>) {
        const { sdk } = this;

        if (name === 'take-picture') {
            const cameraName = parameters.camera;
            if (!cameraName)
                return createToolTextResult(`"camera" parameter is required for take-picture tool. Valid camera names are: ${this.listCameras()}`);
            const camera = sdk.systemManager.getDeviceByName<Camera>(cameraName);
            if (!camera || !camera.interfaces.includes(ScryptedInterface.Camera))
                return createToolTextResult(`${cameraName} is not a valid camera. Valid camera names are: ${this.listCameras()}`);
            const picture = await camera.takePicture();
            const buffer = await sdk.mediaManager.convertMediaObjectToBuffer(picture, 'image/jpeg');
            return createToolTextImageResult(buffer.toString('base64'));
        }
        else if (name === 'turn-light-on' || name === 'turn-light-off') {
            const lightName = parameters.light;
            if (!lightName)
                return createToolTextResult(`"light" parameter is required for ${name} tool. Valid light names are: ${this.listLights()}`);
            const light = sdk.systemManager.getDeviceByName<OnOff>(lightName);
            if (!light)
                return createToolTextResult(`${lightName} is not a valid light. Valid light names are: ${this.listLights()}`);
            if (!light.interfaces.includes(ScryptedInterface.OnOff))
                return createToolTextResult(`${lightName} does not support on/off control.`);
            if (name === 'turn-light-on') {
                await light.turnOn();
                return createToolTextResult(`${lightName} turned on.`);
            }
            else if (name === 'turn-light-off') {
                await light.turnOff();
                return createToolTextResult(`${lightName} turned off.`);
            }
        }
        else if (name === 'turn-fan-on' || name === 'turn-fan-off') {
            const fanName = parameters.fan;
            if (!fanName)
                return createToolTextResult(`"fan" parameter is required for ${name} tool. Valid fan names are: ${this.listFans()}`);
            const fan = sdk.systemManager.getDeviceByName<OnOff>(fanName);
            if (!fan)
                return createToolTextResult(`${fanName} is not a valid fan. Valid fan names are: ${this.listFans()}`);
            if (!fan.interfaces.includes(ScryptedInterface.OnOff))
                return createToolTextResult(`${fanName} does not support on/off control.`);
            if (name === 'turn-fan-on') {
                await fan.turnOn();
                return createToolTextResult(`${fanName} turned on.`);
            }
            else if (name === 'turn-fan-off') {
                await fan.turnOff();
                return createToolTextResult(`${fanName} turned off.`);
            }
        }
        else if (name === 'set-light-brightness') {
            const lightName = parameters.light;
            const brightness = parameters.brightness;
            if (!lightName || brightness === undefined)
                return createToolTextResult(`"light" and "brightness" parameters are required for ${name} tool. Valid light names are: ${this.listLights()}`);
            const light = sdk.systemManager.getDeviceByName<Brightness>(lightName);
            if (!light)
                return createToolTextResult(`${lightName} is not a valid light. Valid light names are: ${this.listLights()}`);
            if (!light.interfaces.includes(ScryptedInterface.Brightness))
                return createToolTextResult(`${lightName} does not support brightness control.`);
            await light.setBrightness(brightness);
            return createToolTextResult(`${lightName} brightness set to ${brightness}.`);
        }
        else if (name === 'list-notifiers') {
            return createToolTextResult(`The ids of the available notifiers and their friendly names:\n${this.listNotifiers()}`);
        }
        else if (name === 'send-notification') {
            const notifierName = parameters.notifier;
            const message = parameters.message;
            if (!notifierName || !message)
                return createToolTextResult(`"notifier" and "message" parameters are required for send-notification tool. Valid notifier names and their ids are: ${this.listNotifiers()}`);
            const popId = notifierName.split('-').pop();
            const notifier = sdk.systemManager.getDeviceById<Notifier>(notifierName) || sdk.systemManager.getDeviceByName<Notifier>(notifierName) || sdk.systemManager.getDeviceById<Notifier>(popId);
            if (!notifier)
                return createToolTextResult(`${notifierName} is not a valid notifier. Valid notifiers are: ${this.listNotifiers()}`);
            if (!notifier.interfaces.includes(ScryptedInterface.Notifier))
                return createToolTextResult(`${notifierName} is not a valid notifier. Valid notifiers are: ${this.listNotifiers()}`);
            await notifier.sendNotification(message);
            return createToolTextResult(`Notification sent to ${notifier.id}: ${notifier.name}.`);
        }
        else if (name === TimeToolFunctionName) {
            return callGetTimeTool();
        }
        return createUnknownToolError(name);
    }
}

import type { Brightness, Camera, ChatCompletionFunctionTool, LLMTools, Notifier, ObjectDetection, OnOff, ScryptedStatic } from "@scrypted/sdk";
import { ScryptedDeviceType, ScryptedInterface } from '@scrypted/types';
import { callGetTimeTool, getTimeToolFunction, TimeToolFunctionName } from "./time-tool";
import { createToolTextImageResult, createToolTextResult, createUnknownToolError } from "./tools-common";

export class ScryptedTools implements LLMTools {
    objectDetector: ObjectDetection;

    constructor(public sdk: ScryptedStatic) {
        // Find object detector using || approach
        this.objectDetector =
            sdk.systemManager.getDeviceById<ObjectDetection>('@scrypted/nvr', 'detection') ||
            sdk.systemManager.getDeviceById<ObjectDetection>('@scrypted/coreml') ||
            sdk.systemManager.getDeviceById<ObjectDetection>('@scrypted/openvino') ||
            sdk.systemManager.getDeviceById<ObjectDetection>('@scrypted/onnx') ||
            sdk.systemManager.getDeviceById<ObjectDetection>('@scrypted/tensorflow-lite');
    }

    /**
     * Creates an annotated image with bounding boxes drawn around detected objects
     * @param imageBuffer The original image buffer
     * @param detections Array of detected objects with bounding box information
     * @returns Base64 encoded JPEG image with bounding boxes
     */
    private async createAnnotatedImage(imageBuffer: Buffer, detections: any[]): Promise<string> {
        // Create an image blob from the buffer
        const blob = new Blob([imageBuffer as any], { type: 'image/jpeg' });
        const imageUrl = URL.createObjectURL(blob);

        // Create an image element to load the image
        const img = new Image();
        img.src = imageUrl;

        // Wait for the image to load
        await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = reject;
        });

        // Create an OffscreenCanvas with the same dimensions as the image
        const canvas = new OffscreenCanvas(img.width, img.height);
        const ctx = canvas.getContext('2d')!;

        // Draw the original image on the canvas
        ctx.drawImage(img, 0, 0);

        // Set up styling for bounding boxes
        ctx.strokeStyle = '#00FF00'; // Green color for bounding boxes
        ctx.lineWidth = 2;
        ctx.fillStyle = '#00FF00'; // Green color for text
        ctx.font = '16px Arial';

        // Draw bounding boxes for each detection
        for (const detection of detections) {
            // Extract bounding box coordinates from ObjectDetectionResult
            // Format: [x, y, width, height] where values are normalized (0-1)
            let x, y, width, height;

            if (detection.boundingBox) {
                // Format from SDK: [x, y, width, height] (in pixels)
                x = detection.boundingBox[0];
                y = detection.boundingBox[1];
                width = detection.boundingBox[2];
                height = detection.boundingBox[3];
            } else {
                // Try alternative formats for compatibility
                if (detection.bbox) {
                    // Format: { x, y, width, height } (in pixels)
                    x = detection.bbox.x;
                    y = detection.bbox.y;
                    width = detection.bbox.width;
                    height = detection.bbox.height;
                } else if (detection.xmin !== undefined) {
                    // Format: { xmin, ymin, xmax, ymax } (in pixels)
                    x = detection.xmin;
                    y = detection.ymin;
                    width = detection.xmax - detection.xmin;
                    height = detection.ymax - detection.ymin;
                } else if (detection.box) {
                    // Format: { box: { x, y, width, height } } (in pixels)
                    if (detection.box.x !== undefined) {
                        x = detection.box.x;
                        y = detection.box.y;
                        width = detection.box.width;
                        height = detection.box.height;
                    } else if (detection.box.xmin !== undefined) {
                        // Format: { box: { xmin, ymin, xmax, ymax } } (in pixels)
                        x = detection.box.xmin;
                        y = detection.box.ymin;
                        width = detection.box.xmax - detection.box.xmin;
                        height = detection.box.ymax - detection.box.ymin;
                    } else {
                        // Skip this detection if we can't parse the bounding box
                        console.warn('Could not parse bounding box for detection:', detection);
                        continue;
                    }
                } else {
                    // Skip this detection if we can't parse the bounding box
                    console.warn('Could not parse bounding box for detection:', detection);
                    continue;
                }
            }

            // Draw bounding box rectangle
            ctx.strokeRect(x, y, width, height);

            // Draw label background
            const label = `${detection.className} ${(detection.score * 100).toFixed(1)}%`;
            const textMetrics = ctx.measureText(label);
            ctx.fillStyle = 'rgba(0, 255, 0, 0.7)'; // Semi-transparent green
            ctx.fillRect(x, y - 20, textMetrics.width + 10, 20);

            // Draw label text
            ctx.fillStyle = '#000000'; // Black text
            ctx.fillText(label, x + 5, y - 5);
        }

        // Convert canvas to base64 JPEG
        const blobResult = await canvas.convertToBlob({ type: 'image/jpeg' });
        const arrayBuffer = await blobResult.arrayBuffer();
        const base64String = Buffer.from(arrayBuffer).toString('base64');

        // Clean up the object URL
        URL.revokeObjectURL(imageUrl);

        return base64String;

    }

    async getLLMTools(): Promise<ChatCompletionFunctionTool[]> {
        const listCameras = this.listCameras();
        const listLights = this.listLights();
        const listFans = this.listFans();
        const listNotifiers = this.listNotifiers();

        const cams: ChatCompletionFunctionTool[] = [];
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

        const lights: ChatCompletionFunctionTool[] = [];
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

        const fans: ChatCompletionFunctionTool[] = [];
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

        const notifiers: ChatCompletionFunctionTool[] = [];
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

        const objectDetectors: ChatCompletionFunctionTool[] = [];
        if (this.objectDetector) {
            objectDetectors.push({
                type: 'function',
                function: {
                    name: 'detect-objects',
                    description: `Perform object detection on an image. Returns a list of detected objects with their labels and confidence scores.`,
                    parameters: {
                        "type": "object",
                        "properties": {
                            "image": {
                                "type": "string",
                                "format": "uri",
                                "description": "Base64 encoded image data URL to perform object detection on.",
                            },
                        },
                        "required": [
                            "image",
                        ],
                        "additionalProperties": false
                    },
                },
            });
        }

        return [...cams, ...lights, ...fans, ...notifiers, ...objectDetectors, getTimeToolFunction()];
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
                // don't wait.
                light.turnOn();
                return createToolTextResult(`${lightName} turned on.`);
            }
            else if (name === 'turn-light-off') {
                // don't wait.
                light.turnOff();
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
                // don't wait.
                fan.turnOn();
                return createToolTextResult(`${fanName} turned on.`);
            }
            else if (name === 'turn-fan-off') {
                // don't wait.
                fan.turnOff();
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
            // don't wait.
            light.setBrightness(brightness);
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
        else if (name === 'detect-objects') {
            const imageData = parameters.image;
            if (!imageData)
                return createToolTextResult(`"image" parameter is required for detect-objects tool.`);

            // Use the pre-initialized object detector
            const objectDetector = this.objectDetector;
            if (!objectDetector)
                return createToolTextResult(`No object detection devices found.`);

            // Convert base64 image data to buffer
            // Handle data URL format if present
            let base64Data = imageData;
            if (imageData.startsWith('data:image')) {
                base64Data = imageData.split(',')[1];
            }

            const imageBuffer = Buffer.from(base64Data, 'base64');

            // Create media object from buffer
            const mediaObject = await this.sdk.mediaManager.createMediaObject(imageBuffer, 'image/jpeg');

            // Perform object detection
            const detectionResult = await objectDetector.detectObjects(mediaObject);

            // Format the results
            if (!detectionResult.detections || detectionResult.detections.length === 0) {
                return createToolTextResult(`No objects detected in the image.`);
            }

            const detectionText = detectionResult.detections
                .map(detection => `${detection.className} (${(detection.score * 100).toFixed(1)}%)`)
                .join(', ');

            const ret = createToolTextResult(`Detected objects: ${detectionText}`);

            // Create annotated image with bounding boxes
            try {
                const annotatedImageBase64 = await this.createAnnotatedImage(imageBuffer, detectionResult.detections);

                // Return text result with annotated image in meta field
                ret._meta = {
                    'chat.scrypted.app/': {
                        images: [
                            {
                                src: `data:image/jpeg;base64,${annotatedImageBase64}`,
                                width: '100%',
                                height: 'auto'
                            }
                        ]
                    }
                };
            } catch (error) {
                // Fallback to text-only result if image annotation fails
                console.error('Failed to create annotated image:', error);
            }
            return ret;
        }
        else if (name === TimeToolFunctionName) {
            return callGetTimeTool();
        }
        return createUnknownToolError(name);
    }
}

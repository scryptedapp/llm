import fs from 'fs';
import os from 'os';
import { Deferred } from '@scrypted/deferred';
import sdk, { ChatCompletion, OnOff, Setting, Settings } from '@scrypted/sdk';
import { StorageSettings } from '@scrypted/sdk/storage-settings';
import child_process from 'child_process';
import { once } from 'events';
import { OpenAI } from 'openai';
import path from 'path';
import { downloadLLama, llamaVersion } from './download-llama';
import { BaseLLM } from './base-llm';
import { fmFork } from './apple-fm';

const modelSetting = {
    title: 'Model',
    description: 'The hugging face model to use for the llama.cpp server. Optional: may include a tag of a specific quantization.',
    placeholder: 'unsloth/gemma-4-E4B-it-GGUF',
    defaultValue: 'unsloth/gemma-4-E4B-it-GGUF',
    combobox: true,
    choices: [
        'unsloth/Qwen3.6-35B-A3B-GGUF',
        'unsloth/Qwen3.6-27B-GGUF',
        'unsloth/Qwen3.5-9B-GGUF',
        'unsloth/Qwen3.5-4B-GGUF',
        'unsloth/Qwen3.5-2B-GGUF',
        'unsloth/gemma-4-31B-it-GGUF',
        'unsloth/gemma-4-26B-A4B-it-GGUF',
        'unsloth/gemma-4-12b-it-GGUF',
        'unsloth/gemma-4-E4B-it-GGUF',
        'unsloth/gemma-4-E2B-it-GGUF',
    ],
};

export async function llamaFork(providedPort: number, apiKey: string, model: string, additionalArguments: string[], backend?: string, version?: string) {
    if (process.platform !== 'win32') {
        // super hacky but need to clean up dangling processes.
        await once(child_process.spawn('killall', ['llama-server']), 'exit').catch(() => { });
    }
    else {
        // windows doesn't have killall, so just kill the process by name.
        await once(child_process.spawn('taskkill', ['/F', '/IM', 'llama-server.exe']), 'exit').catch(() => { });
    }

    const env = process.env.SCRYPTED_INSTALL_ENVIRONMENT;
    if (env?.includes('docker')) {
        const flavor = process.env.SCRYPTED_DOCKER_FLAVOR;
        if (!flavor?.includes('intel') && !flavor?.includes('nvidia')) {
            sdk.log!.a('The llama.cpp server requires the intel or nvidia docker image. There may be stability and performance issues running on this image.');
        }
    }

    // ./llama-server -hf unsloth/gemma-3-4b-it-GGUF:UD-Q4_K_XL -ngl 99 --host 0.0.0.0 --port 8000
    const llamaBinary = await downloadLLama(backend, version);

    const host = apiKey ? '0.0.0.0' : '127.0.0.1';
    providedPort ||= 0;

    const args = [
        '-hf', model,
        '--host', host,
        '--port', providedPort.toString(),
        ...additionalArguments.map(arg => arg.split(' ')).flat().map(arg => arg.trim()).filter(arg => arg),
    ];

    if (apiKey)
        args.push('--api-key', apiKey);

    console.log(os.hostname(), os.platform(), os.arch(), os.release());
    console.log('Starting llama server with args:', ...args);

    const cp = child_process.spawn(llamaBinary,
        args,
        {
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: path.dirname(llamaBinary),
            env: {
                ...process.env,
                LLAMA_CACHE: path.join(process.env.SCRYPTED_PLUGIN_VOLUME!, 'llama-cache'),
            }
        }
    );

    const cpKill = () => {
        cp.kill();
        process.exit();
    };
    // When parent exits, kill the child
    ['exit', 'SIGINT', 'SIGTERM', 'SIGHUP', 'SIGUSR1', 'SIGUSR2'].forEach((signal) => {
        process.on(signal, cpKill);
    });

    const port = new Deferred<number>();

    cp.stdout.on('data', (data: Buffer) => {
        const str = data.toString();
        console.log(str);
    });

    cp.stderr.on('data', (data: Buffer) => {
        const str = data.toString();
        console.error(str);
        // srv  llama_server: listening on http://0.0.0.0:45322
        if (str.includes('listening on')) {
            // parse out the port
            const match = str.match(/http:\/\/\d+\.\d+\.\d+\.\d+:(\d+)/);
            const portNumber = match?.[1];
            if (!portNumber) {
                console.error('Failed to parse port from llama server output:', str);
                cp.kill();
                return;
            }
            port.resolve(parseInt(portNumber, 10));
        }
    });

    cp.on('error', () => {
        console.error('Failed to start llama server.');
        setTimeout(() => {
            process.exit();
        }, 5000);
    });

    cp.on('exit', () => {
        console.log('Llama server exited.');
        setTimeout(() => {
            process.exit();
        }, 5000);
    });

    const p = await port.promise;
    const address = sdk.clusterManager.getClusterAddress() || '127.0.0.1';
    return `http://${address}:${p}/v1`;
}

export class LlamaCPP extends BaseLLM implements OnOff, ChatCompletion {
    forked: ReturnType<typeof sdk.fork<ReturnType<typeof fork>>> | undefined;
    llamaBaseUrl: Promise<string> | undefined;

    llamaSettings = new StorageSettings(this, {
        model: {
            ...modelSetting,
            onPut: () => {
                this.stopLlamaServer();
            }
        },
        backend: {
            title: 'Backend',
            description: 'The runtime backend to use for the llama.cpp server.',
            type: 'string',
            defaultValue: 'Default',
            combobox: true,
            choices: [
                'Default',
                'cpu',
                'cuda-12.4',
                'cuda-13.1',
                'rocm-7.2',
                'hip-radeon',
                'sycl',
                'vulkan',
            ],
            onPut: () => {
                this.stopLlamaServer();
            },
        },
        version: {
            title: 'Version',
            description: 'The llama.cpp version to use.',
            type: 'string',
            defaultValue: llamaVersion,
            combobox: true,
            choices: [
                llamaVersion,
            ],
            onPut: () => {
                this.stopLlamaServer();
            },
        },
        additionalArguments: {
            title: 'Additional Arguments',
            description: 'Additional arguments to pass to the llama server. Vision models require the --jinja argument. Language only models may not work correctly with --jinja.',
            type: 'string',
            multiple: true,
            combobox: true,
            defaultValue: [
                '-ngl 999',
                '--jinja',
                '-fa on',
            ],
            choices: [
                '-ngl 999',
                '--jinja',
                '-fa on',
            ],
            onPut: () => {
                this.stopLlamaServer();
            },
        },
        clusterWorkerLabels: {
            title: 'Cluster Worker Labels',
            description: 'The labels to use for the cluster worker. This is used to determine which worker to run the llama server on.',
            type: 'string',
            multiple: true,
            combobox: true,
            choices: [
                '@scrypted/coreml',
                '@scrypted/openvino',
                '@scrypted/onnx',
                'compute',
                'llm',
            ],
            onPut: () => {
                this.stopLlamaServer();
            },
            defaultValue: [
                'compute',
            ],
            async onGet() {
                return {
                    hide: !sdk.clusterManager?.getClusterMode(),
                }
            },
        },
        apiKey: {
            group: 'Network',
            title: 'API Key',
            type: 'password',
            description: 'Provide an API Key will allow llama.cpp to be usable by other services on your network that have the entered credentials.',
            onPut: () => {
                this.stopLlamaServer();
            },
        },
        port: {
            group: 'Network',
            title: 'Port',
            type: 'number',
            description: 'The port to run the llama server on. If not specified, a random port will be used.',
            onPut: () => {
                this.stopLlamaServer();
            },
        }
    });

    get functionCalls(): boolean {
        return false;
    }

    async stopLlamaServer() {
        if (this.forked) {
            try {
                const result = await this.forked.result;
                await result.terminate();
            }
            catch (e) {
                this.forked.worker.terminate();
            }
            this.console.warn('Terminated llama server fork.');
        }
    }

    async turnOn() {
        this.on = true;
    }

    async turnOff() {
        this.on = false;
        this.stopLlamaServer();
    }

    async getSettings(): Promise<Setting[]> {
        return [
            ...await this.llamaSettings.getSettings(),
            ...await this.storageSettings.getSettings()];
    }

    async putSetting(key: string, value: any): Promise<void> {
        if (key in this.llamaSettings.keys) {
            await this.llamaSettings.putSetting(key, value);
            return;
        }
        await this.storageSettings.putSetting(key, value);
    }

    async startLlamaServer() {
        if (!this.llamaSettings.values.apiKey)
            this.llamaSettings.values.apiKey = Math.random().toString(16).slice(2, 10);
        if (!this.on) {
            this.stopLlamaServer();
            return;
        }
        if (!this.forked) {
            let labels: string[] | undefined = this.llamaSettings.values.clusterWorkerLabels;
            if (!labels?.length)
                labels = undefined;
            this.forked = sdk.fork<ReturnType<typeof fork>>({
                runtime: 'node',
                labels: labels ? {
                    require: labels,
                } : undefined,
                id: this.id,
            });
            this.llamaBaseUrl = (async () => {
                const result = await this.forked!.result;
                return result.llamaFork(this.llamaSettings.values.port, this.llamaSettings.values.apiKey, this.llamaSettings.values.model, this.llamaSettings.values.additionalArguments, this.llamaSettings.values.backend, this.llamaSettings.values.version);
            })();
            this.forked.worker.on('exit', () => {
                this.forked = undefined;
            });
        }
        return this.forked!;
    }

    async getChatCompletion(body: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming): Promise<OpenAI.Chat.Completions.ChatCompletion> {
        const forked = await this.startLlamaServer();
        if (!forked)
            throw new Error('Llama server is not running.\n');

        await forked.result;
        const baseURL = await this.llamaBaseUrl!;


        const client = new OpenAI({
            baseURL,
            apiKey: this.llamaSettings.values.apiKey || 'no-key',
        });

        const completion = await client.chat.completions.create(body);
        return completion;
    }

    async * streamChatCompletionInternal(body: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming): AsyncGenerator<OpenAI.Chat.Completions.ChatCompletionChunk | OpenAI.Chat.Completions.ChatCompletion> {
        const forked = await this.startLlamaServer();
        if (!forked)
            throw new Error('Llama server is not running.\n');

        await forked.result;
        const baseURL = await this.llamaBaseUrl!;


        const client = new OpenAI({
            baseURL,
            apiKey: this.llamaSettings.values.apiKey || 'no-key',
        });

        const stream = client.chat.completions.stream(body);
        for await (const chunk of stream) {
            yield chunk;
        }
        const last = await stream.finalChatCompletion();
        yield last;
    }
}

export async function fork() {
    return {
        llamaFork,
        fmFork,
        async clearModelStorage() {
            const LLAMA_CACHE = path.join(process.env.SCRYPTED_PLUGIN_VOLUME!, 'llama-cache')
            await fs.promises.rm(LLAMA_CACHE, {
                recursive: true,
                force: true,
            });
        },
        async terminate() {
            process.exit(0);
        }
    }
}
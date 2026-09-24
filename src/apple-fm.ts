import { Deferred } from '@scrypted/deferred';
import sdk, { ChatCompletion, OnOff, Setting } from '@scrypted/sdk';
import { StorageSettings } from '@scrypted/sdk/storage-settings';
import child_process from 'child_process';
import http from 'http';
import { once } from 'events';
import { OpenAI } from 'openai';
import { BaseLLM } from './base-llm';

export async function fmFork(providedPort: number, apiKey: string, host: string) {
    if (process.platform !== 'darwin')
        throw new Error('Apple Foundation Models requires the fm CLI, which is only available on macOS 27.');

    // super hacky but need to clean up dangling processes.
    await once(child_process.spawn('killall', ['fm']), 'exit').catch(() => { });

    // fm serve requires a port between 1 and 65535, so pick a random one if none is provided.
    providedPort ||= 10000 + Math.floor(Math.random() * 55534);

    const args = [
        'serve',
        '--host', host,
        '--port', providedPort.toString(),
    ];

    console.log('Starting fm server with args:', ...args);

    const cp = child_process.spawn('fm',
        args,
        {
            stdio: ['pipe', 'pipe', 'pipe'],
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
    let output = '';

    const handleOutput = (data: Buffer) => {
        // fm colorizes its output; strip the ansi escape codes.
        const str = data.toString().replace(/\x1b\[[0-9;]*m/g, '');
        output += str;
        console.log(str);
        // fm refuses to run until the machine has agreed to the license terms, e.g.
        // "YOU HAVE NOT AGREED TO THE APPLE FOUNDATION MODELS CLI LEGAL NOTICE & TERMS.
        // Agreeing ... must be run as a privileged user (e.g. 'sudo fm license')."
        if (str.includes('sudo fm license')) {
            const message = "Apple Foundation Models has not been licensed on this Mac. Run 'sudo fm license' once on this machine to agree to the Apple Foundation Models CLI terms.";
            console.error(message);
            cp.kill();
            port.reject(new Error(message));
        }
    };

    cp.stdout.on('data', handleOutput);
    cp.stderr.on('data', handleOutput);

    // fm may buffer its output when piped, so the startup banner is not
    // reliable for detecting readiness. poll the health endpoint instead.
    (async () => {
        const deadline = Date.now() + 30000;
        while (!port.finished) {
            const healthy = await new Promise<boolean>(resolve => {
                const req = http.get(`http://127.0.0.1:${providedPort}/health`, res => {
                    res.resume();
                    resolve(!!res.statusCode && res.statusCode < 500);
                });
                req.on('error', () => resolve(false));
            });
            if (healthy) {
                console.log(`fm server is listening on port ${providedPort}.`);
                port.resolve(providedPort);
                return;
            }
            if (Date.now() > deadline) {
                cp.kill();
                port.reject(new Error('fm server did not start within 30 seconds.'));
                return;
            }
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    })();

    cp.on('error', () => {
        console.error('Failed to start fm server.');
        port.reject(new Error(output || 'Failed to start fm server.'));
        setTimeout(() => {
            process.exit();
        }, 5000);
    });

    cp.on('exit', () => {
        console.log('fm server exited.');
        port.reject(new Error(output || 'fm server exited.'));
        setTimeout(() => {
            process.exit();
        }, 5000);
    });

    const p = await port.promise;
    const address = sdk.clusterManager.getClusterAddress() || '127.0.0.1';
    return `http://${address}:${p}/v1`;
}

type FMFork = {
    fmFork: typeof fmFork;
    terminate(): Promise<void>;
};

export class AppleFM extends BaseLLM implements OnOff, ChatCompletion {
    forked: ReturnType<typeof sdk.fork<FMFork>> | undefined;
    fmBaseUrl: Promise<string> | undefined;

    fmSettings = new StorageSettings(this, {
        model: {
            title: 'Model',
            description: 'The Apple Foundation Model to use. The on-device system model is currently the only available model.',
            type: 'string',
            defaultValue: 'system',
            combobox: true,
            choices: [
                'system',
            ],
            onPut: () => {
                this.stopFMServer();
            }
        },
        clusterWorkerLabels: {
            title: 'Cluster Worker Labels',
            description: 'The labels to use for the cluster worker. This is used to determine which macOS worker to run the fm server on.',
            type: 'string',
            multiple: true,
            combobox: true,
            choices: [
                '@scrypted/coreml',
                'compute',
                'llm',
            ],
            onPut: () => {
                this.stopFMServer();
            },
            defaultValue: [
                '@scrypted/coreml',
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
            description: 'Providing an API Key will allow the fm server to be usable by other services on your network. Note: fm serve does not enforce API keys; a key is only used by this plugin.',
            onPut: () => {
                this.stopFMServer();
            },
        },
        port: {
            group: 'Network',
            title: 'Port',
            type: 'number',
            description: 'The port to run the fm server on. If not specified, a random port will be used.',
            onPut: () => {
                this.stopFMServer();
            },
        }
    });

    get functionCalls(): boolean {
        return false;
    }

    async stopFMServer() {
        if (this.forked) {
            try {
                const result = await this.forked.result;
                await result.terminate();
            }
            catch (e) {
                this.forked.worker.terminate();
            }
            this.console.warn('Terminated fm server fork.');
        }
    }

    async turnOn() {
        this.on = true;
    }

    async turnOff() {
        this.on = false;
        this.stopFMServer();
    }

    async getSettings(): Promise<Setting[]> {
        return [
            ...await this.fmSettings.getSettings(),
            ...await this.storageSettings.getSettings()];
    }

    async putSetting(key: string, value: any): Promise<void> {
        if (key in this.fmSettings.keys) {
            await this.fmSettings.putSetting(key, value);
            return;
        }
        await this.storageSettings.putSetting(key, value);
    }

    async startFMServer() {
        // the fm server only needs to be reachable by this plugin. when the plugin
        // is clustered, the device and its fork may be on different machines, so
        // the server must be exposed to the network. fm serve does not enforce
        // api keys, so the api key is only used by this plugin's client.
        const host = sdk.clusterManager?.getClusterMode() ? '0.0.0.0' : '127.0.0.1';
        if (host === '0.0.0.0')
            this.console.warn('Clustering is enabled: the fm server will be accessible without credentials by other services on the network.');
        if (!this.on) {
            this.stopFMServer();
            return;
        }
        if (!this.forked) {
            let labels: string[] | undefined = this.fmSettings.values.clusterWorkerLabels;
            if (!labels?.length)
                labels = undefined;
            this.forked = sdk.fork<FMFork>({
                runtime: 'node',
                labels: labels ? {
                    require: labels,
                } : undefined,
                id: this.id,
            });
            this.fmBaseUrl = (async () => {
                const result = await this.forked!.result;
                try {
                    return await result.fmFork(this.fmSettings.values.port, this.fmSettings.values.apiKey, host);
                }
                catch (e) {
                    // surface fork startup errors (e.g. the license notice) as alerts on this device.
                    this.log.a(e instanceof Error ? e.message : String(e));
                    throw e;
                }
            })();
            this.forked.worker.on('exit', () => {
                this.forked = undefined;
            });
        }
        return this.forked!;
    }

    async getChatCompletion(body: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming): Promise<OpenAI.Chat.Completions.ChatCompletion> {
        const forked = await this.startFMServer();
        if (!forked)
            throw new Error('Apple Foundation Model server is not running.\n');

        await forked.result;
        const baseURL = await this.fmBaseUrl!;

        const client = new OpenAI({
            baseURL,
            apiKey: this.fmSettings.values.apiKey || 'no-key',
        });

        const completion = await client.chat.completions.create({
            ...body,
            // fm serve only serves the Apple Foundation Model.
            model: this.fmSettings.values.model,
            // fm serve streams unless explicitly told not to.
            stream: false,
        });
        return completion;
    }

    async * streamChatCompletionInternal(body: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming): AsyncGenerator<OpenAI.Chat.Completions.ChatCompletionChunk | OpenAI.Chat.Completions.ChatCompletion> {
        const forked = await this.startFMServer();
        if (!forked)
            throw new Error('Apple Foundation Model server is not running.\n');

        await forked.result;
        const baseURL = await this.fmBaseUrl!;

        const client = new OpenAI({
            baseURL,
            apiKey: this.fmSettings.values.apiKey || 'no-key',
        });

        const stream = client.chat.completions.stream({
            ...body,
            // fm serve only serves the Apple Foundation Model.
            model: this.fmSettings.values.model,
        });
        for await (const chunk of stream) {
            yield chunk;
        }
        const last = await stream.finalChatCompletion();
        yield last;
    }
}
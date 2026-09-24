import { ChatCompletion, Setting, Settings } from '@scrypted/sdk';
import { StorageSettings } from '@scrypted/sdk/storage-settings';
import { OpenAI } from 'openai';
import { BaseLLM } from './base-llm';

export class OpenAIEndpoint extends BaseLLM implements Settings, ChatCompletion {
    openaiSettings = new StorageSettings(this, {
        model: {
            title: 'Model',
            description: 'The model to use for the OpenAI compatible endpoint.',
            placeholder: 'o4-mini',
        },
        baseURL: {
            title: 'Base URL',
            description: 'The base URL of the OpenAI compatible endpoint. Common base URLs for cloud providers and local LLM servers are provided as examples.',
            placeholder: 'https://api.openai.com/v1',
            combobox: true,
            choices: [
                'https://api.openai.com/v1',
                'https://generativelanguage.googleapis.com/v1beta/openai/',
                'https://api.anthropic.com/v1/',
                'http://llama-cpp.localdomain:8080/v1',
                'http://lmstudio.localdomain:1234/v1',
            ]
        },
        apiKey: {
            title: 'API Key',
            description: 'The API key for the OpenAI compatible endpoint.',
            type: 'password',
        },
        functionCalls: {
            title: 'Legacy Function Calls',
            description: 'Use function calls rather than tool calls for legacy providers like LMStudio.',
            type: 'boolean',
        },
    });

    get functionCalls(): boolean {
        return this.openaiSettings.values.functionCalls || false;
    }

    async * streamChatCompletionInternal(body: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming): AsyncGenerator<OpenAI.Chat.Completions.ChatCompletionChunk | OpenAI.Chat.Completions.ChatCompletion> {
        const client = new OpenAI({
            baseURL: this.openaiSettings.values.baseURL,
            apiKey: this.openaiSettings.values.apiKey || 'no-key',
        });

        body.model ||= this.openaiSettings.values.model;
        for (const message of body.messages) {
            // some apis may send null values across, which chokes gemini up.
            for (const k in message) {
                // @ts-expect-error
                if (message[k] === undefined || message[k] === null) {
                    // @ts-expect-error
                    delete message[k];
                }
            }
        }
        const stream = client.chat.completions.stream(body);
        for await (const chunk of stream) {
            yield chunk;
        }
        const last = await stream.finalChatCompletion();
        yield last;
    }

    async getChatCompletion(body: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming): Promise<OpenAI.Chat.Completions.ChatCompletion> {
        const client = new OpenAI({
            baseURL: this.openaiSettings.values.baseURL,
            apiKey: this.openaiSettings.values.apiKey || 'no-key',
        });

        body.model ||= this.openaiSettings.values.model;

        const completion = await client.chat.completions.create(body);
        return completion;
    }

    async getSettings(): Promise<Setting[]> {
        return [
            ...await this.openaiSettings.getSettings(),
            ...await this.storageSettings.getSettings()];
    }

    async putSetting(key: string, value: any): Promise<void> {
        if (key in this.openaiSettings.keys) {
            await this.openaiSettings.putSetting(key, value);
            return;
        }
        await this.storageSettings.putSetting(key, value);
    }
}
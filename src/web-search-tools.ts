import { Readability } from '@mozilla/readability';
import { ChatCompletionTool, LLMTools, ScryptedDeviceBase, Settings, SettingValue } from '@scrypted/sdk';
import { StorageSettings } from '@scrypted/sdk/storage-settings';
import type { JSDOM as JSDOMType } from 'jsdom';
import { callGetTimeTool, getTimeToolFunction, TimeToolFunctionName } from './time-tool';

interface SearXNGResult {
    title: string;
    url: string;
    content: string;
}

interface SearXNGResponse {
    results: SearXNGResult[];
}

export class WebSearchTools extends ScryptedDeviceBase implements LLMTools, Settings {
    storageSettings = new StorageSettings(this, {
        searxng: {
            title: 'SearxNG URL',
            description: 'The URL of your SearxNG instance. Example: https://searxng.example.com/search',
            type: 'string',
            placeholder: 'https://searxng.example.com/search',
        }
    });

    async getLLMTools(): Promise<ChatCompletionTool[]> {
        return [
            getTimeToolFunction(),
            {
                type: 'function',
                function: {
                    name: 'search-web',
                    description: 'Search the web for a query.',
                    parameters: {
                        "type": "object",
                        "properties": {
                            "query": {
                                "type": "string",
                                "description": "The search query. Rather than using the user input directly, construct a good query for their intent to ensure good results.",
                            },
                        },
                        "required": [
                            "query",
                        ],
                        "additionalProperties": false
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name: 'get-web-page-content',
                    description: 'Get the main content of a web page.',
                    parameters: {
                        "type": "object",
                        "properties": {
                            "url": {
                                "type": "string",
                                "description": "The URL of the web page to retrieve.",
                            },
                        },
                        "required": [
                            "url",
                        ],
                        "additionalProperties": false
                    },
                },
            },
        ]
    }

    async searchWeb(query: string): Promise<string> {
        if (!this.storageSettings.values.searxng)
            return 'Search failed. Inform the user: The SearXNG URL must be configured in the LLM Plugin settings.';

        const searxngUrl = this.storageSettings.values.searxng;
        const encodedQuery = encodeURIComponent(query);
        const apiEndpoint = `${searxngUrl}?format=json&q=${encodedQuery}`;

        try {
            const response = await fetch(apiEndpoint);
            if (!response.ok) {
                return `HTTP error! Status: ${response.status}`;
            }

            const data: SearXNGResponse = await response.json();

            if (!data.results.length) {
                return 'No results found.';
            }

            const header = `The following are the Search results for "${query}". To gather further information from these links, use the get-web-page-content tool. You MUST use multiple get-web-page-content tool calls in a single response if you intend to retrieve content from multiple pages. This will gather them simultaneously. If a web page provides an answer to the query, include the link in your response:\n`;

            return header + data.results.map((result, index) =>
                `
${index}. ${result.title}
    - ${result.url}
    - ${result.content}`
            ).join('\n');
        } catch (error) {
            return `Search failed with backend error. Inform the user: ${error}`;
        }
    }

    async getWebPageContent(url: string): Promise<string> {
        try {
            const response = await fetch(url);
            const html = await response.text();

            // Parse HTML into a DOM
            const { JSDOM } = require('jsdom') as { JSDOM: typeof JSDOMType };
            const dom = new JSDOM(html, { url });
            const document = dom.window.document;

            // Run Readability to parse the article
            const reader = new Readability(document);
            const article = reader.parse();

            if (article) {
                return `# URL: ${url}\n\n# Title: ${article.title}\n\n# Content: ${article.textContent}`;
            } else {
                return `# URL: ${url}\n\nFailed to parse article`;
            }
        } catch (error) {
            return `# URL: ${url}\n\nError fetching or parsing article:\n${error}`;
        }
    }

    async callLLMTool(name: string, parameters: Record<string, any>): Promise<string> {
        if (name === 'search-web') {
            return await this.searchWeb(parameters.query);
        } else if (name === 'get-web-page-content') {
            return await this.getWebPageContent(parameters.url);
        }
        else if (name === TimeToolFunctionName) {
            // this call may be intercepted by the browser to provide a user locale time.
            return callGetTimeTool();
        }

        return 'Unknown tool: ' + name;
    }

    async getSettings() {
        return this.storageSettings.getSettings();
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        return await this.storageSettings.putSetting(key, value);
    }
}
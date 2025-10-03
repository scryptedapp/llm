import { Readability } from '@mozilla/readability';
import { CallToolResult, ChatCompletionFunctionTool, LLMTools, ScryptedDeviceBase, Settings, SettingValue, TextContent } from '@scrypted/sdk';
import { StorageSettings } from '@scrypted/sdk/storage-settings';
import type { JSDOM as JSDOMType } from 'jsdom';
import { callGetTimeTool, getTimeToolFunction, TimeToolFunctionName } from './time-tool';
import { createToolTextResult, createUnknownToolError } from './tools-common';

interface SearXNGResult {
    title: string;
    url: string;
    content: string;
    category: string;
    thumbnail_src?: string;
    thumbnail?: string;
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

    async getLLMTools(): Promise<ChatCompletionFunctionTool[]> {
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
                            "general": {
                                "type": "boolean",
                                "default": true,
                                "description": "Whether to include general search results. This is the default category and should typically be used.",
                            },
                            "news": {
                                "type": "boolean",
                                "default": false,
                                "description": "Whether to include news search results. This is useful for queries that may have recent news articles.",
                            },
                            "images": {
                                "type": "boolean",
                                "default": false,
                                "description": "Whether to include image search results. The image results will not be returned as text results, but will be presented to the user automatically.",
                            },
                            "videos": {
                                "type": "boolean",
                                "default": false,
                                "description": "Whether to include video search results. The video results will not be returned as text results, but will be presented to the user automatically.",
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
                            "htmlContent": {
                                "type": "boolean",
                                "default": false,
                                "description": "Returns the page as HTML content of the article rather than as plain text. HTML content will significantly slow down the request, so HTML content MUST NOT BE REQUESTED BY DEFAULT unless you need the hyperlink 'a' tag to retrieve more content from a referenced page.",
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

    async searchWeb(query: string, general: boolean, news: boolean, images: boolean, videos: boolean): Promise<CallToolResult> {
        if (!this.storageSettings.values.searxng) {
            return createToolTextResult('Search failed. Inform the user: The SearXNG URL must be configured in the LLM Plugin settings.');
        }

        const searxngUrl = this.storageSettings.values.searxng;
        const url = new URL(searxngUrl);
        url.searchParams.set('q', query);
        url.searchParams.set('format', 'json');
        const categories: string[] = [];
        if (general) {
            categories.push('general');
        }
        if (news) {
            categories.push('news');
        }
        if (images) {
            categories.push('images');
        }
        if (videos) {
            categories.push('videos');
        }
        if (categories?.length) {
            url.searchParams.set('categories', categories.join(','));
        }
        const apiEndpoint = url.toString();

        try {
            const response = await fetch(apiEndpoint);
            if (!response.ok) {
                return createToolTextResult(`HTTP error! Status: ${response.status}`);
            }

            const data: SearXNGResponse = await response.json();


            if (!data.results.length) {
                return createToolTextResult('No results found.');
            }

            const header = `The following are the Search results for "${query}". To gather further information from these links, use the get-web-page-content tool. You MUST use multiple get-web-page-content tool calls in a single response if you intend to retrieve content from multiple pages. This will gather them simultaneously. If a web page provides an answer to the query, include the link in your response:\n`;
            const content: TextContent = {
                type: 'text',
                text: '',
            };
            const ret: CallToolResult = {
                content: [
                    content,
                ],
            };

            const filteredResults = data.results.filter(result => result.category === 'general' || result.category === 'news');

            const suppressed = data.results.length - filteredResults.length;

            ret.structuredContent = {
                results: filteredResults,
            };
            content.text = header + filteredResults.map((result, index) =>
                `
${index + 1}. ${result.title}
    - ${result.url}
    - ${result.content}`
            ).join('\n');


            if (suppressed) {
                content.text += `

## Note: ${suppressed} images were removed from the results and presented directly to the user.
                `;

                const presented = data.results.filter(result => result.category === 'images' && result.thumbnail_src).slice(0, 4);
                if (presented.length) {
                    ret._meta = {
                        'chat.scrypted.app/': {
                            images: presented.map(result => ({
                                url: result.url,
                                src: result.thumbnail_src,
                            })),
                        }
                    };
                }
            }

            return ret;
        } catch (error) {
            return createToolTextResult(`Search failed with backend error. Inform the user: ${error}`);
        }
    }

    async getWebPageContent(url: string, htmlContent = false): Promise<CallToolResult> {
        try {
            const response = await fetch(url);
            if (response.headers.get('content-type')?.includes('application/pdf')) {
                // do not send back pdfs.
                response.body?.cancel().catch(() => { });
                return createToolTextResult(`# URL: ${url}\n\nThe URL is a PDF document. Retrieving PDF documents is not supported.`);
            }

            const html = await response.text();

            // Parse HTML into a DOM
            const { JSDOM } = require('jsdom') as { JSDOM: typeof JSDOMType };
            const dom = new JSDOM(html, { url });
            const document = dom.window.document;

            // Run Readability to parse the article
            const reader = new Readability(document);
            const article = reader.parse();

            if (article) {
                return createToolTextResult(`# URL: ${url}\n\n# Title: ${article.title}\n\n# Content: ${htmlContent ? article.content : article.textContent}`);

            } else {
                return createToolTextResult(`# URL: ${url}\n\nFailed to parse article`);
            }
        } catch (error) {
            return createToolTextResult(`# URL: ${url}\n\nError fetching or parsing article:\n${error}`);
        }
    }

    async callLLMTool(name: string, parameters: Record<string, any>) {
        if (name === 'search-web') {
            return await this.searchWeb(parameters.query, parameters.general == undefined ? true : parameters.general, parameters.news, parameters.images, parameters.videos);
        } else if (name === 'get-web-page-content') {
            return await this.getWebPageContent(parameters.url, parameters.htmlContent);
        }
        else if (name === TimeToolFunctionName) {
            // this call may be intercepted by the browser to provide a user locale time.
            return callGetTimeTool();
        }

        return createUnknownToolError(name);
    }

    async getSettings() {
        return this.storageSettings.getSettings();
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        return await this.storageSettings.putSetting(key, value);
    }
}
import { Readability } from '@mozilla/readability';
import { CallToolResult, ChatCompletionFunctionTool, LLMTools, ScryptedDeviceBase } from '@scrypted/sdk';
import type { JSDOM as JSDOMType } from 'jsdom';
import { callGetTimeTool, getTimeToolFunction, TimeToolFunctionName } from './time-tool';
import { createToolTextResult, createUnknownToolError } from './tools-common';

export class WebTools extends ScryptedDeviceBase implements LLMTools {
    async getLLMTools(): Promise<ChatCompletionFunctionTool[]> {
        return [
            getTimeToolFunction(),
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

    async getWebPageContent(url: string, htmlContent = false): Promise<CallToolResult> {
        try {
            const options = {
                method: 'GET',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
                }
            };

            const response = await fetch(url, options);
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

    async callLLMTool(toolCallId: string, name: string, parameters: Record<string, any>) {
        if (name === 'get-web-page-content') {
            return await this.getWebPageContent(parameters.url, parameters.htmlContent);
        }
        else if (name === TimeToolFunctionName) {
            // this call may be intercepted by the browser to provide a user locale time.
            return callGetTimeTool();
        }

        return createUnknownToolError(name);
    }
}
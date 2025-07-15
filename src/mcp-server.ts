import { LLMTools, ChatCompletionTool, ScryptedDeviceBase, Settings, SettingValue } from "@scrypted/sdk";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";


export class MCPServer extends ScryptedDeviceBase implements LLMTools, Settings {
    storageSettings = new StorageSettings(this, {
        mcpServer: {
            title: 'MCP Server URL',
            description: 'The URL of your MCP server. Example: http://localhost:3000',
            type: 'string',
            placeholder: 'http://localhost:3000',
            onPut: () => this.reconnect(),
        },
        token: {
            title: 'MCP Server Token',
            description: 'The token to authenticate with the MCP server.',
            type: 'string',
            placeholder: 'your-token-here',
            onPut: () => this.reconnect(),
        }
    });

    client: Client | undefined;

    async reconnect() {
        await this.client?.close();
        this.client = undefined;
        await this.ensureClientConnected();
    }

    async ensureClientConnected() {
        if (this.client) {
            return;
        }
        if (!this.storageSettings.values.mcpServer) {
            return;
        }

        this.client = new Client({
            name: 'Scrypted LLM Plugin',
            version: '0.0.1',
            description: 'Scrypted LLM Plugin',
        });

        const token = this.storageSettings.values.token;
        try {
            await this.client.connect(new StreamableHTTPClientTransport(new URL(this.storageSettings.values.mcpServer), {
                requestInit: {
                    headers: token
                        ? {
                            Authorization: `Bearer ${token}`,
                        } : undefined
                }
            }));
        }
        catch (e) {
            this.client = undefined;
            throw e;
        }
    }

    async getLLMTools(): Promise<ChatCompletionTool[]> {
        await this.ensureClientConnected();
        const tools = await this.client!.listTools();
        return tools.tools.map(tool => ({
            type: 'function',
            function: {
                description: tool.description,
                name: tool.name,
                parameters: tool.inputSchema,
            },
        }))
    }

    async callLLMTool(name: string, parameters: Record<string, any>): Promise<string> {
        await this.ensureClientConnected();
        const result = await this.client!.callTool({
            name,
            arguments: parameters,
        })
        const {content} = result as any;
        if (!content?.[0]) {
            return 'Tool call did not return any content.';
        }
        if (content[0].type === 'text') {
            return content[0].text;
        }
        return 'Tool call returned non-text content.';
    }

    async getSettings() {
        return this.storageSettings.getSettings();
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        return await this.storageSettings.putSetting(key, value);
    }

}
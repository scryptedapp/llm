import sdk, { LLMTools } from '@scrypted/sdk';
import { OpenAI } from 'openai';

export async function* connectStreamInternal(input: AsyncGenerator<Buffer>, options: {
    name: string,
    baseURL: string,
    apiKey?: string,
    systemPrompt?: string,
    model?: string,
    tools: string[],
}): AsyncGenerator<Buffer> {
    const client = new OpenAI({
        baseURL: options.baseURL,
        apiKey: options.apiKey || 'api requires must not be empty',
    });

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

    if (options.systemPrompt) {
        messages.push({
            role: 'system',
            content: options.systemPrompt,
        });
    }

    yield Buffer.from('> ');
    let curline = '';
    for await (const chunk of input) {
        if (!(chunk instanceof Buffer))
            continue;
        for (const c of chunk.toString()) {
            if (c === '\r') {
                messages.push({
                    role: 'user',
                    content: curline,
                });
                curline = '';

                const toolsPromises = options.tools.map(async tool => {
                    const llmTools = sdk.systemManager.getDeviceById<LLMTools>(tool);
                    const availableTools = await llmTools.getLLMTools();
                    return availableTools;
                });

                const tools = (await Promise.allSettled(toolsPromises)).map(r => r.status === 'fulfilled' ? r.value : []).flat()
                    .map(tool => {
                        tool.parameters ||= {};
                        return {
                            type: 'function' as const,
                            function: tool,
                        };
                    });


                const stream = client.chat.completions.stream({
                    model: options.model!,
                    messages,
                    tools,
                });

                yield Buffer.from(`\n\n${options.name}:\n\n`);

                for await (const token of stream) {
                    yield token.choices[0].delta.content ? Buffer.from(token.choices[0].delta.content) : Buffer.from('');
                }

                yield Buffer.from('\n\n> ');
                continue;
            }
            if (c.charCodeAt(0) === 127) {
                if (curline.length === 0)
                    continue;
                curline = curline.slice(0, -1);
                yield Buffer.from('\b \b');
                continue;
            }
            curline += c;
            yield Buffer.from(c);
        }
    }
}

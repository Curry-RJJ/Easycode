/**
 * OpenAI Provider（兼容 OpenAI Chat Completions API）
 *
 * 也被 Deepseek Provider 复用（仅覆盖 baseURL）。
 */

import OpenAI from 'openai';
import type {
  Message,
  ToolDefinition,
  StreamDelta,
  StreamFn,
  StreamOptions,
} from '../types.js';

// ─── 消息格式转换 ──────────────────────────────────────────────────────

type OpenAIMessage = OpenAI.Chat.ChatCompletionMessageParam;

function toOpenAIMessages(messages: Message[]): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      result.push({ role: 'system', content: typeof msg.content === 'string' ? msg.content : '' });
    } else if (msg.role === 'user') {
      result.push({ role: 'user', content: typeof msg.content === 'string' ? msg.content : '' });
    } else if (msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        result.push({ role: 'assistant', content: msg.content });
      } else {
        // 包含 tool_use 块的 assistant 消息
        const textBlocks = msg.content.filter((b) => b.type === 'text');
        const toolBlocks = msg.content.filter((b) => b.type === 'tool_use');
        result.push({
          role: 'assistant',
          content: textBlocks.map((b) => (b as { type: 'text'; text: string }).text).join('') || null,
          tool_calls: toolBlocks.map((b) => {
            const tb = b as { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
            return {
              id: tb.id,
              type: 'function' as const,
              function: { name: tb.name, arguments: JSON.stringify(tb.input) },
            };
          }),
        });
      }
    } else if (msg.role === 'tool') {
      result.push({
        role: 'tool',
        tool_call_id: msg.tool_call_id ?? '',
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      });
    }
  }

  return result;
}

// ─── 工具定义转换 ─────────────────────────────────────────────────────

function toOpenAITools(tools: ToolDefinition[]): OpenAI.Chat.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters as Record<string, unknown>,
    },
  }));
}

// ─── Provider 工厂 ────────────────────────────────────────────────────

export interface OpenAIProviderOptions {
  apiKey: string;
  baseURL?: string;
  model: string;
}

export function createOpenAIStreamFn(opts: OpenAIProviderOptions): StreamFn {
  const client = new OpenAI({
    apiKey: opts.apiKey,
    baseURL: opts.baseURL,
  });

  return async function* (
    messages: Message[],
    tools: ToolDefinition[],
    streamOpts?: StreamOptions
  ): AsyncIterable<StreamDelta> {
    const openAIMessages = toOpenAIMessages(messages);
    const openAITools = toOpenAITools(tools);

    try {
      const stream = await client.chat.completions.create({
        model: opts.model,
        messages: openAIMessages,
        tools: openAITools.length > 0 ? openAITools : undefined,
        tool_choice: openAITools.length > 0 ? 'auto' : undefined,
        max_tokens: streamOpts?.maxTokens ?? 8096,
        temperature: streamOpts?.temperature ?? 0.7,
        stream: true,
        stream_options: { include_usage: true },
      });

      // 工具调用参数累积（OpenAI 分块发 arguments）
      const toolCallBuffers: Map<number, { callId: string; name: string; args: string }> = new Map();

      for await (const chunk of stream) {
        const choice = chunk.choices?.[0];

        // usage 块（流结束后附带）
        if (chunk.usage) {
          yield {
            type: 'usage',
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
          };
        }

        if (!choice) continue;

        const delta = choice.delta;

        // 文本 delta
        if (delta?.content) {
          yield { type: 'text_delta', content: delta.content };
        }

        // 工具调用 delta
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;

            if (tc.id) {
              // 工具调用开始
              const callId = tc.id;
              const name = tc.function?.name ?? '';
              toolCallBuffers.set(idx, { callId, name, args: tc.function?.arguments ?? '' });
              yield { type: 'tool_call_start', callId, name };
            } else if (tc.function?.arguments) {
              // 工具调用参数增量
              const buf = toolCallBuffers.get(idx);
              if (buf) {
                buf.args += tc.function.arguments;
                yield { type: 'tool_call_delta', callId: buf.callId, argumentsDelta: tc.function.arguments };
              }
            }
          }
        }

        // 结束信号
        if (choice.finish_reason) {
          // 补发所有未结束的 tool_call_end
          for (const [, buf] of toolCallBuffers) {
            yield { type: 'tool_call_end', callId: buf.callId };
          }
          toolCallBuffers.clear();

          const stopReason =
            choice.finish_reason === 'tool_calls'
              ? 'tool_use'
              : choice.finish_reason === 'length'
              ? 'max_tokens'
              : 'end_turn';

          yield { type: 'done', stopReason };
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      yield { type: 'error', message: msg };
    }
  };
}

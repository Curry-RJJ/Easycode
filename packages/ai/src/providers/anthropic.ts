/**
 * Anthropic Provider
 *
 * 使用 @anthropic-ai/sdk，将 Anthropic 事件格式归一化为统一 StreamDelta。
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  Message,
  ToolDefinition,
  StreamDelta,
  StreamFn,
  StreamOptions,
} from '../types.js';

// ─── 消息格式转换 ──────────────────────────────────────────────────────

type AnthropicMessage = Anthropic.MessageParam;

function toAnthropicMessages(messages: Message[]): AnthropicMessage[] {
  const result: AnthropicMessage[] = [];

  for (const msg of messages) {
    // system 单独传，不放进 messages 数组
    if (msg.role === 'system') continue;

    if (msg.role === 'user') {
      result.push({
        role: 'user',
        content: typeof msg.content === 'string' ? msg.content : '',
      });
    } else if (msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        result.push({ role: 'assistant', content: msg.content });
      } else {
        // 包含 tool_use 块的 assistant 消息
        // 使用 Anthropic 的请求参数类型（TextBlockParam / ToolUseBlockParam）
        type ABlock = Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam;
        const blocks: ABlock[] = [];
        for (const b of msg.content) {
          if (b.type === 'text') {
            blocks.push({ type: 'text', text: (b as { type: 'text'; text: string }).text });
          } else if (b.type === 'tool_use') {
            const tb = b as { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
            blocks.push({ type: 'tool_use', id: tb.id, name: tb.name, input: tb.input });
          }
        }
        result.push({ role: 'assistant', content: blocks });
      }
    } else if (msg.role === 'tool') {
      // Anthropic 的 tool_result 放在 user 消息里
      result.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: msg.tool_call_id ?? '',
            content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
          },
        ],
      });
    }
  }

  return result;
}

// ─── 系统提示词提取 ───────────────────────────────────────────────────

function extractSystemPrompt(messages: Message[]): string | undefined {
  const sysMsg = messages.find((m) => m.role === 'system');
  if (!sysMsg) return undefined;
  return typeof sysMsg.content === 'string' ? sysMsg.content : undefined;
}

// ─── 工具定义转换 ─────────────────────────────────────────────────────

function toAnthropicTools(tools: ToolDefinition[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Tool['input_schema'],
  }));
}

// ─── Provider 工厂 ────────────────────────────────────────────────────

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
}

export function createAnthropicStreamFn(opts: AnthropicProviderOptions): StreamFn {
  const client = new Anthropic({ apiKey: opts.apiKey });

  return async function* (
    messages: Message[],
    tools: ToolDefinition[],
    streamOpts?: StreamOptions
  ): AsyncIterable<StreamDelta> {
    const anthropicMessages = toAnthropicMessages(messages);
    const anthropicTools = toAnthropicTools(tools);
    const systemPrompt = extractSystemPrompt(messages) ?? streamOpts?.system;

    try {
      const stream = client.messages.stream({
        model: opts.model,
        max_tokens: streamOpts?.maxTokens ?? 8096,
        system: systemPrompt,
        messages: anthropicMessages,
        tools: anthropicTools.length > 0 ? anthropicTools : undefined,
      });

      for await (const event of stream) {
        switch (event.type) {
          case 'content_block_start': {
            const block = event.content_block;
            if (block.type === 'tool_use') {
              yield { type: 'tool_call_start', callId: block.id, name: block.name };
            }
            break;
          }

          case 'content_block_delta': {
            const delta = event.delta;
            if (delta.type === 'text_delta') {
              yield { type: 'text_delta', content: delta.text };
            } else if (delta.type === 'input_json_delta') {
              // Anthropic 用 input_json_delta 传 tool 参数增量
              // 需要知道当前 block 对应的 callId，通过 index 反查
              // 简化：从 stream 内部状态拿
              const currentBlock = (stream as unknown as { currentMessage?: { content: Array<{ type: string; id?: string }> } })
                .currentMessage?.content[event.index];
              const callId = (currentBlock as { id?: string } | undefined)?.id ?? `block_${event.index}`;
              yield { type: 'tool_call_delta', callId, argumentsDelta: delta.partial_json };
            }
            break;
          }

          case 'content_block_stop': {
            // 找到对应 block，发 tool_call_end
            const msg = await stream.finalMessage().catch(() => null);
            if (msg) {
              const block = msg.content[event.index];
              if (block?.type === 'tool_use') {
                yield { type: 'tool_call_end', callId: block.id };
              }
            }
            break;
          }

          case 'message_delta': {
            if (event.usage) {
              // output tokens 在 message_delta 中
            }
            break;
          }

          case 'message_stop': {
            // 获取最终消息以拿到 usage
            try {
              const finalMsg = await stream.finalMessage();
              yield {
                type: 'usage',
                inputTokens: finalMsg.usage.input_tokens,
                outputTokens: finalMsg.usage.output_tokens,
              };

              const stopReason =
                finalMsg.stop_reason === 'tool_use'
                  ? 'tool_use'
                  : finalMsg.stop_reason === 'max_tokens'
                  ? 'max_tokens'
                  : 'end_turn';

              yield { type: 'done', stopReason };
            } catch {
              yield { type: 'done', stopReason: 'end_turn' };
            }
            break;
          }
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      yield { type: 'error', message: msg };
    }
  };
}

/**
 * Agent runLoop — 双层循环
 *
 * 外层循环（follow-up）：支持多轮对话
 * 内层循环（tool 调用）：处理单次 LLM 响应中的所有工具调用
 *
 * 参考 Pi 的 agent-loop.ts 设计：
 *   外层 → 内层 → 调用 LLM → 解析 tool_calls → 执行工具 → 追加结果 → 如无 tool_calls 退出内层
 */

import type {
  Message,
  ToolDefinition,
  StreamDelta,
  StreamFn,
  ToolResult,
} from '@easycode/ai';
import type { ToolRegistry } from '../tools/registry.js';

// ─── 事件类型（Agent Loop 对外暴露的事件流）──────────────────────────────

export type AgentEvent =
  | { type: 'text'; content: string }
  | { type: 'tool_start'; callId: string; name: string; input: string }
  | { type: 'tool_end'; callId: string; name: string; result: ToolResult; durationMs: number }
  | { type: 'tool_error'; callId: string; name: string; error: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; cacheReadTokens?: number }
  | { type: 'turn_end'; stopReason: 'end_turn' | 'tool_use' | 'max_tokens' }
  | { type: 'error'; message: string }
  | { type: 'done' };

// ─── 工具调用缓冲（流式拼接 arguments）──────────────────────────────────

interface ToolCallBuffer {
  callId: string;
  name: string;
  argumentsRaw: string;
  startTime: number;
}

// ─── 主循环 ────────────────────────────────────────────────────────────

export interface RunLoopOptions {
  messages: Message[];
  tools: ToolDefinition[];
  streamFn: StreamFn;
  registry: ToolRegistry;
  maxTurns?: number;
  onEvent?: (event: AgentEvent) => void;
  /** 用于中断循环（Ctrl+C 信号） */
  abortSignal?: AbortSignal;
}

/**
 * 双层 runLoop：
 *   外层 = follow-up 循环（最多 maxTurns 轮）
 *   内层 = 单轮 LLM 响应的工具调用处理
 */
export async function* runLoop(opts: RunLoopOptions): AsyncIterable<AgentEvent> {
  const {
    messages,
    tools,
    streamFn,
    registry,
    maxTurns = 50,
    abortSignal,
  } = opts;

  // 工作消息数组（会不断追加）
  const ctx: Message[] = [...messages];

  for (let turn = 0; turn < maxTurns; turn++) {
    if (abortSignal?.aborted) {
      yield { type: 'done' };
      return;
    }

    // ── 内层：处理单次 LLM 响应 ──────────────────────────────────────
    const toolBuffers = new Map<string, ToolCallBuffer>();
    let assistantText = '';
    let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' = 'end_turn';
    const assistantToolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];

    // 收集本轮的流式事件
    for await (const delta of streamFn(ctx, tools)) {
      if (abortSignal?.aborted) break;

      switch (delta.type) {
        case 'text_delta': {
          assistantText += delta.content;
          yield { type: 'text', content: delta.content };
          break;
        }

        case 'tool_call_start': {
          toolBuffers.set(delta.callId, {
            callId: delta.callId,
            name: delta.name,
            argumentsRaw: '',
            startTime: Date.now(),
          });
          break;
        }

        case 'tool_call_delta': {
          const buf = toolBuffers.get(delta.callId);
          if (buf) buf.argumentsRaw += delta.argumentsDelta;
          break;
        }

        case 'tool_call_end': {
          const buf = toolBuffers.get(delta.callId);
          if (buf) {
            let parsed: Record<string, unknown> = {};
            try {
              parsed = buf.argumentsRaw ? JSON.parse(buf.argumentsRaw) : {};
            } catch {
              // 解析失败时保留原始字符串
              parsed = { __raw: buf.argumentsRaw };
            }
            assistantToolUses.push({ id: buf.callId, name: buf.name, input: parsed });
            yield { type: 'tool_start', callId: buf.callId, name: buf.name, input: buf.argumentsRaw };
          }
          break;
        }

        case 'usage': {
          yield { type: 'usage', inputTokens: delta.inputTokens, outputTokens: delta.outputTokens, cacheReadTokens: delta.cacheReadTokens };
          break;
        }

        case 'done': {
          stopReason = delta.stopReason;
          break;
        }

        case 'error': {
          yield { type: 'error', message: delta.message };
          return;
        }
      }
    }

    // ── 将 assistant 消息追加到上下文 ──────────────────────────────────
    if (assistantToolUses.length > 0) {
      // 包含工具调用的 assistant 消息
      ctx.push({
        role: 'assistant',
        content: [
          ...(assistantText ? [{ type: 'text' as const, text: assistantText }] : []),
          ...assistantToolUses.map((tu) => ({
            type: 'tool_use' as const,
            id: tu.id,
            name: tu.name,
            input: tu.input,
          })),
        ],
      });
    } else if (assistantText) {
      ctx.push({ role: 'assistant', content: assistantText });
    }

    yield { type: 'turn_end', stopReason };

    // ── 如果没有工具调用，退出外层循环 ─────────────────────────────────
    if (assistantToolUses.length === 0) {
      yield { type: 'done' };
      return;
    }

    // ── 执行工具调用，收集结果 ──────────────────────────────────────────
    const toolResults: Message[] = [];

    for (const tu of assistantToolUses) {
      const startTime = toolBuffers.get(tu.id)?.startTime ?? Date.now();
      const toolDef = registry.get(tu.name);

      if (!toolDef) {
        const errorResult: ToolResult = {
          content: `错误：未知工具 "${tu.name}"，可用工具：${registry.getAll().map((t) => t.name).join(', ')}`,
          isError: true,
        };
        yield { type: 'tool_error', callId: tu.id, name: tu.name, error: errorResult.content };

        toolResults.push({
          role: 'tool',
          content: errorResult.content,
          tool_call_id: tu.id,
          tool_name: tu.name,
        });
        continue;
      }

      try {
        const result = await toolDef.execute(tu.input);
        const durationMs = Date.now() - startTime;

        yield { type: 'tool_end', callId: tu.id, name: tu.name, result, durationMs };

        toolResults.push({
          role: 'tool',
          content: result.content,
          tool_call_id: tu.id,
          tool_name: tu.name,
        });
      } catch (err) {
        const errorMsg = `工具执行异常：${err instanceof Error ? err.message : String(err)}`;
        yield { type: 'tool_error', callId: tu.id, name: tu.name, error: errorMsg };

        toolResults.push({
          role: 'tool',
          content: errorMsg,
          tool_call_id: tu.id,
          tool_name: tu.name,
        });
      }
    }

    // 将工具结果追加到上下文，继续外层循环
    ctx.push(...toolResults);
  }

  // 达到最大轮次
  yield { type: 'error', message: `已达到最大轮次限制（${maxTurns} 轮），任务中止。` };
  yield { type: 'done' };
}

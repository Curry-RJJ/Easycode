/**
 * Agent runLoop — 双层循环（M2 升级版）
 *
 * 新增特性（M2）：
 *   - M2.2 读写并发调度器（scheduleToolCalls）
 *   - M2.3 上下文压缩（compactIfNeeded）
 *   - 新事件类型：compaction / scheduler_log
 *
 * 外层循环（follow-up）：支持多轮对话
 * 内层循环（tool 调用）：处理单次 LLM 响应中的所有工具调用
 */

import type {
  Message,
  ToolDefinition,
  StreamFn,
  ToolResult,
} from '@easycode/ai';
import type { ToolRegistry } from '../tools/registry.js';
import { scheduleToolCalls, type ToolCallToExecute, type ToolExecutionResult } from '../tools/scheduler.js';
import { compactIfNeeded } from '../context/compaction.js';
import { TokenBudget, estimateContextTokens } from '../context/token.js';
import { checkToolApproval, type ApprovalPolicy } from '../security/policy.js';
import type { OnApprovalRequired, ApprovalDecision } from '../security/approval.js';

// ─── 事件类型（Agent Loop 对外暴露的事件流）──────────────────────────────

export type AgentEvent =
  | { type: 'text'; content: string }
  | { type: 'tool_start'; callId: string; name: string; input: string }
  | { type: 'tool_end'; callId: string; name: string; result: ToolResult; durationMs: number }
  | { type: 'tool_error'; callId: string; name: string; error: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; cacheReadTokens?: number }
  | { type: 'turn_end'; stopReason: 'end_turn' | 'tool_use' | 'max_tokens' }
  | { type: 'error'; message: string }
  | {
      type: 'compaction';
      savedTokens: number;
      currentTokens: number;
      summary: string;
    }
  | {
      type: 'approval_required';
      callId: string;
      toolName: string;
      reason: string;
    }
  | {
      type: 'approval_decision';
      callId: string;
      toolName: string;
      decision: ApprovalDecision;
    }
  | {
      type: 'tool_blocked';
      callId: string;
      toolName: string;
      reason: string;
    }
  | { type: 'aborted' }
  | { type: 'done' };

// ─── 工具调用缓冲（流式拼接 arguments）──────────────────────────────────

interface ToolCallBuffer {
  callId: string;
  name: string;
  argumentsRaw: string;
  startTime: number;
}

// ─── 主循环配置 ────────────────────────────────────────────────────────

export interface RunLoopOptions {
  messages: Message[];
  tools: ToolDefinition[];
  streamFn: StreamFn;
  registry: ToolRegistry;
  maxTurns?: number;
  onEvent?: (event: AgentEvent) => void;
  /** 用于中断循环（Ctrl+C 信号） */
  abortSignal?: AbortSignal;
  /** M2.3：是否启用上下文压缩（默认 false） */
  enableCompaction?: boolean;
  /** M2.3：压缩阈值 0-1（默认 0.8） */
  compactionThreshold?: number;
  /** M2.3：模型名称（用于获取上下文窗口大小） */
  model?: string;
  /** M2.3：保留最近 N 轮对话（默认 3） */
  keepRecentTurns?: number;
  /** M3.1：审批策略（默认 ask） */
  approvalPolicy?: ApprovalPolicy;
  /** M3.1：审批回调（CLI 层实现 UI，core 层调用） */
  onApprovalRequired?: OnApprovalRequired;
}

// ─── 主循环 ────────────────────────────────────────────────────────────

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
    enableCompaction = false,
    compactionThreshold = 0.8,
    model = 'deepseek/deepseek-chat',
    keepRecentTurns = 3,
    approvalPolicy = 'ask',
    onApprovalRequired,
  } = opts;

  // M3.1：会话级"全部放行"缓存（allow_all 决策后生效）
  const allowAllTools = new Set<string>();

  // 工作消息数组（会不断追加）
  const ctx: Message[] = [...messages];

  // M2.3: Token 预算跟踪器
  const budget = new TokenBudget(model, compactionThreshold);
  budget.update(ctx);

  for (let turn = 0; turn < maxTurns; turn++) {
    if (abortSignal?.aborted) {
      yield { type: 'done' };
      return;
    }

    // ── M2.3：压缩检查（每轮开始前） ──────────────────────────────────
    if (enableCompaction && budget.shouldCompact()) {
      const compacted = await compactIfNeeded(ctx, streamFn, {
        enabled: true,
        threshold: compactionThreshold,
        currentTokens: budget.currentTokens,
        contextWindow: budget.maxTokens,
        keepRecentTurns,
      });

      if (compacted.triggered) {
        // 原地替换上下文
        ctx.splice(0, ctx.length, ...compacted.messages);
        budget.update(ctx);

        yield {
          type: 'compaction',
          savedTokens: compacted.savedTokens,
          currentTokens: compacted.currentTokens,
          summary: compacted.summary ?? '',
        };
      }
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
              parsed = { __raw: buf.argumentsRaw };
            }
            assistantToolUses.push({ id: buf.callId, name: buf.name, input: parsed });
            yield { type: 'tool_start', callId: buf.callId, name: buf.name, input: buf.argumentsRaw };
          }
          break;
        }

        case 'usage': {
          budget.addUsage(delta.inputTokens, delta.outputTokens);
          yield {
            type: 'usage',
            inputTokens: delta.inputTokens,
            outputTokens: delta.outputTokens,
            cacheReadTokens: delta.cacheReadTokens,
          };
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

    // ── M2.2 + M3.1：安全审批 + 调度器并发执行工具调用 ───────────────
    const toolsToExecute: ToolCallToExecute[] = [];
    let shouldAbort = false;

    for (const tu of assistantToolUses) {
      if (shouldAbort) break;

      const startTime = toolBuffers.get(tu.id)?.startTime ?? Date.now();
      const toolDef = registry.get(tu.name);

      if (!toolDef) {
        // 未知工具：立即报错，不进入调度器
        const errorResult: ToolResult = {
          content: `错误：未知工具 "${tu.name}"，可用工具：${registry.getAll().map((t) => t.name).join(', ')}`,
          isError: true,
        };
        yield { type: 'tool_error', callId: tu.id, name: tu.name, error: errorResult.content };
        ctx.push({
          role: 'tool',
          content: errorResult.content,
          tool_call_id: tu.id,
          tool_name: tu.name,
        });
        continue;
      }

      // M3.1：安全审批检查
      // 已在 allow_all 缓存中 → 直接放行
      if (!allowAllTools.has(tu.name)) {
        const approvalCheck = checkToolApproval(tu.name, tu.input, approvalPolicy);

        if (approvalCheck.isBlocked) {
          // never 策略 / 直接拒绝
          const blockMsg = approvalCheck.reason ?? `工具 "${tu.name}" 被安全策略拒绝`;
          yield { type: 'tool_blocked', callId: tu.id, toolName: tu.name, reason: blockMsg };
          ctx.push({ role: 'tool', content: blockMsg, tool_call_id: tu.id, tool_name: tu.name });
          continue;
        }

        if (approvalCheck.needsApproval && onApprovalRequired) {
          // 弹出审批 UI（async：等待用户输入）
          yield { type: 'approval_required', callId: tu.id, toolName: tu.name, reason: approvalCheck.reason ?? '需要确认' };

          const decision = await onApprovalRequired({
            callId: tu.id,
            toolName: tu.name,
            input: tu.input,
            reason: approvalCheck.reason ?? '需要确认',
          });

          yield { type: 'approval_decision', callId: tu.id, toolName: tu.name, decision };

          if (decision === 'deny') {
            const denyMsg = `用户拒绝执行工具 "${tu.name}"`;
            ctx.push({ role: 'tool', content: denyMsg, tool_call_id: tu.id, tool_name: tu.name });
            continue;
          }
          if (decision === 'deny_abort') {
            yield { type: 'aborted' };
            yield { type: 'done' };
            return;
          }
          if (decision === 'allow_all') {
            allowAllTools.add(tu.name);
          }
          // allow_once / allow_all → 继续执行
        }
      }

      toolsToExecute.push({ callId: tu.id, name: tu.name, input: tu.input, toolDef, startTime });
    }

    if (shouldAbort) {
      yield { type: 'done' };
      return;
    }

    // 调度执行（readonly 并发，write 串行，exclusive 独占）
    const scheduledResults: ToolExecutionResult[] = [];

    if (toolsToExecute.length > 0) {
      const results = await scheduleToolCalls(toolsToExecute);
      scheduledResults.push(...results);
    }

    // 按结果生成事件并追加到上下文（保持原始顺序）
    const toolResultMessages: Message[] = [];

    for (const r of scheduledResults) {
      if (r.result.isError) {
        yield { type: 'tool_error', callId: r.callId, name: r.name, error: r.result.content };
      } else {
        yield { type: 'tool_end', callId: r.callId, name: r.name, result: r.result, durationMs: r.durationMs };
      }
      toolResultMessages.push({
        role: 'tool',
        content: r.result.content,
        tool_call_id: r.callId,
        tool_name: r.name,
      });
    }

    // 将工具结果追加到上下文，继续外层循环
    ctx.push(...toolResultMessages);

    // 更新 token 预算
    budget.update(ctx);
  }

  // 达到最大轮次
  yield { type: 'error', message: `已达到最大轮次限制（${maxTurns} 轮），任务中止。` };
  yield { type: 'done' };
}

// ─── 辅助导出 ──────────────────────────────────────────────────────────

/** 获取当前上下文的估算 token 数（供 CLI 显示进度条） */
export { estimateContextTokens };

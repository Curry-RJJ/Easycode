/**
 * ToolExecutionScheduler — 读写并发调度器
 *
 * 调度规则（参考 DSH 的并发执行策略）：
 *   - readonly   → 可与其他 readonly 工具并发执行（Promise.all）
 *   - write      → 串行，等待前一个 write 完成
 *   - exclusive  → 独占，等所有其他工具完成后再执行（bash 等副作用强的工具）
 *
 * 混合顺序：先跑完所有 readonly（并发），再跑 write（串行），再跑 exclusive（串行）。
 *
 * 验收：read_file(a.ts) + read_file(b.ts) + edit_file(c.ts) →
 *        前两个并发执行，第三个等前两个完成后串行执行。
 */

import type { ToolDefinition, ToolResult } from '@easycode/ai';

// ─── 类型定义 ─────────────────────────────────────────────────────────

export interface ToolCallToExecute {
  /** LLM 分配的工具调用 ID */
  callId: string;
  /** 工具名称 */
  name: string;
  /** 解析后的参数对象 */
  input: Record<string, unknown>;
  /** 工具定义（含 concurrency 标注） */
  toolDef: ToolDefinition;
  /** 工具调用开始时间戳（毫秒，用于 duration 计算） */
  startTime: number;
}

export interface ToolExecutionResult {
  callId: string;
  name: string;
  result: ToolResult;
  /** 实际执行耗时（毫秒） */
  durationMs: number;
  /** 并发模式（用于日志/可视化） */
  concurrencyMode: 'readonly' | 'write' | 'exclusive';
  /** 实际执行开始时间戳 */
  executedAt: number;
}

/** 每次工具执行完成后的回调（用于 UI 实时更新） */
export type OnToolComplete = (result: ToolExecutionResult) => void;

// ─── 调度器主函数 ─────────────────────────────────────────────────────

/**
 * 按并发策略调度执行一批工具调用。
 *
 * @param calls         本轮需要执行的工具列表（原始顺序）
 * @param onComplete    每个工具完成时的回调（出于 UI 需要，实时通知）
 * @returns             按原始顺序排列的执行结果（保证顺序，方便构建消息）
 */
export async function scheduleToolCalls(
  calls: ToolCallToExecute[],
  onComplete?: OnToolComplete
): Promise<ToolExecutionResult[]> {
  if (calls.length === 0) return [];

  // 按 callId 存放结果
  const resultMap = new Map<string, ToolExecutionResult>();

  // ── 单个工具执行包装 ──────────────────────────────────────────────────
  async function executeOne(call: ToolCallToExecute): Promise<void> {
    const executedAt = Date.now();
    try {
      const result = await call.toolDef.execute(call.input);
      const r: ToolExecutionResult = {
        callId: call.callId,
        name: call.name,
        result,
        durationMs: Date.now() - executedAt,
        concurrencyMode: call.toolDef.concurrency,
        executedAt,
      };
      resultMap.set(call.callId, r);
      onComplete?.(r);
    } catch (err) {
      const r: ToolExecutionResult = {
        callId: call.callId,
        name: call.name,
        result: {
          content: `工具执行异常：${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        },
        durationMs: Date.now() - executedAt,
        concurrencyMode: call.toolDef.concurrency,
        executedAt,
      };
      resultMap.set(call.callId, r);
      onComplete?.(r);
    }
  }

  // ── 按并发属性分组 ────────────────────────────────────────────────────
  const readonlyCalls = calls.filter((c) => c.toolDef.concurrency === 'readonly');
  const writeCalls = calls.filter((c) => c.toolDef.concurrency === 'write');
  const exclusiveCalls = calls.filter((c) => c.toolDef.concurrency === 'exclusive');

  // ── 执行顺序：readonly → write → exclusive ────────────────────────────

  // 1. readonly：并发执行（Promise.all）
  if (readonlyCalls.length > 0) {
    await Promise.all(readonlyCalls.map(executeOne));
  }

  // 2. write：串行执行
  for (const call of writeCalls) {
    await executeOne(call);
  }

  // 3. exclusive：串行执行（独占，不与任何其他类型并发）
  for (const call of exclusiveCalls) {
    await executeOne(call);
  }

  // ── 按原始顺序返回结果 ────────────────────────────────────────────────
  return calls.map((c) => {
    const r = resultMap.get(c.callId);
    if (!r) {
      // 防御性：不应发生
      return {
        callId: c.callId,
        name: c.name,
        result: { content: '调度器内部错误：结果丢失', isError: true },
        durationMs: 0,
        concurrencyMode: c.toolDef.concurrency,
        executedAt: Date.now(),
      };
    }
    return r;
  });
}

// ─── 执行日志格式化 ────────────────────────────────────────────────────

export interface SchedulerLog {
  toolName: string;
  concurrencyMode: 'readonly' | 'write' | 'exclusive';
  startTime: number;
  duration: number;
  isError: boolean;
}

/** 从调度结果提取执行日志（供 M2.2.3 使用） */
export function extractSchedulerLog(results: ToolExecutionResult[]): SchedulerLog[] {
  return results.map((r) => ({
    toolName: r.name,
    concurrencyMode: r.concurrencyMode,
    startTime: r.executedAt,
    duration: r.durationMs,
    isError: !!r.result.isError,
  }));
}

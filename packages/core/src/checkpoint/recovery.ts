/**
 * 崩溃恢复 — 合成闭合事件
 *
 * 参考 DSH 的 `interruptedTurnClosers` 设计：
 * 找出所有 tool/call 中没有对应 tool/result 的 callId，
 * 合成"结果未知"的错误闭合事件，文本本身就是给模型的恢复指令。
 *
 * 这样比直接重试更安全：模型自己决定是否需要重新执行（避免重复副作用）。
 */

import type { EventRecord, ExtractEvent } from '../session/types.js';

// ─── 分析函数 ─────────────────────────────────────────────────────────

/** 找出所有未闭合的 tool/call（没有对应 tool/result 的） */
export function findOpenToolCalls(events: EventRecord[]): ExtractEvent<'tool/call'>[] {
  const calls = new Map<string, ExtractEvent<'tool/call'>>();
  const results = new Set<string>();

  for (const event of events) {
    if (event.type === 'tool/call') {
      calls.set(event.data.callId, event);
    } else if (event.type === 'tool/result') {
      results.add(event.data.callId);
    }
  }

  const open: ExtractEvent<'tool/call'>[] = [];
  for (const [callId, callEvent] of calls) {
    if (!results.has(callId)) {
      open.push(callEvent);
    }
  }

  return open;
}

/** 判断 session 是否需要恢复（有未闭合的 tool/call） */
export function needsRecovery(events: EventRecord[]): boolean {
  return findOpenToolCalls(events).length > 0;
}

// ─── 合成闭合事件 ─────────────────────────────────────────────────────

/**
 * 为每个未闭合的 tool/call 合成一条"结果未知"的 tool/result 事件。
 *
 * 合成事件的文本内容是给 LLM 的恢复指令，让模型判断是否需要重试。
 * 这些事件需要追加到 JSONL 末尾（由调用方负责写入）。
 *
 * @returns 需要追加到 JSONL 的合成事件列表
 */
export function synthesizeClosingEvents(events: EventRecord[]): EventRecord[] {
  const openCalls = findOpenToolCalls(events);
  if (openCalls.length === 0) return [];

  const startSeq = events.length > 0 ? Math.max(...events.map((e) => e.seq)) + 1 : 0;
  const now = Date.now();

  return openCalls.map((call, i) => ({
    seq: startSeq + i,
    ts: now,
    type: 'tool/result' as const,
    data: {
      callId: call.data.callId,
      content: [
        `TOOL_OUTCOME_UNKNOWN: 进程在工具执行期间意外中断。`,
        `工具名称：${call.data.name}`,
        `工具 ID：${call.data.callId}`,
        `输入参数：${JSON.stringify(call.data.input, null, 2)}`,
        ``,
        `请分析以下情况并决定下一步：`,
        `1. 如果该操作是幂等的（如读取文件），可以重新执行。`,
        `2. 如果该操作可能已部分完成（如写入文件），请先确认当前状态再决定是否重试。`,
        `3. 如果不确定，请向用户说明情况并询问是否继续。`,
      ].join('\n'),
      isError: true,
    },
  }));
}

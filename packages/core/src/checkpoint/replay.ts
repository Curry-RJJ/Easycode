/**
 * 事件重放 — 将 JSONL 事件列表重建为 Agent 上下文（Message[]）
 *
 * 用途：从崩溃/中断的 session 中恢复，构造出与崩溃前等价的消息数组，
 * 然后交给 Agent.resume() 继续执行。
 *
 * 重放规则：
 *   - session/start   → 写入 system prompt
 *   - user/message    → 写入 user 消息（先 flush assistant 缓冲）
 *   - assistant/text  → 缓冲到当前轮次
 *   - tool/call       → 缓冲到当前轮次
 *   - tool/result     → flush assistant 缓冲 → 写入 tool 消息
 *   - compaction      → 清除历史 → 写入摘要（保持上下文精简）
 *   - session/end     → 最终 flush
 */

import type { Message } from '@easycode/ai';
import type { EventRecord } from '../session/types.js';

// ─── 内部类型 ─────────────────────────────────────────────────────────

interface ReplayResult {
  /** 重建的消息数组（可直接传给 Agent.resume()） */
  messages: Message[];
  /** system prompt（从 session/start 提取） */
  systemPrompt: string;
  /** 最后的用户消息内容 */
  lastUserMessage: string;
}

// ─── 主函数 ────────────────────────────────────────────────────────────

/**
 * 将事件列表重放为 Message[]。
 *
 * 处理了以下复杂情况：
 * 1. 多轮对话（多个 user/message）
 * 2. 一轮内多个工具调用（同一个 assistant 消息包含多个 tool_use block）
 * 3. 压缩事件（compaction）— 清除历史只保留 system + 摘要
 * 4. 崩溃恢复的合成 tool/result 事件（isError=true 的 TOOL_OUTCOME_UNKNOWN）
 */
export function replayToMessages(events: EventRecord[]): ReplayResult {
  let systemPrompt = '';
  let lastUserMessage = '';
  const messages: Message[] = [];

  // ── 当前轮次的 assistant 缓冲 ────────────────────────────────────────
  let bufferedText = '';
  const bufferedToolUses: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
  }> = [];

  /** 将缓冲的 assistant 内容 flush 为一条 assistant 消息 */
  function flushAssistant(): void {
    if (!bufferedText && bufferedToolUses.length === 0) return;

    messages.push({
      role: 'assistant',
      content: [
        ...(bufferedText ? [{ type: 'text' as const, text: bufferedText }] : []),
        ...bufferedToolUses.map((tu) => ({
          type: 'tool_use' as const,
          id: tu.id,
          name: tu.name,
          input: tu.input,
        })),
      ],
    });

    bufferedText = '';
    bufferedToolUses.length = 0;
  }

  for (const event of events) {
    switch (event.type) {
      case 'session/start': {
        systemPrompt = event.data.systemPrompt;
        messages.push({ role: 'system', content: event.data.systemPrompt });
        break;
      }

      case 'user/message': {
        // 新的用户消息前，先 flush 上一轮 assistant 缓冲
        flushAssistant();
        lastUserMessage = event.data.content;
        messages.push({ role: 'user', content: event.data.content });
        break;
      }

      case 'assistant/text': {
        bufferedText += event.data.content;
        break;
      }

      case 'tool/call': {
        bufferedToolUses.push({
          id: event.data.callId,
          name: event.data.name,
          input: event.data.input,
        });
        break;
      }

      case 'tool/result': {
        // tool/result 之前：flush assistant（把 text + tool_uses 合并为一条 assistant 消息）
        flushAssistant();
        messages.push({
          role: 'tool',
          content: event.data.content,
          tool_call_id: event.data.callId,
        });
        break;
      }

      case 'compaction': {
        // 压缩事件：丢弃所有历史消息，只保留 system 和摘要
        // 1. 先 flush 未完成的 assistant 内容（不应有，但防御性处理）
        flushAssistant();

        // 2. 只保留 system 消息
        const systemMessages = messages.filter((m) => m.role === 'system');
        messages.length = 0;
        messages.push(...systemMessages);

        // 3. 将摘要以 user→assistant 对话形式注入
        messages.push({
          role: 'user',
          content: `【上下文已压缩，以下是截至目前的工作摘要】\n\n${event.data.summary}`,
        });
        messages.push({
          role: 'assistant',
          content: '已了解。我会基于上述摘要继续完成任务。',
        });
        break;
      }

      case 'token/usage':
      case 'approval':
        // 这些事件不影响消息数组，跳过
        break;

      case 'session/end': {
        flushAssistant();
        break;
      }
    }
  }

  // 处理末尾未 flush 的 assistant 内容（正常不应有，防御性处理）
  flushAssistant();

  return { messages, systemPrompt, lastUserMessage };
}

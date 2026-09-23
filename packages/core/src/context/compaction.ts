/**
 * 上下文压缩（Context Compaction）
 *
 * 压缩触发后：
 *   1. 保留：system prompt（不动）
 *   2. 保留：最近 N 轮完整对话（默认 3 轮）
 *   3. 压缩：中间历史消息 → 用 LLM 生成摘要（一段话总结完成了什么）
 *   4. 替换：中间消息改为 user→assistant 摘要对话对
 *   5. 返回：新的消息数组 + 统计信息
 *
 * 参考 Pi 的上下文压缩设计（保留最近 N 轮 + LLM 摘要替换中间历史）。
 */

import type { Message, StreamFn } from '@easycode/ai';
import { estimateContextTokens } from './token.js';

// ─── 类型定义 ─────────────────────────────────────────────────────────

export interface CompactionResult {
  /** 是否实际触发了压缩 */
  triggered: boolean;
  /** 压缩后的消息数组 */
  messages: Message[];
  /** 压缩节省的估算 token 数 */
  savedTokens: number;
  /** 压缩后的 token 数 */
  currentTokens: number;
  /** LLM 生成的摘要文本（triggered=true 时有值） */
  summary?: string;
}

export interface CompactionOptions {
  /** 是否启用压缩（默认 false，需显式开启） */
  enabled: boolean;
  /** 触发压缩的 token 使用率阈值（0-1，默认 0.8） */
  threshold: number;
  /** 当前上下文 token 数（由外层跟踪） */
  currentTokens: number;
  /** 模型上下文窗口大小（token） */
  contextWindow: number;
  /** 保留最近 N 轮对话（默认 3） */
  keepRecentTurns?: number;
}

// ─── 内部工具函数 ─────────────────────────────────────────────────────

/**
 * 将消息数组按"轮次"分组。
 * 一轮 = 一条 user 消息 + 其后的所有 assistant/tool 消息（直到下一条 user 消息）。
 */
function groupIntoTurns(messages: Message[]): Message[][] {
  const turns: Message[][] = [];
  let current: Message[] = [];

  for (const msg of messages) {
    if (msg.role === 'user' && current.length > 0) {
      turns.push(current);
      current = [];
    }
    current.push(msg);
  }
  if (current.length > 0) turns.push(current);

  return turns;
}

/**
 * 将消息转为便于 LLM 摘要的纯文本。
 */
function messagesToText(messages: Message[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    const role = msg.role === 'user' ? 'User' : msg.role === 'assistant' ? 'Assistant' : 'Tool';
    if (typeof msg.content === 'string') {
      lines.push(`${role}: ${msg.content}`);
    } else {
      for (const block of msg.content) {
        if ('text' in block && block.text) {
          lines.push(`${role}: ${block.text}`);
        } else if ('type' in block && block.type === 'tool_use') {
          lines.push(`${role} → [工具调用] ${block.name}(${JSON.stringify(block.input)})`);
        } else if ('content' in block && typeof block.content === 'string') {
          lines.push(`Tool Result: ${block.content.slice(0, 500)}`);
        }
      }
    }
  }
  return lines.join('\n');
}

// ─── LLM 摘要调用 ─────────────────────────────────────────────────────

const SUMMARY_SYSTEM_PROMPT = `你是一个专业的对话摘要助手。请对以下 AI 编程助手的工作会话进行精炼摘要。

要求：
1. 用中文输出
2. 重点描述：已完成了哪些具体操作（读/改/运行了哪些文件和命令）
3. 当前状态：任务进展到哪个阶段，还有什么待完成
4. 关键发现：代码中发现的重要信息（bug、结构、依赖关系等）
5. 篇幅控制在 300-600 字以内，不要遗漏重要的技术细节`;

/**
 * 调用 LLM 为历史消息生成摘要。
 */
async function generateSummary(
  streamFn: StreamFn,
  historyMessages: Message[]
): Promise<string> {
  const historyText = messagesToText(historyMessages);
  const prompt = `请对以下编程助手会话历史进行摘要：\n\n${historyText}\n\n---\n请输出摘要：`;

  const summaryMessages: Message[] = [
    { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ];

  let summary = '';

  try {
    for await (const delta of streamFn(summaryMessages, [], {
      maxTokens: 800,
      temperature: 0.3,
    })) {
      if (delta.type === 'text_delta') {
        summary += delta.content;
      } else if (delta.type === 'done' || delta.type === 'error') {
        break;
      }
    }
  } catch {
    summary = `[摘要生成失败，已截断历史上下文，保留最近对话记录]`;
  }

  return summary.trim() || '[历史上下文已截断]';
}

// ─── 主函数 ────────────────────────────────────────────────────────────

/**
 * 检查是否需要压缩，需要时执行压缩并返回新的消息数组。
 *
 * @param ctx       当前消息数组
 * @param streamFn  LLM 调用函数（用于生成摘要）
 * @param opts      压缩配置
 * @returns         压缩结果（triggered=false 表示未触发压缩）
 */
export async function compactIfNeeded(
  ctx: Message[],
  streamFn: StreamFn,
  opts: CompactionOptions
): Promise<CompactionResult> {
  const { enabled, threshold, currentTokens, contextWindow, keepRecentTurns = 3 } = opts;

  // 未启用，或未达阈值
  if (!enabled || currentTokens < contextWindow * threshold) {
    return {
      triggered: false,
      messages: ctx,
      savedTokens: 0,
      currentTokens,
    };
  }

  // ── 分离 system 消息 ────────────────────────────────────────────────
  const systemMessages = ctx.filter((m) => m.role === 'system');
  const nonSystemMessages = ctx.filter((m) => m.role !== 'system');

  // 消息太少，没有压缩空间（system + 少于 2 轮）
  const turns = groupIntoTurns(nonSystemMessages);
  if (turns.length <= keepRecentTurns) {
    return {
      triggered: false,
      messages: ctx,
      savedTokens: 0,
      currentTokens,
    };
  }

  // ── 分割：历史 vs 最近 N 轮 ─────────────────────────────────────────
  const historyTurns = turns.slice(0, turns.length - keepRecentTurns);
  const recentTurns = turns.slice(turns.length - keepRecentTurns);

  const historyMessages = historyTurns.flat();
  const recentMessages = recentTurns.flat();

  // ── 生成摘要 ─────────────────────────────────────────────────────────
  const summary = await generateSummary(streamFn, historyMessages);

  // ── 构建压缩后的上下文 ───────────────────────────────────────────────
  const compactedCtx: Message[] = [
    ...systemMessages,
    {
      role: 'user',
      content: `【上下文已自动压缩，以下是历史工作摘要】\n\n${summary}`,
    },
    {
      role: 'assistant',
      content: '好的，我已了解历史进度。现在继续完成剩余任务。',
    },
    ...recentMessages,
  ];

  const beforeTokens = currentTokens;
  const afterTokens = estimateContextTokens(compactedCtx);
  const savedTokens = Math.max(0, beforeTokens - afterTokens);

  return {
    triggered: true,
    messages: compactedCtx,
    savedTokens,
    currentTokens: afterTokens,
    summary,
  };
}

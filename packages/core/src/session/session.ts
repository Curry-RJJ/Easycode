/**
 * SessionRecorder — 会话记录器
 *
 * 在 Agent 运行期间持续记录事件到 JSONL，
 * 提供高层 API 屏蔽底层存储细节。
 */

import { randomUUID } from 'crypto';
import type { EventRecord } from './types.js';
import {
  appendEvent,
  createSessionEntry,
  updateSessionStatus,
  readEvents,
  sessionExists,
} from './storage.js';

// ─── 类型 ─────────────────────────────────────────────────────────────

export interface SessionStartOptions {
  model: string;
  systemPrompt: string;
  prompt: string;
}

/** start() 已调用后暴露的只读信息 */
export interface SessionInfo {
  sessionId: string;
  model: string;
  prompt: string;
  startedAt: number;
}

// ─── SessionRecorder ──────────────────────────────────────────────────

export class SessionRecorder {
  readonly sessionId: string;
  private _seq = 0;
  private _info: SessionInfo | null = null;

  constructor(sessionId?: string) {
    this.sessionId = sessionId ?? randomUUID();
  }

  get info(): SessionInfo {
    if (!this._info) throw new Error('Session 尚未调用 start()');
    return this._info;
  }

  /**
   * 开始记录新 Session。
   * 创建 SQLite 索引记录，并写入第一条 session/start 事件。
   */
  start(opts: SessionStartOptions): void {
    const now = Date.now();
    this._info = {
      sessionId: this.sessionId,
      model: opts.model,
      prompt: opts.prompt,
      startedAt: now,
    };

    // 写入 SQLite 索引
    createSessionEntry({
      id: this.sessionId,
      model: opts.model,
      prompt: opts.prompt,
      status: 'running',
    });

    // 写入首条事件
    this._append({
      type: 'session/start',
      data: {
        id: this.sessionId,
        model: opts.model,
        systemPrompt: opts.systemPrompt,
        prompt: opts.prompt,
      },
    });
  }

  /**
   * 记录任意事件（自动附加 seq + ts）。
   * 调用前必须先调用 start()。
   */
  record(event: Omit<EventRecord, 'seq' | 'ts'>): void {
    this._append(event);
  }

  // ─── 快捷方法 ────────────────────────────────────────────────────────

  recordUserMessage(content: string): void {
    this._append({ type: 'user/message', data: { content } });
  }

  recordAssistantText(content: string): void {
    if (!content) return;
    this._append({ type: 'assistant/text', data: { content } });
  }

  recordToolCall(callId: string, name: string, input: Record<string, unknown>): void {
    this._append({ type: 'tool/call', data: { callId, name, input } });
  }

  recordToolResult(callId: string, content: string, isError: boolean): void {
    this._append({ type: 'tool/result', data: { callId, content, isError } });
  }

  recordTokenUsage(input: number, output: number, cacheRead?: number): void {
    this._append({
      type: 'token/usage',
      data: { input, output, ...(cacheRead !== undefined ? { cacheRead } : {}) },
    });
  }

  recordCompaction(opts: {
    reason: string;
    summaryTokens: number;
    savedTokens: number;
    summary: string;
  }): void {
    this._append({ type: 'compaction', data: opts });
  }

  /** 会话正常完成 */
  complete(): void {
    this._append({ type: 'session/end', data: { reason: 'completed' } });
    updateSessionStatus(this.sessionId, 'completed');
  }

  /** 会话被中断（Ctrl+C） */
  interrupt(): void {
    this._append({ type: 'session/end', data: { reason: 'interrupted' } });
    updateSessionStatus(this.sessionId, 'interrupted');
  }

  /** 会话因错误终止 */
  error(message: string): void {
    this._append({ type: 'session/end', data: { reason: 'error', message } });
    updateSessionStatus(this.sessionId, 'error');
  }

  // ─── 静态工厂 ─────────────────────────────────────────────────────────

  /**
   * 从已有 JSONL 文件恢复 Recorder（用于 resume 时继续追加事件）。
   * 恢复 seq 计数，确保不重复。
   */
  static fromExisting(sessionId: string): SessionRecorder {
    if (!sessionExists(sessionId)) {
      throw new Error(`Session 不存在：${sessionId}`);
    }
    const recorder = new SessionRecorder(sessionId);
    const events = readEvents(sessionId);
    recorder._seq = events.length > 0 ? Math.max(...events.map((e) => e.seq)) + 1 : 0;
    return recorder;
  }

  // ─── 私有方法 ─────────────────────────────────────────────────────────

  private _append(event: Omit<EventRecord, 'seq' | 'ts'>): void {
    const full = {
      seq: this._seq++,
      ts: Date.now(),
      ...event,
    } as EventRecord;
    appendEvent(this.sessionId, full);
  }
}

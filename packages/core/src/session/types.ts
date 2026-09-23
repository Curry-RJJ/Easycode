/**
 * 事件溯源系统的核心事件类型
 *
 * 每个会话（Session）由一系列 EventRecord 组成，按 seq 严格递增。
 * 存储格式：每行一个 JSON 对象（JSONL），追加写入，不修改历史。
 *
 * 参考 DSH 的事件 JSONL 格式（每行一个事件，seq 严格递增）。
 */

// ─── 基础字段 ─────────────────────────────────────────────────────────

interface BaseEvent {
  /** 严格递增的序列号，用于排序和去重 */
  seq: number;
  /** 事件发生的 Unix 时间戳（毫秒） */
  ts: number;
}

// ─── 事件联合类型 ──────────────────────────────────────────────────────

export type EventRecord =
  | (BaseEvent & {
      type: 'session/start';
      data: {
        id: string;
        model: string;
        systemPrompt: string;
        /** 本 session 的首条用户指令 */
        prompt: string;
      };
    })
  | (BaseEvent & {
      type: 'user/message';
      data: { content: string };
    })
  | (BaseEvent & {
      type: 'assistant/text';
      /** 本轮 assistant 文本（完整，非流式 delta） */
      data: { content: string };
    })
  | (BaseEvent & {
      type: 'tool/call';
      data: {
        callId: string;
        name: string;
        input: Record<string, unknown>;
      };
    })
  | (BaseEvent & {
      type: 'tool/result';
      data: {
        callId: string;
        content: string;
        isError: boolean;
      };
    })
  | (BaseEvent & {
      type: 'token/usage';
      data: {
        input: number;
        output: number;
        cacheRead?: number;
        cacheWrite?: number;
      };
    })
  | (BaseEvent & {
      type: 'compaction';
      data: {
        /** 触发压缩的原因 */
        reason: string;
        /** 压缩摘要的 token 数 */
        summaryTokens: number;
        /** 压缩节省的估算 token 数 */
        savedTokens: number;
        /** 摘要文本（用于 replay 时重建上下文） */
        summary: string;
      };
    })
  | (BaseEvent & {
      type: 'approval';
      data: {
        callId: string;
        policy: 'ask' | 'auto' | 'never';
        decision: 'allow_once' | 'allow_all' | 'deny' | 'deny_abort';
      };
    })
  | (BaseEvent & {
      type: 'session/end';
      data: {
        reason: 'completed' | 'interrupted' | 'error';
        message?: string;
      };
    });

export type EventType = EventRecord['type'];

/** 辅助：按 type 提取具体事件类型 */
export type ExtractEvent<T extends EventType> = Extract<EventRecord, { type: T }>;

/**
 * @easycode/ai — 核心类型定义
 *
 * LLM 消息格式、工具定义、流式 Delta、StreamFn 抽象
 */

// ─── 内容块（多模态支持预留）────────────────────────────────────────────
export type TextBlock = { type: 'text'; text: string };
export type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
export type ToolResultBlock = { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };
export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

// ─── 消息格式（统一内部表示）─────────────────────────────────────────────
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export type Message = {
  role: MessageRole;
  content: string | ContentBlock[];
  /** 工具调用 ID（role=tool 时必填，用于匹配 tool_use） */
  tool_call_id?: string;
  /** 工具名称（role=tool 时） */
  tool_name?: string;
};

// ─── JSON Schema 精简类型（工具参数描述）──────────────────────────────────
export type JSONSchemaType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';

export type JSONSchema = {
  type?: JSONSchemaType | JSONSchemaType[];
  description?: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  enum?: unknown[];
  default?: unknown;
  additionalProperties?: boolean | JSONSchema;
};

// ─── 工具定义（供 LLM 调用）──────────────────────────────────────────────
/**
 * concurrency 声明该工具的并发属性（供 M2.2 调度器使用）：
 *   - readonly   → 可与其他 readonly 工具并发执行
 *   - write      → 串行，等待前一个 write 完成
 *   - exclusive  → 独占，等所有其他工具完成（bash 等副作用强的工具）
 */
export type ToolConcurrency = 'readonly' | 'write' | 'exclusive';

export type ToolResult = {
  content: string;
  isError?: boolean;
};

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: JSONSchema;
  concurrency: ToolConcurrency;
  execute: (input: Record<string, unknown>) => Promise<ToolResult>;
};

// ─── 流式输出 Delta（Agent Loop 消费的统一格式）───────────────────────────
export type StreamDelta =
  | { type: 'text_delta'; content: string }
  | { type: 'tool_call_start'; callId: string; name: string }
  | { type: 'tool_call_delta'; callId: string; argumentsDelta: string }
  | { type: 'tool_call_end'; callId: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }
  | { type: 'done'; stopReason: 'end_turn' | 'tool_use' | 'max_tokens' }
  | { type: 'error'; message: string };

// ─── StreamFn 选项 ─────────────────────────────────────────────────────
export type StreamOptions = {
  /** 最大输出 token 数 */
  maxTokens?: number;
  /** 温度 */
  temperature?: number;
  /** 系统提示词（有些 Provider 通过独立字段传递） */
  system?: string;
};

/**
 * 核心抽象：一个返回 AsyncIterable<StreamDelta> 的函数。
 * Agent Loop 只依赖这一个接口，与具体 Provider 完全解耦。
 */
export type StreamFn = (
  messages: Message[],
  tools: ToolDefinition[],
  opts?: StreamOptions
) => AsyncIterable<StreamDelta>;

// ─── Provider 标识 ─────────────────────────────────────────────────────
export type ProviderName = 'openai' | 'anthropic' | 'deepseek';

export type ProviderConfig = {
  apiKey: string;
  baseUrl?: string;
};

// ─── 全局配置类型（与 config.ts 保持同步）────────────────────────────────
export type EasycodeConfigData = {
  version: 1;
  defaultModel: string;
  approvalPolicy: 'ask' | 'auto' | 'never';
  compactionThreshold: number;
  providers: Partial<Record<ProviderName, ProviderConfig>>;
};

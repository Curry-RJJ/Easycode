/**
 * @easycode/ai — 公开导出
 */

// 核心类型
export type {
  Message,
  MessageRole,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ToolDefinition,
  ToolResult,
  ToolConcurrency,
  StreamDelta,
  StreamFn,
  StreamOptions,
  JSONSchema,
  JSONSchemaType,
  ProviderName,
  ProviderConfig,
  EasycodeConfigData,
} from './types.js';

// 配置管理
export { EasycodeConfig, getConfig, resetConfigSingleton, maskApiKey } from './config.js';

// Provider 工厂
export { createStreamFn, createDefaultStreamFn, parseModelString } from './factory.js';
export type { ParsedModel } from './factory.js';

// 各 Provider（供直接使用）
export { createOpenAIStreamFn } from './providers/openai.js';
export { createDeepseekStreamFn } from './providers/deepseek.js';
export { createAnthropicStreamFn } from './providers/anthropic.js';

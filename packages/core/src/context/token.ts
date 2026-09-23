/**
 * Token 计数与预算监控
 *
 * 使用 js-tiktoken（cl100k_base 编码）本地计算 token 数，
 * 失败时自动降级到字符数近似估算（1 token ≈ 4 字符）。
 *
 * 参考 Pi 的 UsageRecord 设计：tracked/uncached 分列统计。
 */

import type { Message } from '@easycode/ai';

// ─── Token 计数 ────────────────────────────────────────────────────────

let _encoder: { encode: (text: string) => number[] } | null = null;
let _encoderFailed = false;

/** 惰性初始化 tiktoken 编码器 */
async function getEncoder(): Promise<{ encode: (text: string) => number[] } | null> {
  if (_encoderFailed) return null;
  if (_encoder) return _encoder;

  try {
    const { getEncoding } = await import('js-tiktoken');
    _encoder = getEncoding('cl100k_base');
    return _encoder;
  } catch {
    _encoderFailed = true;
    return null;
  }
}

/** 估算字符串的 token 数（近似：1 token ≈ 4 字符） */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** 精确计算字符串的 token 数（使用 tiktoken，失败时降级到估算） */
export async function countTokens(text: string): Promise<number> {
  const enc = await getEncoder();
  if (!enc) return estimateTokens(text);
  try {
    return enc.encode(text).length;
  } catch {
    return estimateTokens(text);
  }
}

/**
 * 计算整个消息数组的 token 总量（同步版，用于实时监控）。
 * 使用简单估算，不依赖异步初始化。
 */
export function estimateContextTokens(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      total += estimateTokens(msg.content);
    } else {
      for (const block of msg.content) {
        if ('text' in block && block.text) {
          total += estimateTokens(block.text);
        } else if ('content' in block && typeof block.content === 'string') {
          total += estimateTokens(block.content);
        }
      }
    }
    // 每条消息有约 4 token 的固定开销（角色、格式等）
    total += 4;
  }
  return total;
}

// ─── 模型上下文窗口大小 ───────────────────────────────────────────────

/** 常见模型的上下文窗口大小（tokens） */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // DeepSeek
  'deepseek-chat': 64_000,
  'deepseek-coder': 128_000,
  'deepseek-reasoner': 64_000,
  // OpenAI
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4-turbo': 128_000,
  'gpt-4': 8_192,
  'gpt-3.5-turbo': 16_385,
  // Anthropic
  'claude-3-5-sonnet-20241022': 200_000,
  'claude-3-5-haiku-20241022': 200_000,
  'claude-3-opus-20240229': 200_000,
  'claude-3-sonnet-20240229': 200_000,
  'claude-3-haiku-20240307': 200_000,
};

const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * 获取模型的上下文窗口大小。
 * 支持 "provider/model" 格式（自动提取 model 部分）。
 */
export function getModelContextWindow(model: string): number {
  // 提取 model 名（去掉 "provider/" 前缀）
  const modelName = model.includes('/') ? model.split('/').slice(1).join('/') : model;

  // 精确匹配
  if (MODEL_CONTEXT_WINDOWS[modelName]) {
    return MODEL_CONTEXT_WINDOWS[modelName];
  }

  // 前缀模糊匹配（如 "deepseek-chat-v3" 匹配 "deepseek-chat"）
  for (const [key, size] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (modelName.startsWith(key)) return size;
  }

  return DEFAULT_CONTEXT_WINDOW;
}

// ─── TokenBudget — Token 预算跟踪器 ───────────────────────────────────

/**
 * 实时跟踪上下文 token 使用量，判断是否需要压缩。
 *
 * 使用：
 *   const budget = new TokenBudget('deepseek/deepseek-chat', 0.8);
 *   budget.update(messages);
 *   if (budget.shouldCompact()) { ... }
 */
export class TokenBudget {
  private contextWindow: number;
  private threshold: number;
  private _currentTokens = 0;

  /** @param threshold 触发压缩的阈值（0-1，默认 0.8 = 80%） */
  constructor(model: string, threshold = 0.8) {
    this.contextWindow = getModelContextWindow(model);
    this.threshold = threshold;
  }

  /** 更新当前 token 估算（每轮调用一次） */
  update(messages: Message[]): void {
    this._currentTokens = estimateContextTokens(messages);
  }

  /** 累加 API 返回的实际 token 用量（更准确） */
  addUsage(inputTokens: number, outputTokens: number): void {
    // 使用实际 token 数（比估算更准确）
    this._currentTokens = Math.max(this._currentTokens, inputTokens + outputTokens);
  }

  get currentTokens(): number {
    return this._currentTokens;
  }

  get maxTokens(): number {
    return this.contextWindow;
  }

  /** 当前使用率（0-1） */
  get usageRatio(): number {
    return this._currentTokens / this.contextWindow;
  }

  /** 是否达到压缩阈值 */
  shouldCompact(): boolean {
    return this._currentTokens >= this.contextWindow * this.threshold;
  }

  /** 格式化显示（如 "45k/128k"） */
  format(): string {
    const cur = this._currentTokens >= 1000
      ? `${(this._currentTokens / 1000).toFixed(0)}k`
      : String(this._currentTokens);
    const max = this.contextWindow >= 1000
      ? `${(this.contextWindow / 1000).toFixed(0)}k`
      : String(this.contextWindow);
    return `${cur}/${max}`;
  }
}

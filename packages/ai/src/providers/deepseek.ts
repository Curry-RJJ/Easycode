/**
 * Deepseek Provider
 *
 * Deepseek API 完全兼容 OpenAI Chat Completions 接口，
 * 直接复用 openai.ts 的实现，仅覆盖 baseURL。
 */

import { createOpenAIStreamFn } from './openai.js';
import type { StreamFn } from '../types.js';

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';

export interface DeepseekProviderOptions {
  apiKey: string;
  baseUrl?: string;
  model: string;
}

export function createDeepseekStreamFn(opts: DeepseekProviderOptions): StreamFn {
  return createOpenAIStreamFn({
    apiKey: opts.apiKey,
    baseURL: opts.baseUrl ?? DEEPSEEK_BASE_URL,
    model: opts.model,
  });
}

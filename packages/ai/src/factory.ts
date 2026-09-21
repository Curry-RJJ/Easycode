/**
 * @easycode/ai — Provider 工厂
 *
 * 根据 "provider/model" 字符串创建对应的 StreamFn，API Key 自动从 config 读取。
 *
 * 用法：
 *   const stream = createStreamFn("deepseek/deepseek-chat");
 *   const stream = createStreamFn("openai/gpt-4o");
 *   const stream = createStreamFn("anthropic/claude-3-5-sonnet-20241022");
 */

import { getConfig } from './config.js';
import { createOpenAIStreamFn } from './providers/openai.js';
import { createDeepseekStreamFn } from './providers/deepseek.js';
import { createAnthropicStreamFn } from './providers/anthropic.js';
import type { StreamFn, ProviderName } from './types.js';

// ─── 模型字符串解析 ────────────────────────────────────────────────────

export type ParsedModel = {
  provider: ProviderName;
  model: string;
};

/**
 * 解析 "provider/model" 格式的字符串
 * 例如：
 *   "deepseek/deepseek-chat"         → { provider: 'deepseek', model: 'deepseek-chat' }
 *   "openai/gpt-4o"                  → { provider: 'openai', model: 'gpt-4o' }
 *   "anthropic/claude-3-5-sonnet-..."→ { provider: 'anthropic', model: 'claude-3-5-sonnet-...' }
 */
export function parseModelString(modelStr: string): ParsedModel {
  const slashIdx = modelStr.indexOf('/');
  if (slashIdx === -1) {
    throw new Error(
      `无效的模型格式 "${modelStr}"，期望格式：provider/model（例如 deepseek/deepseek-chat）`
    );
  }

  const providerRaw = modelStr.slice(0, slashIdx).toLowerCase();
  const model = modelStr.slice(slashIdx + 1);

  const validProviders: ProviderName[] = ['openai', 'anthropic', 'deepseek'];
  if (!validProviders.includes(providerRaw as ProviderName)) {
    throw new Error(
      `不支持的 Provider "${providerRaw}"，支持的 Provider：${validProviders.join(', ')}`
    );
  }

  return { provider: providerRaw as ProviderName, model };
}

// ─── 工厂函数 ─────────────────────────────────────────────────────────

/**
 * 根据模型字符串创建 StreamFn。
 * API Key 自动从 ~/.easycode/config.json 读取。
 *
 * @param modelStr - "provider/model" 格式，如 "deepseek/deepseek-chat"
 * @throws 如果对应 Provider 未配置 API Key
 */
export function createStreamFn(modelStr: string): StreamFn {
  const { provider, model } = parseModelString(modelStr);
  const config = getConfig();
  const providerConfig = config.getProviderConfig(provider);

  if (!providerConfig?.apiKey) {
    throw new Error(
      `Provider "${provider}" 未配置 API Key。\n` +
      `请运行 easycode config set-key ${provider} 进行配置，或运行 easycode setup 启动引导向导。`
    );
  }

  switch (provider) {
    case 'openai':
      return createOpenAIStreamFn({
        apiKey: providerConfig.apiKey,
        baseURL: providerConfig.baseUrl,
        model,
      });

    case 'deepseek':
      return createDeepseekStreamFn({
        apiKey: providerConfig.apiKey,
        baseUrl: providerConfig.baseUrl,
        model,
      });

    case 'anthropic':
      return createAnthropicStreamFn({
        apiKey: providerConfig.apiKey,
        model,
      });

    default:
      throw new Error(`未实现的 Provider: ${provider as string}`);
  }
}

/**
 * 使用当前默认模型创建 StreamFn（快捷方式）
 */
export function createDefaultStreamFn(): StreamFn {
  const model = getConfig().getDefaultModel();
  return createStreamFn(model);
}

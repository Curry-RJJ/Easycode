/**
 * API Key 有效性验证
 *
 * 每个 Provider 发一次最小化请求验证 Key 是否有效。
 * 区分错误类型：invalid_key / quota_exceeded / network_error
 */

import type { ProviderName } from '@easycode/ai';

// ─── 错误类型 ─────────────────────────────────────────────────────────

export type ValidationError =
  | { kind: 'invalid_key'; message: string }
  | { kind: 'quota_exceeded'; message: string }
  | { kind: 'network_error'; message: string }
  | { kind: 'unknown'; message: string };

export type ValidationResult =
  | { ok: true; modelName: string }
  | { ok: false; error: ValidationError };

// ─── 各 Provider 验证逻辑 ─────────────────────────────────────────────

async function validateOpenAI(apiKey: string, baseUrl?: string): Promise<ValidationResult> {
  const url = `${baseUrl ?? 'https://api.openai.com/v1'}/models`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10000),
    });

    if (res.ok) {
      return { ok: true, modelName: 'gpt-4o' };
    }

    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    const errMsg = (body?.error as { message?: string } | undefined)?.message ?? res.statusText;

    if (res.status === 401) return { ok: false, error: { kind: 'invalid_key', message: errMsg } };
    if (res.status === 429 || res.status === 402) {
      return { ok: false, error: { kind: 'quota_exceeded', message: errMsg } };
    }
    return { ok: false, error: { kind: 'unknown', message: errMsg } };
  } catch (err) {
    return { ok: false, error: { kind: 'network_error', message: String(err) } };
  }
}

async function validateDeepseek(apiKey: string, baseUrl?: string): Promise<ValidationResult> {
  const url = `${baseUrl ?? 'https://api.deepseek.com/v1'}/models`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10000),
    });

    if (res.ok) {
      return { ok: true, modelName: 'deepseek-chat' };
    }

    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    const errMsg = (body?.error as { message?: string } | undefined)?.message ?? res.statusText;

    if (res.status === 401) return { ok: false, error: { kind: 'invalid_key', message: errMsg } };
    if (res.status === 402 || res.status === 429) {
      return { ok: false, error: { kind: 'quota_exceeded', message: errMsg } };
    }
    return { ok: false, error: { kind: 'unknown', message: errMsg } };
  } catch (err) {
    return { ok: false, error: { kind: 'network_error', message: String(err) } };
  }
}

async function validateAnthropic(apiKey: string): Promise<ValidationResult> {
  // Anthropic 用发一条 1 token 消息来验证（没有 models 列表端点）
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-3-haiku-20240307',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (res.ok || res.status === 400) {
      // 400 也说明 Key 有效（可能是参数问题）
      return { ok: true, modelName: 'claude-3-haiku-20240307' };
    }

    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    const errMsg = (body?.error as { message?: string } | undefined)?.message ?? res.statusText;

    if (res.status === 401) return { ok: false, error: { kind: 'invalid_key', message: errMsg } };
    if (res.status === 429) return { ok: false, error: { kind: 'quota_exceeded', message: errMsg } };
    return { ok: false, error: { kind: 'unknown', message: errMsg } };
  } catch (err) {
    return { ok: false, error: { kind: 'network_error', message: String(err) } };
  }
}

// ─── 统一入口 ─────────────────────────────────────────────────────────

export async function validateApiKey(
  provider: ProviderName,
  apiKey: string,
  baseUrl?: string
): Promise<ValidationResult> {
  switch (provider) {
    case 'openai':
      return validateOpenAI(apiKey, baseUrl);
    case 'deepseek':
      return validateDeepseek(apiKey, baseUrl);
    case 'anthropic':
      return validateAnthropic(apiKey);
    default:
      return { ok: false, error: { kind: 'unknown', message: `未知 Provider: ${provider as string}` } };
  }
}

// ─── 错误信息人性化 ───────────────────────────────────────────────────

export function formatValidationError(error: ValidationError): string {
  switch (error.kind) {
    case 'invalid_key':
      return `❌ API Key 无效：${error.message}\n   请检查 Key 是否正确，或前往 Provider 官网重新生成。`;
    case 'quota_exceeded':
      return `⚠️  账户额度不足或欠费：${error.message}\n   请检查账户余额后重试。`;
    case 'network_error':
      return `🌐 网络错误，无法连接到 API：${error.message}\n   请检查网络连接或代理设置。`;
    default:
      return `❓ 验证失败：${error.message}`;
  }
}

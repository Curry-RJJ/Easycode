/**
 * 代理自动检测与设置
 *
 * Node.js 内置 fetch（基于 undici）默认不走系统代理。
 * 此模块从以下来源自动检测代理并设为全局 dispatcher：
 *   1. 环境变量：HTTPS_PROXY / HTTP_PROXY / ALL_PROXY（及小写变体）
 *   2. Windows 注册表系统代理（当环境变量未设置时）
 */

import { execSync } from 'child_process';
import { setGlobalDispatcher, ProxyAgent } from 'undici';

// ─── 从环境变量读取代理 ────────────────────────────────────────────────

function getProxyFromEnv(): string | null {
  const keys = [
    'HTTPS_PROXY', 'https_proxy',
    'HTTP_PROXY',  'http_proxy',
    'ALL_PROXY',   'all_proxy',
  ];
  for (const key of keys) {
    const val = process.env[key];
    if (val) return val;
  }
  return null;
}

// ─── 从 Windows 注册表读取系统代理 ────────────────────────────────────

function getProxyFromWindowsRegistry(): string | null {
  if (process.platform !== 'win32') return null;
  try {
    const regKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    const enabledOutput = execSync(`reg query "${regKey}" /v ProxyEnable`, { encoding: 'utf-8', timeout: 2000 });
    const enabled = enabledOutput.includes('0x1');
    if (!enabled) return null;

    const serverOutput = execSync(`reg query "${regKey}" /v ProxyServer`, { encoding: 'utf-8', timeout: 2000 });
    const match = serverOutput.match(/ProxyServer\s+REG_SZ\s+(.+)/);
    if (!match) return null;

    const server = match[1].trim();
    // 格式可能是 "127.0.0.1:7890" 或 "http=127.0.0.1:7890;https=127.0.0.1:7890"
    // 取 https 优先
    const httpsMatch = server.match(/https=([^;]+)/);
    const httpMatch  = server.match(/http=([^;]+)/);
    const raw = httpsMatch?.[1] ?? httpMatch?.[1] ?? server;

    return raw.startsWith('http') ? raw : `http://${raw}`;
  } catch {
    return null;
  }
}

// ─── 初始化代理（全局生效）────────────────────────────────────────────

let initialized = false;

export function setupProxy(): string | null {
  if (initialized) return null;
  initialized = true;

  const proxy = getProxyFromEnv() ?? getProxyFromWindowsRegistry();
  if (!proxy) return null;

  try {
    setGlobalDispatcher(new ProxyAgent(proxy));
    return proxy;
  } catch {
    return null;
  }
}

/**
 * @easycode/ai — 配置管理器
 *
 * 读写 ~/.easycode/config.json，管理 API Key、默认模型、审批策略等。
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import type { EasycodeConfigData, ProviderName, ProviderConfig } from './types.js';

// ─── 常量 ─────────────────────────────────────────────────────────────
const CONFIG_DIR = path.join(os.homedir(), '.easycode');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const DEFAULT_CONFIG: EasycodeConfigData = {
  version: 1,
  defaultModel: 'deepseek/deepseek-chat',
  approvalPolicy: 'ask',
  compactionThreshold: 0.8,
  providers: {},
};

// ─── 读写辅助 ─────────────────────────────────────────────────────────
function readConfigFile(): EasycodeConfigData {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      return { ...DEFAULT_CONFIG, providers: {} };
    }
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
    const data = JSON.parse(raw) as Partial<EasycodeConfigData>;
    return { ...DEFAULT_CONFIG, ...data, providers: data.providers ?? {} };
  } catch {
    return { ...DEFAULT_CONFIG, providers: {} };
  }
}

function writeConfigFile(data: EasycodeConfigData): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

// ─── 脱敏工具函数 ──────────────────────────────────────────────────────
/**
 * 将 API Key 脱敏：只显示前 4 位和后 4 位，中间用 **** 替代
 * 例如：sk-ab12****5678
 */
export function maskApiKey(key: string): string {
  if (key.length <= 8) return '****';
  const prefix = key.slice(0, 4);
  const suffix = key.slice(-4);
  return `${prefix}****${suffix}`;
}

// ─── EasycodeConfig 类 ─────────────────────────────────────────────────
export class EasycodeConfig {
  private data: EasycodeConfigData;

  constructor() {
    this.data = readConfigFile();
  }

  /** 重新从磁盘读取（用于多进程场景） */
  reload(): void {
    this.data = readConfigFile();
  }

  /** 保存到磁盘 */
  save(): void {
    writeConfigFile(this.data);
  }

  // ─── API Key 管理 ──────────────────────────────────────────────────

  getApiKey(provider: ProviderName): string | undefined {
    return this.data.providers[provider]?.apiKey;
  }

  setApiKey(provider: ProviderName, key: string, baseUrl?: string): void {
    const existing = this.data.providers[provider] ?? {};
    this.data.providers[provider] = {
      ...existing,
      apiKey: key,
      ...(baseUrl ? { baseUrl } : {}),
    } as ProviderConfig;
    this.save();
  }

  removeApiKey(provider: ProviderName): void {
    delete this.data.providers[provider];
    this.save();
  }

  getProviderConfig(provider: ProviderName): ProviderConfig | undefined {
    return this.data.providers[provider];
  }

  /** 返回所有已配置的 Provider 名称 */
  getConfiguredProviders(): ProviderName[] {
    return (Object.keys(this.data.providers) as ProviderName[]).filter(
      (p) => !!this.data.providers[p]?.apiKey
    );
  }

  // ─── 默认模型 ─────────────────────────────────────────────────────

  getDefaultModel(): string {
    return this.data.defaultModel;
  }

  setDefaultModel(model: string): void {
    this.data.defaultModel = model;
    this.save();
  }

  // ─── 审批策略 ─────────────────────────────────────────────────────

  getApprovalPolicy(): 'ask' | 'auto' | 'never' {
    return this.data.approvalPolicy;
  }

  setApprovalPolicy(policy: 'ask' | 'auto' | 'never'): void {
    this.data.approvalPolicy = policy;
    this.save();
  }

  // ─── 压缩阈值 ─────────────────────────────────────────────────────

  getCompactionThreshold(): number {
    return this.data.compactionThreshold;
  }

  setCompactionThreshold(threshold: number): void {
    this.data.compactionThreshold = Math.max(0.1, Math.min(0.99, threshold));
    this.save();
  }

  // ─── 检测是否已完成初始配置 ─────────────────────────────────────────

  isConfigured(): boolean {
    return this.getConfiguredProviders().length > 0;
  }

  /** 获取原始配置数据的只读副本（供 config list 命令展示用） */
  toJSON(): Readonly<EasycodeConfigData> {
    return { ...this.data, providers: { ...this.data.providers } };
  }
}

/** 全局单例（懒初始化） */
let _instance: EasycodeConfig | null = null;

export function getConfig(): EasycodeConfig {
  if (!_instance) {
    _instance = new EasycodeConfig();
  }
  return _instance;
}

/** 仅在测试中用于重置单例 */
export function resetConfigSingleton(): void {
  _instance = null;
}

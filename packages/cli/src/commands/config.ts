/**
 * easycode config 命令
 *
 * 查看和修改配置（API Key、默认模型、审批策略）。
 */

import chalk from 'chalk';
import { password } from '@inquirer/prompts';
import { getConfig, maskApiKey } from '@easycode/ai';
import type { ProviderName } from '@easycode/ai';
import { validateApiKey, formatValidationError } from '../setup/validator.js';

const PROVIDERS: ProviderName[] = ['deepseek', 'openai', 'anthropic'];

// ─── config list ─────────────────────────────────────────────────────

export async function configListCommand(): Promise<void> {
  const config = getConfig();
  const data = config.toJSON();

  console.log();
  console.log(chalk.bold('EasyCode 当前配置'));
  console.log(chalk.gray('─'.repeat(60)));
  console.log(`默认模型：   ${chalk.cyan(data.defaultModel)}`);
  console.log(`审批策略：   ${chalk.cyan(data.approvalPolicy)}`);
  console.log(`压缩阈值：   ${chalk.cyan((data.compactionThreshold * 100).toFixed(0) + '%')}`);
  console.log();
  console.log(chalk.bold('Provider 配置'));
  console.log(chalk.gray('─'.repeat(60)));

  const header = `${'Provider'.padEnd(12)} ${'API Key'.padEnd(20)} 状态`;
  console.log(chalk.gray(header));
  console.log(chalk.gray('─'.repeat(60)));

  for (const p of PROVIDERS) {
    const cfg = data.providers[p];
    const keyDisplay = cfg?.apiKey ? maskApiKey(cfg.apiKey) : chalk.gray('未配置');
    const status = cfg?.apiKey ? chalk.green('✓ 已配置') : chalk.gray('-');
    const isDefault = data.defaultModel.startsWith(p + '/') ? chalk.yellow(' [默认]') : '';
    console.log(`${p.padEnd(12)} ${keyDisplay.padEnd(20)} ${status}${isDefault}`);
  }

  console.log();
}

// ─── config set-key ───────────────────────────────────────────────────

export async function configSetKeyCommand(provider: string): Promise<void> {
  if (!PROVIDERS.includes(provider as ProviderName)) {
    console.error(chalk.red(`未知 Provider "${provider}"，支持：${PROVIDERS.join(', ')}`));
    process.exit(1);
  }

  const p = provider as ProviderName;
  const config = getConfig();

  console.log();
  const apiKey = await password({
    message: `请输入 ${provider} API Key：`,
    mask: '*',
    validate: (input: string) => input.trim().length > 0 || 'API Key 不能为空',
  });

  console.log();
  process.stdout.write('  ⠋ 验证中...');

  const result = await validateApiKey(p, apiKey.trim());

  process.stdout.write('\r\x1b[K');

  if (!result.ok) {
    console.error(chalk.red(`\n${formatValidationError(result.error)}`));
    process.exit(1);
  }

  config.setApiKey(p, apiKey.trim());
  console.log(chalk.green(`✓ ${provider} API Key 已保存（验证成功，模型：${result.modelName}）`));
  console.log();
}

// ─── config set-model ─────────────────────────────────────────────────

export async function configSetModelCommand(model: string): Promise<void> {
  const config = getConfig();

  // 简单校验格式
  if (!model.includes('/')) {
    console.error(chalk.red(`模型格式错误，期望 "provider/model"，例如：deepseek/deepseek-chat`));
    process.exit(1);
  }

  config.setDefaultModel(model);
  console.log(chalk.green(`✓ 默认模型已设置为：${model}`));
}

// ─── config set-approval ──────────────────────────────────────────────

export async function configSetApprovalCommand(policy: string): Promise<void> {
  if (!['ask', 'auto', 'never'].includes(policy)) {
    console.error(chalk.red(`无效的审批策略 "${policy}"，支持：ask、auto、never`));
    process.exit(1);
  }

  const config = getConfig();
  config.setApprovalPolicy(policy as 'ask' | 'auto' | 'never');
  console.log(chalk.green(`✓ 审批策略已设置为：${policy}`));
}

// ─── config remove-key ────────────────────────────────────────────────

export async function configRemoveKeyCommand(provider: string): Promise<void> {
  if (!PROVIDERS.includes(provider as ProviderName)) {
    console.error(chalk.red(`未知 Provider "${provider}"，支持：${PROVIDERS.join(', ')}`));
    process.exit(1);
  }

  const config = getConfig();
  config.removeApiKey(provider as ProviderName);
  console.log(chalk.green(`✓ ${provider} API Key 已删除。`));
}

/**
 * 首次运行引导向导（Setup Wizard）
 *
 * 使用 inquirer v9+ 模块化 API，支持方向键选择。
 */

import { select, password, confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { getConfig } from '@easycode/ai';
import type { ProviderName } from '@easycode/ai';
import { validateApiKey, formatValidationError } from './validator.js';

// ─── Provider 选项 ────────────────────────────────────────────────────

const PROVIDERS: Array<{ name: string; value: ProviderName; description: string }> = [
  { name: 'Deepseek  （推荐，价格最低，适合开发调试）', value: 'deepseek',  description: 'deepseek-chat' },
  { name: 'OpenAI    （GPT-4o 系列）',                  value: 'openai',    description: 'gpt-4o' },
  { name: 'Anthropic （Claude 系列）',                  value: 'anthropic', description: 'claude-3-5-sonnet' },
];

// ─── 主向导流程 ───────────────────────────────────────────────────────

export async function runSetupWizard(): Promise<void> {
  console.log();
  console.log(chalk.cyan('  ══════════════════════════════════════════'));
  console.log(chalk.cyan('    Welcome to EasyCode! ') + chalk.yellow('🎉'));
  console.log(chalk.gray('    需要先配置一个 LLM Provider 才能使用。'));
  console.log(chalk.cyan('  ══════════════════════════════════════════'));
  console.log();

  const config = getConfig();

  while (true) {
    // 1. 选择 Provider（方向键）
    const provider = await select<ProviderName>({
      message: '选择 LLM Provider：',
      choices: PROVIDERS,
      default: 'deepseek',
    });

    // 2. 输入 API Key（隐藏）
    const apiKey = await password({
      message: `请输入 ${provider} API Key：`,
      mask: '*',
      validate: (input: string) => input.trim().length > 0 || 'API Key 不能为空',
    });

    // 3. 验证（旋转动画）
    const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let i = 0;
    const interval = setInterval(() => {
      process.stdout.write(`\r  ${chalk.cyan(spinner[i++ % spinner.length])} 正在验证 API Key...`);
    }, 80);

    const result = await validateApiKey(provider, apiKey.trim());
    clearInterval(interval);
    process.stdout.write('\r\x1b[K');

    if (!result.ok) {
      console.log(chalk.red(`\n  ${formatValidationError(result.error)}\n`));

      const retry = await confirm({
        message: '是否重新输入？',
        default: true,
      });

      if (!retry) process.exit(1);
      continue;
    }

    // 4. 连接成功
    console.log(chalk.green(`  ✓ 连接成功！模型：${result.modelName}`));

    // 5. 询问是否设为默认
    const setDefault = await confirm({
      message: `设为默认模型（${provider}/${result.modelName}）？`,
      default: true,
    });

    if (setDefault) {
      config.setDefaultModel(`${provider}/${result.modelName}`);
    }

    // 6. 保存
    config.setApiKey(provider, apiKey.trim());

    console.log();
    console.log(chalk.green('  ✓ 配置已保存到 ~/.easycode/config.json'));
    console.log(chalk.green('  ✓ 现在可以开始使用 EasyCode 了！'));
    console.log();
    break;
  }
}

// ─── 检测是否需要引导 ─────────────────────────────────────────────────

export async function ensureConfigured(): Promise<void> {
  const config = getConfig();
  if (!config.isConfigured()) {
    await runSetupWizard();
  }
}

#!/usr/bin/env node
/**
 * @easycode/cli — EasyCode CLI 入口
 *
 * 使用 Commander.js 注册所有子命令。
 */

import { Command } from 'commander';
import { runCommand } from './commands/run.js';
import {
  configListCommand,
  configSetKeyCommand,
  configSetModelCommand,
  configSetApprovalCommand,
  configRemoveKeyCommand,
} from './commands/config.js';
import { runSetupWizard } from './setup/wizard.js';

const program = new Command();

program
  .name('easycode')
  .description('EasyCode — AI Coding Agent，由 LLM 驱动的命令行编程助手')
  .version('0.1.0');

// ─── easycode "<prompt>" ──────────────────────────────────────────────
program
  .argument('[prompt]', '要执行的任务描述（不提供时进入交互模式）')
  .option('-m, --model <model>', '指定模型（格式：provider/model）')
  .action(async (prompt: string | undefined, opts: { model?: string }) => {
    if (!prompt) {
      console.log('用法：easycode "<任务描述>"');
      console.log('示例：easycode "读取 README.md 并统计行数"');
      console.log('\n运行 easycode --help 查看所有命令。');
      return;
    }
    await runCommand(prompt, opts);
  });

// ─── easycode setup ───────────────────────────────────────────────────
program
  .command('setup')
  .description('重新运行配置引导向导（配置 API Key 等）')
  .action(async () => {
    await runSetupWizard();
  });

// ─── easycode config ──────────────────────────────────────────────────
const configCmd = program
  .command('config')
  .description('查看和管理配置');

configCmd
  .command('list')
  .description('查看当前配置（API Key 脱敏显示）')
  .action(configListCommand);

configCmd
  .command('set-key <provider>')
  .description('添加或更新 Provider 的 API Key（交互式输入）')
  .action(configSetKeyCommand);

configCmd
  .command('set-model <model>')
  .description('切换默认模型（格式：provider/model）')
  .action(configSetModelCommand);

configCmd
  .command('set-approval <policy>')
  .description('修改审批策略（ask | auto | never）')
  .action(configSetApprovalCommand);

configCmd
  .command('remove-key <provider>')
  .description('删除指定 Provider 的 API Key')
  .action(configRemoveKeyCommand);

// ─── 解析命令行 ───────────────────────────────────────────────────────
program.parseAsync(process.argv).catch((err: unknown) => {
  console.error('错误：', err instanceof Error ? err.message : String(err));
  process.exit(1);
});

#!/usr/bin/env node
/**
 * @easycode/cli — EasyCode CLI 入口
 *
 * M3 新增：
 *   --mcp <config>     接入 MCP Server（stdio/HTTP）
 *   --approval <policy> 审批策略覆盖（ask/auto/never）
 *   --log-format json  结构化 JSON 日志输出
 *   stats <id>         Session 统计面板
 */

import { setupProxy } from './utils/proxy.js';
const detectedProxy = setupProxy();
if (detectedProxy) {
  process.env._EASYCODE_PROXY = detectedProxy;
}

import { Command } from 'commander';
import { runCommand } from './commands/run.js';
import { replCommand } from './commands/repl.js';
import { resumeCommand, listCommand } from './commands/resume.js';
import { statsCommand } from './commands/stats.js';
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
  .option('--approval <policy>', '审批策略：ask（默认）| auto | never')
  .option('--mcp <config>', '接入 MCP Server（格式：stdio:"cmd" 或 http://host）')
  .option('--log-format <format>', '日志格式：text（默认）| json')
  .action(async (
    prompt: string | undefined,
    opts: { model?: string; approval?: string; mcp?: string; logFormat?: string }
  ) => {
    if (!prompt) {
      await replCommand();
      return;
    }
    await runCommand(prompt, opts);
  });

// ─── easycode resume <id> ────────────────────────────────────────────
program
  .command('resume <session-id>')
  .description('恢复中断的会话（断点续传）')
  .action(async (sessionId: string) => {
    await resumeCommand(sessionId);
  });

// ─── easycode list ────────────────────────────────────────────────────
program
  .command('list')
  .description('查看历史会话列表（含状态：已完成 / 已中断）')
  .action(async () => {
    await listCommand();
  });

// ─── easycode stats <id> ─────────────────────────────────────────────
program
  .command('stats <session-id>')
  .description('查看会话统计（token 用量、工具调用、费用估算）')
  .action(async (sessionId: string) => {
    await statsCommand(sessionId);
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

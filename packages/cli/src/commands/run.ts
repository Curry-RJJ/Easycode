/**
 * easycode "<prompt>" 命令
 *
 * 启动单次任务，流式打印 LLM 输出，显示工具执行日志。
 */

import chalk from 'chalk';
import { createDefaultStreamFn } from '@easycode/ai';
import { Agent, createDefaultRegistryAsync } from '@easycode/core';
import { ensureConfigured } from '../setup/wizard.js';

// ─── 格式化工具 ────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

// ─── run 命令主逻辑 ────────────────────────────────────────────────────

export async function runCommand(prompt: string, opts: { model?: string } = {}): Promise<void> {
  // 1. 确保已配置（未配置时触发引导向导）
  await ensureConfigured();

  // 2. 创建 StreamFn 和工具注册表
  let streamFn;
  try {
    streamFn = opts.model
      ? (await import('@easycode/ai')).createStreamFn(opts.model)
      : createDefaultStreamFn();
  } catch (err) {
    console.error(chalk.red(`\n配置错误：${err instanceof Error ? err.message : String(err)}\n`));
    process.exit(1);
  }

  const registry = await createDefaultRegistryAsync();

  // 3. 创建 Agent
  const agent = new Agent({ streamFn, registry });

  // 4. 设置中断信号
  const abortController = new AbortController();
  process.on('SIGINT', () => {
    console.log(chalk.yellow('\n\n⚠️  收到中断信号，正在停止...\n'));
    abortController.abort();
  });

  // 5. 打印任务开始
  console.log();
  console.log(chalk.cyan('●') + ' ' + chalk.bold('EasyCode'));
  console.log(chalk.gray('─'.repeat(50)));
  console.log(chalk.gray(`任务：`) + prompt);
  console.log(chalk.gray('─'.repeat(50)));
  console.log();

  // 统计
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let toolCallCount = 0;
  const startTime = Date.now();

  // 当前是否在输出文本（用于换行控制）
  let inTextStream = false;

  // 6. 消费事件流
  try {
    for await (const event of agent.run(prompt, abortController.signal)) {
      switch (event.type) {
        case 'text': {
          if (!inTextStream) {
            inTextStream = true;
          }
          process.stdout.write(event.content);
          break;
        }

        case 'tool_start': {
          if (inTextStream) {
            console.log(); // 确保工具日志在新行
            inTextStream = false;
          }
          process.stdout.write(
            chalk.gray(`\n[工具] `) +
            chalk.cyan(event.name) +
            chalk.gray(' 执行中...')
          );
          toolCallCount++;
          break;
        }

        case 'tool_end': {
          const duration = formatDuration(event.durationMs);
          clearLine();
          const icon = event.result.isError ? chalk.red('✗') : chalk.green('✓');
          console.log(
            chalk.gray(`[工具] `) +
            chalk.cyan(event.name) +
            ` ${icon} ` +
            chalk.gray(`(${duration})`)
          );
          break;
        }

        case 'tool_error': {
          clearLine();
          console.log(
            chalk.gray(`[工具] `) +
            chalk.cyan(event.name) +
            ` ${chalk.red('✗')} ` +
            chalk.red(event.error)
          );
          break;
        }

        case 'usage': {
          totalInputTokens += event.inputTokens;
          totalOutputTokens += event.outputTokens;
          break;
        }

        case 'error': {
          if (inTextStream) { console.log(); inTextStream = false; }
          console.error(chalk.red(`\n错误：${event.message}`));
          break;
        }

        case 'done': {
          if (inTextStream) { console.log(); inTextStream = false; }
          break;
        }

        case 'turn_end': {
          // 轮次结束，不需要额外输出
          break;
        }
      }
    }
  } catch (err) {
    console.error(chalk.red(`\n运行失败：${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }

  // 7. 打印统计摘要
  const elapsed = Date.now() - startTime;
  console.log();
  console.log(chalk.gray('─'.repeat(50)));
  console.log(
    chalk.green('✅ 任务完成') +
    chalk.gray(` │ ${toolCallCount} 次工具调用`) +
    chalk.gray(` │ ${formatTokens(totalInputTokens + totalOutputTokens)} tokens`) +
    chalk.gray(` │ 耗时 ${formatDuration(elapsed)}`)
  );
  console.log();
}

function clearLine(): void {
  process.stdout.write('\r\x1b[K');
}

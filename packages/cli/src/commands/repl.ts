/**
 * 交互式 REPL 模式
 *
 * 运行 `easycode`（不带参数）进入持续对话，
 * 每轮完成后自动等待下一条指令，输入 exit/quit 或 Ctrl+C 退出。
 */

import readline, { moveCursor, cursorTo } from 'readline';
import chalk from 'chalk';
import { createDefaultStreamFn } from '@easycode/ai';
import { Agent, createDefaultRegistryAsync } from '@easycode/core';
import { ensureConfigured } from '../setup/wizard.js';

// ─── 工具函数 ─────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

// ─── 对话框 UI ────────────────────────────────────────────────────────

/** 当前终端宽度 */
const W = () => process.stdout.columns || 80;

/**
 * 带灰色背景高亮的 prompt 字符串。
 * 末尾故意不重置颜色，使灰色背景"泄漏"到用户输入文字。
 *   48;5;237 = 深灰背景   38;5;252 = 浅灰前景
 */
const INPUT_PROMPT = '\x1b[48;5;237m\x1b[38;5;252m > ';
/** INPUT_PROMPT 的可见字符长度（不含 ANSI 转义码）*/
const INPUT_PROMPT_VISIBLE_LEN = 3; // ' > '

/** 单纯打印一条分隔横线 */
function sep(): string {
  return chalk.dim('─'.repeat(W()));
}

/**
 * 打印上横线 + 调用 rl.prompt() + 在其返回后追加下横线并把光标移回。
 *
 * 原理：readline 内部 _refreshLine() 会调用 clearScreenDown()，
 * 在 rl.prompt() 返回后追加下横线，就能绕过这个问题。
 * 首次进入 / 每轮 AI 回复结束后调用此函数。
 *
 * 最终视觉效果：
 *   ─────────────────────
 *    > █
 *   ─────────────────────
 */
function showPromptFrame(rl: readline.Interface): void {
  // 1. 上横线
  process.stdout.write('\n' + sep() + '\n');
  // 2. readline 绘制 prompt（内部 clearScreenDown 清掉下方，但此时下方为空）
  rl.prompt();
  // 3. prompt 已同步写入，此时光标在 ' > ' 末尾（灰色背景仍泄漏中）。
  //    先重置颜色，再写下横线，最后把光标移回 prompt 行的输入起始位置。
  process.stdout.write('\x1b[0m\n' + sep());
  moveCursor(process.stdout, 0, -1);
  cursorTo(process.stdout, INPUT_PROMPT_VISIBLE_LEN);
}

/** 用户按 Enter 后：重置泄漏的灰色背景，打印下横线（关闭输入框）*/
function closePromptFrame(): void {
  process.stdout.write('\x1b[0m'); // 重置泄漏的灰色背景
  process.stdout.write(sep() + '\n');
}

// ─── REPL 主逻辑 ──────────────────────────────────────────────────────

export async function replCommand(): Promise<void> {
  // 1. 确保已配置
  await ensureConfigured();

  // 2. 初始化 Agent
  const streamFn = createDefaultStreamFn();
  const registry = await createDefaultRegistryAsync();
  const agent = new Agent({ streamFn, registry });

  // 3. 打印欢迎语
  console.log();
  console.log(chalk.cyan('●') + ' ' + chalk.bold('EasyCode') + chalk.gray(' — 交互模式'));
  console.log(chalk.gray('  输入任务描述开始，输入 exit 退出，Ctrl+C 中断当前任务'));
  console.log(chalk.gray('─'.repeat(50)));

  // 4. 创建 readline 接口（使用带灰色背景的 prompt）
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: INPUT_PROMPT,
  });

  // 首次显示
  showPromptFrame(rl);

  rl.on('line', async (line) => {
    // 用户按 Enter 后：关闭输入框（打印下横线）
    closePromptFrame();

    const input = line.trim();

    // 空行跳过
    if (!input) {
      showPromptFrame(rl);
      return;
    }

    // 退出命令
    if (['exit', 'quit', 'q', ':q'].includes(input.toLowerCase())) {
      console.log(chalk.gray('再见！'));
      rl.close();
      process.exit(0);
    }

    // 暂停 readline，防止用户在 Agent 运行时乱输入
    rl.pause();

    // 5. 运行任务
    const abortController = new AbortController();
    const onSigint = () => {
      console.log(chalk.yellow('\n\n⚠️  中断当前任务...'));
      abortController.abort();
    };
    process.once('SIGINT', onSigint);

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let toolCallCount = 0;
    let inTextStream = false;
    const startTime = Date.now();

    console.log();

    try {
      for await (const event of agent.run(input, abortController.signal)) {
        switch (event.type) {
          case 'text': {
            inTextStream = true;
            process.stdout.write(event.content);
            break;
          }
          case 'tool_start': {
            if (inTextStream) { console.log(); inTextStream = false; }
            process.stdout.write(
              chalk.gray(`\n[工具] `) + chalk.cyan(event.name) + chalk.gray(' ...')
            );
            toolCallCount++;
            break;
          }
          case 'tool_end': {
            process.stdout.write('\r\x1b[K');
            const icon = event.result.isError ? chalk.red('✗') : chalk.green('✓');
            console.log(
              chalk.gray(`[工具] `) + chalk.cyan(event.name) +
              ` ${icon} ` + chalk.gray(`(${formatDuration(event.durationMs)})`)
            );
            break;
          }
          case 'tool_error': {
            process.stdout.write('\r\x1b[K');
            console.log(
              chalk.gray(`[工具] `) + chalk.cyan(event.name) +
              ` ${chalk.red('✗')} ` + chalk.red(event.error)
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
        }
      }
    } catch (err) {
      console.error(chalk.red(`\n运行失败：${err instanceof Error ? err.message : String(err)}`));
    }

    process.removeListener('SIGINT', onSigint);

    // 打印本轮统计
    const elapsed = Date.now() - startTime;
    const total = totalInputTokens + totalOutputTokens;
    console.log();
    if (total > 0 || toolCallCount > 0) {
      console.log(
        chalk.gray(`─ ${toolCallCount} 次工具调用`) +
        (total > 0 ? chalk.gray(` │ ${formatTokens(total)} tokens`) : '') +
        chalk.gray(` │ ${formatDuration(elapsed)}`)
      );
    }
    console.log();

    // 恢复输入
    rl.resume();
    showPromptFrame(rl);
  });

  // Ctrl+D 退出
  rl.on('close', () => {
    console.log(chalk.gray('\n再见！'));
    process.exit(0);
  });
}

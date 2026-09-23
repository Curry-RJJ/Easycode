/**
 * 交互式 REPL 模式
 *
 * 使用 readline（非 Ink）以正确支持中文 IME 输入法：
 * readline 将物理光标放在行内输入位置，OS 的 preedit 跟着对齐。
 *
 * UI 风格参考 Claude Code：
 * - 输入时：干净的 " > "，无任何背景色
 * - 提交后：用 moveCursor 回溯覆写该行为灰色背景气泡
 * - 无横线装饰
 */

import readline, { moveCursor, cursorTo } from 'readline';
import chalk from 'chalk';
import { select } from '@inquirer/prompts';
import { createDefaultStreamFn, EasycodeConfig } from '@easycode/ai';
import { Agent, createDefaultRegistryAsync, SessionRecorder } from '@easycode/core';
import type { ApprovalDecision, ApprovalRequest } from '@easycode/core';
import { ensureConfigured } from '../setup/wizard.js';

// ─── 审批 UI（M3.1）────────────────────────────────────────────────────

async function approvalUI(req: ApprovalRequest): Promise<ApprovalDecision> {
  const { toolName, input, reason } = req;
  console.log();
  console.log(chalk.yellow('⚠️  Agent 请求执行以下操作：'));
  console.log(chalk.gray('─'.repeat(50)));
  console.log(chalk.bold(`  工具：`) + chalk.cyan(toolName));
  if (toolName === 'run_bash') {
    console.log(chalk.bold(`  命令：`) + chalk.white(String(input.command ?? '')));
  } else {
    console.log(chalk.bold(`  文件：`) + chalk.white(String(input.path ?? '')));
  }
  console.log(chalk.bold(`  原因：`) + chalk.yellow(reason));
  console.log(chalk.gray('─'.repeat(50)));

  return select<ApprovalDecision>({
    message: '请选择操作：',
    choices: [
      { name: '✅  允许本次', value: 'allow_once' },
      { name: '✅  允许全部（本会话内不再询问此工具）', value: 'allow_all' },
      { name: '❌  拒绝本次（Agent 继续运行）', value: 'deny' },
      { name: '🛑  拒绝并中止任务', value: 'deny_abort' },
    ],
  });
}

// ─── 工具函数 ─────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

// ─── 灰色气泡 UI ──────────────────────────────────────────────────────

const W = () => process.stdout.columns || 80;
const PROMPT = ' > ';

/**
 * 用户按 Enter 后调用。
 * moveCursor 回溯到 prompt 行，将 " > rawLine" 覆写为灰色背景气泡。
 * 输入时完全无背景色，避免 IME preedit 颜色干扰。
 */
function renderBubble(rawLine: string): void {
  const cols = W();
  const text = PROMPT + rawLine;
  const numLines = Math.max(1, Math.ceil(text.length / cols));

  moveCursor(process.stdout, 0, -numLines);
  cursorTo(process.stdout, 0);

  // 灰色背景气泡（48;5;237 深灰背景，38;5;252 浅灰前景）
  process.stdout.write('\x1b[48;5;237m\x1b[38;5;252m' + text + '\x1b[0m\n');

  if (numLines > 1) moveCursor(process.stdout, 0, numLines - 1);
}

// ─── REPL 主逻辑 ──────────────────────────────────────────────────────

export async function replCommand(): Promise<void> {
  await ensureConfigured();

  const streamFn = createDefaultStreamFn();
  const registry = await createDefaultRegistryAsync();
  const config = EasycodeConfig.load();
  const approvalPolicy = config.approvalPolicy ?? 'ask';
  const agent = new Agent({
    streamFn,
    registry,
    approvalPolicy,
    onApprovalRequired: approvalUI,
  });

  console.log();
  console.log(chalk.cyan('●') + ' ' + chalk.bold('EasyCode') + chalk.gray(' — 交互模式'));
  console.log(chalk.gray('  输入任务描述开始，Ctrl+C 中断，输入 exit 退出'));
  console.log();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: PROMPT,
  });

  rl.prompt();

  rl.on('line', async (line) => {
    // 提交后覆写为灰色气泡
    renderBubble(line);

    const input = line.trim();

    if (!input) {
      rl.prompt();
      return;
    }

    if (['exit', 'quit', 'q', ':q'].includes(input.toLowerCase())) {
      console.log(chalk.gray('再见！'));
      rl.close();
      process.exit(0);
    }

    rl.pause();

    // 会话记录（M2）
    const recorder = new SessionRecorder();
    try {
      recorder.start({
        model: 'default',
        systemPrompt: agent.getSystemPrompt(),
        prompt: input,
      });
      recorder.recordUserMessage(input);
    } catch { /* 记录失败不阻塞 */ }

    const abortController = new AbortController();
    let wasInterrupted = false;
    const onSigint = () => {
      console.log(chalk.yellow('\n\n⚠️  中断当前任务...'));
      wasInterrupted = true;
      abortController.abort();
    };
    process.once('SIGINT', onSigint);

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let toolCallCount = 0;
    let inTextStream = false;
    let turnText = '';
    const startTime = Date.now();

    console.log();

    try {
      for await (const event of agent.run(input, abortController.signal)) {
        switch (event.type) {

          case 'text': {
            inTextStream = true;
            turnText += event.content;
            process.stdout.write(event.content);
            break;
          }

          case 'tool_start': {
            if (inTextStream) { console.log(); inTextStream = false; }
            process.stdout.write(
              chalk.gray(`\n[工具] `) + chalk.cyan(event.name) + chalk.gray(' ...')
            );
            toolCallCount++;
            let parsedInput: Record<string, unknown> = {};
            try { parsedInput = JSON.parse(event.input || '{}'); } catch { /* ignore */ }
            recorder.recordToolCall(event.callId, event.name, parsedInput);
            break;
          }

          case 'tool_end': {
            process.stdout.write('\r\x1b[K');
            const icon = event.result.isError ? chalk.red('✗') : chalk.green('✓');
            console.log(
              chalk.gray(`[工具] `) + chalk.cyan(event.name) +
              ` ${icon} ` + chalk.gray(`(${formatDuration(event.durationMs)})`)
            );
            recorder.recordToolResult(event.callId, event.result.content, !!event.result.isError);
            break;
          }

          case 'tool_error': {
            process.stdout.write('\r\x1b[K');
            console.log(
              chalk.gray(`[工具] `) + chalk.cyan(event.name) +
              ` ${chalk.red('✗')} ` + chalk.red(event.error)
            );
            recorder.recordToolResult(event.callId, event.error, true);
            break;
          }

          case 'usage': {
            totalInputTokens += event.inputTokens;
            totalOutputTokens += event.outputTokens;
            recorder.recordTokenUsage(event.inputTokens, event.outputTokens, event.cacheReadTokens);
            break;
          }

          case 'turn_end': {
            if (turnText) {
              recorder.recordAssistantText(turnText);
              turnText = '';
            }
            break;
          }

          case 'compaction': {
            if (inTextStream) { console.log(); inTextStream = false; }
            const savedFmt = event.savedTokens >= 1000
              ? `${(event.savedTokens / 1000).toFixed(0)}k`
              : String(event.savedTokens);
            console.log(
              chalk.magenta(`\n⚡ 上下文已自动压缩`) +
              chalk.gray(` (节省 ~${savedFmt} tokens)`)
            );
            recorder.recordCompaction({
              reason: '上下文 token 超过阈值',
              summaryTokens: Math.ceil(event.summary.length / 4),
              savedTokens: event.savedTokens,
              summary: event.summary,
            });
            break;
          }

          case 'approval_required': {
            if (inTextStream) { console.log(); inTextStream = false; }
            break;
          }

          case 'approval_decision': {
            const icon = event.decision.startsWith('allow') ? chalk.green('✓') : chalk.red('✗');
            const decisionText: Record<string, string> = {
              allow_once: '允许（本次）',
              allow_all: '允许（全部）',
              deny: '拒绝',
              deny_abort: '拒绝并中止',
            };
            console.log(
              chalk.gray(`[审批] `) + chalk.cyan(event.toolName) +
              ` ${icon} ${decisionText[event.decision] ?? event.decision}`
            );
            recorder.record({
              type: 'approval',
              data: { callId: event.callId, policy: approvalPolicy, decision: event.decision },
            });
            break;
          }

          case 'tool_blocked': {
            if (inTextStream) { console.log(); inTextStream = false; }
            console.log(
              chalk.gray(`[安全] `) + chalk.cyan(event.toolName) +
              ` ${chalk.red('✗ 已拦截')} ` + chalk.red(event.reason)
            );
            break;
          }

          case 'aborted': {
            if (inTextStream) { console.log(); inTextStream = false; }
            console.log(chalk.yellow('\n⚠️  任务已中止（用户拒绝审批）'));
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

      if (wasInterrupted) {
        recorder.interrupt();
      } else {
        recorder.complete();
      }
    } catch (err) {
      console.error(chalk.red(`\n运行失败：${err instanceof Error ? err.message : String(err)}`));
      recorder.error(err instanceof Error ? err.message : String(err));
    }

    process.removeListener('SIGINT', onSigint);

    const elapsed = Date.now() - startTime;
    const total = totalInputTokens + totalOutputTokens;
    console.log();
    if (total > 0 || toolCallCount > 0) {
      console.log(
        chalk.gray(`─ ${toolCallCount} 次工具调用`) +
        (total > 0 ? chalk.gray(` │ ${formatTokens(total)} tokens`) : '') +
        chalk.gray(` │ ${formatDuration(elapsed)}`)
      );
      console.log(chalk.gray(`  会话 ID：${recorder.sessionId}`));
    }
    console.log();

    rl.resume();
    rl.prompt();
  });

  rl.on('close', () => {
    console.log(chalk.gray('\n再见！'));
    process.exit(0);
  });
}

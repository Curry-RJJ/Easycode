/**
 * easycode resume <session-id> — 断点续传命令
 *
 * 流程：
 *   1. 从 JSONL 读取历史事件
 *   2. 找出未闭合的 tool/call，合成"结果未知"闭合事件追加到 JSONL
 *   3. 重放所有事件重建消息数组
 *   4. 继续运行 Agent（继续记录到同一 JSONL）
 *
 * easycode list — 列出历史会话
 */

import chalk from 'chalk';
import { createDefaultStreamFn } from '@easycode/ai';
import {
  Agent,
  createDefaultRegistryAsync,
  readEvents,
  appendEvent,
  listSessionEntries,
  getSessionEntry,
  synthesizeClosingEvents,
  needsRecovery,
  replayToMessages,
  SessionRecorder,
} from '@easycode/core';
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

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatStatus(status: string): string {
  switch (status) {
    case 'completed':   return chalk.green('✓ 已完成');
    case 'interrupted': return chalk.yellow('⚠ 已中断');
    case 'error':       return chalk.red('✗ 出错');
    case 'running':     return chalk.blue('● 运行中');
    default:            return chalk.gray(status);
  }
}

// ─── list 命令 ────────────────────────────────────────────────────────

export async function listCommand(): Promise<void> {
  const sessions = listSessionEntries(20);

  if (sessions.length === 0) {
    console.log(chalk.gray('\n暂无历史会话。运行 easycode "<任务>" 开始第一个任务。\n'));
    return;
  }

  console.log();
  console.log(chalk.bold('历史会话列表') + chalk.gray('（最近 20 条）'));
  console.log(chalk.gray('─'.repeat(80)));

  const col1 = 38, col2 = 12, col3 = 20;
  console.log(
    chalk.gray(
      '  ' + 'ID (前36字符)'.padEnd(col1) +
      '状态'.padEnd(col2) +
      '创建时间'.padEnd(col3) +
      '任务'
    )
  );
  console.log(chalk.gray('─'.repeat(80)));

  for (const s of sessions) {
    const status = formatStatus(s.status);
    const time = formatDate(s.created_at);
    const prompt = s.prompt.length > 28 ? s.prompt.slice(0, 28) + '…' : s.prompt;

    // status 含 ANSI 码，需手动对齐
    const statusText = s.status === 'completed' ? '✓ 已完成' :
      s.status === 'interrupted' ? '⚠ 已中断' :
      s.status === 'error' ? '✗ 出错' : '● 运行中';

    console.log(
      `  ${chalk.cyan(s.id)}  ` +
      `${status}  ` +
      `${chalk.gray(time)}  ` +
      `${chalk.white(prompt)}`
    );
    void statusText;
  }

  console.log(chalk.gray('─'.repeat(80)));
  console.log(chalk.gray(`\n  使用 ${chalk.white('easycode resume <会话ID>')} 恢复中断的会话\n`));
}

// ─── resume 命令 ──────────────────────────────────────────────────────

export async function resumeCommand(sessionId: string): Promise<void> {
  // 1. 确保已配置
  await ensureConfigured();

  // 2. 检查 session 是否存在
  const entry = getSessionEntry(sessionId);
  if (!entry) {
    console.error(chalk.red(`\n错误：找不到会话 "${sessionId}"。`));
    console.log(chalk.gray('使用 easycode list 查看可用的会话列表。\n'));
    process.exit(1);
  }

  // 3. 读取事件
  const events = readEvents(sessionId);
  if (events.length === 0) {
    console.error(chalk.red(`\n错误：会话 "${sessionId}" 的事件文件为空或已损坏。\n`));
    process.exit(1);
  }

  console.log();
  console.log(chalk.cyan('●') + ' ' + chalk.bold('EasyCode') + chalk.gray(' — 断点续传'));
  console.log(chalk.gray('─'.repeat(50)));
  console.log(chalk.gray(`会话 ID：`) + chalk.cyan(sessionId));
  console.log(chalk.gray(`原始任务：`) + entry.prompt.slice(0, 80));
  console.log(chalk.gray(`原始状态：`) + formatStatus(entry.status));
  console.log(chalk.gray('─'.repeat(50)));

  // 4. 崩溃恢复：合成未闭合 tool/call 的闭合事件
  if (needsRecovery(events)) {
    const closing = synthesizeClosingEvents(events);
    console.log(
      chalk.yellow(`\n⚠️  发现 ${closing.length} 个未完成的工具调用，正在合成恢复事件...`)
    );
    for (const ev of closing) {
      appendEvent(sessionId, ev);
      events.push(ev);
    }
    console.log(chalk.green('✓ 恢复事件已写入 JSONL'));
  }

  // 5. 重放事件，重建消息上下文
  const { messages, lastUserMessage } = replayToMessages(events);
  console.log(chalk.gray(`\n已重建上下文：${messages.length} 条消息`));

  // 6. 初始化 Agent
  const streamFn = createDefaultStreamFn();
  const registry = await createDefaultRegistryAsync();
  const agent = new Agent({ streamFn, registry });

  // 7. 继续记录到同一 JSONL（从现有 seq 继续）
  const recorder = SessionRecorder.fromExisting(sessionId);

  // 8. 打印恢复提示并继续运行
  console.log(chalk.gray('─'.repeat(50)));
  if (lastUserMessage) {
    console.log(chalk.gray('继续执行任务：') + chalk.white(lastUserMessage.slice(0, 80)));
  }
  console.log(chalk.gray('─'.repeat(50)));
  console.log();

  // 9. 设置中断信号
  const abortController = new AbortController();
  process.on('SIGINT', () => {
    console.log(chalk.yellow('\n\n⚠️  收到中断信号，正在停止...'));
    abortController.abort();
  });

  // 统计
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let toolCallCount = 0;
  const startTime = Date.now();
  let inTextStream = false;

  // 缓存本轮 assistant 文本（用于 turn_end 时写入 JSONL）
  let turnText = '';

  // 10. 执行 resume
  try {
    for await (const event of agent.resume(messages, abortController.signal)) {
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
            chalk.gray(`\n[工具] `) + chalk.cyan(event.name) + chalk.gray(' 执行中...')
          );
          toolCallCount++;

          // 记录工具调用到 JSONL
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
          // flush 本轮文本到 JSONL
          if (turnText) {
            recorder.recordAssistantText(turnText);
            turnText = '';
          }
          break;
        }

        case 'compaction': {
          if (inTextStream) { console.log(); inTextStream = false; }
          console.log(
            chalk.magenta(`\n⚡ 上下文已自动压缩`) +
            chalk.gray(` (节省 ~${formatTokens(event.savedTokens)} tokens，当前 ${formatTokens(event.currentTokens)})`)
          );
          recorder.recordCompaction({
            reason: '上下文 token 超过阈值',
            summaryTokens: Math.ceil(event.summary.length / 4),
            savedTokens: event.savedTokens,
            summary: event.summary,
          });
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

    recorder.complete();
  } catch (err) {
    if (inTextStream) { console.log(); }
    console.error(chalk.red(`\n运行失败：${err instanceof Error ? err.message : String(err)}`));
    recorder.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // 打印统计摘要
  const elapsed = Date.now() - startTime;
  const total = totalInputTokens + totalOutputTokens;
  console.log();
  console.log(chalk.gray('─'.repeat(50)));
  console.log(
    chalk.green('✅ 续传完成') +
    chalk.gray(` │ ${toolCallCount} 次工具调用`) +
    (total > 0 ? chalk.gray(` │ ${formatTokens(total)} tokens`) : '') +
    chalk.gray(` │ 耗时 ${formatDuration(elapsed)}`)
  );
  console.log();
}

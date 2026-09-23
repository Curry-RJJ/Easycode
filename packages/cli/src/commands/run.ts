/**
 * easycode "<prompt>" 命令
 *
 * 启动单次任务，流式打印 LLM 输出，显示工具执行日志。
 * M2：每次运行自动创建 Session，记录完整事件溯源到 JSONL。
 */

import chalk from 'chalk';
import { select } from '@inquirer/prompts';
import { createDefaultStreamFn, EasycodeConfig } from '@easycode/ai';
import { Agent, createDefaultRegistryAsync, SessionRecorder } from '@easycode/core';
import type { ApprovalDecision, ApprovalRequest, AgentEvent } from '@easycode/core';
import { EasycodeMcpClient, parseMcpArg, loadMcpTools } from '@easycode/mcp';
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

function clearLine(): void {
  process.stdout.write('\r\x1b[K');
}

// ─── run 命令主逻辑 ────────────────────────────────────────────────────

// ─── 审批 UI（M3.1）────────────────────────────────────────────────────

async function approvalUI(req: ApprovalRequest): Promise<ApprovalDecision> {
  const { toolName, input, reason } = req;

  console.log();
  console.log(chalk.yellow('⚠️  Agent 请求执行以下操作：'));
  console.log(chalk.gray('─'.repeat(50)));
  console.log(chalk.bold(`  工具：`) + chalk.cyan(toolName));
  if (toolName === 'run_bash') {
    console.log(chalk.bold(`  命令：`) + chalk.white(String(input.command ?? '')));
  } else if (toolName === 'write_file' || toolName === 'edit_file') {
    console.log(chalk.bold(`  文件：`) + chalk.white(String(input.path ?? '')));
  }
  console.log(chalk.bold(`  原因：`) + chalk.yellow(reason));
  console.log(chalk.gray('─'.repeat(50)));

  const decision = await select<ApprovalDecision>({
    message: '请选择操作：',
    choices: [
      { name: '✅  允许本次', value: 'allow_once' },
      { name: '✅  允许全部（本会话内不再询问此工具）', value: 'allow_all' },
      { name: '❌  拒绝本次（Agent 继续运行）', value: 'deny' },
      { name: '🛑  拒绝并中止任务', value: 'deny_abort' },
    ],
  });

  return decision;
}

// ─── run 命令主逻辑 ────────────────────────────────────────────────────

export async function runCommand(
  prompt: string,
  opts: { model?: string; approval?: string; mcp?: string; logFormat?: string } = {}
): Promise<void> {
  // JSON 日志模式：所有 AgentEvent 直接输出到 stdout（供外部工具消费）
  const jsonMode = opts.logFormat === 'json';
  function emitJson(event: AgentEvent): void {
    process.stdout.write(JSON.stringify({ ts: Date.now(), ...event }) + '\n');
  }

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

  // 3. M3.2 — 接入 MCP Server（如果指定了 --mcp）
  let mcpClient: EasycodeMcpClient | null = null;
  if (opts.mcp) {
    try {
      const mcpConfig = parseMcpArg(opts.mcp);
      mcpClient = new EasycodeMcpClient();
      if (!jsonMode) {
        process.stdout.write(chalk.gray(`\n[MCP] 正在连接：${opts.mcp} ...`));
      }
      const mcpTools = await loadMcpTools(mcpClient, mcpConfig, opts.mcp);
      registry.registerAll(mcpTools);
      if (!jsonMode) {
        process.stdout.write(`\r\x1b[K`);
        console.log(chalk.gray(`[MCP] ✓ 已连接，加载 ${mcpTools.length} 个工具`));
      }
    } catch (err) {
      console.error(chalk.red(`\n[MCP] 连接失败：${err instanceof Error ? err.message : String(err)}\n`));
      process.exit(1);
    }
  }

  // 4. 读取审批策略
  const config = EasycodeConfig.load();
  const approvalPolicy = (opts.approval as 'ask' | 'auto' | 'never' | undefined)
    ?? config.approvalPolicy
    ?? 'ask';

  // 5. 创建 Agent（含审批回调）
  const agent = new Agent({
    streamFn,
    registry,
    approvalPolicy,
    onApprovalRequired: jsonMode ? undefined : approvalUI,
  });

  // 6. 创建 SessionRecorder（M2：事件溯源）
  const recorder = new SessionRecorder();
  try {
    recorder.start({
      model: opts.model ?? 'default',
      systemPrompt: agent.getSystemPrompt(),
      prompt,
    });
    recorder.recordUserMessage(prompt);
  } catch (err) {
    // 会话记录失败不应阻止主流程
    console.warn(chalk.gray(`[警告] 无法初始化会话记录：${err instanceof Error ? err.message : String(err)}`));
  }

  // 7. 设置中断信号
  const abortController = new AbortController();
  let wasInterrupted = false;
  process.on('SIGINT', () => {
    console.log(chalk.yellow('\n\n⚠️  收到中断信号，正在停止...\n'));
    wasInterrupted = true;
    abortController.abort();
  });

  // 8. 打印任务开始
  if (!jsonMode) {
    console.log();
    console.log(chalk.cyan('●') + ' ' + chalk.bold('EasyCode'));
    console.log(chalk.gray('─'.repeat(50)));
    console.log(chalk.gray(`任务：`) + prompt);
    console.log(chalk.gray(`会话：`) + chalk.gray(recorder.sessionId));
    console.log(chalk.gray('─'.repeat(50)));
    console.log();
  }

  // 统计
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let toolCallCount = 0;
  const startTime = Date.now();

  // 当前是否在输出文本（用于换行控制）
  let inTextStream = false;
  // 缓存本轮 assistant 文本（用于 turn_end 时写入 JSONL）
  let turnText = '';

  // 9. 消费事件流
  try {
    for await (const event of agent.run(prompt, abortController.signal)) {
      // JSON 模式：所有事件直接输出
      if (jsonMode) {
        emitJson(event);
        // 仍需统计 tokens 和记录 JSONL
        if (event.type === 'usage') {
          totalInputTokens += event.inputTokens;
          totalOutputTokens += event.outputTokens;
          recorder.recordTokenUsage(event.inputTokens, event.outputTokens, event.cacheReadTokens);
        } else if (event.type === 'tool_start') {
          let parsedInput: Record<string, unknown> = {};
          try { parsedInput = JSON.parse(event.input || '{}'); } catch { /* ignore */ }
          recorder.recordToolCall(event.callId, event.name, parsedInput);
        } else if (event.type === 'tool_end') {
          recorder.recordToolResult(event.callId, event.result.content, !!event.result.isError);
        } else if (event.type === 'turn_end' && turnText) {
          recorder.recordAssistantText(turnText);
          turnText = '';
        } else if (event.type === 'text') {
          turnText += event.content;
        }
        continue;
      }

      // 普通文本模式
      switch (event.type) {
        case 'text': {
          if (!inTextStream) inTextStream = true;
          turnText += event.content;
          process.stdout.write(event.content);
          break;
        }

        case 'tool_start': {
          if (inTextStream) { console.log(); inTextStream = false; }
          process.stdout.write(
            chalk.gray(`\n[工具] `) +
            chalk.cyan(event.name) +
            chalk.gray(' 执行中...')
          );
          toolCallCount++;
          let parsedInput: Record<string, unknown> = {};
          try { parsedInput = JSON.parse(event.input || '{}'); } catch { /* ignore */ }
          recorder.recordToolCall(event.callId, event.name, parsedInput);
          break;
        }

        case 'tool_end': {
          clearLine();
          const icon = event.result.isError ? chalk.red('✗') : chalk.green('✓');
          console.log(
            chalk.gray(`[工具] `) + chalk.cyan(event.name) +
            ` ${icon} ` + chalk.gray(`(${formatDuration(event.durationMs)})`)
          );
          recorder.recordToolResult(event.callId, event.result.content, !!event.result.isError);
          break;
        }

        case 'tool_error': {
          clearLine();
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
          // M3.3.3：实时显示 token 进度
          const total = totalInputTokens + totalOutputTokens;
          if (total > 0) {
            process.stdout.write(
              chalk.gray(`\n  [context: ${formatTokens(total)} tokens]\n`)
            );
          }
          break;
        }

        case 'compaction': {
          if (inTextStream) { console.log(); inTextStream = false; }
          const savedFmt = formatTokens(event.savedTokens);
          const curFmt = formatTokens(event.currentTokens);
          console.log(chalk.magenta(`\n⚡ 上下文已压缩`) +
            chalk.gray(` (节省 ~${savedFmt} tokens，当前 ${curFmt})`));
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
          const labels: Record<string, string> = {
            allow_once: '允许（本次）', allow_all: '允许（全部）',
            deny: '拒绝', deny_abort: '拒绝并中止',
          };
          console.log(chalk.gray(`[审批] `) + chalk.cyan(event.toolName) +
            ` ${icon} ${labels[event.decision] ?? event.decision}`);
          recorder.record({
            type: 'approval',
            data: { callId: event.callId, policy: approvalPolicy, decision: event.decision },
          });
          break;
        }

        case 'tool_blocked': {
          if (inTextStream) { console.log(); inTextStream = false; }
          console.log(chalk.gray(`[安全] `) + chalk.cyan(event.toolName) +
            ` ${chalk.red('✗ 已拦截')} ` + chalk.red(event.reason));
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
    if (inTextStream) { console.log(); }
    console.error(chalk.red(`\n运行失败：${err instanceof Error ? err.message : String(err)}`));
    recorder.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  } finally {
    // 断开 MCP 连接
    if (mcpClient) await mcpClient.disconnect().catch(() => {});
  }

  // 10. 打印统计摘要
  const elapsed = Date.now() - startTime;
  if (!jsonMode) {
    console.log();
    console.log(chalk.gray('─'.repeat(50)));
    console.log(
      chalk.green('✅ 任务完成') +
      chalk.gray(` │ ${toolCallCount} 次工具调用`) +
      chalk.gray(` │ ${formatTokens(totalInputTokens + totalOutputTokens)} tokens`) +
      chalk.gray(` │ 耗时 ${formatDuration(elapsed)}`)
    );
    console.log(chalk.gray(`会话 ID：${recorder.sessionId}`));
    console.log(chalk.gray(`  (easycode stats ${recorder.sessionId} 查看详情)`));
    console.log();
  }
}

/**
 * 交互式 REPL — Ink 版本
 *
 * 参考 Claude Code CLI 的整体渲染方式：
 * - Ink 接管完整终端输出，所有消息通过 React 状态统一管理
 * - 对话历史用 <Static> 一次性渲染（不再重绘），性能好
 * - 用户历史 prompt：灰色气泡，无横线
 * - 当前输入：干净 " > " 无任何背景色
 */

import React, { useState, useCallback, useRef } from 'react';
import { render, Box, Text, Static, useInput, useApp } from 'ink';
import chalk from 'chalk';
import { createDefaultStreamFn } from '@easycode/ai';
import { Agent, createDefaultRegistryAsync, SessionRecorder } from '@easycode/core';
import { ensureConfigured } from '../setup/wizard.js';

// ─── 类型定义 ─────────────────────────────────────────────────────────

interface ToolRecord {
  callId: string;
  name: string;
  status: 'running' | 'done' | 'error';
  durationMs?: number;
}

interface CompletedTurn {
  id: string;
  userMessage: string;
  tools: ToolRecord[];
  assistantText: string;
  inputTokens: number;
  outputTokens: number;
  toolCount: number;
  elapsedMs: number;
  interrupted?: boolean;
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

// ─── 子组件：已完成的对话轮次 ─────────────────────────────────────────

function TurnView({ turn }: { turn: CompletedTurn }) {
  const total = turn.inputTokens + turn.outputTokens;
  return (
    <Box flexDirection="column" marginBottom={1}>
      {/* 用户 prompt — 灰色背景气泡，无横线 */}
      <Text backgroundColor="#2d2d2d" color="#a8a8a8"> {'>'} {turn.userMessage} </Text>

      {/* 工具调用记录 */}
      {turn.tools.map(tool => (
        <Box key={tool.callId}>
          <Text color="gray">[工具] </Text>
          <Text color="cyan">{tool.name}</Text>
          <Text>
            {' '}{tool.status === 'error' ? chalk.red('✗') : chalk.green('✓')}{' '}
          </Text>
          {tool.durationMs !== undefined && (
            <Text color="gray">({formatDuration(tool.durationMs)})</Text>
          )}
        </Box>
      ))}

      {/* AI 回复正文 */}
      {turn.assistantText ? <Text>{turn.assistantText}</Text> : null}

      {/* 本轮统计 */}
      <Text dimColor color="gray">
        {'─'} {turn.toolCount} 次工具调用
        {total > 0 ? ` │ ${formatTokens(total)} tokens` : ''}
        {` │ ${formatDuration(turn.elapsedMs)}`}
        {turn.interrupted ? ' │ ⚠️ 已中断' : ''}
      </Text>
    </Box>
  );
}

// ─── 当前轮次（流式输出中）────────────────────────────────────────────

function CurrentTurnView({
  userMessage,
  tools,
  streamText,
}: {
  userMessage: string;
  tools: ToolRecord[];
  streamText: string;
}) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text backgroundColor="#2d2d2d" color="#a8a8a8"> {'>'} {userMessage} </Text>
      {tools.map(tool => (
        <Box key={tool.callId}>
          <Text color="gray">[工具] </Text>
          <Text color="cyan">{tool.name}</Text>
          <Text>
            {' '}
            {tool.status === 'running'
              ? chalk.gray('...')
              : tool.status === 'error'
                ? chalk.red('✗')
                : chalk.green('✓')}
            {' '}
          </Text>
          {tool.durationMs !== undefined && (
            <Text color="gray">({formatDuration(tool.durationMs)})</Text>
          )}
        </Box>
      ))}
      {streamText ? <Text>{streamText}</Text> : null}
    </Box>
  );
}

// ─── 主 App ───────────────────────────────────────────────────────────

function ReplApp({ agent }: { agent: Agent }) {
  const { exit } = useApp();

  // 已完成的历史轮次（用 Static 渲染，不重绘）
  const [history, setHistory] = useState<CompletedTurn[]>([]);

  // 当前输入框内容
  const [inputText, setInputText] = useState('');

  // 是否正在运行 Agent
  const [isRunning, setIsRunning] = useState(false);

  // 当前轮次的流式状态（用于实时渲染）
  const [currentUserMsg, setCurrentUserMsg] = useState('');
  const [currentTools, setCurrentTools] = useState<ToolRecord[]>([]);
  const [currentStreamText, setCurrentStreamText] = useState('');

  // 用 ref 存储积累值，避免 async 闭包读到 stale state
  const streamTextRef = useRef('');
  const toolsRef = useRef<ToolRecord[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  // ── 键盘输入处理 ─────────────────────────────────────────────────────
  useInput((input, key) => {
    // Ctrl+C / Ctrl+D：运行中则中断任务，否则退出 REPL
    const isCtrlC = key.ctrl && (input === 'c' || input === '\x03');
    const isCtrlD = key.ctrl && (input === 'd' || input === '\x04');
    if (isCtrlC || isCtrlD) {
      if (isRunning) {
        abortRef.current?.abort();
      } else {
        exit();
      }
      return;
    }

    // 运行中不接受普通输入
    if (isRunning) return;

    if (key.return) {
      const prompt = inputText.trim();
      if (!prompt) return;
      if (['exit', 'quit', 'q', ':q'].includes(prompt.toLowerCase())) {
        exit();
        return;
      }
      runTurn(prompt);
      return;
    }

    if (key.backspace || key.delete) {
      setInputText(prev => prev.slice(0, -1));
      return;
    }

    // 普通字符（支持粘贴多字符）
    if (input && !key.ctrl && !key.meta) {
      setInputText(prev => prev + input);
    }
  });

  // ── Agent 执行 ────────────────────────────────────────────────────────
  const runTurn = useCallback(async (prompt: string) => {
    // 初始化状态
    setIsRunning(true);
    setInputText('');
    setCurrentUserMsg(prompt);
    setCurrentTools([]);
    setCurrentStreamText('');
    streamTextRef.current = '';
    toolsRef.current = [];

    const abortController = new AbortController();
    abortRef.current = abortController;

    const recorder = new SessionRecorder();
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let toolCallCount = 0;
    let wasInterrupted = false;
    const startTime = Date.now();

    try {
      recorder.start({
        model: 'default',
        systemPrompt: agent.getSystemPrompt(),
        prompt,
      });
      recorder.recordUserMessage(prompt);

      for await (const event of agent.run(prompt, abortController.signal)) {
        switch (event.type) {

          case 'text': {
            streamTextRef.current += event.content;
            setCurrentStreamText(streamTextRef.current);
            break;
          }

          case 'tool_start': {
            toolCallCount++;
            const newTool: ToolRecord = { callId: event.callId, name: event.name, status: 'running' };
            toolsRef.current = [...toolsRef.current, newTool];
            setCurrentTools([...toolsRef.current]);
            let parsedInput: Record<string, unknown> = {};
            try { parsedInput = JSON.parse(event.input || '{}'); } catch { /* ignore */ }
            recorder.recordToolCall(event.callId, event.name, parsedInput);
            break;
          }

          case 'tool_end': {
            toolsRef.current = toolsRef.current.map(t =>
              t.callId === event.callId
                ? { ...t, status: event.result.isError ? 'error' as const : 'done' as const, durationMs: event.durationMs }
                : t
            );
            setCurrentTools([...toolsRef.current]);
            recorder.recordToolResult(event.callId, event.result.content, !!event.result.isError);
            break;
          }

          case 'tool_error': {
            toolsRef.current = toolsRef.current.map(t =>
              t.callId === event.callId ? { ...t, status: 'error' as const } : t
            );
            setCurrentTools([...toolsRef.current]);
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
            if (streamTextRef.current) {
              recorder.recordAssistantText(streamTextRef.current);
            }
            break;
          }

          case 'compaction': {
            const savedFmt = event.savedTokens >= 1000
              ? `${(event.savedTokens / 1000).toFixed(0)}k`
              : String(event.savedTokens);
            streamTextRef.current += `\n⚡ 上下文已自动压缩（节省 ~${savedFmt} tokens）\n`;
            setCurrentStreamText(streamTextRef.current);
            recorder.recordCompaction({
              reason: '上下文 token 超过阈值',
              summaryTokens: Math.ceil(event.summary.length / 4),
              savedTokens: event.savedTokens,
              summary: event.summary,
            });
            break;
          }

          case 'error': {
            streamTextRef.current += `\n${chalk.red('错误：' + event.message)}\n`;
            setCurrentStreamText(streamTextRef.current);
            break;
          }

          case 'done': {
            break;
          }
        }
      }

      wasInterrupted = abortController.signal.aborted;
      if (wasInterrupted) {
        recorder.interrupt();
      } else {
        recorder.complete();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      streamTextRef.current += `\n${chalk.red('运行失败：' + msg)}\n`;
      setCurrentStreamText(streamTextRef.current);
      recorder.error(msg);
    }

    const elapsedMs = Date.now() - startTime;

    // 将本轮移入历史
    const completedTurn: CompletedTurn = {
      id: recorder.sessionId,
      userMessage: prompt,
      tools: toolsRef.current,
      assistantText: streamTextRef.current,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      toolCount: toolCallCount,
      elapsedMs,
      interrupted: wasInterrupted,
    };

    setHistory(prev => [...prev, completedTurn]);

    // 清空当前轮次状态
    setCurrentUserMsg('');
    setCurrentTools([]);
    setCurrentStreamText('');
    streamTextRef.current = '';
    toolsRef.current = [];
    setIsRunning(false);
  }, [agent]);

  // ── 渲染 ─────────────────────────────────────────────────────────────
  return (
    <Box flexDirection="column">
      {/* 已完成的历史（Static = 只渲染一次，不随 state 变化重绘）*/}
      <Static items={history}>
        {turn => <TurnView key={turn.id} turn={turn} />}
      </Static>

      {/* 当前正在运行的轮次（实时流式更新）*/}
      {isRunning && (
        <CurrentTurnView
          userMessage={currentUserMsg}
          tools={currentTools}
          streamText={currentStreamText}
        />
      )}

      {/* 输入行：仅在空闲时显示，无背景色、无横线 */}
      {!isRunning && (
        <Box>
          <Text> {'>'} {inputText}</Text>
        </Box>
      )}
    </Box>
  );
}

// ─── 导出命令入口 ─────────────────────────────────────────────────────

export async function replCommand(): Promise<void> {
  await ensureConfigured();

  // ── 关键修复：@inquirer/prompts（readline 驱动）完成后可能遗留 stdin 监听器，
  // 导致 Ink 的 useInput 拿不到键盘事件。
  // 在 Ink 接管前强制清理 stdin 状态：移除旧监听器、恢复流、退出 raw mode。
  process.stdin.removeAllListeners();
  process.stdin.resume();
  if (process.stdin.isTTY) {
    try { process.stdin.setRawMode(false); } catch { /* ignore */ }
  }

  const streamFn = createDefaultStreamFn();
  const registry = await createDefaultRegistryAsync();
  const agent = new Agent({ streamFn, registry });

  // 欢迎语在 Ink 接管前输出（Ink 接管后 console.log 会被拦截/重定向）
  process.stdout.write(
    '\n' +
    chalk.cyan('●') + ' ' + chalk.bold('EasyCode') + chalk.gray(' — 交互模式') + '\n' +
    chalk.gray('  输入任务描述开始，Ctrl+C 中断，输入 exit 退出') + '\n\n'
  );

  const { waitUntilExit } = render(<ReplApp agent={agent} />, {
    exitOnCtrlC: false,   // 自己处理 Ctrl+C，区分"中断任务"和"退出 REPL"
    patchConsole: false,  // 不拦截 console.log，避免与 Agent 输出冲突
  });
  await waitUntilExit();
}

/**
 * easycode stats <session-id> — Session 统计面板（M3.3.1）
 *
 * 从 JSONL 事件溯源文件中聚合：
 *   - 会话时长
 *   - Token 用量（input/output/缓存命中）
 *   - 工具调用次数与平均耗时
 *   - 上下文压缩记录
 *   - 估算费用
 */

import chalk from 'chalk';
import { readEvents, getSessionEntry } from '@easycode/core';

// ─── 费用估算（美元/1K tokens，2024 年底价格参考） ────────────────────

const PRICE_TABLE: Record<string, { input: number; output: number }> = {
  'deepseek-chat':            { input: 0.00027, output: 0.0011 },
  'deepseek-reasoner':        { input: 0.00055, output: 0.0022 },
  'gpt-4o':                   { input: 0.0025,  output: 0.01   },
  'gpt-4o-mini':              { input: 0.00015, output: 0.0006 },
  'claude-3-5-sonnet-20241022': { input: 0.003, output: 0.015  },
};

function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const modelName = model.includes('/') ? model.split('/').pop()! : model;
  const price = PRICE_TABLE[modelName];
  if (!price) return 0;
  return (inputTokens / 1000) * price.input + (outputTokens / 1000) * price.output;
}

// ─── 格式化工具 ────────────────────────────────────────────────────────

function fmtNum(n: number): string {
  return n.toLocaleString('zh-CN');
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}m ${s}s`;
}

function fmtStatus(status: string): string {
  switch (status) {
    case 'completed':   return chalk.green('✓ 已完成');
    case 'interrupted': return chalk.yellow('⚠ 已中断');
    case 'error':       return chalk.red('✗ 出错');
    case 'running':     return chalk.blue('● 运行中');
    default:            return chalk.gray(status);
  }
}

function box(lines: string[], width = 48): string {
  const inner = width - 2;
  const top    = '┌' + '─'.repeat(inner) + '┐';
  const bottom = '└' + '─'.repeat(inner) + '┘';
  const mid    = '├' + '─'.repeat(inner) + '┤';

  const rows = lines.map((l) => {
    if (l === '---') return mid;
    // 剥离 ANSI 计算可见长度
    const visible = l.replace(/\x1b\[[0-9;]*m/g, '');
    const pad = Math.max(0, inner - 2 - visible.length);
    return '│ ' + l + ' '.repeat(pad) + ' │';
  });

  return [top, ...rows, bottom].join('\n');
}

// ─── 主命令 ────────────────────────────────────────────────────────────

export async function statsCommand(sessionId: string): Promise<void> {
  const entry = getSessionEntry(sessionId);
  if (!entry) {
    console.error(chalk.red(`\n找不到会话：${sessionId}\n`));
    process.exit(1);
  }

  const events = readEvents(sessionId);
  if (events.length === 0) {
    console.error(chalk.red(`\n会话事件文件为空或已损坏\n`));
    process.exit(1);
  }

  // ── 聚合统计 ──────────────────────────────────────────────────────────

  let totalInput = 0, totalOutput = 0, totalCacheRead = 0;
  const toolStats: Map<string, { count: number; totalMs: number }> = new Map();
  const toolCallTimes: Map<string, number> = new Map(); // callId → startTs
  const compactions: Array<{ seq: number; savedTokens: number }> = [];

  let sessionStartTs = 0;
  let sessionEndTs = 0;
  let model = entry.model;

  for (const e of events) {
    switch (e.type) {
      case 'session/start':
        sessionStartTs = e.ts;
        model = e.data.model;
        break;
      case 'session/end':
        sessionEndTs = e.ts;
        break;
      case 'token/usage':
        totalInput   += e.data.input;
        totalOutput  += e.data.output;
        totalCacheRead += e.data.cacheRead ?? 0;
        break;
      case 'tool/call':
        toolCallTimes.set(e.data.callId, e.ts);
        break;
      case 'tool/result': {
        const startTs = toolCallTimes.get(e.data.callId) ?? e.ts;
        const durationMs = e.ts - startTs;
        const name = events.find(
          (x) => x.type === 'tool/call' && x.data.callId === e.data.callId
        )?.type === 'tool/call'
          ? (events.find(
              (x) => x.type === 'tool/call' && x.data.callId === e.data.callId
            ) as Extract<typeof e, { type: 'tool/call' }>).data.name
          : 'unknown';
        const existing = toolStats.get(name) ?? { count: 0, totalMs: 0 };
        toolStats.set(name, { count: existing.count + 1, totalMs: existing.totalMs + durationMs });
        break;
      }
      case 'compaction':
        compactions.push({ seq: e.seq, savedTokens: e.data.savedTokens });
        break;
    }
  }

  const elapsedMs = sessionEndTs
    ? sessionEndTs - sessionStartTs
    : Date.now() - sessionStartTs;

  const totalTokens = totalInput + totalOutput;
  const cost = estimateCost(model, totalInput, totalOutput);

  // ── 渲染面板 ──────────────────────────────────────────────────────────

  const shortId = sessionId.length > 20 ? sessionId.slice(0, 20) + '…' : sessionId;

  const lines: string[] = [
    `${chalk.bold('Session:')} ${chalk.cyan(shortId)}  ${fmtStatus(entry.status)}`,
    `${chalk.gray('时长:')} ${fmtDuration(elapsedMs)}`,
    '---',
    chalk.bold('Token 用量'),
    `  Input:  ${chalk.white(fmtNum(totalInput).padStart(12))}` +
      (totalCacheRead > 0 ? chalk.gray(`  (缓存命中: ${fmtNum(totalCacheRead)})`) : ''),
    `  Output: ${chalk.white(fmtNum(totalOutput).padStart(12))}`,
    `  Total:  ${chalk.white(fmtNum(totalTokens).padStart(12))}`,
    cost > 0
      ? `  ${chalk.gray('预计费用:')} ${chalk.yellow('$' + cost.toFixed(4))}`
      : `  ${chalk.gray('费用：模型未收录，无法估算')}`,
  ];

  if (toolStats.size > 0) {
    lines.push('---');
    lines.push(chalk.bold('工具调用记录'));
    for (const [name, { count, totalMs }] of toolStats) {
      const avg = Math.round(totalMs / count);
      lines.push(
        `  ${chalk.cyan(name.padEnd(18))} ×${String(count).padStart(2)}   avg ${fmtDuration(avg)}`
      );
    }
  }

  if (compactions.length > 0) {
    lines.push('---');
    lines.push(chalk.bold('压缩记录'));
    compactions.forEach((c, i) => {
      const savedFmt = c.savedTokens >= 1000
        ? `~${(c.savedTokens / 1000).toFixed(0)}k`
        : String(c.savedTokens);
      lines.push(`  第 ${i + 1} 次压缩  节省 ${chalk.magenta(savedFmt)} tokens`);
    });
  }

  console.log();
  console.log(box(lines, 56));
  console.log();
}

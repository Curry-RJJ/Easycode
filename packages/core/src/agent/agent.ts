/**
 * Agent 类（对外 API）
 *
 * 封装 runLoop，提供简洁的调用接口：
 *   const agent = new Agent({ streamFn, registry });
 *   for await (const event of agent.run("帮我修复 bug")) { ... }
 *
 * M2 新增：
 *   - enableCompaction / compactionThreshold / keepRecentTurns（上下文压缩）
 *   - model（用于确定上下文窗口大小）
 */

import os from 'os';
import type { Message, StreamFn, ToolDefinition } from '@easycode/ai';
import type { ToolRegistry } from '../tools/registry.js';
import { runLoop, type AgentEvent } from './agent-loop.js';
import type { ApprovalPolicy } from '../security/policy.js';
import type { OnApprovalRequired } from '../security/approval.js';

// ─── 系统提示词 ─────────────────────────────────────────────────────────

function buildSystemPrompt(): string {
  const cwd = process.cwd();
  const platform = os.platform();
  const now = new Date().toISOString();

  return [
    'You are EasyCode, an expert AI coding assistant operating in a terminal environment.',
    '',
    `Current working directory: ${cwd}`,
    `Platform: ${platform}`,
    `Current time: ${now}`,
    '',
    '## Your capabilities',
    'You have access to the following tools to help users with coding tasks:',
    '- read_file: Read file contents',
    '- write_file: Create or overwrite files',
    '- edit_file: Search-and-replace edit within a file (preferred for modifications)',
    '- run_bash: Execute shell commands',
    '- list_dir: List directory contents',
    '- search_files: Search file contents with regex',
    '',
    '## Guidelines',
    '1. Always read files before editing them to understand the current state.',
    '2. Prefer edit_file over write_file for modifications to avoid overwriting unrelated content.',
    '3. After making changes, verify with run_bash (e.g., run tests) when appropriate.',
    '4. Be concise in explanations; show your work through tool calls rather than verbose text.',
    '5. If a task is ambiguous, ask for clarification before proceeding.',
    '6. Respond in the same language as the user.',
  ].join('\n');
}

// ─── Agent 类 ─────────────────────────────────────────────────────────

export interface AgentOptions {
  streamFn: StreamFn;
  registry: ToolRegistry;
  maxTurns?: number;
  systemPrompt?: string;
  /** 模型标识（"provider/model" 格式），用于确定上下文窗口大小 */
  model?: string;
  /** M2.3：是否启用上下文压缩（默认 false） */
  enableCompaction?: boolean;
  /** M2.3：压缩阈值 0-1（默认 0.8） */
  compactionThreshold?: number;
  /** M2.3：保留最近 N 轮完整对话（默认 3） */
  keepRecentTurns?: number;
  /** M3.1：审批策略（默认 ask） */
  approvalPolicy?: ApprovalPolicy;
  /** M3.1：审批回调（CLI 层实现） */
  onApprovalRequired?: OnApprovalRequired;
}

export class Agent {
  private streamFn: StreamFn;
  private registry: ToolRegistry;
  private maxTurns: number;
  private systemPrompt: string;
  private model: string;
  private enableCompaction: boolean;
  private compactionThreshold: number;
  private keepRecentTurns: number;
  private approvalPolicy: ApprovalPolicy;
  private onApprovalRequired?: OnApprovalRequired;

  constructor(opts: AgentOptions) {
    this.streamFn = opts.streamFn;
    this.registry = opts.registry;
    this.maxTurns = opts.maxTurns ?? 50;
    this.systemPrompt = opts.systemPrompt ?? buildSystemPrompt();
    this.model = opts.model ?? 'deepseek/deepseek-chat';
    this.enableCompaction = opts.enableCompaction ?? false;
    this.compactionThreshold = opts.compactionThreshold ?? 0.8;
    this.keepRecentTurns = opts.keepRecentTurns ?? 3;
    this.approvalPolicy = opts.approvalPolicy ?? 'ask';
    this.onApprovalRequired = opts.onApprovalRequired;
  }

  /**
   * 运行一次任务，返回事件流。
   * @param prompt 用户输入的任务描述
   * @param abortSignal 用于中断（Ctrl+C）
   */
  async *run(prompt: string, abortSignal?: AbortSignal): AsyncIterable<AgentEvent> {
    const messages: Message[] = [
      { role: 'system', content: this.systemPrompt },
      { role: 'user', content: prompt },
    ];

    const tools: ToolDefinition[] = this.registry.getAll();

    yield* runLoop({
      messages,
      tools,
      streamFn: this.streamFn,
      registry: this.registry,
      maxTurns: this.maxTurns,
      abortSignal,
      enableCompaction: this.enableCompaction,
      compactionThreshold: this.compactionThreshold,
      model: this.model,
      keepRecentTurns: this.keepRecentTurns,
      approvalPolicy: this.approvalPolicy,
      onApprovalRequired: this.onApprovalRequired,
    });
  }

  /**
   * 从历史消息继续（用于 resume 功能）。
   * messages 已包含 system prompt，由 replay.ts 重建。
   */
  async *resume(
    messages: Message[],
    abortSignal?: AbortSignal
  ): AsyncIterable<AgentEvent> {
    const tools: ToolDefinition[] = this.registry.getAll();

    yield* runLoop({
      messages,
      tools,
      streamFn: this.streamFn,
      registry: this.registry,
      maxTurns: this.maxTurns,
      abortSignal,
      enableCompaction: this.enableCompaction,
      compactionThreshold: this.compactionThreshold,
      model: this.model,
      keepRecentTurns: this.keepRecentTurns,
      approvalPolicy: this.approvalPolicy,
      onApprovalRequired: this.onApprovalRequired,
    });
  }

  /** 暴露 system prompt（用于 SessionRecorder） */
  getSystemPrompt(): string {
    return this.systemPrompt;
  }

  /** 暴露模型名（用于 SessionRecorder） */
  getModel(): string {
    return this.model;
  }
}

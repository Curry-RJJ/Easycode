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

import type { Message, StreamFn, ToolDefinition } from '@easycode/ai';
import type { ToolRegistry } from '../tools/registry.js';
import { runLoop, type AgentEvent } from './agent-loop.js';
import type { ApprovalPolicy } from '../security/policy.js';
import type { OnApprovalRequired } from '../security/approval.js';
import { buildSystemPrompt } from './system-prompt.js';
import { loadProjectMemory } from '../context/project-memory.js';
import { getCwd } from '../utils/cwd.js';

// ─── Agent 类 ─────────────────────────────────────────────────────────

export interface AgentOptions {
  streamFn: StreamFn;
  registry: ToolRegistry;
  maxTurns?: number;
  /** 覆盖自动生成的系统提示词（一般不需要手动传，由 buildSystemPrompt 生成） */
  systemPrompt?: string;
  /** 模型标识（"provider/model" 格式），用于确定上下文窗口大小 */
  model?: string;
  /** 项目根目录（默认 getCwd()），用于查找 CLAUDE.md / AGENTS.md */
  projectRoot?: string;
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
    this.model = opts.model ?? 'deepseek/deepseek-chat';

    // F-02：系统提示词工程 — 使用结构化五段提示词 + CLAUDE.md 注入
    if (opts.systemPrompt) {
      this.systemPrompt = opts.systemPrompt;
    } else {
      const projectRoot = opts.projectRoot ?? getCwd();
      const projectMemory = loadProjectMemory(projectRoot);
      this.systemPrompt = buildSystemPrompt({ projectRoot, projectMemory });
    }
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

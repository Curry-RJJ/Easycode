/**
 * @easycode/core — 公开导出
 */

// ─── Agent 类与 runLoop ───────────────────────────────────────────────
export { Agent } from './agent/agent.js';
export { runLoop, estimateContextTokens } from './agent/agent-loop.js';
export type { AgentEvent, RunLoopOptions } from './agent/agent-loop.js';
export type { AgentOptions } from './agent/agent.js';

// ─── 工具注册表 ────────────────────────────────────────────────────────
export { ToolRegistry, createDefaultRegistryAsync } from './tools/registry.js';

// ─── 内置工具 ──────────────────────────────────────────────────────────
export { readFileTool } from './tools/handlers/read.js';
export { writeFileTool } from './tools/handlers/write.js';
export { editFileTool } from './tools/handlers/edit.js';
export { runBashTool } from './tools/handlers/bash.js';
export { listDirTool } from './tools/handlers/ls.js';
export { searchFilesTool } from './tools/handlers/grep.js';

// ─── M2.2 读写并发调度器 ───────────────────────────────────────────────
export { scheduleToolCalls, extractSchedulerLog } from './tools/scheduler.js';
export type {
  ToolCallToExecute,
  ToolExecutionResult,
  SchedulerLog,
  OnToolComplete,
} from './tools/scheduler.js';

// ─── F-02 系统提示词 + 项目记忆 ───────────────────────────────────────
export { buildSystemPrompt } from './agent/system-prompt.js';
export type { SystemPromptOptions } from './agent/system-prompt.js';
export { loadProjectMemory } from './context/project-memory.js';

// ─── M2.3 Token 计数与压缩 ─────────────────────────────────────────────
export {
  estimateTokens,
  countTokens,
  getModelContextWindow,
  TokenBudget,
} from './context/token.js';
export { compactIfNeeded } from './context/compaction.js';
export type { CompactionResult, CompactionOptions } from './context/compaction.js';

// ─── M2.1 Session 事件溯源 ─────────────────────────────────────────────
export type { EventRecord, EventType, ExtractEvent } from './session/types.js';
export {
  appendEvent,
  readEvents,
  sessionExists,
  getSessionFilePath,
  createSessionEntry,
  updateSessionStatus,
  listSessionEntries,
  getSessionEntry,
  SESSIONS_DIR,
} from './session/storage.js';
export type { SessionStatus, SessionEntry } from './session/storage.js';
export { SessionRecorder } from './session/session.js';
export type { SessionStartOptions, SessionInfo } from './session/session.js';

// ─── M2.1 Checkpoint（崩溃恢复 + 事件重放） ────────────────────────────
export {
  findOpenToolCalls,
  needsRecovery,
  synthesizeClosingEvents,
} from './checkpoint/recovery.js';
export { replayToMessages } from './checkpoint/replay.js';

// ─── M3.1 安全审批 ────────────────────────────────────────────────────
export {
  DANGEROUS_PATTERNS,
  WRITE_TOOLS,
  checkDangerousCommand,
  checkToolApproval,
} from './security/policy.js';
export type { DangerCheck, ApprovalCheck, ApprovalPolicy } from './security/policy.js';
export type {
  ApprovalDecision,
  ApprovalRequest,
  OnApprovalRequired,
} from './security/approval.js';

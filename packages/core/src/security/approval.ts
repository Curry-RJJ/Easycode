/**
 * 审批决策类型（L2 防线）
 *
 * 审批策略三态：
 *   - ask    → 写操作/危险命令弹出交互式确认（默认）
 *   - auto   → 所有工具自动放行（危险命令仍被 L1 拦截）
 *   - never  → 所有写操作拒绝（纯只读模式）
 *
 * ApprovalDecision：用户对一次审批的回复。
 */

export type { ApprovalPolicy } from './policy.js';

// ─── 审批决策 ─────────────────────────────────────────────────────────

export type ApprovalDecision =
  | 'allow_once'  // 本次允许
  | 'allow_all'   // 本次会话内全部允许（跳过后续同类工具的审批）
  | 'deny'        // 拒绝本次，Agent 继续运行（工具返回错误）
  | 'deny_abort'; // 拒绝并中止整个任务

// ─── 审批请求（传给 CLI 层的信息） ───────────────────────────────────

export interface ApprovalRequest {
  callId: string;
  toolName: string;
  input: Record<string, unknown>;
  /** 危险原因说明（来自 policy.ts） */
  reason: string;
}

// ─── 回调类型（由 CLI 层实现，传入 agent-loop） ───────────────────────

/**
 * 审批回调：当工具调用需要用户确认时，agent-loop 调用此函数等待用户决定。
 * CLI 层通过 inquirer 实现交互式询问。
 * 返回 Promise 使 agent-loop 能异步等待用户输入。
 */
export type OnApprovalRequired = (req: ApprovalRequest) => Promise<ApprovalDecision>;

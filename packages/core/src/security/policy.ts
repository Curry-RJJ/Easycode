/**
 * 安全策略 — 危险命令模式匹配（L1 防线）
 *
 * 参考 Codex 的 execpolicy 设计：
 *   - L1：静态模式匹配，识别已知危险命令
 *   - 匹配成功 → 强制升级到审批，无论策略是否为 auto
 *
 * 工具安全级别：
 *   - safe      → 直接执行，无需审批
 *   - dangerous → 匹配了危险模式，需要审批
 *   - blocked   → 策略为 never 时，写操作直接拒绝
 */

// ─── 危险命令模式库 ─────────────────────────────────────────────────────

/**
 * 危险命令模式（正则匹配 bash 命令字符串）。
 * 只要命令匹配任一模式，即触发审批确认。
 */
export const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /rm\s+(-\w*r\w*f\w*|-\w*f\w*r\w*)\s*/i, reason: '递归强制删除文件' },
  { pattern: /rm\s+-rf/i,                              reason: '递归强制删除文件' },
  { pattern: /sudo\s+/,                                reason: '提权执行命令' },
  { pattern: /chmod\s+[0-7]*7[0-7][0-7]/,             reason: '开放危险权限' },
  { pattern: /curl[^|]+\|\s*(ba)?sh/i,                 reason: '远程脚本执行' },
  { pattern: /wget[^|]+\|\s*(ba)?sh/i,                 reason: '远程脚本执行' },
  { pattern: />\s*\/etc\//,                            reason: '写入系统配置目录' },
  { pattern: />\s*\/usr\//,                            reason: '写入系统目录' },
  { pattern: />\s*\/bin\//,                            reason: '写入二进制目录' },
  { pattern: /DROP\s+TABLE/i,                          reason: '删除数据库表' },
  { pattern: /DROP\s+DATABASE/i,                       reason: '删除整个数据库' },
  { pattern: /TRUNCATE\s+TABLE/i,                      reason: '清空数据库表' },
  { pattern: /mkfs\./,                                 reason: '格式化磁盘分区' },
  { pattern: /dd\s+if=/,                               reason: '底层磁盘写入' },
  { pattern: /:\(\)\{.*\}\s*;/,                        reason: 'Fork Bomb 危险代码' },
  { pattern: /shutdown\s+/i,                           reason: '系统关机/重启' },
  { pattern: /reboot\b/i,                              reason: '系统重启' },
  { pattern: /passwd\s+/,                              reason: '修改用户密码' },
  { pattern: /userdel\s+/,                             reason: '删除系统用户' },
  { pattern: /iptables\s+/,                            reason: '修改防火墙规则' },
];

// ─── 写操作工具集（policy=never 时拒绝） ──────────────────────────────

/**
 * 被认为是"写操作"的工具名称集合。
 * 策略为 never 时，这些工具的调用会被直接拒绝。
 */
export const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'run_bash']);

// ─── 判断函数 ─────────────────────────────────────────────────────────

export interface DangerCheck {
  isDangerous: boolean;
  reason?: string;
  /** 匹配到的具体模式（调试用） */
  matchedPattern?: string;
}

/**
 * 检查一个 run_bash 命令是否触发危险模式。
 * 只对 run_bash 工具的 command 参数生效。
 */
export function checkDangerousCommand(command: string): DangerCheck {
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return {
        isDangerous: true,
        reason,
        matchedPattern: pattern.toString(),
      };
    }
  }
  return { isDangerous: false };
}

/**
 * 综合判断一次工具调用是否需要审批。
 *
 * @param toolName  工具名
 * @param input     工具参数
 * @param policy    当前审批策略
 * @returns         { needsApproval, reason, isBlocked }
 */
export interface ApprovalCheck {
  /** 是否需要弹出审批确认 */
  needsApproval: boolean;
  /** 是否直接拒绝（policy=never 时的写操作） */
  isBlocked: boolean;
  /** 拒绝/审批原因说明 */
  reason?: string;
}

export type ApprovalPolicy = 'ask' | 'auto' | 'never';

export function checkToolApproval(
  toolName: string,
  input: Record<string, unknown>,
  policy: ApprovalPolicy
): ApprovalCheck {
  // ── never 策略：所有写操作直接拒绝 ────────────────────────────────
  if (policy === 'never' && WRITE_TOOLS.has(toolName)) {
    return {
      needsApproval: false,
      isBlocked: true,
      reason: `策略为 never（只读模式），工具 "${toolName}" 涉及写操作，已拒绝执行`,
    };
  }

  // ── 危险命令检测：只对 run_bash 生效 ──────────────────────────────
  if (toolName === 'run_bash') {
    const command = (input.command as string | undefined) ?? '';
    const dangerCheck = checkDangerousCommand(command);

    if (dangerCheck.isDangerous) {
      // auto 策略：危险命令仍需审批（L1 强制覆盖）
      // ask 策略：弹出审批
      // never 策略：已在上面拒绝了 run_bash，到这里说明是 never+run_bash 且不在 WRITE_TOOLS 中（不可能）
      return {
        needsApproval: true,
        isBlocked: false,
        reason: dangerCheck.reason,
      };
    }
  }

  // ── ask 策略：write_file / edit_file 需要确认 ─────────────────────
  if (policy === 'ask' && (toolName === 'write_file' || toolName === 'edit_file')) {
    return {
      needsApproval: true,
      isBlocked: false,
      reason: `工具 "${toolName}" 会修改文件系统`,
    };
  }

  return { needsApproval: false, isBlocked: false };
}

/**
 * 持久 CWD 状态管理
 *
 * 模块级单例：在整个 Agent 会话中保持工作目录的持续状态。
 * 每次 run_bash 执行完成后，由 shell.ts 调用 setCwd() 同步最新目录。
 *
 * 设计参考：
 *   D:\projects\claude-code\src\utils\cwd.ts — getCwd / setCwd
 */

/** 当前 Shell 会话工作目录 */
let _cwd: string = process.cwd();

/** 获取当前工作目录（Agent 会话视角） */
export function getCwd(): string {
  return _cwd;
}

/** 更新工作目录（由 execBash 在命令完成后调用） */
export function setCwd(path: string): void {
  _cwd = path;
}

/** 重置为进程初始工作目录（用于测试或会话重置） */
export function resetCwd(): void {
  _cwd = process.cwd();
}

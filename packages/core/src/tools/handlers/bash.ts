/**
 * run_bash 工具（F-01 重写版）
 *
 * 核心改造：
 *   - execSync → execBash（spawn-based，非阻塞）
 *   - CWD 持久：cd 命令效果跨调用保留
 *   - 流式进度：长命令每秒向 stderr 打印最新输出行
 *   - 超时 + AbortSignal：SIGTERM 真正终止子进程
 *   - 删除 working_dir 参数（使用持久 CWD，通过 cd 命令改变目录）
 *
 * 设计参考：
 *   D:\projects\claude-code\packages\builtin-tools\src\tools\BashTool\BashTool.tsx
 *   D:\projects\claude-code\src\utils\Shell.ts — exec()
 */

import type { ToolDefinition, ToolResult } from '@easycode/ai';
import { execBash } from '../../utils/shell.js';
import { getCwd } from '../../utils/cwd.js';

const DEFAULT_TIMEOUT_MS = 120_000; // 2 分钟（spawn 比 execSync 更稳，适当放宽）
const MAX_OUTPUT_CHARS = 100_000;   // 超过则截断（F-05 会改为溢写磁盘）

// 模块级当前进程引用（供 Ctrl+C 杀死）
// 由于 bash 工具是 exclusive 并发，同时只有一个在跑

/** 进度输出到 stderr（临时方案，F-09 会改为 CLI 事件渲染） */
function writeProgress(elapsed: number, lastLine: string): void {
  const secs = Math.floor(elapsed / 1000);
  const preview = lastLine.slice(0, 80);
  process.stderr.write(`\r  \u280b 执行中 ${secs}s... ${preview}\x1b[K`);
}

/** 清除进度行 */
function clearProgress(): void {
  process.stderr.write('\r\x1b[K');
}

export const runBashTool: ToolDefinition = {
  name: 'run_bash',
  description:
    '在持久 Shell 会话中执行 shell 命令，返回 stdout 和 stderr。\n' +
    '- CWD 在调用之间持久保留：cd 命令的效果下次调用依然有效。\n' +
    '- 默认超时 120 秒，可通过 timeout_ms 参数调整（最大 300 秒）。\n' +
    '- 输出超过 100000 字符时会被截断。\n' +
    '- 危险命令（如 rm -rf、sudo 等）需要用户审批。\n' +
    '- 不需要指定工作目录参数，使用 cd 命令改变目录即可。',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: '要执行的 shell 命令',
      },
      timeout_ms: {
        type: 'integer',
        description: `超时时间（毫秒），默认 ${DEFAULT_TIMEOUT_MS}，最大 300000`,
      },
    },
    required: ['command'],
  },
  concurrency: 'exclusive',

  async execute(input): Promise<ToolResult> {
    const command = input['command'] as string;
    const rawTimeout = (input['timeout_ms'] as number | undefined) ?? DEFAULT_TIMEOUT_MS;
    const timeoutMs = Math.min(rawTimeout, 300_000);

    const startTime = Date.now();
    let progressShown = false;

    try {
      const result = await execBash(command, {
        timeoutMs,
        onProgress: (line, elapsed) => {
          progressShown = true;
          writeProgress(elapsed, line);
        },
      });

      if (progressShown) clearProgress();

      const elapsed = Date.now() - startTime;
      const newCwd = getCwd();

      // 合并 stdout/stderr 展示
      let output = '';
      if (result.stdout) output += result.stdout;
      if (result.stderr) {
        output += output ? `\n[stderr]\n${result.stderr}` : `[stderr]\n${result.stderr}`;
      }

      // 截断超长输出（F-05 会改为溢写磁盘）
      let displayOutput = output || '（命令执行成功，无输出）';
      if (displayOutput.length > MAX_OUTPUT_CHARS) {
        displayOutput =
          displayOutput.slice(0, MAX_OUTPUT_CHARS) +
          `\n\n[输出被截断，共 ${displayOutput.length} 字符，只显示前 ${MAX_OUTPUT_CHARS} 字符]`;
      }

      if (result.timedOut) {
        return {
          content:
            `[命令] ${command}\n` +
            `[超时] ${timeoutMs}ms 后强制终止\n` +
            `[CWD] ${newCwd}\n` +
            `[输出]\n${displayOutput}`,
          isError: true,
        };
      }

      if (result.interrupted) {
        return {
          content:
            `[命令] ${command}\n` +
            `[中断] 被用户取消\n` +
            `[CWD] ${newCwd}\n` +
            `[输出]\n${displayOutput}`,
          isError: true,
        };
      }

      if (result.exitCode !== 0) {
        return {
          content:
            `[命令] ${command}\n` +
            `[耗时] ${elapsed}ms\n` +
            `[失败] 退出码 ${result.exitCode}\n` +
            `[CWD] ${newCwd}\n` +
            `[输出]\n${displayOutput}`,
          isError: true,
        };
      }

      return {
        content:
          `[命令] ${command}\n` +
          `[耗时] ${elapsed}ms\n` +
          `[CWD] ${newCwd}\n` +
          `[输出]\n${displayOutput}`,
      };
    } catch (err: unknown) {
      if (progressShown) clearProgress();
      const elapsed = Date.now() - startTime;
      const msg = err instanceof Error ? err.message : String(err);

      // 常见：bash 未找到（Windows 无 Git Bash）
      const hint =
        process.platform === 'win32' && msg.includes('ENOENT')
          ? '\n提示：未找到 bash。请安装 Git for Windows 并确保 bash.exe 在 PATH 中，' +
            '或设置环境变量 CLAUDE_CODE_GIT_BASH_PATH 指向 bash.exe 路径。'
          : '';

      return {
        content:
          `[命令] ${command}\n` +
          `[耗时] ${elapsed}ms\n` +
          `执行失败：${msg}${hint}`,
        isError: true,
      };
    }
  },
};

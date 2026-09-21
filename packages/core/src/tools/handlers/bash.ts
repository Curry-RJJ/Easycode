/**
 * run_bash 工具
 *
 * 执行 shell 命令，返回 stdout/stderr。
 * 并发类型为 exclusive（副作用强，需独占执行）。
 */

import { execSync } from 'child_process';
import type { ToolDefinition, ToolResult } from '@easycode/ai';

const DEFAULT_TIMEOUT_MS = 30_000; // 30 秒
const MAX_OUTPUT_CHARS = 50_000;   // 截断超长输出

export const runBashTool: ToolDefinition = {
  name: 'run_bash',
  description:
    '在当前工作目录执行 shell 命令，返回 stdout 和 stderr。\n' +
    '- 适合运行测试、构建命令、查看输出等。\n' +
    '- 默认超时 30 秒，可通过 timeout_ms 参数调整。\n' +
    '- 输出超过 50000 字符时会被截断。\n' +
    '- 危险命令（如 rm -rf、sudo 等）需要用户审批。',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: '要执行的 shell 命令',
      },
      working_dir: {
        type: 'string',
        description: '命令执行目录（可选，默认为当前工作目录）',
      },
      timeout_ms: {
        type: 'integer',
        description: `超时时间（毫秒），默认 ${DEFAULT_TIMEOUT_MS}`,
      },
    },
    required: ['command'],
  },
  concurrency: 'exclusive',

  async execute(input): Promise<ToolResult> {
    const command = input.command as string;
    const workingDir = (input.working_dir as string | undefined) ?? process.cwd();
    const timeoutMs = (input.timeout_ms as number | undefined) ?? DEFAULT_TIMEOUT_MS;

    const startTime = Date.now();

    try {
      const output = execSync(command, {
        cwd: workingDir,
        timeout: timeoutMs,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 10 * 1024 * 1024, // 10MB
      });

      const elapsed = Date.now() - startTime;
      let result = output || '（命令执行成功，无输出）';

      if (result.length > MAX_OUTPUT_CHARS) {
        result =
          result.slice(0, MAX_OUTPUT_CHARS) +
          `\n\n[输出被截断，共 ${result.length} 字符，只显示前 ${MAX_OUTPUT_CHARS} 字符]`;
      }

      return {
        content: `[命令] ${command}\n[耗时] ${elapsed}ms\n[输出]\n${result}`,
      };
    } catch (err: unknown) {
      const elapsed = Date.now() - startTime;

      // execSync 抛出的错误包含 stderr
      if (err && typeof err === 'object' && 'stdout' in err) {
        const execError = err as { stdout: string; stderr: string; status: number | null; signal: string | null };
        const stdout = execError.stdout || '';
        const stderr = execError.stderr || '';
        const exitCode = execError.status;
        const signal = execError.signal;

        let output = '';
        if (stdout) output += `[stdout]\n${stdout}\n`;
        if (stderr) output += `[stderr]\n${stderr}\n`;

        const reason = signal
          ? `信号 ${signal}`
          : exitCode !== null
          ? `退出码 ${exitCode}`
          : '未知错误';

        return {
          content:
            `[命令] ${command}\n` +
            `[耗时] ${elapsed}ms\n` +
            `[失败] ${reason}\n` +
            output.trim(),
          isError: true,
        };
      }

      return {
        content: `执行命令失败：${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
};

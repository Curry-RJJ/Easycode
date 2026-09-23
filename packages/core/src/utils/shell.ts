/**
 * spawn-based Shell 执行工具
 *
 * 取代 execSync 的核心改造：
 *   - 非阻塞：spawn + stream，不锁死事件循环
 *   - CWD 持久：每次命令执行后捕获 pwd，更新模块级 shellState
 *   - 流式进度：onProgress 回调，每新行调用一次
 *   - 超时 + AbortSignal：发 SIGTERM 真正终止子进程
 *
 * Windows 策略：
 *   优先查找 Git Bash（CLAUDE_CODE_GIT_BASH_PATH / 常见安装路径）
 *   找不到则 fallback 到 cmd.exe（有限 CWD 跟踪）
 *
 * 设计参考：
 *   D:\projects\claude-code\src\utils\Shell.ts — exec() 完整实现
 *   D:\projects\claude-code\packages\builtin-tools\src\tools\BashTool\BashTool.tsx — runShellCommand
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { readFileSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getCwd, setCwd } from './cwd.js';
import { randomBytes } from 'crypto';

// ─── 进度轮询间隔（毫秒） ──────────────────────────────────────────────
const PROGRESS_THRESHOLD_MS = 2000;

// ─── 进程终止（Windows 需要 taskkill 杀死进程树） ─────────────────────

/**
 * 平台感知的进程终止。
 * - Unix: 发 SIGTERM（父进程终止时 child 通常也会退出）
 * - Windows: 用 `taskkill /f /t /pid <pid>` 强制杀死整个进程树
 *   （向 cmd.exe 发 SIGTERM 在 Windows 上不可靠，子进程会继续运行）
 */
function killProcess(proc: ReturnType<typeof spawn>): void {
  if (process.platform === 'win32') {
    // taskkill /f(强制) /t(含子进程树) /pid <pid>
    try {
      spawn('taskkill', ['/f', '/t', '/pid', String(proc.pid)], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      // 进程可能已退出，静默忽略
      proc.kill();
    }
  } else {
    proc.kill('SIGTERM');
  }
}

// ─── 类型定义 ─────────────────────────────────────────────────────────

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  newCwd: string;
  timedOut: boolean;
  interrupted: boolean;
}

export interface ExecOptions {
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  /** 有新输出行时调用（不含 CWD 捕获行） */
  onProgress?: (line: string, elapsedMs: number) => void;
}

// ─── Windows Git Bash 搜索路径 ────────────────────────────────────────

const WIN_BASH_CANDIDATES: (string | undefined)[] = [
  process.env['CLAUDE_CODE_GIT_BASH_PATH'],
  process.env['GIT_BASH_PATH'],
  process.env['ProgramFiles']
    ? `${process.env['ProgramFiles']}\\Git\\bin\\bash.exe`
    : undefined,
  process.env['ProgramFiles(x86)']
    ? `${process.env['ProgramFiles(x86)']}\\Git\\bin\\bash.exe`
    : undefined,
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
];

// ─── Shell 检测（带缓存） ─────────────────────────────────────────────

interface ShellInfo {
  exe: string;
  isBash: boolean; // bash（含 Git Bash）还是 cmd.exe
}

let _cachedShell: ShellInfo | null = null;

export function detectShell(): ShellInfo {
  if (_cachedShell) return _cachedShell;

  if (process.platform === 'win32') {
    // 优先找 Git Bash
    for (const candidate of WIN_BASH_CANDIDATES) {
      if (candidate && existsSync(candidate)) {
        _cachedShell = { exe: candidate, isBash: true };
        return _cachedShell;
      }
    }
    // fallback cmd.exe
    _cachedShell = { exe: 'cmd.exe', isBash: false };
    return _cachedShell;
  }

  // Unix：默认 bash，找不到也可以用 /bin/sh
  const unixBash = process.env['SHELL'] || '/bin/bash';
  _cachedShell = { exe: unixBash, isBash: true };
  return _cachedShell;
}

/** 仅供测试使用：清空缓存以重新检测 */
export function _resetShellCache(): void {
  _cachedShell = null;
}

// ─── 主执行函数 ───────────────────────────────────────────────────────

/**
 * 执行 Shell 命令，异步非阻塞，支持 CWD 持久、进度回调和中断。
 *
 * @param command  要执行的命令字符串
 * @param opts     超时、中断信号、进度回调
 */
export async function execBash(
  command: string,
  opts: ExecOptions = {},
): Promise<ExecResult> {
  const { timeoutMs = 30_000, abortSignal, onProgress } = opts;
  const shell = detectShell();

  // ── 生成临时文件路径 ─────────────────────────────────────────────
  const uid = randomBytes(4).toString('hex');
  const cwdFile = join(tmpdir(), `ec_cwd_${uid}.txt`);

  // ── 构建命令（追加 CWD 捕获） ───────────────────────────────────────
  let shellExe: string;
  let shellArgs: string[];
  let batchFile: string | null = null; // cmd.exe 临时批处理文件

  if (shell.isBash) {
    // bash：命令末尾追加 pwd > cwdFile（换行分隔，即使命令返回非 0 也能捕获）
    // 注意：若命令显式调用 `exit N` 则无法捕获，此为已知限制
    const posixCwdFile = cwdFile.replace(/\\/g, '/');
    const cwdCapture = `\npwd > "${posixCwdFile}"`;
    shellExe = shell.exe;
    shellArgs = ['-c', command + cwdCapture];
  } else {
    // cmd.exe fallback：使用临时批处理文件，避免 Windows 命令行引号转义问题
    //   1. 写入批处理文件（命令 + cd > cwdFile）
    //   2. 执行批处理文件
    //   3. 进程关闭后读取 cwdFile，清理批处理文件
    //
    // 限制：命令中的裸 `%` 需要转义为 `%%`（批处理变量语法），
    //       对大多数常规命令透明，agent 通常不生成裸 `%`
    batchFile = join(tmpdir(), `ec_cmd_${uid}.bat`);
    // 批处理文件结构：
    //   1. 执行原始命令
    //   2. 保存 %ERRORLEVEL%（确保 cd 不覆盖退出码）
    //   3. 裸 `cd` 捕获当前目录到临时文件
    //   4. exit /b 传递原始退出码
    const batchContent =
      `@echo off\r\n` +
      `${command}\r\n` +
      `set __EC_EXIT=%ERRORLEVEL%\r\n` +
      `cd > "${cwdFile}"\r\n` +
      `exit /b %__EC_EXIT%\r\n`;
    writeFileSync(batchFile, batchContent, 'latin1');
    shellExe = 'cmd.exe';
    shellArgs = ['/c', batchFile];
  }

  const startTime = Date.now();
  let progressTimer: ReturnType<typeof setInterval> | null = null;

  return new Promise<ExecResult>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let interrupted = false;
    let stdoutBuf = ''; // 行缓冲（用于回调）
    let lastProgressLine = ''; // 最近一行进度输出

    // ── 启动进程 ────────────────────────────────────────────────────
    const proc = spawn(shellExe, shellArgs, {
      cwd: getCwd(),
      env: { ...process.env } as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true, // Windows：隐藏控制台窗口
    });

    // ── 超时控制 ────────────────────────────────────────────────────
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      killProcess(proc);
    }, timeoutMs);

    // ── AbortSignal 支持 ────────────────────────────────────────────
    const onAbort = (): void => {
      interrupted = true;
      killProcess(proc);
    };
    if (abortSignal) {
      if (abortSignal.aborted) {
        killProcess(proc);
        interrupted = true;
      } else {
        abortSignal.addEventListener('abort', onAbort);
      }
    }

    // ── 流式读取 stdout ─────────────────────────────────────────────
    proc.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;

      if (onProgress) {
        stdoutBuf += text;
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trimEnd();
          if (trimmed) {
            lastProgressLine = trimmed;
          }
        }
      }
    });

    // ── 流式读取 stderr ─────────────────────────────────────────────
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // ── 进度轮询定时器（PROGRESS_THRESHOLD_MS 后开始） ────────────────
    if (onProgress) {
      progressTimer = setInterval(() => {
        const elapsed = Date.now() - startTime;
        if (elapsed >= PROGRESS_THRESHOLD_MS && lastProgressLine) {
          onProgress(lastProgressLine, elapsed);
        }
      }, 1000);
    }

    // ── 进程关闭 ────────────────────────────────────────────────────
    proc.on('close', (code) => {
      clearTimeout(timeoutHandle);
      if (progressTimer) clearInterval(progressTimer);
      if (abortSignal) abortSignal.removeEventListener('abort', onAbort);

      // 读取并更新 CWD（bash 和 cmd.exe 都通过临时文件捕获）
      let newCwd = getCwd();
      try {
        const raw = readFileSync(cwdFile, 'utf-8').trim();
        if (raw) {
          newCwd = raw;
          setCwd(newCwd);
        }
      } catch {
        // 命令提前 exit / 写入失败 → 保留当前 CWD
      } finally {
        // 清理 CWD 临时文件
        try { unlinkSync(cwdFile); } catch { /* ignore */ }
        // 清理 cmd.exe 批处理文件
        if (batchFile) {
          try { unlinkSync(batchFile); } catch { /* ignore */ }
        }
      }

      resolve({
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
        exitCode: code ?? -1,
        newCwd,
        timedOut,
        interrupted,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timeoutHandle);
      if (progressTimer) clearInterval(progressTimer);
      if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
      try { unlinkSync(cwdFile); } catch { /* ignore */ }
      if (batchFile) { try { unlinkSync(batchFile); } catch { /* ignore */ } }
      reject(err);
    });
  });
}

// ─── 临时文件写入（供测试 mock） ──────────────────────────────────────

/** 仅供内部/测试使用：在指定路径写入一行内容 */
export function _writeCwdFile(path: string, content: string): void {
  writeFileSync(path, content + '\n', 'utf-8');
}

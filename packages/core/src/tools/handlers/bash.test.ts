/**
 * F-01 单元测试：execBash + CWD 持久化
 *
 * 验收标准（来自 flesh-blood-plan.md F-01）：
 *   1. cd 命令后，下一次调用工作在新目录（CWD 持久化）
 *   2. onProgress 在长命令运行时被调用
 *   3. 超时后进程被终止，timedOut = true
 *   4. AbortSignal 触发后 interrupted = true
 *   5. exitCode 非零时正确返回
 *
 * 跨平台说明：
 *   - 使用 `node -e "..."` 作为跨平台执行（node 在 PATH 中）
 *   - CWD 切换使用 shell 原生 cd 命令（bash/cmd.exe 各自语法）
 *   - 不依赖 Unix-only 工具（sleep、/tmp 等）
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { tmpdir } from 'os';
import { execBash, detectShell } from '../../utils/shell.js';
import { getCwd, resetCwd } from '../../utils/cwd.js';

const IS_WINDOWS = process.platform === 'win32';
const shell = detectShell();

// ─── 平台感知命令构建 ─────────────────────────────────────────────────

/** 跨平台 sleep（用 node 定时器，避免 bash/cmd 差异） */
const sleepCmd = (ms: number): string =>
  `node -e "setTimeout(()=>{},${ms})"`;

/** 跨平台输出 hello */
const echoHello = `node -e "console.log('hello')"`;

/** 跨平台非零退出 */
const exit42 = `node -e "process.exit(42)"`;

/** 跨平台写 stderr */
const writeStderr = `node -e "process.stderr.write('my-error\\n')"`;

/** 
 * 跨平台多行定期输出（每隔 intervalMs 输出一行，共 n 行）
 * 用于测试 onProgress 回调
 */
const echoLinesCmd = (n: number, intervalMs: number): string =>
  `node -e "let i=0;const t=setInterval(()=>{process.stdout.write('line'+i+'\\n');if(++i>=${n})clearInterval(t);},${intervalMs})"`;

/**
 * 平台感知 cd 命令
 *   bash: cd "<path>"
 *   cmd.exe: cd /d "<path>"
 */
function cdCmd(targetPath: string): string {
  if (shell.isBash) {
    // bash 下用 POSIX 斜杠
    const posixPath = targetPath.replace(/\\/g, '/');
    return `cd "${posixPath}"`;
  } else {
    // cmd.exe 下用 /d 支持跨驱动器切换
    return `cd /d "${targetPath}"`;
  }
}

/**
 * 获取可靠的 CWD 切换目标目录（系统临时目录）
 * 保证与当前 cwd 不同
 */
function getTargetDir(): string {
  return tmpdir();
}

// ─── 测试 ─────────────────────────────────────────────────────────────

describe('execBash — spawn-based 执行', () => {
  beforeEach(() => {
    resetCwd();
  });

  it('基础命令：返回 stdout', async () => {
    const result = await execBash(echoHello);
    expect(result.stdout).toContain('hello');
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.interrupted).toBe(false);
  });

  it('非零退出码正确返回', async () => {
    const result = await execBash(exit42, { timeoutMs: 5000 });
    expect(result.exitCode).toBe(42);
    expect(result.timedOut).toBe(false);
  });

  it('stderr 独立返回', async () => {
    const result = await execBash(writeStderr);
    expect(result.stderr).toContain('my-error');
  });

  it('超时后 timedOut = true', async () => {
    // timeoutMs=600 → 600ms 后应 kill 进程，Windows taskkill 略有延迟，给 12s 余量
    const result = await execBash(sleepCmd(10_000), { timeoutMs: 600 });
    expect(result.timedOut).toBe(true);
  }, 12_000);

  it('AbortSignal 中断后 interrupted = true', async () => {
    const ac = new AbortController();
    const resultPromise = execBash(sleepCmd(10_000), {
      timeoutMs: 30_000,
      abortSignal: ac.signal,
    });
    // 400ms 后触发 abort，Windows taskkill 略有延迟
    setTimeout(() => ac.abort(), 400);
    const result = await resultPromise;
    expect(result.interrupted).toBe(true);
  }, 12_000);
});

describe('CWD 持久化', () => {
  beforeEach(() => {
    resetCwd();
  });

  it('cd 命令后，getCwd() 反映新目录', async () => {
    const targetDir = getTargetDir();
    const result = await execBash(cdCmd(targetDir));
    // cd 可能返回非 0 退出码但仍然成功（部分系统）
    // 重点：getCwd() 应更新
    const newCwd = getCwd();
    const normalizedCwd = newCwd.toLowerCase().replace(/\\/g, '/');
    const normalizedTarget = targetDir.toLowerCase().replace(/\\/g, '/');
    expect(normalizedCwd).toBe(normalizedTarget);
  });

  it('连续两条命令：第一条 cd，第二条在新目录中执行', async () => {
    const targetDir = getTargetDir();
    const originalCwd = getCwd();

    // 1. 切换到临时目录
    await execBash(cdCmd(targetDir));
    expect(getCwd().toLowerCase().replace(/\\/g, '/')).toBe(
      targetDir.toLowerCase().replace(/\\/g, '/'),
    );

    // 2. 执行 node 打印 cwd
    const result2 = await execBash(
      `node -e "process.stdout.write(process.cwd())"`,
    );
    expect(result2.exitCode).toBe(0);

    // 第二条命令的工作目录应是 targetDir（node 继承了 spawn 时的 cwd）
    const resultCwd = result2.stdout.toLowerCase().replace(/\\/g, '/');
    expect(resultCwd).toBe(targetDir.toLowerCase().replace(/\\/g, '/'));
  });
});

describe('onProgress 回调', () => {
  it('长命令期间 onProgress 被调用（至少一次）', async () => {
    const progressLines: string[] = [];
    const elapsedTimes: number[] = [];

    // 每隔 600ms 输出一行，共 5 行，总计 ~3s → 超过 PROGRESS_THRESHOLD_MS(2s)
    await execBash(echoLinesCmd(5, 600), {
      timeoutMs: 15_000,
      onProgress: (line, ms) => {
        progressLines.push(line);
        elapsedTimes.push(ms);
      },
    });

    // 至少触发了一次进度回调
    expect(progressLines.length).toBeGreaterThan(0);

    // elapsed 均 >= PROGRESS_THRESHOLD_MS(2000ms)
    for (const ms of elapsedTimes) {
      expect(ms).toBeGreaterThanOrEqual(2000);
    }
  }, 20_000);
});

# 血肉计划 — EasyCode 生产落地优化方案

> **核心诊断**：当前项目是一副可以通过 `npm run build` 的**骨架**。
> 每个模块都有文件、有类型、有调用链，但在真实任务中立刻暴露致命缺陷：
> Bash 会阻塞进程、文件编辑靠精确字符匹配、模型没有系统提示词不知道自己是谁、
> CWD 在每次执行后丢失……任何一项都能让真实任务在 30 秒内崩掉。
>
> **血肉的定义**：让骨架能在真实开发任务中**实际运作**，而非只是演示通过。
>
> 参考基准：`D:\projects\claude-code`（以下简称 CC）
> 当前项目：`D:\projects\Easycode`（以下简称 EC）

---

## 读前须知：差距全景图

| 缺陷等级 | 编号 | 缺陷项 | 具体症状 | CC 参考路径 |
|---------|------|--------|----------|------------|
| 🔴 P0 致命 | F-01 | Bash 用 `execSync` | 长命令阻塞整个进程，无流式输出，无 CWD 持久 | `BashTool.tsx:exec()` |
| 🔴 P0 致命 | F-02 | 系统提示词完全缺失 | 模型不知道工具怎么用，不知道输出格式，行为飘忽 | `BashTool/prompt.ts` |
| 🔴 P0 致命 | F-03 | FileRead 无行数/大小限制 | 读 100K 行文件直接 OOM，上下文秒满 | `FileReadTool.ts` |
| 🟠 P1 严重 | F-04 | FileEdit 精确字符匹配 | 模型生成的 old_str 有一个空格不同就失败 | `FileEditTool/utils.ts` |
| 🟠 P1 严重 | F-05 | CWD 不追踪 | `cd src && ls` 后下次 bash 回到初始目录 | `BashTool/src/utils/cwd.ts` |
| 🟠 P1 严重 | F-06 | 工具结果无大小上限 | 大文件内容全量进入消息数组，context 秒爆 | `toolResultStorage.ts` |
| 🟠 P1 严重 | F-07 | max_tokens 无恢复机制 | LLM 截断时直接失败，任务中断 | `query.ts:1510` |
| 🟡 P2 重要 | F-08 | API 无重试/退避 | 限速 429 / 网络抖动直接报错退出 | `services/api/withRetry.ts` |
| 🟡 P2 重要 | F-09 | 无 CLAUDE.md/AGENTS.md 注入 | 无法感知项目上下文和记忆 | `utils/attachments.ts` |
| 🟡 P2 重要 | F-10 | Bash 无实时进度 | 用户盯着空白等几分钟不知道是否卡死 | `BashTool/UI.tsx` |
| 🟡 P2 重要 | F-11 | 权限系统无白名单 | 只有黑名单正则，合法命令也容易被误拦 | `bashPermissions.ts` |
| 🟢 P3 增强 | F-12 | 无 Git diff 追踪 | 不知道改了哪些文件，无法 rollback | `utils/gitDiff.ts` |
| 🟢 P3 增强 | F-13 | 无多文件批量读取工具 | 没有 glob/find 语义工具，靠 bash 补偿 | `GlobTool.ts` |
| 🟢 P3 增强 | F-14 | Plan 模式未实现 | 只能执行，不能先规划再确认 | `query.ts:permissionMode` |
| 🟢 P3 增强 | F-15 | 子 Agent 未实现 | 并行子任务 / 多 Agent 协同 | `AgentTool.tsx` |
| 🎨 UI 视觉 | U-01 | 颜色硬编码，无主题系统 | 浅色终端显示黑色气泡，完全不可读 | `src/utils/theme.ts` |
| 🎨 UI 视觉 | U-02 | 无终端能力检测 | truecolor 颜色在老终端乱码显示 | `src/utils/systemTheme.ts` |
| 🎨 UI 视觉 | U-03 | Spinner 静态无动画 | 用户不知道程序在运行还是已卡死 | `src/components/Spinner.tsx` |
| 🎨 UI 视觉 | U-04 | CJK/ANSI 宽度计算错误 | 中文字符折行位置偏移，输出错位 | `src/utils/terminal.ts` |
| 🎨 UI 视觉 | U-05 | 无 OSC 8 文件超链接 | 文件路径不可点击，无法快速跳转 | `src/utils/hyperlink.ts` |
| 🎨 UI 视觉 | U-06 | Windows 终端无适配 | Braille 符号在 cmd 乱码，颜色失效 | `WindowsTerminalBackend.ts` |
| 🎨 UI 视觉 | U-07 | diff 无彩色渲染 | 文件改动一片黑白，难以分辨增删 | `StructuredDiff/colorDiff.ts` |

---

## 一、P0 — 致命缺陷修复（先做这三项，其余免谈）

- [ ] **F-01：Bash 工具重写 — spawn + 持久 Shell Session**

**现状问题**：

```typescript
// ❌ 当前实现 packages/core/src/tools/handlers/bash.ts:50
const output = execSync(command, {
  cwd: workingDir,
  timeout: timeoutMs,
  encoding: 'utf-8',
});
```

`execSync` 的三大致命伤：
1. **阻塞 Node.js 事件循环**：30 秒超时内整个进程无法响应任何事件，Ctrl+C 失效
2. **无实时输出**：用户看不到进度，不知道命令是否卡死
3. **CWD 不持久**：每次 `exec` 都是全新进程，`cd` 命令的效果当场消失

**CC 的做法**（参考 `D:\projects\claude-code\packages\builtin-tools\src\tools\BashTool\BashTool.tsx`）：
- 使用 `exec` from `src/utils/Shell.js` — 基于 `spawn` + Stream
- 持久 Shell Session（共享 env + CWD across calls）
- 每 2 秒更新一次进度（显示最近一行输出）
- 支持 `AbortController` 信号真正终止子进程

**改造方案**：

```typescript
// ✅ 目标实现方向 (packages/core/src/tools/handlers/bash.ts)
import { spawn } from 'child_process';

// 模块级持久 Shell State
interface ShellState {
  cwd: string;
  env: Record<string, string>;
}
const shellState: ShellState = {
  cwd: process.cwd(),
  env: { ...process.env } as Record<string, string>,
};

export async function execBash(
  command: string,
  opts: { timeoutMs: number; abortSignal?: AbortSignal; onProgress?: (line: string) => void }
): Promise<{ stdout: string; stderr: string; exitCode: number; newCwd: string }> {
  // 核心：在命令末尾追加 `echo "::CWD::$(pwd)"` 获取执行后的 cwd
  const wrappedCmd = `${command}\necho "::CWD::$(pwd)"`;
  
  return new Promise((resolve, reject) => {
    const proc = spawn('bash', ['-c', wrappedCmd], {
      cwd: shellState.cwd,
      env: shellState.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    
    // 流式收集，同时回调进度
    let stdout = '';
    let stderr = '';
    
    proc.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      const lastLine = text.trim().split('\n').at(-1) ?? '';
      if (!lastLine.startsWith('::CWD::')) opts.onProgress?.(lastLine);
    });
    
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    
    // 超时 + 中断信号
    const timer = setTimeout(() => proc.kill('SIGTERM'), opts.timeoutMs);
    opts.abortSignal?.addEventListener('abort', () => proc.kill('SIGTERM'));
    
    proc.on('close', (code) => {
      clearTimeout(timer);
      // 解析 cwd 并更新 shellState
      const cwdMatch = stdout.match(/::CWD::(.+)\n?$/);
      const newCwd = cwdMatch?.[1]?.trim() ?? shellState.cwd;
      shellState.cwd = newCwd;
      stdout = stdout.replace(/::CWD::.+\n?$/, '');
      resolve({ stdout, stderr, exitCode: code ?? -1, newCwd });
    });
    
    proc.on('error', reject);
  });
}
```

**CWD 展示**：在 CLI 的每轮 prompt 里显示当前 `shellState.cwd`，让用户一眼知道 Agent 在哪里操作。

**参考文件**：
- `D:\projects\claude-code\packages\builtin-tools\src\tools\BashTool\BashTool.tsx` — call 方法完整实现
- `D:\projects\claude-code\packages\builtin-tools\src\tools\BashTool\src\utils\Shell.ts` — exec 工具函数
- `D:\projects\claude-code\packages\builtin-tools\src\tools\BashTool\utils.ts` — resetCwdIfOutsideProject 等辅助

**验收**：
- `cd /tmp && pwd` 后，下一次 `ls` 列出 `/tmp` 内容
- `npm install`（10~60 秒）期间每 2 秒打印最后一行输出
- Ctrl+C 能真正杀死子进程

---

- [x] **F-02：系统提示词工程 — 从零到可用**

**现状问题**：

```typescript
// ❌ 当前实现 packages/core/src/agent/agent.ts
// system prompt 是一个空字符串或极简描述
```

没有系统提示词，模型不知道：
- 自己是谁（CLI Coding Agent）
- 工具怎么用（什么时候用 read_file vs bash cat）
- 输出格式要求（markdown、代码块格式）
- 何时询问用户 vs 自主决策
- 文件路径规范（相对路径 vs 绝对路径）
- 安全边界（不能做什么）

**CC 的系统提示词结构**（参考 `D:\projects\claude-code\packages\builtin-tools\src\tools\BashTool\prompt.ts` 及各工具 `prompt.ts`）：

每个工具都有独立的 `prompt()` 函数，动态生成该工具的 description。主系统提示词由多段拼接：
1. **Identity**：你是谁、能做什么
2. **Tools instructions**：每个工具的 prompt 字段（动态拼接）
3. **Project context**：CLAUDE.md / AGENTS.md 内容
4. **Output format rules**：markdown 规范、代码块语言标注等
5. **Safety rules**：不擅自删除、不操作 `~` 以外目录等

**需要实现的系统提示词**（`packages/core/src/agent/system-prompt.ts`）：

```typescript
export function buildSystemPrompt(opts: {
  projectRoot: string;
  tools: ToolDefinition[];
  additionalContext?: string; // CLAUDE.md 内容
}): string {
  const sections: string[] = [];

  // 1. Identity
  sections.push(`你是 EasyCode，一个运行在终端的 AI 编程助手。
你帮助开发者完成编码任务：理解代码、修复 Bug、重构、编写测试等。

工作目录：${opts.projectRoot}
`);

  // 2. 核心行为准则
  sections.push(`## 行为准则

- **先思考，再行动**：在修改文件前，先用 read_file 或 run_bash 理解当前状态
- **最小改动原则**：只改任务要求的内容，不主动重构无关代码
- **验证改动**：编辑文件后，运行相关测试或命令验证结果
- **明确路径**：所有文件路径使用相对于工作目录的路径
- **分步汇报**：每完成一个步骤，简要说明做了什么和结果
`);

  // 3. 工具使用指南
  sections.push(`## 工具使用规范

### read_file
- 读取文件前务必先 read_file，不要凭记忆假设文件内容
- 大文件使用 start_line/end_line 参数只读相关段落
- 不要反复读取同一文件，读一次后记住内容

### edit_file  
- old_str 必须是文件中**实际存在**的内容（先 read_file 确认）
- old_str 至少包含 3 行上下文确保位置唯一
- 倾向于小的精准改动，避免大块替换

### run_bash
- 优先用 read_file/edit_file/search_files 完成文件操作，bash 用于执行命令
- 长时间运行命令（如 npm install）会实时显示进度
- 测试命令优先用此工具验证改动

### write_file
- 只用于创建新文件或完全重写（旧内容不重要时）
- 已有文件的局部修改用 edit_file
`);

  // 4. 项目上下文（CLAUDE.md 内容）
  if (opts.additionalContext) {
    sections.push(`## 项目上下文\n\n${opts.additionalContext}`);
  }

  // 5. 安全边界
  sections.push(`## 安全边界

- 不执行删除用户主目录文件的命令
- 危险操作（rm -rf、DROP TABLE 等）必须等待用户确认
- 不主动安装 npm 全局包或修改系统配置
- 不泄露 API Key 或配置文件中的敏感信息
`);

  return sections.join('\n---\n\n');
}
```

**CLAUDE.md / AGENTS.md 自动注入**（参考 `D:\projects\claude-code\src\utils\attachments.ts`）：

```typescript
// 在 Agent 启动时，自动查找并读取项目上下文文件
export async function loadProjectContext(projectRoot: string): Promise<string> {
  const candidates = ['CLAUDE.md', 'AGENTS.md', '.claude/context.md'];
  for (const file of candidates) {
    const fullPath = path.join(projectRoot, file);
    if (fs.existsSync(fullPath)) {
      return fs.readFileSync(fullPath, 'utf-8');
    }
  }
  return '';
}
```

**参考文件**：
- `D:\projects\claude-code\packages\builtin-tools\src\tools\BashTool\prompt.ts` — Bash 工具提示词
- `D:\projects\claude-code\packages\builtin-tools\src\tools\FileReadTool\prompt.ts` — FileRead 提示词
- `D:\projects\claude-code\src\utils\attachments.ts` — CLAUDE.md 注入机制

**验收**：
- Agent 在第一轮就能正确使用 edit_file 而不是 bash sed 改文件
- 对未知文件的任务，Agent 自动先 read_file 再决策
- 危险命令触发审批弹出

**✅ 完成记录（commit: 257d086）**：
- 新建 `packages/core/src/agent/system-prompt.ts` — `buildSystemPrompt(opts)` 五段结构
  1. Identity（EasyCode 身份 + CWD + platform + 时间）
  2. Core Rules（先读后改、最小改动、验证、语言跟随用户）
  3. Tool Guide（全部 6 个工具的 when/how/禁忌，英文指令 + 中文示例）
  4. Project Context（CLAUDE.md 注入，可选）
  5. Safety Rules（危险命令、secrets、不擅自提交）
- 新建 `packages/core/src/context/project-memory.ts` — `loadProjectMemory()`
  - 从启动目录向上遍历至 home，查找 CLAUDE.md / AGENTS.md / .easycode/context.md
  - 子目录优先级高于父目录；单文件截断 10k chars
- 修改 `packages/core/src/agent/agent.ts` — 删内联提示词，接 `buildSystemPrompt` + `loadProjectMemory`；新增 `projectRoot` 构造参数
- 测试：12 个单测全部通过（vitest run → 20 passed 含 F-01 × 8）

---

- [ ] **F-03：FileRead 防 OOM — 行数限制 + 行号显示**

**现状问题**：

```typescript
// ❌ 当前实现 packages/core/src/tools/handlers/read.ts
const content = fs.readFileSync(absPath, 'utf-8');
return { content };  // 100K 行的文件也整个返回
```

无任何大小控制，读一个大文件就直接把上下文爆掉。

**CC 的做法**（参考 `D:\projects\claude-code\packages\builtin-tools\src\tools\FileReadTool\FileReadTool.ts`）：
- 支持 `start_line`/`end_line` 参数（只读指定行范围）
- 返回内容带行号前缀（`1 | import foo...`），帮助模型定位后续编辑位置
- 大文件只读前 N 行并提示 `[文件共 X 行，当前显示 1-2000 行]`
- 二进制文件检测，拒绝读取（避免乱码污染上下文）

**改造方案**：

```typescript
// ✅ 目标实现 (packages/core/src/tools/handlers/read.ts)
const MAX_LINES = 2000;      // 单次最多返回行数
const MAX_FILE_SIZE = 1 * 1024 * 1024;  // 1MB 二进制检测阈值

export const readFileTool: ToolDefinition = {
  name: 'read_file',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      start_line: { type: 'integer', description: '起始行号（1-indexed，默认 1）' },
      end_line: { type: 'integer', description: '结束行号（默认读到 start_line + 2000）' },
    },
    required: ['path'],
  },
  concurrency: 'readonly',
  async execute(input) {
    const filePath = input.path as string;
    const startLine = (input.start_line as number | undefined) ?? 1;
    
    const stats = fs.statSync(absPath);
    
    // 二进制检测
    if (isBinaryFile(absPath)) {
      return { content: `[二进制文件，无法以文本形式显示：${filePath}]`, isError: false };
    }
    
    const allLines = fs.readFileSync(absPath, 'utf-8').split('\n');
    const totalLines = allLines.length;
    const endLine = Math.min(
      (input.end_line as number | undefined) ?? startLine + MAX_LINES - 1,
      startLine + MAX_LINES - 1,  // 硬上限
      totalLines
    );
    
    const selectedLines = allLines.slice(startLine - 1, endLine);
    // 添加行号前缀（和 CC 一样，帮助模型定位）
    const withLineNumbers = selectedLines.map(
      (line, i) => `${String(startLine + i).padStart(4)} | ${line}`
    ).join('\n');
    
    const truncationNote = endLine < totalLines 
      ? `\n\n[文件共 ${totalLines} 行，当前显示 ${startLine}-${endLine} 行。用 start_line=${endLine + 1} 继续读取]`
      : '';
    
    return { content: withLineNumbers + truncationNote };
  }
};
```

**参考文件**：
- `D:\projects\claude-code\packages\builtin-tools\src\tools\FileReadTool\FileReadTool.ts` — 完整实现含 PDF、图片支持
- `D:\projects\claude-code\src\utils\readFileInRange.js` — 行范围读取工具函数
- `D:\projects\claude-code\src\utils\file.js:addLineNumbers` — 行号前缀添加

**验收**：
- 读取 10 万行文件时只返回前 2000 行 + 截断提示
- 模型可以通过 start_line 参数分段读取大文件
- 读取 .png/.zip 等二进制文件返回友好提示而非乱码

---

## 二、P1 — 严重影响生产力的缺陷

- [ ] **F-04：FileEdit 容错匹配 — 处理空白/换行差异**

**现状问题**：模型生成的 `old_str` 与实际文件内容有细微空格差异时，精确 `indexOf` 必然失败。

**CC 的做法**（参考 `D:\projects\claude-code\packages\builtin-tools\src\tools\FileEditTool\utils.ts`）：

`findActualString` 先做精确匹配，再做 trailing whitespace 归一化重试：

```typescript
// ✅ 参考 utils.ts:stripTrailingWhitespace
export function stripTrailingWhitespace(str: string): string {
  const lines = str.split(/(\r\n|\n|\r)/);
  let result = '';
  for (let i = 0; i < lines.length; i++) {
    result += i % 2 === 0 ? lines[i]!.replace(/\s+$/, '') : lines[i];
  }
  return result;
}
```

**EC 的改造方案**（`packages/core/src/tools/handlers/edit.ts`）：

```typescript
function findOldStr(fileContent: string, oldStr: string): string | null {
  // 1. 精确匹配
  if (fileContent.includes(oldStr)) return oldStr;
  
  // 2. 去除行尾空白后匹配
  const normalizedFile = stripTrailingWhitespace(fileContent);
  const normalizedSearch = stripTrailingWhitespace(oldStr);
  if (normalizedFile.includes(normalizedSearch)) {
    // 用归一化版本定位，返回文件中实际的那段（保留原始格式）
    const idx = normalizedFile.indexOf(normalizedSearch);
    return fileContent.slice(idx, idx + oldStr.length); // 近似，精确位置
  }
  
  // 3. CRLF/LF 换行符差异
  const unifiedFile = fileContent.replace(/\r\n/g, '\n');
  const unifiedSearch = oldStr.replace(/\r\n/g, '\n');
  if (unifiedFile.includes(unifiedSearch)) {
    return oldStr; // 找到了，让 replace 处理换行差异
  }
  
  return null;  // 真的找不到
}
```

**参考文件**：
- `D:\projects\claude-code\packages\builtin-tools\src\tools\FileEditTool\utils.ts` — stripTrailingWhitespace、findActualString、applyEditToFile

---

- [ ] **F-05：工具结果大小上限 — 防上下文爆炸**

**现状问题**：`run_bash` 执行 `find . -type f` 可能输出几万行，全量追加到消息数组。
`read_file` 读大文件后整个内容留在上下文直到下次压缩。

**CC 的做法**（参考 `D:\projects\claude-code\src\utils\toolResultStorage.ts`）：
- 每个工具有 `maxResultSizeChars` 属性
- 超过阈值时：将完整结果写入磁盘（`~/.easycode/tool-results/<uuid>.txt`），只返回预览 + 路径

**EC 改造方案**（`packages/core/src/tools/registry.ts` + 各工具）：

```typescript
// 在工具注册表中增加结果截断逻辑
export function truncateToolResult(result: ToolResult, maxChars: number): ToolResult {
  if (result.content.length <= maxChars) return result;
  
  const preview = result.content.slice(0, maxChars);
  const overflowPath = saveToTempFile(result.content);  // 写磁盘
  
  return {
    ...result,
    content: preview + `\n\n[输出过长（${result.content.length} 字符），已截断。` +
             `完整内容已保存到 ${overflowPath}，可用 read_file 查看。]`,
  };
}

// 各工具 maxResultSizeChars 建议值：
// run_bash: 100_000 chars (~25k tokens)
// read_file: Infinity（已有行数限制，不需要二次截断）
// search_files: 50_000 chars
// list_dir: 30_000 chars
```

**参考文件**：
- `D:\projects\claude-code\src\utils\toolResultStorage.ts` — buildLargeToolResultMessage、generatePreview

---

- [ ] **F-06：max_tokens 恢复机制 — 截断后继续**

**现状问题**：当 LLM 因为 `max_tokens` 限制输出被截断时，当前 runLoop 没有任何恢复，任务直接失败。

**CC 的做法**（参考 `D:\projects\claude-code\src\query.ts:1510`）：

```typescript
// CC 的实现逻辑
if (maxOutputTokensRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
  const recoveryMessage = createUserMessage({
    content: `Output token limit hit. Resume directly — no apology, no recap. Pick up mid-thought if that is where the cut happened.`,
    isMeta: true,
  });
  // 追加恢复消息，继续下一轮
  state.messages = [...messagesForQuery, ...assistantMessages, recoveryMessage];
  state.maxOutputTokensRecoveryCount++;
  continue;
}
```

**EC 改造方案**（`packages/core/src/agent/agent-loop.ts`）：

在 `runLoop` 内，检测到 `stopReason === 'max_tokens'` 时，注入恢复消息继续循环：

```typescript
// 在 runLoop 的 turn_end 处理之后
if (stopReason === 'max_tokens' && maxTokensRecoveryCount < 3) {
  // 注入恢复指令（meta 消息，不展示给用户）
  ctx.push({
    role: 'user',
    content: '输出被截断。请直接继续，无需解释或道歉，从截断处继续完成任务。',
  });
  maxTokensRecoveryCount++;
  continue; // 继续外层循环
}
```

**参考文件**：
- `D:\projects\claude-code\src\query.ts` 第 1476-1540 行 — max_tokens 恢复完整逻辑

---

- [ ] **F-07：API 重试机制 — 指数退避**

**现状问题**：`packages/ai/src/providers/` 中所有 Provider 都没有重试逻辑，一次 429 直接向上抛错。

**CC 的做法**（参考 `D:\projects\claude-code\src\services\api\withRetry.ts`）：
- 对 429（限速）和 5xx（服务端错误）做指数退避重试
- 最多重试 3 次，间隔 1s → 2s → 4s
- 其他错误（401、400）直接抛出，不重试

**EC 改造方案**（`packages/ai/src/utils/retry.ts`，新文件）：

```typescript
export async function* withRetry<T>(
  fn: () => AsyncIterable<T>,
  opts = { maxRetries: 3, baseDelayMs: 1000 }
): AsyncIterable<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      yield* fn();
      return;
    } catch (err) {
      const status = (err as { status?: number }).status;
      // 只重试限速和服务端错误
      if (status === 429 || (status && status >= 500)) {
        lastError = err;
        const delay = opts.baseDelayMs * Math.pow(2, attempt);
        await sleep(delay);
        continue;
      }
      throw err;  // 其他错误直接抛
    }
  }
  throw lastError;
}
```

**参考文件**：
- `D:\projects\claude-code\src\services\api\withRetry.ts` — 完整重试逻辑含 FallbackTriggeredError

---

## 三、P2 — 生产落地必备增强

- [ ] **F-08：CLAUDE.md / AGENTS.md 自动注入**

**功能描述**：在 Agent 启动时，自动查找项目根目录及父目录中的 `CLAUDE.md`、`AGENTS.md`，
将内容注入系统提示词末尾，让模型了解项目规范、技术栈、禁忌操作等。

**CC 的做法**（参考 `D:\projects\claude-code\src\utils\attachments.ts`）：
- 向上遍历目录树查找 `CLAUDE.md`（最多找到 git root 或 home 目录）
- 子目录的 CLAUDE.md 优先级高于父目录（局部覆盖全局）
- 文件过大时截断（防止污染上下文）

**EC 改造方案**（`packages/core/src/context/project-memory.ts`，新文件）：

```typescript
export async function loadProjectMemory(startDir: string): Promise<string[]> {
  const memories: string[] = [];
  let dir = startDir;
  const home = os.homedir();
  
  // 向上遍历，直到 home 目录
  while (dir !== home && dir !== path.dirname(dir)) {
    for (const filename of ['CLAUDE.md', 'AGENTS.md', '.easycode/context.md']) {
      const filePath = path.join(dir, filename);
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf-8').slice(0, 10_000);
        memories.unshift(`[来自 ${filename}]\n${content}`);  // 父级在后
      }
    }
    dir = path.dirname(dir);
  }
  
  return memories;
}
```

**参考文件**：
- `D:\projects\claude-code\src\utils\attachments.ts` — getAttachmentMessages 完整逻辑
- `D:\projects\claude-code\docs\context\project-memory.mdx` — 项目记忆设计文档

---

- [ ] **F-09：Bash 实时进度展示**

**功能描述**：长时间运行的命令（如 `npm install`、`cargo build`）执行期间，
每秒更新一行进度，显示最新的 stdout 内容，而不是让用户盯着空白等待。

**CC 的做法**（参考 `D:\projects\claude-code\packages\builtin-tools\src\tools\BashTool\UI.tsx`）：
- `PROGRESS_THRESHOLD_MS = 2000`：2 秒后开始显示进度
- 用 Ink 的 `<Text>` 组件动态更新（重绘最后一行）
- 超时时显示 `[命令运行中 45s... 最近输出: Building src/...]`

**EC 改造方案**（`packages/cli/src/ui/progress.ts`，新文件）：

```typescript
// 在 CLI 层，订阅 AgentEvent 的进度事件
export function renderBashProgress(event: BashProgressEvent): void {
  const elapsed = Math.floor((Date.now() - event.startTime) / 1000);
  process.stdout.write(`\r  ⠋ 执行中 ${elapsed}s... ${event.lastLine.slice(0, 60)}`);
}
```

在 `runBashTool` 中，通过 `opts.onProgress` 回调向上传递最新输出行，
CLI 层捕获后做实时重绘（`\r` 覆盖当前行）。

**参考文件**：
- `D:\projects\claude-code\packages\builtin-tools\src\tools\BashTool\UI.tsx` — renderToolUseProgressMessage
- `D:\projects\claude-code\packages\builtin-tools\src\tools\BashTool\BashTool.tsx:89` — PROGRESS_THRESHOLD_MS

---

- [ ] **F-10：权限白名单机制 — 精细化审批**

**现状问题**：当前权限系统只有正则黑名单，没有白名单，也没有"对 `./dist` 目录操作不需审批"这类路径级别的放行规则。

**CC 的做法**（参考 `D:\projects\claude-code\packages\builtin-tools\src\tools\BashTool\bashPermissions.ts`）：
- 支持 `alwaysAllowRules` / `alwaysDenyRules` 两个规则集
- 规则支持通配符 pattern（`git *`、`npm *`、`rm ./dist/**`）
- 规则持久化到 `~/.easycode/config.json`
- 会话级"全部放行"（`allow_all` 决策后本工具的后续调用跳过审批）

**EC 改造方案**（扩展 `packages/core/src/security/policy.ts`）：

```typescript
// 新增白名单结构
export interface PermissionConfig {
  alwaysAllow: string[];  // 例如: ["git *", "npm test", "ls *"]
  alwaysDeny: string[];   // 例如: ["rm -rf /", "sudo *"]
}

export function checkToolApproval(
  toolName: string,
  input: Record<string, unknown>,
  policy: ApprovalPolicy,
  config: PermissionConfig,
): ApprovalCheck {
  const command = toolName === 'run_bash' ? (input.command as string) : '';
  
  // 白名单优先
  if (matchesAny(command, config.alwaysAllow)) {
    return { needsApproval: false, isBlocked: false };
  }
  
  // 黑名单
  if (matchesAny(command, config.alwaysDeny) || DANGEROUS_PATTERNS.some(p => p.test(command))) {
    return { needsApproval: policy !== 'auto', isBlocked: policy === 'never' };
  }
  
  return { needsApproval: policy === 'ask', isBlocked: false };
}
```

**参考文件**：
- `D:\projects\claude-code\packages\builtin-tools\src\tools\BashTool\bashPermissions.ts` — bashToolHasPermission、matchWildcardPattern

---

- [ ] **F-11：Git Diff 追踪 — 知道改了什么**

**功能描述**：Agent 修改文件后，自动通过 `git diff` 展示变更摘要，让用户一眼看出改了什么。

**CC 的做法**（参考 `D:\projects\claude-code\src\utils\gitDiff.ts`）：
- `fetchSingleFileGitDiff(filePath)` — 获取单文件的 unified diff
- 每次 FileEdit/FileWrite 完成后，在结果中附上 diff 摘要

**EC 改造方案**（`packages/core/src/tools/handlers/edit.ts`）：

```typescript
// 在 edit_file 成功后，追加 git diff 预览
const diff = await getGitDiff(absPath);
if (diff) {
  return { content: `✓ 编辑成功：${filePath}\n\n变更预览：\n\`\`\`diff\n${diff.slice(0, 3000)}\n\`\`\`` };
}
```

```typescript
// packages/core/src/utils/git.ts (新文件)
import { execSync } from 'child_process';

export function getGitDiff(filePath: string): string | null {
  try {
    return execSync(`git diff --no-color "${filePath}"`, { encoding: 'utf-8' });
  } catch {
    return null;  // 非 git 项目静默失败
  }
}
```

**参考文件**：
- `D:\projects\claude-code\src\utils\gitDiff.ts` — fetchSingleFileGitDiff 实现

---

## 四、P3 — 进阶增强（完成后可对标商业产品）

- [ ] **F-12：Glob 工具 — 模式搜索文件**

**现状问题**：EC 没有 glob 语义工具，模型只能用 `run_bash find . -name "*.ts"` 代替，
在 Windows 下不可靠，且浪费 bash 资源。

**CC 的做法**（参考 `D:\projects\claude-code\packages\builtin-tools\src\tools\GlobTool\GlobTool.ts`）：
- 输入：glob pattern（如 `src/**/*.ts`）+ 可选 root 目录
- 输出：匹配的文件路径列表（按修改时间排序）
- 支持忽略 `.gitignore` 中排除的路径

**EC 改造方案**（`packages/core/src/tools/handlers/glob.ts`）：

```typescript
import { glob } from 'fast-glob';  // 或 Node.js 原生 glob (v21+)

export const globTool: ToolDefinition = {
  name: 'glob_files',
  description: '用 glob 模式查找文件，比 bash find 更快、更跨平台',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob 模式，如 src/**/*.ts' },
      root: { type: 'string', description: '搜索根目录（默认当前工作目录）' },
    },
    required: ['pattern'],
  },
  concurrency: 'readonly',
  async execute(input) {
    const files = await glob(input.pattern as string, {
      cwd: (input.root as string) || process.cwd(),
      ignore: ['**/node_modules/**', '**/.git/**'],
      onlyFiles: true,
    });
    return { content: files.join('\n') || '（没有匹配的文件）' };
  }
};
```

**参考文件**：
- `D:\projects\claude-code\packages\builtin-tools\src\tools\GlobTool\GlobTool.ts`

---

- [ ] **F-13：Plan 模式 — 先规划再执行**

**功能描述**：M4.1 的完整实现。在执行前先输出执行计划，用户确认后再开始写操作。

**CC 的做法**（参考 `D:\projects\claude-code\docs\safety\plan-mode.mdx`）：
- Plan 阶段：只允许 read-only 工具 + `create_plan` 工具
- 用户确认计划 → 切换到 Execute 阶段
- Execute 阶段：解锁写工具

**EC 改造方案**：

```typescript
// 在 runLoop 中支持 plan 模式
if (opts.planMode === 'planning') {
  // 只允许 readonly 工具
  const allowedTools = tools.filter(t => t.concurrency === 'readonly' || t.name === 'create_plan');
  // 生成计划后暂停，等用户确认
}
```

```bash
easycode --plan "重构 src/auth 模块的错误处理"
# → 输出分步计划 → [确认?] → 执行
```

**参考文件**：
- `D:\projects\claude-code\docs\safety\plan-mode.mdx` — Plan 模式设计文档
- `D:\projects\claude-code\src\query.ts` — permissionMode === 'plan' 相关逻辑

---

- [ ] **F-14：子 Agent — 并行任务分解**

**功能描述**：主 Agent 可以派生子 Agent 并行处理独立子任务（如同时修改 4 个模块）。

**CC 的做法**（参考 `D:\projects\claude-code\packages\builtin-tools\src\tools\AgentTool\AgentTool.tsx`）：
- `AgentTool`：一个特殊工具，输入是任务描述，内部运行完整的 runLoop
- 子 Agent 有独立的上下文，结果以摘要形式返回给主 Agent
- 支持并发运行多个子 Agent（只读任务）

**EC 改造方案**（`packages/core/src/tools/handlers/agent.ts`，新文件）：

```typescript
export const agentTool: ToolDefinition = {
  name: 'run_agent',
  description: '派生一个子 Agent 完成指定任务，适用于独立、可并行的子任务',
  concurrency: 'readonly',  // 多个子 Agent 可并发
  async execute(input, { registry, streamFn, abortSignal }) {
    // 在独立上下文中运行完整的 runLoop
    const subResult = await runSubAgent({
      task: input.task as string,
      context: input.context as string | undefined,
      registry,
      streamFn,
      abortSignal,
    });
    return { content: subResult.summary };
  }
};
```

**参考文件**：
- `D:\projects\claude-code\packages\builtin-tools\src\tools\AgentTool\runAgent.ts` — runAgent 完整实现
- `D:\projects\claude-code\packages\builtin-tools\src\tools\AgentTool\forkSubagent.ts` — forkSubagent 实现

---

## 五、执行优先级 & 里程碑

> F-xx（功能）与 U-xx（UI）按同一条时间线排列，实现时从上往下逐条推进即可。

| 顺序 | 编号 | 任务 | 预估时间 | 说明 |
|------|------|------|---------|------|
| **Week 1 — 先跑起来** | | | | |
| 1 | F-01 | Bash spawn + CWD 持久 | 1天 | 最关键，其他全依赖它 |
| 2 | F-02 | 系统提示词工程 | 半天 | 让模型知道自己是谁 |
| 3 | F-03 | FileRead 行数限制 + 行号 | 半天 | 防 OOM |
| 4 | U-02 | 终端能力检测 | 15分钟 | 防颜色乱码，顺手做 |
| 5 | U-06 | Windows 终端兼容 | 2小时 | Braille 符号降级 |
| **Week 2 — 生产可用** | | | | |
| 6 | F-04 | FileEdit 容错匹配 | 半天 | 空白差异不再失败 |
| 7 | F-05 | 工具结果大小上限 | 半天 | 大文件不爆 context |
| 8 | F-06 | max_tokens 恢复机制 | 2小时 | 截断后继续 |
| 9 | F-07 | API 指数退避重试 | 1小时 | 限速 429 不退出 |
| 10 | U-01 | 主题系统（替换硬编码颜色）| 1天 | 浅色终端不再乱 |
| 11 | U-03 | 动态 Spinner 动画 | 半天 | 用户知道在工作 |
| **Week 3 — 体验打磨** | | | | |
| 12 | F-08 | CLAUDE.md/AGENTS.md 注入 | 半天 | 感知项目上下文 |
| 13 | F-09 | Bash 实时进度展示 | 半天 | 长命令不再盲等 |
| 14 | F-10 | 权限白名单机制 | 半天 | 精细化审批 |
| 15 | F-11 | Git diff 追踪 | 2小时 | 改了什么一目了然 |
| 16 | U-04 | ANSI 安全渲染（CJK 宽度）| 半天 | 中文折行不错位 |
| 17 | U-07 | Diff 彩色渲染 | 半天 | 增删行有颜色区分 |
| **Week 4 — 进阶增强** | | | | |
| 18 | F-12 | Glob 文件搜索工具 | 半天 | 跨平台文件查找 |
| 19 | F-13 | Plan 模式 | 1天 | 先规划再执行 |
| 20 | F-14 | 子 Agent 并行 | 2天 | 多任务协同 |
| 21 | U-05 | OSC 8 文件超链接 | 1小时 | 路径可点击，锦上添花 |

---

## 六、验收标准（真实任务测试）

以下 3 个场景能跑通，项目才算真正有血有肉：

### 场景 A：修复 Bug（30 秒内完成）
```bash
easycode "src/auth.ts 的 login 函数有个空指针问题，帮我找到并修复"
```
期望行为：
1. Agent 自动 `read_file src/auth.ts`（带行号显示）
2. 定位问题行，生成精准的 `edit_file` 调用
3. 调用 `run_bash npm test` 验证
4. 输出 git diff 摘要

### 场景 B：长任务不崩（5 分钟任务）
```bash
easycode "帮我把 packages/core 里的所有 console.log 替换成结构化日志"
```
期望行为：
1. 多轮工具调用（read + edit × N）不 OOM
2. 上下文接近满时自动压缩
3. `max_tokens` 截断后自动恢复继续

### 场景 C：安全审批（危险命令拦截）
```bash
easycode "清理所有日志文件"
```
期望行为：
1. Agent 提议 `rm -rf ./logs/*.log`
2. 触发审批弹窗（即使在 `auto` 策略下 `rm -rf` 也要审批）
3. 用户确认后执行，记录到 JSONL

---

## 七、参考代码速查表

| 功能 | CC 参考路径 | EC 目标路径 |
|------|------------|------------|
| Bash spawn + 流式 | `packages/builtin-tools/src/tools/BashTool/BashTool.tsx` | `packages/core/src/tools/handlers/bash.ts` |
| Shell.ts exec 工具函数 | `packages/builtin-tools/src/tools/BashTool/src/utils/Shell.ts` | `packages/core/src/utils/shell.ts`（新建） |
| CWD 跟踪 | `packages/builtin-tools/src/tools/BashTool/src/utils/cwd.ts` | `packages/core/src/utils/cwd.ts`（新建） |
| 系统提示词 | `packages/builtin-tools/src/tools/BashTool/prompt.ts` | `packages/core/src/agent/system-prompt.ts`（新建） |
| FileRead 行范围 | `packages/builtin-tools/src/tools/FileReadTool/FileReadTool.ts` | `packages/core/src/tools/handlers/read.ts` |
| FileEdit 容错匹配 | `packages/builtin-tools/src/tools/FileEditTool/utils.ts` | `packages/core/src/tools/handlers/edit.ts` |
| 工具结果磁盘溢写 | `src/utils/toolResultStorage.ts` | `packages/core/src/tools/result-storage.ts`（新建） |
| max_tokens 恢复 | `src/query.ts:1510` | `packages/core/src/agent/agent-loop.ts` |
| API 重试退避 | `src/services/api/withRetry.ts` | `packages/ai/src/utils/retry.ts`（新建） |
| 项目记忆注入 | `src/utils/attachments.ts` | `packages/core/src/context/project-memory.ts`（新建） |
| Git diff 追踪 | `src/utils/gitDiff.ts` | `packages/core/src/utils/git.ts`（新建） |
| 权限白名单 | `packages/builtin-tools/src/tools/BashTool/bashPermissions.ts` | `packages/core/src/security/policy.ts` |
| Bash 进度展示 | `packages/builtin-tools/src/tools/BashTool/UI.tsx` | `packages/cli/src/ui/progress.ts`（新建） |
| Glob 工具 | `packages/builtin-tools/src/tools/GlobTool/GlobTool.ts` | `packages/core/src/tools/handlers/glob.ts`（新建） |
| Plan 模式 | `src/query.ts: permissionMode === 'plan'` | `packages/core/src/agent/agent-loop.ts` |
| 子 Agent | `packages/builtin-tools/src/tools/AgentTool/runAgent.ts` | `packages/core/src/tools/handlers/agent.ts`（新建） |

---

---

## 八、终端渲染兼容 & UI 设计（独立专题）

> 这一章是 EasyCode 与 claude-code **视觉质感**最大的差距。
> 当前 EC 的 UI 是"凑合能用"，CC 的 UI 是"打开就有专业感"。
> 这部分直接决定用户第一眼的印象。

---

- [ ] **U-01：主题系统 — 不同终端下的自适应配色**

**现状问题**：

```typescript
// ❌ 当前实现 packages/cli/src/commands/repl-ink.tsx
<Text backgroundColor="#2d2d2d" color="#a8a8a8">
<Text color="cyan">
<Text dimColor color="gray">
```

EC 全部使用硬编码颜色。在浅色终端下用户看到深灰背景气泡，完全不可读。
在不支持 truecolor 的终端（如 Windows 老版 cmd）里，`#2d2d2d` 直接乱码显示。

**CC 的做法**（参考 `D:\projects\claude-code\src\utils\theme.ts`）：

CC 定义了 6 套主题：
- `dark` / `light` — 24-bit RGB 全彩
- `dark-ansi` / `light-ansi` — 仅用 16 色 ANSI，适配所有终端
- `dark-daltonized` / `light-daltonized` — 色盲友好版本

每套主题包含 60+ 语义颜色键：

```typescript
// D:\projects\claude-code\src\utils\theme.ts
const darkTheme: Theme = {
  claude: 'rgb(215,119,87)',       // 品牌橙色（spinner 等核心元素）
  success: 'rgb(78,186,101)',      // 操作成功
  error: 'rgb(255,107,128)',       // 错误提示
  warning: 'rgb(255,193,7)',       // 警告
  diffAdded: 'rgb(34,92,43)',      // diff 新增行背景
  diffRemoved: 'rgb(122,41,54)',   // diff 删除行背景
  promptBorder: 'rgb(136,136,136)', // 输入框边框
  subtle: 'rgb(80,80,80)',         // 辅助灰色文字
  // ...共 60+ 个语义色
}
```

**EC 改造方案**（`packages/cli/src/utils/theme.ts`，新文件）：

```typescript
// 两套主题即可覆盖 95% 场景
export type ThemeColors = {
  brand: string;        // 品牌主色（spinner、logo）
  success: string;      // ✓ 成功
  error: string;        // ✗ 错误
  warning: string;      // ⚠ 警告
  toolName: string;     // 工具名高亮
  userBubbleBg: string; // 用户消息背景
  userBubbleText: string;
  promptBorder: string; // 输入框颜色
  dim: string;          // 辅助信息
  diffAdd: string;      // git diff 新增
  diffDel: string;      // git diff 删除
};

const darkTheme: ThemeColors = {
  brand: 'rgb(215,119,87)',      // Claude orange
  success: 'rgb(78,186,101)',
  error: 'rgb(255,107,128)',
  warning: 'rgb(255,193,7)',
  toolName: 'rgb(147,165,255)',
  userBubbleBg: 'rgb(55,55,55)',
  userBubbleText: 'rgb(200,200,200)',
  promptBorder: 'rgb(136,136,136)',
  dim: 'rgb(102,102,102)',
  diffAdd: 'rgb(34,92,43)',
  diffDel: 'rgb(122,41,54)',
};

const lightTheme: ThemeColors = {
  brand: 'rgb(215,119,87)',
  success: 'rgb(44,122,57)',
  error: 'rgb(171,43,63)',
  warning: 'rgb(150,108,30)',
  toolName: 'rgb(87,105,247)',
  userBubbleBg: 'rgb(240,240,240)',
  userBubbleText: 'rgb(30,30,30)',
  promptBorder: 'rgb(153,153,153)',
  dim: 'rgb(153,153,153)',
  diffAdd: 'rgb(105,219,124)',
  diffDel: 'rgb(255,168,180)',
};

// ANSI fallback（16色终端用标准 ANSI 颜色名，CC 同款策略）
const darkAnsiTheme: ThemeColors = {
  brand: 'redBright',
  success: 'greenBright',
  error: 'redBright',
  warning: 'yellowBright',
  toolName: 'blueBright',
  userBubbleBg: 'blackBright',
  userBubbleText: 'white',
  promptBorder: 'white',
  dim: 'white',
  diffAdd: 'green',
  diffDel: 'red',
};
```

**参考文件**：
- `D:\projects\claude-code\src\utils\theme.ts` — 完整 6 套主题定义（含所有颜色键）

---

- [ ] **U-02：终端能力检测 — 自动适配不同终端**

**CC 的检测体系**（参考 `D:\projects\claude-code\src\utils\systemTheme.ts` + `terminalSetup.tsx`）：

```
终端能力检测链：
1. 颜色支持级别：truecolor(24bit) > 256色 > 16色ANSI > 无色
   → 根据 $COLORTERM、$TERM、chalk.level 判断
   → Apple Terminal 特殊处理：强制 256色模式（它声称支持 truecolor 但实际有 bug）

2. 深色/浅色模式检测（按优先级）：
   → OSC 11 终端查询（最准确，异步）：发 \x1b]11;?\x07 查询背景色 RGB
   → $COLORFGBG 环境变量（同步初始值）：格式 "fg;bg"，bg<=6 or =8 是深色
   → 默认 dark（大多数终端是深色）

3. 超链接支持：supportsHyperlinks() — 检测 $TERM_PROGRAM、$COLORTERM 等
   → 支持：iTerm2、Kitty、Hyper、WezTerm 等
   → 不支持：cmd.exe、老版 Terminal.app

4. 终端类型识别：
   → $TERM_PROGRAM: 'iTerm.app', 'vscode', 'WarpTerminal' 等
   → $WT_SESSION: Windows Terminal
   → CSI u 支持：Ghostty/Kitty/iTerm2/WezTerm（现代键盘协议）
```

**EC 改造方案**（`packages/cli/src/utils/terminal-caps.ts`，新文件）：

```typescript
import chalk from 'chalk';

export interface TerminalCaps {
  colorLevel: 0 | 1 | 2 | 3;  // 0=无色, 1=16色, 2=256色, 3=truecolor
  isDark: boolean;              // 终端背景深色？
  supportsHyperlinks: boolean;  // OSC 8 支持？
  isWindowsTerminal: boolean;   // Windows Terminal
  isVSCode: boolean;            // VSCode 终端
  isCI: boolean;                // CI 环境
}

export function detectTerminalCaps(): TerminalCaps {
  const isCI = !!(process.env.CI || process.env.GITHUB_ACTIONS);
  const colorLevel = isCI ? 1 : (chalk.level as 0 | 1 | 2 | 3);
  
  // 深色检测：优先 COLORFGBG，默认 dark
  const colorfgbg = process.env.COLORFGBG;
  let isDark = true;
  if (colorfgbg) {
    const parts = colorfgbg.split(';');
    const bg = Number(parts[parts.length - 1]);
    isDark = bg <= 6 || bg === 8;
  }
  
  // Apple Terminal 强制 256色（truecolor 显示有 bug）
  // 参考 CC: src/utils/theme.ts:chalkForChart
  const isAppleTerminal = process.env.TERM_PROGRAM === 'Apple_Terminal';
  const effectiveLevel = (isAppleTerminal && colorLevel === 3) ? 2 : colorLevel;
  
  const termProgram = process.env.TERM_PROGRAM ?? '';
  const supportsHyperlinks = ['iTerm.app', 'Hyper', 'WezTerm'].includes(termProgram) ||
    !!process.env.WT_SESSION;  // Windows Terminal
  
  return {
    colorLevel: effectiveLevel as 0 | 1 | 2 | 3,
    isDark,
    supportsHyperlinks,
    isWindowsTerminal: !!process.env.WT_SESSION,
    isVSCode: termProgram === 'vscode',
    isCI,
  };
}

// 根据终端能力选择主题
export function resolveTheme(caps: TerminalCaps): ThemeColors {
  if (caps.colorLevel <= 1) return caps.isDark ? darkAnsiTheme : lightAnsiTheme;
  return caps.isDark ? darkTheme : lightTheme;
}
```

**参考文件**：
- `D:\projects\claude-code\src\utils\systemTheme.ts` — OSC 11 深色检测 + COLORFGBG 解析
- `D:\projects\claude-code\src\commands\terminalSetup\terminalSetup.tsx` — NATIVE_CSIU_TERMINALS + Apple Terminal 处理
- `D:\projects\claude-code\src\utils\theme.ts:617` — chalkForChart（Apple Terminal 256色降级）

---

- [ ] **U-03：动态 Spinner — 闪烁动画 + 卡顿感知**

**现状问题**：EC 的等待状态只有静态 `[工具] xxx ...`，用户看不出程序是否还在运行。

**CC 的做法**（参考 `D:\projects\claude-code\src\components\Spinner.tsx` + `SpinnerAnimationRow.tsx`）：

```
Spinner 特性一览：
1. 50ms 帧率动画：8帧往返扫描 ⠋⠙⠹⠸⠼⠴⠦⠧（Braille 点阵符号）
2. Shimmer 效果：verb 文字从左到右逐字高亮扫过（glimmerIndex 算法）
3. 卡顿感知：
   → 3 秒内无新 token：spinner 字符变红（"可能卡住了"信号）
   → 30 秒后：显示 token 计数（让用户知道在工作）
4. Thinking 模式：显示 "thinking..." + 结束后展示耗时 "🤔 3.2s"
5. 进度条：context 压缩时显示 token 进度条
6. 减少动效：读取 prefersReducedMotion，禁用动画只显示静态 ●
```

**CC Spinner 帧序列**（`src/components/Spinner/index.ts`）：

```typescript
// Braille 点阵符号，视觉上更精致
const DEFAULT_CHARACTERS = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧'];
const FRAMES = [...DEFAULT_CHARACTERS, ...[...DEFAULT_CHARACTERS].reverse()];
// 50ms 一帧，每轮 16 帧 (800ms 完整循环)
```

**EC 改造方案**（`packages/cli/src/components/Spinner.tsx`，新文件）：

```tsx
import { Box, Text, useAnimationFrame } from 'ink';
import * as React from 'react';

const FRAMES = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠧','⠦','⠴','⠼','⠸','⠹','⠙','⠋'];

interface SpinnerProps {
  message: string;           // 动态动词，如 "Reading..."
  color?: string;            // Ink 颜色键
  stalled?: boolean;         // true 时变红（超时警示）
  reducedMotion?: boolean;   // 无障碍：禁用动画
  elapsedMs?: number;        // 经过时间（显示 token 计数）
  tokenCount?: number;       // 已生成 token 数
}

export function EasycodeSpinner({ message, color = 'brand', stalled, reducedMotion, elapsedMs = 0, tokenCount }: SpinnerProps) {
  const [, time] = useAnimationFrame(reducedMotion ? null : 50);
  const frame = Math.floor(time / 50) % FRAMES.length;
  const glyph = reducedMotion ? '●' : FRAMES[frame]!;
  const glyphColor = stalled ? 'red' : color;
  
  // 30 秒后显示 token 计数
  const showTokens = elapsedMs > 30_000 && tokenCount !== undefined;
  const tokenText = showTokens ? ` · ${(tokenCount / 1000).toFixed(1)}k tokens` : '';
  const timeText = elapsedMs > 5_000 ? ` ${Math.floor(elapsedMs / 1000)}s` : '';
  
  return (
    <Box>
      <Text color={glyphColor}>{glyph} </Text>
      <Text color={color}>{message}</Text>
      <Text dimColor>{timeText}{tokenText}</Text>
    </Box>
  );
}
```

**Shimmer 效果**（参考 `D:\projects\claude-code\src\bridge\bridgeStatusUtil.ts:computeShimmerSegments`）：

```typescript
// 计算 shimmer 扫过位置：verb 文字从左到右逐字高亮
function computeShimmerSegments(verb: string, glimmerIndex: number) {
  const chars = [...verb];  // 处理 Unicode 多字节字符
  return {
    before: chars.slice(0, glimmerIndex).join(''),
    shimmer: chars[glimmerIndex] ?? '',     // 高亮当前字符
    after: chars.slice(glimmerIndex + 1).join(''),
  };
}
// 渲染：before(dim) + shimmer(bright) + after(dim) → 产生扫光效果
```

**参考文件**：
- `D:\projects\claude-code\src\components\Spinner.tsx` — SpinnerWithVerb + BriefSpinner 完整实现
- `D:\projects\claude-code\src\components\Spinner\SpinnerAnimationRow.tsx` — 50ms 时钟 + shimmer
- `D:\projects\claude-code\src\bridge\bridgeStatusUtil.ts` — computeShimmerSegments + computeGlimmerIndex

---

- [ ] **U-04：ANSI 安全渲染 — Unicode 宽度 + 内容截断**

**现状问题**：EC 直接用 `string.length` 做宽度计算，对 CJK（中文）字符和 ANSI 转义码的处理是错的。
`🎉` 和 `A` 在代码里都是 1，但前者在终端里占 2 格。ANSI 转义码 `\x1b[31m` 有 5 个字符但显示宽度为 0。

**CC 的做法**：
- 使用 `@anthropic/ink` 的 `stringWidth()` — ANSI 感知的显示宽度
- 使用 `sliceAnsi()` — ANSI 安全的字符串切割（不会切断转义序列）
- `renderTruncatedContent()` — 按**终端宽度**折行，超过 3 行折叠为 `+N lines`

**参考 CC 实现**（`D:\projects\claude-code\src\utils\terminal.ts`）：

```typescript
// ✅ ANSI 安全折行 + 超出截断
export function renderTruncatedContent(content: string, terminalWidth: number): string {
  const MAX_LINES = 3;
  const wrapWidth = Math.max(terminalWidth - 10, 10);
  
  // 关键：用 stringWidth 计算可见宽度，sliceAnsi 切割时保留转义码
  const lines = content.split('\n');
  const wrappedLines: string[] = [];
  
  for (const line of lines) {
    const visibleWidth = stringWidth(line);  // ← 而非 line.length
    if (visibleWidth <= wrapWidth) {
      wrappedLines.push(line.trimEnd());
    } else {
      let pos = 0;
      while (pos < visibleWidth) {
        wrappedLines.push(sliceAnsi(line, pos, pos + wrapWidth).trimEnd());  // ← ANSI 安全
        pos += wrapWidth;
      }
    }
  }
  
  const remaining = wrappedLines.length - MAX_LINES;
  if (remaining > 1) {
    return wrappedLines.slice(0, MAX_LINES).join('\n') + `\n\x1b[2m… +${remaining} lines\x1b[0m`;
  }
  return wrappedLines.join('\n');
}
```

**EC 改造方案**（安装依赖 + 新增工具函数）：

```bash
npm install slice-ansi string-width  # 或直接用 @anthropic/ink 内置版
```

```typescript
// packages/cli/src/utils/terminal.ts (新文件)
import stringWidth from 'string-width';
import sliceAnsi from 'slice-ansi';

// 折行 + 超出截断（适用于工具结果展示）
export function truncateForDisplay(content: string, columns: number, maxLines = 3): string {
  const lines = content.trimEnd().split('\n');
  const wrapped: string[] = [];
  const wrapAt = Math.max(columns - 6, 20);
  
  for (const line of lines) {
    const w = stringWidth(line);
    if (w <= wrapAt) { wrapped.push(line); continue; }
    let pos = 0;
    while (pos < w) {
      wrapped.push(sliceAnsi(line, pos, pos + wrapAt));
      pos += wrapAt;
    }
  }
  
  const extra = wrapped.length - maxLines;
  if (extra > 1) {
    return wrapped.slice(0, maxLines).join('\n') + `\n\x1b[2m… +${extra} 行\x1b[0m`;
  }
  return wrapped.join('\n');
}
```

**参考文件**：
- `D:\projects\claude-code\src\utils\terminal.ts` — renderTruncatedContent、wrapText、isOutputLineTruncated
- `D:\projects\claude-code\src\utils\sliceAnsi.ts` — ANSI 安全切割工具

---

- [ ] **U-05：OSC 8 超链接 — 文件路径可点击**

**CC 的做法**（参考 `D:\projects\claude-code\src\utils\hyperlink.ts`）：

工具执行结果里的文件路径，在支持的终端（iTerm2/WezTerm/Windows Terminal）里变成可点击链接：

```typescript
// ✅ CC 实现
export function createHyperlink(url: string, content?: string): string {
  if (!supportsHyperlinks()) return url;  // 不支持则降级为纯文本
  const displayText = chalk.blue(content ?? url);
  return `\x1b]8;;${url}\x07${displayText}\x1b]8;;\x07`;
}

// 文件路径超链接（file:// URL）
function formatFilePathLink(filePath: string): string {
  if (!supportsHyperlinks()) return chalk.dim(filePath);
  const fileUrl = pathToFileURL(filePath).toString();
  return `\x1b]8;;${fileUrl}\x07${chalk.dim(filePath)}\x1b]8;;\x07`;
}
```

**EC 改造方案**（`packages/cli/src/utils/hyperlink.ts`，新文件）：

```typescript
import { pathToFileURL } from 'url';

// 检测：Windows Terminal / iTerm2 / WezTerm 支持 OSC 8
function supportsHyperlinks(): boolean {
  return !!(
    process.env.WT_SESSION ||   // Windows Terminal
    process.env.TERM_PROGRAM === 'iTerm.app' ||
    process.env.TERM_PROGRAM === 'WezTerm' ||
    process.env.VTE_VERSION     // GNOME Terminal 0.50+
  );
}

export function fileLink(filePath: string, displayText?: string): string {
  if (!supportsHyperlinks()) return displayText ?? filePath;
  const url = pathToFileURL(filePath).toString();
  return `\x1b]8;;${url}\x07${displayText ?? filePath}\x1b]8;;\x07`;
}
```

**在工具结果中应用**：

```typescript
// edit_file 完成后：
return {
  content: `✓ 已编辑 ${fileLink(filePath, filePath)}\n  行 ${lineNum}：${oldLines}行 → ${newLines}行`
};
```

**参考文件**：
- `D:\projects\claude-code\src\utils\hyperlink.ts` — createHyperlink、OSC8 格式
- `D:\projects\claude-code\src\commands\terminalSetup\terminalSetup.tsx:80` — formatPathLink 实现

---

- [ ] **U-06：Windows 兼容 — PowerShell / Windows Terminal**

**现状问题**：EC 在 Windows PowerShell 里运行时可能遇到：
- `⠋` Braille 符号不渲染（PowerShell 默认 Code Page 936）
- `#2d2d2d` 格式在某些旧终端显示错误
- 换行符（CRLF vs LF）导致 ANSI 转义码失效

**CC 的兼容策略**（参考 `D:\projects\claude-code\src\utils\swarm\backends\WindowsTerminalBackend.ts`）：

```typescript
// CC 对 Windows 的特殊处理：
// 1. 启动时检测 $WT_SESSION（Windows Terminal）
// 2. 有 WT_SESSION = 现代 Windows Terminal，支持全功能
// 3. 无 WT_SESSION = 老 cmd / PowerShell，降级到 16色 ANSI + ASCII 符号

const isModernWindows = !!process.env.WT_SESSION;
const spinnerChars = isModernWindows 
  ? ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧']  // Braille
  : ['|','/','-','\\'];                    // ASCII fallback
```

**EC 改造方案**（在 terminal-caps.ts 中集成）：

```typescript
export function getSpinnerFrames(caps: TerminalCaps): string[] {
  // Windows Terminal 支持 Braille，老终端和 CI 用 ASCII
  if (caps.isWindowsTerminal || (caps.colorLevel >= 2 && !process.platform.startsWith('win'))) {
    return ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠧','⠦','⠴','⠼','⠸','⠹','⠙','⠋'];
  }
  return ['|','/','-','\\','\\','-','/','-'];  // ASCII fallback
}

export function getBrandChar(caps: TerminalCaps): string {
  // 品牌符号：● 在 Windows 老终端可能不显示
  return caps.colorLevel >= 1 ? '●' : '*';
}
```

**参考文件**：
- `D:\projects\claude-code\src\utils\swarm\backends\WindowsTerminalBackend.ts` — Windows 专项适配
- `D:\projects\claude-code\src\commands\terminalSetup\terminalSetup.tsx:30` — NATIVE_CSIU_TERMINALS 检测

---

- [ ] **U-07：Diff 彩色渲染 — 让文件改动一目了然**

**CC 的做法**（参考 `D:\projects\claude-code\src\components\StructuredDiff\colorDiff.ts`）：

git diff 输出不只是黑白文字，CC 做了词级别（word-level）的高亮：

```
传统 unified diff：
- const foo = 'old value';
+ const foo = 'new value';

CC 的 word diff：
  const foo = 'old value';  ← 删除行：整行红底
                ^^^^^^^^^^^     ← 单词"old value"背景更深红
  const foo = 'new value';  ← 新增行：整行绿底
                ^^^^^^^^^^^     ← 单词"new value"背景更深绿
```

**EC 改造方案**（`packages/cli/src/utils/diff-render.ts`，新文件）：

```typescript
import { diffWords } from 'diff';  // npm install diff

export function renderColoredDiff(unified: string, theme: ThemeColors): string {
  const lines = unified.split('\n');
  return lines.map(line => {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      return chalk.bgHex(theme.diffAdd)(line);
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      return chalk.bgHex(theme.diffDel)(line);
    }
    if (line.startsWith('@@')) {
      return chalk.cyan(line);
    }
    return line;
  }).join('\n');
}

// 词级别高亮（只用于短 diff，长 diff 不做词级别，太慢）
export function renderWordDiff(oldLine: string, newLine: string): { old: string; new: string } {
  const changes = diffWords(oldLine, newLine);
  let oldStr = '', newStr = '';
  for (const part of changes) {
    if (part.removed) oldStr += chalk.bgRed(part.value);
    else if (part.added) newStr += chalk.bgGreen(part.value);
    else { oldStr += part.value; newStr += part.value; }
  }
  return { old: oldStr, new: newStr };
}
```

**参考文件**：
- `D:\projects\claude-code\src\components\StructuredDiff\colorDiff.ts` — colorDiff 实现
- `D:\projects\claude-code\src\utils\theme.ts:36-42` — diffAdded/diffRemoved/diffAddedWord/diffRemovedWord 颜色定义

---

### UI 模块参考速查表

| 功能 | CC 参考路径 | EC 目标路径 |
|------|------------|------------|
| 主题颜色定义 | `src/utils/theme.ts` | `packages/cli/src/utils/theme.ts` |
| 深色/浅色检测 | `src/utils/systemTheme.ts` | `packages/cli/src/utils/terminal-caps.ts` |
| 终端能力检测 | `src/commands/terminalSetup/terminalSetup.tsx` | 同上 |
| Spinner 主组件 | `src/components/Spinner.tsx` | `packages/cli/src/components/Spinner.tsx` |
| Shimmer 动画行 | `src/components/Spinner/SpinnerAnimationRow.tsx` | 同上 |
| ANSI 安全折行 | `src/utils/terminal.ts` | `packages/cli/src/utils/terminal.ts` |
| ANSI 切割工具 | `src/utils/sliceAnsi.ts` | 用 `slice-ansi` npm 包 |
| OSC 8 超链接 | `src/utils/hyperlink.ts` | `packages/cli/src/utils/hyperlink.ts` |
| Diff 彩色渲染 | `src/components/StructuredDiff/colorDiff.ts` | `packages/cli/src/utils/diff-render.ts` |
| Windows 适配 | `src/utils/swarm/backends/WindowsTerminalBackend.ts` | `packages/cli/src/utils/terminal-caps.ts` |

---

> 最后一句话：
> **骨架让人看到轮廓，血肉才能让工具真正跑起来。**
> 这 21 项改造（14 功能 + 7 UI），完成前 7 项（F-01~F-03 + U-01~U-03 + U-06）就能在真实项目上体面地工作。

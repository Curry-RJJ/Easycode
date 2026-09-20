# EasyCode CLI — Coding Agent 项目方案

> 目标：独立开发一个类 Claude Code 风格的 CLI Coding Agent，覆盖岗位要求的全部核心技术点，用以证明对 Agent 系统架构的深度理解与实际工程能力。

---

## 一、背景与动机

本项目源于对以下三个主流开源 Coding Agent 的深度调研：

| 项目 | 语言 | 架构特色 |
|------|------|---------|
| **Pi** | TypeScript | 库式 Agent 类，事件钩子扩展，JSONL 事实源 |
| **OpenAI Codex** | Rust | 大核多壳，四层安全纵深，Responses API 绑定 |
| **DSH** | TypeScript | 全插件微内核（Cordis），事件溯源，能力缝设计 |

EasyCode 不重复造轮子，而是吸收三家的设计精华：

- **来自 Pi**：简洁的 Agent 类 + runLoop 双层循环 + JSONL 会话存储
- **来自 Codex**：多层安全审批纵深 + token 预算管理 + apply_patch 式改代码
- **来自 DSH**：事件溯源崩溃恢复 + 读写并发调度 + MCP 协议接入

---

## 二、岗位要求覆盖矩阵

| 岗位要求 | EasyCode 对应实现 | 所在 Phase |
|---------|-----------------|-----------|
| 多轮工具调用编排 | Agent runLoop 双层循环 | Phase 1 |
| 只读并行、写入串行 | ToolExecutionScheduler | Phase 2 |
| 可中断、可恢复执行 | Checkpoint + JSONL 重放 | Phase 2 |
| Context Engineering | 上下文压缩 + token 窗口监控 | Phase 2 |
| Checkpoint 机制 | 事件溯源 + 崩溃尾巴合成闭合 | Phase 2 |
| MCP 协议 | MCP Client，动态工具注册 | Phase 3 |
| 系统可观测性 | 结构化日志 + token 统计面板 | Phase 3 |
| 效果评估 | Session Replay + 执行摘要 | Phase 4 |

---

## 三、技术栈

| 层次 | 选型 | 理由 |
|-----|------|------|
| 语言 | TypeScript | 岗位要求，类型安全，生态丰富 |
| 运行时 | Node.js 20+ | 原生支持 ESM、fetch、readline |
| CLI 渲染 | Ink（React for CLI） | 流式输出、加载动画、交互式审批 |
| 命令行解析 | Commander.js | 成熟，支持子命令 |
| 会话存储 | JSONL 文件 + SQLite 索引 | 可读性强，易 debug，支持快速查询 |
| LLM 接入 | 抽象 streamFn（兼容 OpenAI/Anthropic/Deepseek） | 可热插拔，不绑定单一厂商 |
| 测试 | Vitest | 快速，支持 ESM |
| 构建 | tsup | 零配置打包 |

---

## 四、项目结构

```
easycode/
├── packages/
│   ├── core/                   # Agent 核心逻辑
│   │   ├── agent/
│   │   │   ├── agent.ts        # Agent 类（对外 API）
│   │   │   └── agent-loop.ts   # runLoop 双层循环
│   │   ├── tools/
│   │   │   ├── registry.ts     # 工具注册表
│   │   │   ├── scheduler.ts    # 读写并发调度器
│   │   │   └── handlers/       # 内置工具实现
│   │   │       ├── read.ts
│   │   │       ├── write.ts
│   │   │       ├── edit.ts     # 搜索替换式编辑
│   │   │       ├── bash.ts
│   │   │       ├── grep.ts
│   │   │       └── ls.ts
│   │   ├── context/
│   │   │   ├── context.ts      # AgentContext（消息数组管理）
│   │   │   ├── compaction.ts   # 上下文压缩（超窗口触发摘要）
│   │   │   └── token.ts        # token 计数与预算监控
│   │   ├── session/
│   │   │   ├── session.ts      # Session 类
│   │   │   ├── storage.ts      # JSONL 读写
│   │   │   └── types.ts        # 事件类型定义（EventRecord）
│   │   ├── checkpoint/
│   │   │   ├── recovery.ts     # 崩溃恢复（合成闭合事件）
│   │   │   └── replay.ts       # 事件重放
│   │   └── security/
│   │       ├── approval.ts     # 审批决策（ask/auto/never）
│   │       ├── policy.ts       # 危险命令模式匹配
│   │       └── sandbox.ts      # 沙箱执行（未来扩展）
│   ├── ai/
│   │   ├── provider.ts         # streamFn 抽象接口
│   │   ├── openai.ts           # OpenAI 实现
│   │   ├── anthropic.ts        # Anthropic 实现
│   │   └── deepseek.ts         # Deepseek 实现
│   ├── mcp/
│   │   ├── client.ts           # MCP Client
│   │   └── tool-bridge.ts      # MCP 工具 → EasyCode 工具适配
│   └── cli/
│       ├── index.ts            # 入口，Commander.js 命令注册
│       ├── ui/
│       │   ├── chat.tsx        # Ink 对话界面
│       │   ├── approval.tsx    # 交互式审批 UI
│       │   └── stats.tsx       # token 统计面板
│       └── commands/
│           ├── run.ts          # easycode <prompt>
│           ├── resume.ts       # easycode resume <id>
│           └── stats.ts        # easycode stats <id>
├── docs/
│   └── project-plan.md         # 本文档
├── package.json
├── tsconfig.json
└── README.md
```

---

## 五、详细里程碑

---

### 🔴 Milestone 1：MVP — 能跑起来的 Agent Loop

**目标**：`easycode "帮我修复 src/auth.ts 的 bug"` 端到端跑通

**产出物**：

- [ ] **M1.1** `packages/ai/` — LLM 提供者抽象
  - 定义 `StreamFn` 接口：`(messages, tools) => AsyncIterable<Delta>`
  - 实现 OpenAI Provider（基于 `openai` npm 包）
  - 支持流式输出（streaming）

- [ ] **M1.2** `packages/core/tools/` — 内置工具集
  - `read_file(path)` — 读取文件内容
  - `write_file(path, content)` — 全量写入
  - `edit_file(path, old_str, new_str)` — 搜索替换式编辑（参考 Pi 的 edit 工具）
  - `run_bash(command)` — 执行 shell 命令，返回 stdout/stderr
  - `list_dir(path)` — 列目录
  - `search_files(pattern, path)` — grep 搜索

- [ ] **M1.3** `packages/core/agent/` — Agent 类与双层 runLoop
  ```
  外层循环（follow-up）
  └─ 内层循环（tool 调用）
      ├─ 调用 LLM → 解析 tool_calls
      ├─ 执行工具 → 收集结果
      ├─ 追加结果到消息数组
      └─ 如无 tool_calls，退出内层
  ```

- [ ] **M1.4** `packages/cli/` — 基础 CLI
  - `easycode "<prompt>"` 启动单次任务
  - 流式打印 LLM 输出
  - 简单的工具执行日志（`[tool] read_file src/auth.ts`）

**验收标准**：
> 运行 `easycode "读取 README.md 并统计行数"` → Agent 自动调用 `read_file` + `run_bash` → 输出正确结果

---

### 🟡 Milestone 2：工程核心 — 体现架构深度的三大特性

#### M2.1：事件溯源会话存储（Checkpoint 机制）

**目标**：每次任务全程可追溯，进程崩溃后能断点续传

**产出物**：

- [ ] **M2.1.1** 定义 `EventRecord` 事件类型体系
  ```typescript
  type EventRecord =
    | { type: 'session/start';  data: { id, model, systemPrompt } }
    | { type: 'user/message';   data: { content } }
    | { type: 'tool/call';      data: { callId, name, input } }
    | { type: 'tool/result';    data: { callId, content, isError } }
    | { type: 'assistant/text'; data: { content } }
    | { type: 'token/usage';    data: { input, output, cacheRead, cacheWrite } }
    | { type: 'compaction';     data: { reason, summaryTokens } }
    | { type: 'approval';       data: { callId, policy, decision } }
    | { type: 'session/end';    data: { reason } }
  ```

- [ ] **M2.1.2** JSONL 存储层（`packages/core/session/storage.ts`）
  - 追加写入（append-only），不修改历史
  - 每个 session 存为 `~/.easycode/sessions/<id>.jsonl`
  - SQLite 维护 session 索引（id、创建时间、状态）

- [ ] **M2.1.3** 崩溃恢复（参考 DSH 的"合成闭合事件"设计）
  ```
  重启后流程：
  1. 读取 JSONL，找出所有 tool/call 中没有对应 tool/result 的 callId
  2. 合成错误闭合事件（文本即恢复指令）：
     "TOOL_OUTCOME_UNKNOWN: 进程意外中断，该工具调用结果未知，
      请重新确认操作是否已完成，再继续执行"
  3. 将合成事件追加到 JSONL
  4. 重放所有事件重建上下文，继续运行
  ```

- [ ] **M2.1.4** CLI 命令
  - `easycode resume <session-id>` — 恢复指定会话
  - `easycode list` — 查看历史会话列表（含状态：完成/中断）

**验收标准**：
> 任务执行中用 Ctrl+C 杀进程 → 重启后执行 `easycode resume <id>` → Agent 正确识别到未完成的工具调用，继续完成任务

---

#### M2.2：读写并发调度器（只读并行 / 写入串行）

**目标**：同一个 LLM 响应中多个工具调用，安全并发执行

**产出物**：

- [ ] **M2.2.1** 工具标注（每个工具声明自己的并发属性）
  ```typescript
  interface ToolDefinition {
    name: string;
    description: string;
    parameters: JSONSchema;
    concurrency: 'readonly' | 'write' | 'exclusive';
    execute: (input) => Promise<ToolResult>;
  }
  // readonly  → 可与其他 readonly 工具并发执行
  // write     → 串行，等待前一个 write 完成
  // exclusive → 独占，等所有其他工具完成（bash 等副作用强的工具）
  ```

- [ ] **M2.2.2** `ToolExecutionScheduler`（`packages/core/tools/scheduler.ts`）
  ```
  调度算法：
  1. 对同一批 tool_calls 按 concurrency 分组
  2. readonly 组 → Promise.all 并发执行
  3. write/exclusive 组 → 串行，逐个等待
  4. 混合时：先跑完所有 readonly，再跑 write，再跑 exclusive
  ```

- [ ] **M2.2.3** 执行日志（每次工具执行记录 `{ toolName, concurrencyMode, startTime, duration }`）

**验收标准**：
> 一次响应中包含 `read_file(a.ts)` + `read_file(b.ts)` + `edit_file(c.ts)` → 前两个并发执行，第三个等前两个完成后串行执行，日志可验证

---

#### M2.3：上下文压缩（Context Engineering）

**目标**：token 接近窗口上限时，自动压缩历史消息，保持 Agent 可持续运行

**产出物**：

- [ ] **M2.3.1** Token 计数（`packages/core/context/token.ts`）
  - 使用 `tiktoken` 或 `js-tiktoken` 本地计算 token 数
  - 实时追踪当前上下文 token 总量
  - 设定压缩阈值（默认：触达模型上下文窗口的 80%）

- [ ] **M2.3.2** 压缩策略（`packages/core/context/compaction.ts`）
  ```
  压缩触发后：
  1. 保留：系统提示词（system prompt 不动）
  2. 保留：最近 N 轮完整对话（默认保留最近 3 轮）
  3. 压缩：中间历史消息 → 用 LLM 生成摘要（一段话总结完成了什么）
  4. 替换：中间消息改为 "【历史摘要】xxx"
  5. 记录：写入 compaction 事件到 JSONL
  ```

- [ ] **M2.3.3** CLI 进度条显示当前 token 使用量（`[context: 45k/128k]`）

**验收标准**：
> 执行一个涉及大量文件读取的长任务 → Agent 在 token 接近上限时自动触发压缩 → 压缩后任务继续完成，不因上下文溢出中断

---

### 🟢 Milestone 3：差异化亮点 — 安全 + MCP + 可观测性

#### M3.1：多层安全审批

**目标**：参考 Codex 四层纵深，实现两层防线

**产出物**：

- [ ] **M3.1.1** 危险命令模式匹配（L1 防线）
  ```typescript
  // packages/core/security/policy.ts
  const DANGEROUS_PATTERNS = [
    /rm\s+-rf/,          // 递归删除
    /sudo\s+/,           // 提权
    /chmod\s+777/,       // 权限开放
    /curl.*\|\s*bash/,   // 远程执行
    />\s*\/etc\//,       // 写系统目录
    /DROP\s+TABLE/i,     // 删数据库
  ];
  ```

- [ ] **M3.1.2** 审批决策层（L2 防线）
  ```
  审批策略三态（持久化到 session 事件）：
  - auto   → 所有工具自动放行（危险命令仍被 L1 拦截）
  - ask    → 危险命令弹出交互式确认（默认）
  - never  → 所有写操作拒绝（纯只读模式，适合代码审查场景）
  ```

- [ ] **M3.1.3** Ink 交互式审批 UI
  ```
  ⚠️  Agent 请求执行以下命令：
  
    bash: rm -rf ./dist
  
  [ Allow Once ]  [ Allow All ]  [ Deny ]  [ Deny & Abort ]
  ```

- [ ] **M3.1.4** 审批记录入 JSONL（可审计）
  ```json
  { "type": "approval", "data": { "callId": "call_3", "command": "rm -rf ./dist",
    "policy": "ask", "decision": "allow_once", "timestamp": 1704067200 } }
  ```

**验收标准**：
> 执行 `easycode "清理项目构建产物"` → Agent 试图执行 `rm -rf ./dist` → 弹出审批确认框 → 用户选择 Allow → 执行成功并记录到日志

---

#### M3.2：MCP 协议支持

**目标**：支持接入外部 MCP Server 提供的工具，实现工具动态扩展

**产出物**：

- [ ] **M3.2.1** MCP Client（`packages/mcp/client.ts`）
  - 连接 MCP Server（支持 stdio、HTTP/SSE 两种传输方式）
  - 调用 `tools/list` 获取工具列表
  - 调用 `tools/call` 执行工具

- [ ] **M3.2.2** MCP 工具适配器（`packages/mcp/tool-bridge.ts`）
  - 将 MCP 工具 Schema 转为 EasyCode `ToolDefinition`
  - 自动注入 MCP 工具到工具注册表

- [ ] **M3.2.3** CLI 参数支持
  ```bash
  easycode --mcp stdio:"node mcp-server.js" "帮我查询数据库"
  easycode --mcp http://localhost:3000 "执行任务"
  ```

**验收标准**：
> 启动一个第三方 MCP Server（如 `@modelcontextprotocol/server-filesystem`） → EasyCode 自动发现并使用其提供的工具完成任务

---

#### M3.3：可观测性 — 结构化日志与统计面板

**产出物**：

- [ ] **M3.3.1** Session 统计（`packages/cli/commands/stats.ts`）
  ```
  easycode stats <session-id>
  
  ┌─────────────────────────────────────────┐
  │  Session: abc-123  (完成)               │
  │  时长: 3m 42s                           │
  ├─────────────────────────────────────────┤
  │  Token 用量                             │
  │  Input:     45,230  (缓存命中: 12,000)  │
  │  Output:     3,820                      │
  │  Total:     49,050                      │
  │  Cost:      $0.047                      │
  ├─────────────────────────────────────────┤
  │  工具调用记录                             │
  │  read_file   ×8   avg 12ms              │
  │  edit_file   ×3   avg 45ms              │
  │  run_bash    ×2   avg 1200ms            │
  ├─────────────────────────────────────────┤
  │  压缩记录                                │
  │  第 1 次压缩  轮次 12  节省 ~18k tokens  │
  └─────────────────────────────────────────┘
  ```

- [ ] **M3.3.2** 结构化日志输出模式
  ```bash
  easycode --log-format json "任务" > task.log
  # 每行输出一个 JSON 事件，供外部工具消费
  ```

- [ ] **M3.3.3** 实时进度展示（Ink 渲染）
  ```
  ● EasyCode v0.1.0
  
  Context [████████████░░░░░░░░] 45k / 128k tokens
  
  > read_file src/auth.ts            ✓  (12ms)
  > edit_file src/auth.ts            ✓  (38ms)
  > run_bash npm test                ✓  (2.1s)
  
  ✅ 任务完成  |  3 工具调用  |  $0.012  |  耗时 8.3s
  ```

---

### 🔵 Milestone 4（加分项）：Plan 模式 + Session Replay

#### M4.1：Plan 模式（先规划，再执行）

**产出物**：

- [ ] **M4.1.1** Plan 模式实现
  - 第一阶段：Agent 只能用读工具和 `create_plan` 工具，输出执行计划
  - 用户确认计划后，切换到执行阶段（解锁写工具）
  - `create_plan` 工具将计划写入 session 事件

- [ ] **M4.1.2** CLI 支持
  ```bash
  easycode --plan "重构 src/auth 模块"
  # → 输出分步计划 → 用户确认 → 执行
  ```

---

#### M4.2：Session Replay（效果评估）

**产出物**：

- [ ] **M4.2.1** 重放 JSONL 日志，还原完整执行过程
  ```bash
  easycode replay <session-id>
  # 按时间戳逐步回放每个事件，展示完整的 Agent 执行轨迹
  ```

- [ ] **M4.2.2** Diff 报告
  - 对比任务前后的文件变更（`git diff` 风格）
  - 展示 Agent 对哪些文件做了什么操作

---

## 六、核心设计决策说明

### 决策 1：为什么用 JSONL 而不是纯 SQLite？

- **可读性**：出错时可以直接 `cat session.jsonl` 调试，不需要 DB 工具
- **追加语义**：天然 append-only，崩溃不会破坏历史记录
- **调研支撑**：Pi、DSH、Codex 三家均使用 JSONL 作为主要事实源

SQLite 只作为索引层（会话列表、快速查询），不存储内容本体。

### 决策 2：为什么 streamFn 要抽象出去？

- 解耦 Agent 核心逻辑与 LLM 厂商
- 测试时可以注入 mock streamFn，无需真实 API 调用
- 后续支持本地模型（Ollama）只需新增一个 Provider 实现

### 决策 3：崩溃恢复为什么要"合成闭合事件"而不是直接重试？

- 直接重试可能重复执行有副作用的操作（比如已经写入文件又写一次）
- 合成一条"结果未知"的错误 tool/result，让**模型自己决定**是否重试
- 这是 DSH 的核心设计哲学：合成事件的文本本身就是给模型的恢复指令

### 决策 4：读写并发为什么不用简单的全串行？

- 大型项目中 Agent 经常一次性读取十几个文件，串行会显著增加延迟
- 读操作是幂等的，并发执行没有安全风险
- 关键：写操作和 bash 命令必须串行，避免竞争条件

---

## 七、面试演示脚本

### 演示 1：基础能力
```bash
cd demo-project
easycode "src/auth.ts 的 login 函数有一个 null pointer 问题，帮我修复并跑一下测试"
```

**展示点**：流式输出、多工具调用、自动跑测试验证

### 演示 2：断点续传
```bash
# 任务执行中 Ctrl+C 杀进程
easycode list                    # 查看中断的 session
easycode resume abc-123          # 恢复执行
```

**展示点**：JSONL 事实源、崩溃恢复、合成闭合事件

### 演示 3：安全审批
```bash
easycode "删除所有 .log 文件"   # 触发 rm 危险命令审批
```

**展示点**：L1 危险命令识别、Ink 交互式审批 UI、审批日志可审计

### 演示 4：统计面板
```bash
easycode stats abc-123           # 查看刚才任务的 token 用量和工具统计
```

**展示点**：可观测性、成本透明

### 演示 5：MCP 扩展（加分）
```bash
easycode --mcp stdio:"npx @modelcontextprotocol/server-filesystem ." \
  "列出项目中所有 TypeScript 文件"
```

**展示点**：MCP 协议、工具动态扩展

---

## 八、与调研成果的对应关系

本项目是对三家开源 Agent 调研的**工程化落地**，每个设计决策都有源码级参考：

| EasyCode 特性 | 参考来源 | 核心文件路径 |
|-------------|---------|------------|
| runLoop 双层循环 | Pi | `packages/agent/src/agent-loop.ts` |
| JSONL 事实源 | Pi / DSH | `harness/session/types.ts` |
| 合成闭合事件 | DSH | `interruptedTurnClosers()` |
| 读写并发调度 | DSH | `tools/execute` 五道瀑布 |
| 上下文压缩阈值 | Pi | `compaction.ts` |
| 危险命令模式匹配 | Pi | `ai/src/utils/retry.ts` 模式库设计借鉴 |
| 四层审批纵深 | Codex | `safety.rs`, `execpolicy` |
| MCP 工具桥 | Codex / DSH | `mcp_resource`, `hooks-codex` |
| token 分列统计 | Pi | `UsageRecord`（cached/uncached 分列） |

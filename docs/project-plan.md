# EasyCode CLI — Coding Agent 项目方案

> 目标：独立开发一个类 Claude Code 风格的 CLI Coding Agent，覆盖岗位要求的全部核心技术点，用以证明对 Agent 系统架构的深度理解与实际工程能力。

---

## 📖 给大模型的阅读指引

**本文档是主执行方案**，每个里程碑的关键设计决策均标注了 `→ 参考` 指向调研资料。

调研资料位于 `docs/research/`（本地，不进 git），共 10 个专题 MD 文件，索引见 `[docs/research/README.md](./research/README.md)`。

**执行任务前的推荐阅读顺序**：

1. 先读本文档对应里程碑的完整描述（包括验收标准）
2. 再读该里程碑标注的 `→ 参考` 文件，了解三家开源项目的实现对比
3. 按本文档的设计决策（第六章）编写代码，优先采纳推荐方案

**项目根目录**：`D:\projects\Easycode`
**代码仓库**：`https://github.com/Curry-RJJ/Easycode`

---

## 一、背景与动机

本项目源于对以下三个主流开源 Coding Agent 的深度调研：


| 项目               | 语言         | 架构特色                         |
| ---------------- | ---------- | ---------------------------- |
| **Pi**           | TypeScript | 库式 Agent 类，事件钩子扩展，JSONL 事实源  |
| **OpenAI Codex** | Rust       | 大核多壳，四层安全纵深，Responses API 绑定 |
| **DSH**          | TypeScript | 全插件微内核（Cordis），事件溯源，能力缝设计    |


EasyCode 不重复造轮子，而是吸收三家的设计精华：

- **来自 Pi**：简洁的 Agent 类 + runLoop 双层循环 + JSONL 会话存储
- **来自 Codex**：多层安全审批纵深 + token 预算管理 + apply_patch 式改代码
- **来自 DSH**：事件溯源崩溃恢复 + 读写并发调度 + MCP 协议接入

---



## 二、岗位要求覆盖矩阵


| 岗位要求                | EasyCode 对应实现          | 所在 Phase |
| ------------------- | ---------------------- | -------- |
| 多轮工具调用编排            | Agent runLoop 双层循环     | Phase 1  |
| 只读并行、写入串行           | ToolExecutionScheduler | Phase 2  |
| 可中断、可恢复执行           | Checkpoint + JSONL 重放  | Phase 2  |
| Context Engineering | 上下文压缩 + token 窗口监控     | Phase 2  |
| Checkpoint 机制       | 事件溯源 + 崩溃尾巴合成闭合        | Phase 2  |
| MCP 协议              | MCP Client，动态工具注册      | Phase 3  |
| 系统可观测性              | 结构化日志 + token 统计面板     | Phase 3  |
| 效果评估                | Session Replay + 执行摘要  | Phase 4  |


---



## 三、技术栈


| 层次     | 选型                                        | 理由                      |
| ------ | ----------------------------------------- | ----------------------- |
| 语言     | TypeScript                                | 岗位要求，类型安全，生态丰富          |
| 运行时    | Node.js 20+                               | 原生支持 ESM、fetch、readline |
| CLI 渲染 | Ink（React for CLI）                        | 流式输出、加载动画、交互式审批         |
| 命令行解析  | Commander.js                              | 成熟，支持子命令                |
| 会话存储   | JSONL 文件 + SQLite 索引                      | 可读性强，易 debug，支持快速查询     |
| LLM 接入 | 抽象 streamFn（兼容 OpenAI/Anthropic/Deepseek） | 可热插拔，不绑定单一厂商            |
| 测试     | Vitest                                    | 快速，支持 ESM               |
| 构建     | tsup                                      | 零配置打包                   |


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
│   │   ├── src/
│   │   │   ├── types.ts            # 核心类型（Message、ToolDefinition、StreamDelta、StreamFn）
│   │   │   ├── config.ts           # 配置管理器（读写 ~/.easycode/config.json）
│   │   │   ├── factory.ts          # Provider 工厂（createStreamFn("deepseek/deepseek-chat")）
│   │   │   ├── providers/
│   │   │   │   ├── openai.ts       # OpenAI Provider（流式）
│   │   │   │   ├── anthropic.ts    # Anthropic Provider（流式）
│   │   │   │   └── deepseek.ts     # Deepseek Provider（OpenAI 兼容，复用 openai SDK）
│   │   │   └── index.ts            # 公开导出
│   │   └── package.json
│   ├── mcp/
│   │   ├── client.ts           # MCP Client
│   │   └── tool-bridge.ts      # MCP 工具 → EasyCode 工具适配
│   └── cli/
│       ├── index.ts            # 入口，Commander.js 命令注册
│       ├── setup/
│       │   ├── wizard.ts       # 首次运行引导（readline 交互，检测→选 Provider→输入 Key→验证→保存）
│       │   └── validator.ts    # API Key 有效性验证（发一次最小请求测试连通性）
│       ├── ui/
│       │   ├── chat.tsx        # Ink 对话界面
│       │   ├── approval.tsx    # 交互式审批 UI
│       │   └── stats.tsx       # token 统计面板
│       └── commands/
│           ├── run.ts          # easycode <prompt>
│           ├── resume.ts       # easycode resume <id>
│           ├── stats.ts        # easycode stats <id>
│           ├── setup.ts        # easycode setup（手动触发引导）
│           └── config.ts       # easycode config（查看/修改配置）
├── docs/
│   └── project-plan.md         # 本文档
├── package.json
├── tsconfig.json
└── README.md
```

---



## 五、详细里程碑

---



### ✅ Milestone 1：MVP — 能跑起来的 Agent Loop（已完成）

**目标**：`easycode "帮我修复 src/auth.ts 的 bug"` 端到端跑通

> 📚 **参考资料**：
>
> - `[docs/research/01-架构对比.md](./research/01-架构对比.md)` — 三家 Agent 整体架构图，重点看图1（Pi 双层循环）和图2（Codex 多壳设计）
> - `[docs/research/06-系统提示词与指令遵循.md](./research/06-系统提示词与指令遵循.md)` — 系统提示词拼装方式，EasyCode 采用 Pi 的"应用层纯函数拼装"思路

**产出物**：

- [x] **M1.1** `packages/ai/` — LLM 提供者抽象 + API Key 管理
  #### 设计要点：打包后用户如何管理自己的 API Key？
  核心思路：API Key 不放在代码里、不放在 `.env`（打包后用户看不到），而是存储在用户主目录的配置文件 `~/.easycode/config.json` 中，与程序本体完全分离。
  **配置文件位置与结构**：
  ```
  Windows: C:\Users\<用户名>\.easycode\config.json
  macOS/Linux: ~/.easycode/config.json
  ```
  ```json
  {
    "version": 1,
    "defaultModel": "deepseek/deepseek-chat",
    "approvalPolicy": "ask",
    "compactionThreshold": 0.8,
    "providers": {
      "openai": {
        "apiKey": "sk-...",
        "baseUrl": "https://api.openai.com/v1"
      },
      "anthropic": {
        "apiKey": "sk-ant-..."
      },
      "deepseek": {
        "apiKey": "sk-...",
        "baseUrl": "https://api.deepseek.com/v1"
      }
    }
  }
  ```
  #### 首次运行引导（Setup Wizard）
  **触发条件**：每次 `easycode <任何命令>` 启动时，先检测是否存在有效 API Key。未配置则自动进入引导，无需用户手动运行 `easycode setup`。
  **CLI 交互流程**：
  ```
  ╔══════════════════════════════════════════╗
  ║   Welcome to EasyCode! 🎉               ║
  ║   需要先配置一个 LLM Provider 才能使用。  ║
  ╚══════════════════════════════════════════╝

  ? 选择 LLM Provider：
    ❯ Deepseek（推荐，价格最低，适合开发调试）
      OpenAI（GPT-4o 系列）
      Anthropic（Claude 系列）

  ? 请输入 Deepseek API Key（输入时不显示）：
    ›  ****************************

  ⠋ 正在验证 API Key...
  ✓ 连接成功！模型：deepseek-chat

  ? 设为默认模型？(Y/n) Y

  ✓ 配置已保存到 ~/.easycode/config.json
  ✓ 现在可以开始使用 EasyCode 了！
  ```
  #### API Key 管理命令
  打包发布后，用户通过 CLI 命令管理自己的配置，不需要触碰任何代码：
  ```bash
  # 查看当前配置（API Key 脱敏显示，只显示前4位和后4位）
  easycode config list

  # 输出示例：
  # Provider     Model                    API Key          状态
  # ─────────────────────────────────────────────────────────
  # deepseek   deepseek-chat (默认)     sk-xx****xxxx    ✓ 已验证
  # openai     -                        未配置            -

  # 添加或更新某个 Provider 的 Key（交互式输入，输入时隐藏）
  easycode config set-key openai
  easycode config set-key deepseek

  # 切换默认模型
  easycode config set-model openai/gpt-4o
  easycode config set-model deepseek/deepseek-chat

  # 修改审批策略
  easycode config set-approval ask|auto|never

  # 删除某 Provider 的 Key
  easycode config remove-key openai

  # 重新运行完整引导向导
  easycode setup
  ```
  #### 技术实现
  - [x] **M1.1.1** `packages/ai/src/types.ts` — 核心类型定义
    ```typescript
    // LLM 消息格式（统一内部表示）
    type Message = { role: 'system'|'user'|'assistant'|'tool'; content: string | ContentBlock[] }

    // 工具定义（供 LLM 调用）
    type ToolDefinition = { name: string; description: string; parameters: JSONSchema; concurrency: 'readonly'|'write'|'exclusive' }

    // 流式输出 Delta（Agent Loop 消费的统一格式）
    type StreamDelta =
      | { type: 'text_delta';       content: string }
      | { type: 'tool_call_start';  callId: string; name: string }
      | { type: 'tool_call_delta';  callId: string; argumentsDelta: string }
      | { type: 'tool_call_end';    callId: string }
      | { type: 'usage';            inputTokens: number; outputTokens: number; cacheReadTokens?: number }
      | { type: 'done';             stopReason: 'end_turn'|'tool_use'|'max_tokens' }
      | { type: 'error';            message: string }

    // 核心抽象：一个返回 AsyncIterable 的函数，Agent Loop 只依赖这个接口
    type StreamFn = (messages: Message[], tools: ToolDefinition[], opts?: StreamOptions) => AsyncIterable<StreamDelta>
    ```
  - [x] **M1.1.2** `packages/ai/src/config.ts` — 配置管理器
    - 读写 `~/.easycode/config.json`（不存在则自动创建目录）
    - `EasycodeConfig.getApiKey(provider)` / `setApiKey(provider, key)` / `removeApiKey(provider)`
    - `EasycodeConfig.getDefaultModel()` / `setDefaultModel(model)`
    - API Key 脱敏工具函数（`sk-ab12****5678`，展示时用）
  - [x] **M1.1.3** `packages/ai/src/providers/` — 三个 Provider 实现
    - **OpenAI**：使用 `openai` npm 包，支持流式 `chat.completions.create({ stream: true })`
    - **Deepseek**：复用 `openai` SDK，仅覆盖 `baseURL: 'https://api.deepseek.com/v1'`（Deepseek 接口完全兼容 OpenAI）
    - **Anthropic**：使用 `@anthropic-ai/sdk`，对接 `messages.stream()`，将 Anthropic 事件格式转换为统一 `StreamDelta`
    - 每个 Provider 将各自的流式格式**归一化**为统一 `StreamDelta`，Agent Loop 无需感知底层差异
  - [x] **M1.1.4** `packages/ai/src/factory.ts` — Provider 工厂
    ```typescript
    // 根据 "provider/model" 字符串创建对应的 StreamFn，Key 自动从 config 读取
    createStreamFn("deepseek/deepseek-chat")  // → DeepseekProvider
    createStreamFn("openai/gpt-4o")           // → OpenAIProvider
    createStreamFn("anthropic/claude-3-5-sonnet-20241022") // → AnthropicProvider
    ```
  - [x] **M1.1.5** `packages/cli/src/setup/wizard.ts` — 首次运行引导
    - 用 Node.js 内置 `readline` 实现交互式问答（无额外依赖）
    - 密码输入模式：输入时隐藏字符（`process.stdout.write('\r\033[K')` + 监听原始按键）
    - 引导结束后调用 `validator.ts` 发一次最小测试请求验证 Key 有效性
  - [x] **M1.1.6** `packages/cli/src/setup/validator.ts` — Key 有效性验证
    - 每个 Provider 各有一个轻量验证请求（OpenAI: `models.list`；Deepseek/Anthropic: 发一条 1 token 的消息）
    - 区分错误类型：`invalid_key`（401）/ `quota_exceeded`（429/402）/ `network_error`（timeout）
    - 给用户清晰的错误提示，不直接抛裸错误

- [x] **M1.2** `packages/core/tools/` — 内置工具集
  > 📚 **参考**：`[docs/research/04-工具调用.md](./research/04-工具调用.md)` — 三家默认工具集对比（Pi 8个/Codex 15个/DSH 全插件），EasyCode 采用 Pi 的"最小工作闭环"：读文件→改文件→跑命令验证
  - `read_file(path)` — 读取文件内容
  - `write_file(path, content)` — 全量写入
  - `edit_file(path, old_str, new_str)` — 搜索替换式编辑（参考 Pi 的 edit 工具）
  - `run_bash(command)` — 执行 shell 命令，返回 stdout/stderr
  - `list_dir(path)` — 列目录
  - `search_files(pattern, path)` — grep 搜索

- [x] **M1.3** `packages/core/agent/` — Agent 类与双层 runLoop
  > 📚 **参考**：`[docs/research/01-架构对比.md](./research/01-架构对比.md)` 图1 Pi 的 `runLoop` 实现，`packages/agent/src/agent-loop.ts`；`[docs/research/06-系统提示词与指令遵循.md](./research/06-系统提示词与指令遵循.md)` Pi 的 `buildSystemPrompt` 函数设计
  ```
  外层循环（follow-up）
  └─ 内层循环（tool 调用）
      ├─ 调用 LLM → 解析 tool_calls
      ├─ 执行工具 → 收集结果
      ├─ 追加结果到消息数组
      └─ 如无 tool_calls，退出内层
  ```

- [x] **M1.4** `packages/cli/` — 基础 CLI
  - `easycode "<prompt>"` 启动单次任务
  - `easycode`（无参数）进入**交互式 REPL 模式**（持续对话，类 Claude Code 体验）
  - 流式打印 LLM 输出
  - 工具执行日志（`[工具] read_file ✓ (12ms)`）
  - 每轮结束展示统计摘要（工具调用次数 / token 数 / 耗时）

- [x] **M1.5** 交互式 REPL 模式（`packages/cli/src/commands/repl.ts`）
  - `easycode` 直接启动，无需每次输入命令
  - `readline` 持续读取用户输入，支持多轮连续对话
  - `Ctrl+C` 中断当前任务，继续等待下一条指令
  - `exit` / `quit` / `q` / `:q` 退出
  - **对话框 UI**：每次输入前后各一条细横线，视觉上框住用户输入区域
    ```
    ──────────────────────────────────────────────────
     > █                   ← 灰色背景高亮，标识当前输入行
    ──────────────────────────────────────────────────
    ```
    - 实现要点：利用 `rl.prompt()` 同步返回的特性，在其之后立即追加下横线 + `readline.moveCursor` / `cursorTo` 回位，绕过 readline 内部 `clearScreenDown` 的干扰
    - 用户输入行通过 ANSI 背景色泄漏（`\x1b[48;5;237m`）实现整行灰色高亮

- [x] **M1.6** 系统代理自动检测（`packages/cli/src/utils/proxy.ts`）
  - 读取环境变量 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`
  - Windows 注册表自动读取系统代理设置
  - 通过 `undici ProxyAgent` 全局生效，所有 `fetch` 请求自动走代理

- [x] **M1.7** `easycode config` 配置管理命令（`packages/cli/src/commands/config.ts`）
  - `config list` — 查看当前配置，API Key 脱敏显示
  - `config set-key <provider>` — 交互式添加/更新 API Key
  - `config set-model <model>` — 切换默认模型
  - `config set-approval <policy>` — 修改审批策略
  - `config remove-key <provider>` — 删除指定 Provider 的 Key

**验收标准**：

> 1. 运行 `easycode "读取 README.md 并统计行数"` → Agent 自动调用 `read_file` + `run_bash` → 输出正确结果 ✅
> 2. 运行 `easycode`（无参数）→ 进入交互模式，显示带上下横线的对话框 UI，可持续多轮对话 ✅
> 3. 运行 `easycode config list` → 脱敏显示当前配置 ✅

**M1 完成状态**：✅ 全部子任务通过，构建产物正常（`npm run build` 通过，`@easycode/cli` 已 npm link 可全局使用）

---



### 🟢 Milestone 2：工程核心 — 体现架构深度的三大特性（已完成）



#### M2.1：事件溯源会话存储（Checkpoint 机制）

**目标**：每次任务全程可追溯，进程崩溃后能断点续传

> 📚 **参考资料**：
>
> - `[docs/research/03-会话管理.md](./research/03-会话管理.md)` — 三家存储格式实物对比（Pi 树状JSONL / Codex 线性JSONL / DSH 事件JSONL），**EasyCode 采用 DSH 的事件 JSONL 格式**（最简洁，每行一个事件，seq 严格递增）
> - `[docs/research/05-重连与容错.md](./research/05-重连与容错.md)` — 崩溃恢复机制对比，**EasyCode 采用 DSH 的"合成闭合事件"策略**（`interruptedTurnClosers` 函数逻辑），优于 Pi 的操作记录恢复和 Codex 的无专门处理

**产出物**：

- [x] **M2.1.1** 定义 `EventRecord` 事件类型体系
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

- [x] **M2.1.2** JSONL 存储层（`packages/core/session/storage.ts`）
  - 追加写入（append-only），不修改历史
  - 每个 session 存为 `~/.easycode/sessions/<id>.jsonl`
  - SQLite 维护 session 索引（id、创建时间、状态）

- [x] **M2.1.3** 崩溃恢复（参考 DSH 的"合成闭合事件"设计）
  ```
  重启后流程：
  1. 读取 JSONL，找出所有 tool/call 中没有对应 tool/result 的 callId
  2. 合成错误闭合事件（文本即恢复指令）：
     "TOOL_OUTCOME_UNKNOWN: 进程意外中断，该工具调用结果未知，
      请重新确认操作是否已完成，再继续执行"
  3. 将合成事件追加到 JSONL
  4. 重放所有事件重建上下文，继续运行
  ```

- [x] **M2.1.4** CLI 命令
  - `easycode resume <session-id>` — 恢复指定会话
  - `easycode list` — 查看历史会话列表（含状态：完成/中断）

**验收标准**：

> 任务执行中用 Ctrl+C 杀进程 → 重启后执行 `easycode resume <id>` → Agent 正确识别到未完成的工具调用，继续完成任务

---



#### M2.2：读写并发调度器（只读并行 / 写入串行）

**目标**：同一个 LLM 响应中多个工具调用，安全并发执行

> 📚 **参考资料**：
>
> - `[docs/research/04-工具调用.md](./research/04-工具调用.md)` — DSH 的"五道瀑布"执行管线（`pre → guard → around → post → result`），工具并发通过 `waterfall` 中间件控制
> - `[docs/research/07-思维链与工作流编排.md](./research/07-思维链与工作流编排.md)` — 只读并行/写入串行的编排逻辑，Codex 的 `ToolOrchestrator` 审批→沙箱→尝试→升级流程可参考

**产出物**：

- [x] **M2.2.1** 工具标注（每个工具声明自己的并发属性）
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

- [x] **M2.2.2** `ToolExecutionScheduler`（`packages/core/tools/scheduler.ts`）
  ```
  调度算法：
  1. 对同一批 tool_calls 按 concurrency 分组
  2. readonly 组 → Promise.all 并发执行
  3. write/exclusive 组 → 串行，逐个等待
  4. 混合时：先跑完所有 readonly，再跑 write，再跑 exclusive
  ```

- [x] **M2.2.3** 执行日志（每次工具执行记录 `{ toolName, concurrencyMode, startTime, duration }`）

**验收标准**：

> 一次响应中包含 `read_file(a.ts)` + `read_file(b.ts)` + `edit_file(c.ts)` → 前两个并发执行，第三个等前两个完成后串行执行，日志可验证

---



#### M2.3：上下文压缩（Context Engineering）

**目标**：token 接近窗口上限时，自动压缩历史消息，保持 Agent 可持续运行

> 📚 **参考资料**：
>
> - `[docs/research/02-上下文管理.md](./research/02-上下文管理.md)` — **重点阅读**，三家上下文管理策略全对比。EasyCode 的压缩策略：保留 system prompt + 最近 N 轮（来自 Pi），压缩时用 LLM 生成摘要替换中间历史；Codex 的六条铁律（单项 <10K token 等）可作为扩展参考
> - `[docs/research/08-性能设计与成本管理.md](./research/08-性能设计与成本管理.md)` — Pi 的 `UsageRecord`（cached/uncached 分列）设计，用于 token 计数统计

**产出物**：

- [x] **M2.3.1** Token 计数（`packages/core/context/token.ts`）
  - 使用 `tiktoken` 或 `js-tiktoken` 本地计算 token 数
  - 实时追踪当前上下文 token 总量
  - 设定压缩阈值（默认：触达模型上下文窗口的 80%）

- [x] **M2.3.2** 压缩策略（`packages/core/context/compaction.ts`）
  ```
  压缩触发后：
  1. 保留：系统提示词（system prompt 不动）
  2. 保留：最近 N 轮完整对话（默认保留最近 3 轮）
  3. 压缩：中间历史消息 → 用 LLM 生成摘要（一段话总结完成了什么）
  4. 替换：中间消息改为 "【历史摘要】xxx"
  5. 记录：写入 compaction 事件到 JSONL
  ```

- [x] **M2.3.3** CLI 进度条显示当前 token 使用量（`[context: 45k/128k]`）

**验收标准**：

> 执行一个涉及大量文件读取的长任务 → Agent 在 token 接近上限时自动触发压缩 → 压缩后任务继续完成，不因上下文溢出中断

**M2 完成状态**：✅ 全部子任务通过，构建产物正常（`npm run build` 通过）

---



### 🟢 Milestone 3：差异化亮点 — 安全 + MCP + 可观测性（已完成）



#### M3.1：多层安全审批

**目标**：参考 Codex 四层纵深，实现两层防线

> 📚 **参考资料**：
>
> - `[docs/research/10-安全与权限控制.md](./research/10-安全与权限控制.md)` — **重点阅读**，三家完整安全链路对比。EasyCode 实现 Codex 四层中的 L1（审批策略）+ L2（execpolicy 危险命令匹配），DSH 的"fail-closed + 提权引导"策略也值得参考
> - 危险命令模式库参考：Pi 的 `NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN` 模式库设计思路（`docs/research/05-重连与容错.md`）

**产出物**：

- [x] **M3.1.1** 危险命令模式匹配（L1 防线）
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

- [x] **M3.1.2** 审批决策层（L2 防线）
  ```
  审批策略三态（持久化到 session 事件）：
  - auto   → 所有工具自动放行（危险命令仍被 L1 拦截）
  - ask    → 危险命令弹出交互式确认（默认）
  - never  → 所有写操作拒绝（纯只读模式，适合代码审查场景）
  ```

- [x] **M3.1.3** 交互式审批 UI（@inquirer/prompts select）
  ```
  ⚠️  Agent 请求执行以下命令：

    bash: rm -rf ./dist

  [ Allow Once ]  [ Allow All ]  [ Deny ]  [ Deny & Abort ]
  ```

- [x] **M3.1.4** 审批记录入 JSONL（可审计）
  ```json
  { "type": "approval", "data": { "callId": "call_3", "command": "rm -rf ./dist",
    "policy": "ask", "decision": "allow_once", "timestamp": 1704067200 } }
  ```

**验收标准**：

> 执行 `easycode "清理项目构建产物"` → Agent 试图执行 `rm -rf ./dist` → 弹出审批确认框 → 用户选择 Allow → 执行成功并记录到日志

---



#### M3.2：MCP 协议支持

**目标**：支持接入外部 MCP Server 提供的工具，实现工具动态扩展

> 📚 **参考资料**：
>
> - `[docs/research/09-可扩展性.md](./research/09-可扩展性.md)` — Codex 的 `mcp_resource`（read/list）和 plugin 包设计，DSH 的 `hooks-codex` 工具桥模式；**EasyCode MCP Client 参考 Codex 的 MCP 接入方式**（`@modelcontextprotocol/sdk` 标准 SDK）

**产出物**：

- [x] **M3.2.1** MCP Client（`packages/mcp/client.ts`）
  - 连接 MCP Server（支持 stdio、HTTP/SSE 两种传输方式）
  - 调用 `tools/list` 获取工具列表
  - 调用 `tools/call` 执行工具

- [x] **M3.2.2** MCP 工具适配器（`packages/mcp/tool-bridge.ts`）
  - 将 MCP 工具 Schema 转为 EasyCode `ToolDefinition`
  - 自动注入 MCP 工具到工具注册表

- [x] **M3.2.3** CLI 参数支持
  ```bash
  easycode --mcp stdio:"node mcp-server.js" "帮我查询数据库"
  easycode --mcp http://localhost:3000 "执行任务"
  ```

**验收标准**：

> 启动一个第三方 MCP Server（如 `@modelcontextprotocol/server-filesystem`） → EasyCode 自动发现并使用其提供的工具完成任务

---



#### M3.3：可观测性 — 结构化日志与统计面板

> 📚 **参考资料**：
>
> - `[docs/research/08-性能设计与成本管理.md](./research/08-性能设计与成本管理.md)` — **重点阅读**，Pi 的 `UsageRecord + SessionStats` 累计设计（cached/uncached 分列）是 EasyCode token 统计的直接参考；Codex 的 `TokenBudgetConfig` 可作为预算控制扩展参考

**产出物**：

- [x] **M3.3.1** Session 统计（`packages/cli/commands/stats.ts`）
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

- [x] **M3.3.2** 结构化日志输出模式
  ```bash
  easycode --log-format json "任务" > task.log
  # 每行输出一个 JSON 事件，供外部工具消费
  ```

- [x] **M3.3.3** 实时进度展示（每轮结束显示当前 context token 用量）
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

> 📚 **参考资料**：
>
> - `[docs/research/07-思维链与工作流编排.md](./research/07-思维链与工作流编排.md)` — Codex 的 `plan mode`（`handle_plan_segments` 禁 Write 段）和 `update_plan` 工具设计，DSH 的 `plan-mode` 插件；**EasyCode 参考 Codex 的两阶段设计**（规划阶段只读 → 用户确认 → 执行阶段解锁写操作）

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

> 📚 **参考资料**：
>
> - `[docs/research/05-重连与容错.md](./research/05-重连与容错.md)` — DSH 的事件重放机制（`interruptedTurnClosers` + 事件顺序还原），**EasyCode Replay 直接复用 M2.1 的 JSONL 重放逻辑**，按 `seq` 顺序还原每个事件
> - `[docs/research/03-会话管理.md](./research/03-会话管理.md)` — 三家会话文件的 diff 对比，了解 git 信息与会话如何关联（Codex 的 SQLite 镜像设计）

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


| EasyCode 特性  | 参考来源        | 核心文件路径                             |
| ------------ | ----------- | ---------------------------------- |
| runLoop 双层循环 | Pi          | `packages/agent/src/agent-loop.ts` |
| JSONL 事实源    | Pi / DSH    | `harness/session/types.ts`         |
| 合成闭合事件       | DSH         | `interruptedTurnClosers()`         |
| 读写并发调度       | DSH         | `tools/execute` 五道瀑布               |
| 上下文压缩阈值      | Pi          | `compaction.ts`                    |
| 危险命令模式匹配     | Pi          | `ai/src/utils/retry.ts` 模式库设计借鉴    |
| 四层审批纵深       | Codex       | `safety.rs`, `execpolicy`          |
| MCP 工具桥      | Codex / DSH | `mcp_resource`, `hooks-codex`      |
| token 分列统计   | Pi          | `UsageRecord`（cached/uncached 分列）  |


---



## 九、参考资料完整索引

> 所有调研文件存放于 `docs/research/`（本地，不进 git）。
> 索引文件：`[docs/research/README.md](./research/README.md)`


| 文件路径                                                            | 主题                                  | 对应里程碑       |
| --------------------------------------------------------------- | ----------------------------------- | ----------- |
| `[docs/research/01-架构对比.md](./research/01-架构对比.md)`             | Pi / Codex / DSH 整体架构图（ASCII 绘制）    | M1.3        |
| `[docs/research/02-上下文管理.md](./research/02-上下文管理.md)`           | 三家 Context 结构实物对比（代码级）              | M1.1 / M2.3 |
| `[docs/research/03-会话管理.md](./research/03-会话管理.md)`             | 三家 Session JSONL 存储格式逐行解读           | M2.1        |
| `[docs/research/04-工具调用.md](./research/04-工具调用.md)`             | 工具定义→调用消息→执行管线→结果消息全流程              | M1.2 / M2.2 |
| `[docs/research/05-重连与容错.md](./research/05-重连与容错.md)`           | 崩溃恢复机制 + 请求重试策略                     | M2.1 / M4.2 |
| `[docs/research/06-系统提示词与指令遵循.md](./research/06-系统提示词与指令遵循.md)` | 系统提示词拼装方式、AGENTS.md 注入              | M1.3        |
| `[docs/research/07-思维链与工作流编排.md](./research/07-思维链与工作流编排.md)`   | CoT 深度控制、Plan 模式、子代理树               | M2.2 / M4.1 |
| `[docs/research/08-性能设计与成本管理.md](./research/08-性能设计与成本管理.md)`   | Token 统计累计、KV Cache、成本计算            | M2.3 / M3.3 |
| `[docs/research/09-可扩展性.md](./research/09-可扩展性.md)`             | Extension 工厂 / hooks JSON / MCP 工具桥 | M3.2        |
| `[docs/research/10-安全与权限控制.md](./research/10-安全与权限控制.md)`       | 审批策略、沙箱矩阵、Guardian LLM              | M3.1        |



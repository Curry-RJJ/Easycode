# EasyCode CLI

> 一个类 Claude Code 风格的命令行 Coding Agent，基于 LLM 驱动，支持多轮工具调用、断点续传、安全审批与 MCP 扩展。

[![Node.js](https://img.shields.io/badge/Node.js-20+-green)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4+-blue)](https://typescriptlang.org)
[![Docker](https://img.shields.io/badge/Docker-支持-2496ED)](https://docker.com)
[![License](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)

---

## 特性

- 🔄 **多轮工具调用** — Agent Loop 双层循环，自动完成读文件→改代码→跑测试的完整闭环
- 💾 **断点续传** — 基于 JSONL 事件溯源，进程崩溃后一键恢复，上下文零失真
- ⚡ **读写并发调度** — 读操作并发执行，写操作串行加锁，最大化执行效率
- 🧠 **上下文压缩** — token 接近窗口上限时自动摘要压缩，可持续运行超长任务
- 🔒 **多层安全审批** — 危险命令自动识别 + 交互式审批 UI + 操作日志可审计
- 🔌 **MCP 协议支持** — 动态接入外部 MCP Server，无限扩展工具能力
- 📊 **可观测性** — 实时 token 用量、工具执行统计、结构化日志输出

---

## 快速开始

### 方式一：Docker（推荐）

```bash
# 1. 克隆项目
git clone https://github.com/Curry-RJJ/Easycode.git
cd Easycode

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env，填入你的 API Key

# 3. 启动开发环境
docker compose up dev

# 4. 在容器中运行
docker compose exec dev node /app/packages/cli/dist/index.js "帮我修复 src/auth.ts 的登录 bug"
```

### 方式二：本地运行

```bash
# 环境要求：Node.js >= 20

git clone https://github.com/Curry-RJJ/Easycode.git
cd Easycode

npm install
npm run build

cp .env.example .env   # 填入 API Key

npm link packages/cli
easycode "帮我修复 src/auth.ts 的登录 bug"
```

---

## 使用方式

```bash
# 基本用法
easycode "<任务描述>"

# 断点续传
easycode list                    # 查看历史会话
easycode resume <session-id>     # 恢复中断的会话

# 查看统计
easycode stats <session-id>      # token 用量 + 工具执行统计

# 指定模型
easycode --model openai/gpt-4o "任务"
easycode --model deepseek/deepseek-chat "任务"

# 安全审批策略
easycode --approval ask "任务"   # 危险命令弹窗确认（默认）
easycode --approval auto "任务"  # 全部自动放行
easycode --approval never "任务" # 只读模式（不执行写操作）

# Plan 模式（先规划后执行）
easycode --plan "重构 src/auth 模块"

# 接入 MCP Server
easycode --mcp stdio:"node mcp-server.js" "任务"
easycode --mcp http://localhost:3000 "任务"

# 结构化日志
easycode --log-format json "任务" > task.log
```

---

## Docker 开发工作流

```bash
# 启动开发容器（热重载）
docker compose up dev

# 进入容器 shell
docker compose exec dev bash

# 运行测试
docker compose --profile test up test

# 构建生产镜像
docker compose --profile prod up app

# 查看容器日志
docker compose logs -f dev
```

---

## 项目结构

```
easycode/
├── packages/
│   ├── core/       # Agent 核心（循环、工具调度、会话、安全）
│   ├── ai/         # LLM 提供者抽象（OpenAI/Anthropic/Deepseek）
│   ├── mcp/        # MCP 协议客户端
│   └── cli/        # 命令行界面（Commander.js + Ink）
├── docs/
│   └── project-plan.md   # 详细项目方案与里程碑
├── demo/                 # 演示项目（用于测试）
├── Dockerfile            # 生产镜像
├── Dockerfile.dev        # 开发镜像
├── docker-compose.yml    # 编排配置
└── .env.example          # 环境变量模板
```

---

## 设计灵感

本项目的架构设计基于对以下三个开源 Coding Agent 的深度调研：

| 项目 | 借鉴点 |
|------|-------|
| [Pi Agent](https://github.com/anthropics/pi) | Agent 双层 runLoop、JSONL 事件溯源、Extension 机制 |
| [OpenAI Codex](https://github.com/openai/codex) | 四层安全纵深、token 预算管理、apply_patch 编辑模式 |
| [DSH](https://github.com/deepseek-ai/dsh) | 崩溃尾巴合成闭合、读写并发调度、MCP 工具桥 |

详细方案见 [docs/project-plan.md](docs/project-plan.md)

---

## License

MIT

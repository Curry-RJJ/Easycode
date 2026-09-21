/**
 * 工具注册表
 *
 * 管理所有可用工具，供 Agent Loop 使用。
 */

import type { ToolDefinition } from '@easycode/ai';

export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  registerAll(tools: ToolDefinition[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  clear(): void {
    this.tools.clear();
  }

  /** 返回供 LLM 使用的工具定义列表（不含 execute 函数） */
  toLLMTools(): Omit<ToolDefinition, 'execute' | 'concurrency'>[] {
    return this.getAll().map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    }));
  }
}

/** 创建预置了所有内置工具的注册表 */
export function createDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  // 延迟导入，避免循环依赖
  Promise.resolve().then(async () => {
    const { readFileTool } = await import('./handlers/read.js');
    const { writeFileTool } = await import('./handlers/write.js');
    const { editFileTool } = await import('./handlers/edit.js');
    const { runBashTool } = await import('./handlers/bash.js');
    const { listDirTool } = await import('./handlers/ls.js');
    const { searchFilesTool } = await import('./handlers/grep.js');

    registry.registerAll([
      readFileTool,
      writeFileTool,
      editFileTool,
      runBashTool,
      listDirTool,
      searchFilesTool,
    ]);
  });

  return registry;
}

/** 同步创建（所有 handler 直接 import） */
export async function createDefaultRegistryAsync(): Promise<ToolRegistry> {
  const registry = new ToolRegistry();

  const { readFileTool } = await import('./handlers/read.js');
  const { writeFileTool } = await import('./handlers/write.js');
  const { editFileTool } = await import('./handlers/edit.js');
  const { runBashTool } = await import('./handlers/bash.js');
  const { listDirTool } = await import('./handlers/ls.js');
  const { searchFilesTool } = await import('./handlers/grep.js');

  registry.registerAll([
    readFileTool,
    writeFileTool,
    editFileTool,
    runBashTool,
    listDirTool,
    searchFilesTool,
  ]);

  return registry;
}

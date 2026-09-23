/**
 * 项目上下文记忆加载器
 *
 * 在 Agent 启动时自动查找并读取项目上下文文件（CLAUDE.md / AGENTS.md）。
 * 向上遍历目录树（从启动目录到 home 目录）：
 *   - 子目录的文件优先级高于父目录（局部覆盖全局）
 *   - 内容超过 10000 chars 时截断，防止污染上下文
 *
 * 设计参考：
 *   D:\projects\claude-code\src\utils\attachments.ts — loadNestedMemoryFiles
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

// 按优先级顺序查找的文件名
const MEMORY_FILENAMES = ['CLAUDE.md', 'AGENTS.md', '.easycode/context.md'] as const;

// 单个文件最大读取长度
const MAX_FILE_CHARS = 10_000;

/**
 * 从指定目录向上遍历，收集所有 CLAUDE.md / AGENTS.md 内容。
 *
 * @param startDir  起始目录（通常是 getCwd()）
 * @returns         合并后的项目上下文字符串，若无则返回空字符串
 */
export function loadProjectMemory(startDir: string): string {
  const memories: string[] = [];
  const home = os.homedir();
  let dir = path.resolve(startDir);

  // 向上遍历，直到 home 目录或文件系统根
  while (dir !== home && dir !== path.dirname(dir)) {
    for (const filename of MEMORY_FILENAMES) {
      const filePath = path.join(dir, filename);
      if (fs.existsSync(filePath)) {
        try {
          const raw = fs.readFileSync(filePath, 'utf-8');
          const content = raw.length > MAX_FILE_CHARS
            ? raw.slice(0, MAX_FILE_CHARS) + '\n...[truncated]'
            : raw;

          const label = dir === startDir
            ? filename
            : `${filename} (${path.relative(startDir, dir) || dir})`;

          // push：从 child → parent 遍历，child 先 push，parent 后 push
          // 最终 join 时 child 在前（优先级高）
          memories.push(`[Project context from ${label}]\n${content}`);
        } catch {
          // 读取失败静默忽略
        }
      }
    }
    dir = path.dirname(dir);
  }

  return memories.join('\n\n---\n\n');
}

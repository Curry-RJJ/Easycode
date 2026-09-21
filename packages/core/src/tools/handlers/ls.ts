/**
 * list_dir 工具
 *
 * 列出目录内容，支持递归和过滤。
 */

import fs from 'fs';
import path from 'path';
import type { ToolDefinition, ToolResult } from '@easycode/ai';

const IGNORE_PATTERNS = [
  'node_modules',
  '.git',
  '.DS_Store',
  'dist',
  '.next',
  '.nuxt',
  '__pycache__',
  '.pytest_cache',
  '*.pyc',
];

function shouldIgnore(name: string): boolean {
  return IGNORE_PATTERNS.some((p) => {
    if (p.startsWith('*')) {
      return name.endsWith(p.slice(1));
    }
    return name === p;
  });
}

function listRecursive(
  dirPath: string,
  prefix: string,
  maxDepth: number,
  currentDepth: number
): string[] {
  if (currentDepth > maxDepth) return ['  ...（超出最大深度）'];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [`  [无法读取目录]`];
  }

  const lines: string[] = [];
  const filtered = entries.filter((e) => !shouldIgnore(e.name)).sort((a, b) => {
    // 目录排前面
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  filtered.forEach((entry, idx) => {
    const isLast = idx === filtered.length - 1;
    const connector = isLast ? '└── ' : '├── ';
    const childPrefix = isLast ? '    ' : '│   ';

    if (entry.isDirectory()) {
      lines.push(`${prefix}${connector}${entry.name}/`);
      if (currentDepth < maxDepth) {
        const children = listRecursive(
          path.join(dirPath, entry.name),
          prefix + childPrefix,
          maxDepth,
          currentDepth + 1
        );
        lines.push(...children);
      }
    } else {
      // 显示文件大小
      try {
        const stat = fs.statSync(path.join(dirPath, entry.name));
        const size = formatSize(stat.size);
        lines.push(`${prefix}${connector}${entry.name}  \x1b[90m(${size})\x1b[0m`);
      } catch {
        lines.push(`${prefix}${connector}${entry.name}`);
      }
    }
  });

  return lines;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export const listDirTool: ToolDefinition = {
  name: 'list_dir',
  description:
    '列出目录内容，以树形结构显示。自动忽略 node_modules、.git、dist 等目录。',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '要列出的目录路径（默认为当前工作目录）',
      },
      max_depth: {
        type: 'integer',
        description: '最大递归深度（默认为 2，最大 5）',
      },
    },
    required: [],
  },
  concurrency: 'readonly',

  async execute(input): Promise<ToolResult> {
    const dirPath = (input.path as string | undefined) ?? process.cwd();
    const maxDepth = Math.min((input.max_depth as number | undefined) ?? 2, 5);

    try {
      const absPath = path.resolve(dirPath);

      if (!fs.existsSync(absPath)) {
        return { content: `错误：目录不存在：${dirPath}`, isError: true };
      }

      if (!fs.statSync(absPath).isDirectory()) {
        return { content: `错误：路径不是目录：${dirPath}`, isError: true };
      }

      const lines = listRecursive(absPath, '', maxDepth, 1);
      const header = `${absPath}/`;

      return {
        content: [header, ...lines].join('\n'),
      };
    } catch (err) {
      return {
        content: `列目录失败：${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
};

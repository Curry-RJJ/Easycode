/**
 * search_files 工具
 *
 * 在目录中搜索匹配 pattern 的文件内容（类 grep 功能）。
 */

import fs from 'fs';
import path from 'path';
import type { ToolDefinition, ToolResult } from '@easycode/ai';

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', '.next', '__pycache__']);
const MAX_RESULTS = 100;
const MAX_LINE_LENGTH = 200;

interface MatchLine {
  file: string;
  lineNum: number;
  line: string;
}

function searchInFile(filePath: string, pattern: RegExp): MatchLine[] {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const matches: MatchLine[] = [];

    for (let i = 0; i < lines.length; i++) {
      if (pattern.test(lines[i])) {
        let line = lines[i];
        if (line.length > MAX_LINE_LENGTH) {
          line = line.slice(0, MAX_LINE_LENGTH) + '...';
        }
        matches.push({ file: filePath, lineNum: i + 1, line: line.trim() });
      }
    }

    return matches;
  } catch {
    return [];
  }
}

function walkDir(
  dirPath: string,
  pattern: RegExp,
  filePattern: RegExp | null,
  results: MatchLine[]
): void {
  if (results.length >= MAX_RESULTS) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (results.length >= MAX_RESULTS) break;

    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name)) {
        walkDir(fullPath, pattern, filePattern, results);
      }
    } else if (entry.isFile()) {
      if (!filePattern || filePattern.test(entry.name)) {
        // 跳过二进制文件（简单判断：扩展名）
        const ext = path.extname(entry.name).toLowerCase();
        const binaryExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.woff', '.ttf', '.eot', '.pdf', '.zip', '.tar', '.gz', '.exe', '.dll', '.so']);
        if (!binaryExts.has(ext)) {
          results.push(...searchInFile(fullPath, pattern));
        }
      }
    }
  }
}

export const searchFilesTool: ToolDefinition = {
  name: 'search_files',
  description:
    '在目录中搜索包含指定 pattern 的文件内容（类 grep 功能）。\n' +
    '- pattern 支持正则表达式。\n' +
    '- 可通过 file_pattern 过滤文件类型（如 "\\.ts$" 只搜索 TypeScript 文件）。\n' +
    '- 自动忽略 node_modules、dist 等目录。\n' +
    '- 最多返回 100 个匹配结果。',
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: '搜索模式（支持正则表达式）',
      },
      path: {
        type: 'string',
        description: '搜索目录（默认为当前工作目录）',
      },
      file_pattern: {
        type: 'string',
        description: '文件名过滤正则（可选，例如 "\\.ts$" 只搜索 .ts 文件）',
      },
      case_sensitive: {
        type: 'boolean',
        description: '是否区分大小写（默认 false，不区分）',
      },
    },
    required: ['pattern'],
  },
  concurrency: 'readonly',

  async execute(input): Promise<ToolResult> {
    const patternStr = input.pattern as string;
    const searchPath = (input.path as string | undefined) ?? process.cwd();
    const filePatternStr = input.file_pattern as string | undefined;
    const caseSensitive = (input.case_sensitive as boolean | undefined) ?? false;

    try {
      const absPath = path.resolve(searchPath);

      if (!fs.existsSync(absPath)) {
        return { content: `错误：目录不存在：${searchPath}`, isError: true };
      }

      const flags = caseSensitive ? 'g' : 'gi';
      let pattern: RegExp;
      let filePattern: RegExp | null = null;

      try {
        pattern = new RegExp(patternStr, flags);
      } catch {
        return { content: `无效的正则表达式：${patternStr}`, isError: true };
      }

      if (filePatternStr) {
        try {
          filePattern = new RegExp(filePatternStr, 'i');
        } catch {
          return { content: `无效的文件名正则：${filePatternStr}`, isError: true };
        }
      }

      const results: MatchLine[] = [];

      if (fs.statSync(absPath).isFile()) {
        results.push(...searchInFile(absPath, pattern));
      } else {
        walkDir(absPath, pattern, filePattern, results);
      }

      if (results.length === 0) {
        return { content: `未找到匹配 "${patternStr}" 的内容。` };
      }

      // 按文件分组输出
      const byFile = new Map<string, MatchLine[]>();
      for (const r of results) {
        const relPath = path.relative(absPath, r.file);
        if (!byFile.has(relPath)) byFile.set(relPath, []);
        byFile.get(relPath)!.push(r);
      }

      const lines: string[] = [`共找到 ${results.length} 个匹配${results.length >= MAX_RESULTS ? '（已达上限）' : ''}：\n`];

      for (const [file, matches] of byFile) {
        lines.push(`📄 ${file}`);
        for (const m of matches) {
          lines.push(`  ${String(m.lineNum).padStart(4)}│ ${m.line}`);
        }
        lines.push('');
      }

      return { content: lines.join('\n') };
    } catch (err) {
      return {
        content: `搜索失败：${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
};

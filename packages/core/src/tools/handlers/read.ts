/**
 * read_file 工具
 *
 * 读取文件内容，支持指定行范围。
 */

import fs from 'fs';
import path from 'path';
import type { ToolDefinition, ToolResult } from '@easycode/ai';

export const readFileTool: ToolDefinition = {
  name: 'read_file',
  description:
    '读取文件内容。支持指定起始行和结束行（1-indexed）来只读取部分内容，对大文件非常有用。',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '要读取的文件路径（相对路径或绝对路径）',
      },
      start_line: {
        type: 'integer',
        description: '起始行号（1-indexed，可选，默认从第1行开始）',
      },
      end_line: {
        type: 'integer',
        description: '结束行号（1-indexed，可选，默认读到文件末尾）',
      },
    },
    required: ['path'],
  },
  concurrency: 'readonly',

  async execute(input): Promise<ToolResult> {
    const filePath = input.path as string;
    const startLine = (input.start_line as number | undefined) ?? 1;
    const endLine = input.end_line as number | undefined;

    try {
      const absPath = path.resolve(filePath);

      if (!fs.existsSync(absPath)) {
        return { content: `错误：文件不存在：${filePath}`, isError: true };
      }

      const stat = fs.statSync(absPath);
      if (stat.isDirectory()) {
        return { content: `错误：路径是一个目录，请使用 list_dir 工具：${filePath}`, isError: true };
      }

      const raw = fs.readFileSync(absPath, 'utf-8');
      const lines = raw.split('\n');
      const totalLines = lines.length;

      const from = Math.max(1, startLine) - 1; // 转为 0-indexed
      const to = endLine !== undefined ? Math.min(endLine, totalLines) : totalLines;

      const selected = lines.slice(from, to);
      const content = selected.join('\n');

      const header =
        startLine !== 1 || endLine !== undefined
          ? `[文件：${filePath}，第 ${from + 1}–${to} 行，共 ${totalLines} 行]\n\n`
          : `[文件：${filePath}，共 ${totalLines} 行]\n\n`;

      return { content: header + content };
    } catch (err) {
      return {
        content: `读取文件失败：${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
};

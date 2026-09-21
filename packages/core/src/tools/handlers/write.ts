/**
 * write_file 工具
 *
 * 全量写入文件内容（会创建父目录）。
 */

import fs from 'fs';
import path from 'path';
import type { ToolDefinition, ToolResult } from '@easycode/ai';

export const writeFileTool: ToolDefinition = {
  name: 'write_file',
  description:
    '将内容全量写入文件。如果文件已存在，会完全覆盖。如果父目录不存在，会自动创建。' +
    '适合创建新文件或完全替换文件内容。如果只需要修改部分内容，请使用 edit_file 工具。',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '要写入的文件路径（相对路径或绝对路径）',
      },
      content: {
        type: 'string',
        description: '要写入的文件内容',
      },
    },
    required: ['path', 'content'],
  },
  concurrency: 'write',

  async execute(input): Promise<ToolResult> {
    const filePath = input.path as string;
    const content = input.content as string;

    try {
      const absPath = path.resolve(filePath);
      const dir = path.dirname(absPath);

      // 自动创建父目录
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const isNew = !fs.existsSync(absPath);
      fs.writeFileSync(absPath, content, 'utf-8');

      const lines = content.split('\n').length;
      const action = isNew ? '创建' : '覆盖写入';

      return {
        content: `✓ ${action}文件成功：${filePath}（${lines} 行，${Buffer.byteLength(content)} 字节）`,
      };
    } catch (err) {
      return {
        content: `写入文件失败：${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
};

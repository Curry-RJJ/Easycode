/**
 * edit_file 工具
 *
 * 搜索替换式编辑（参考 Pi 的 edit 工具设计）。
 * 用 old_str 精确定位，替换为 new_str，要求 old_str 在文件中唯一存在。
 */

import fs from 'fs';
import path from 'path';
import type { ToolDefinition, ToolResult } from '@easycode/ai';

export const editFileTool: ToolDefinition = {
  name: 'edit_file',
  description:
    '通过搜索替换精确编辑文件的某一段内容。\n' +
    '- old_str 必须在文件中唯一存在（否则操作会被拒绝，以避免误改）。\n' +
    '- old_str 应包含足够的上下文（至少3行），确保位置唯一。\n' +
    '- 如果需要创建新文件或完全重写，请使用 write_file 工具。',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '要编辑的文件路径',
      },
      old_str: {
        type: 'string',
        description: '要被替换的原始内容（必须在文件中唯一存在）',
      },
      new_str: {
        type: 'string',
        description: '替换后的新内容（可以为空字符串，表示删除 old_str）',
      },
    },
    required: ['path', 'old_str', 'new_str'],
  },
  concurrency: 'write',

  async execute(input): Promise<ToolResult> {
    const filePath = input.path as string;
    const oldStr = input.old_str as string;
    const newStr = input.new_str as string;

    try {
      const absPath = path.resolve(filePath);

      if (!fs.existsSync(absPath)) {
        return { content: `错误：文件不存在：${filePath}`, isError: true };
      }

      const original = fs.readFileSync(absPath, 'utf-8');

      // 检查 old_str 是否存在
      const firstIdx = original.indexOf(oldStr);
      if (firstIdx === -1) {
        return {
          content:
            `错误：在文件 ${filePath} 中找不到指定的 old_str。\n` +
            `请确认内容完全匹配（包括空格和换行）。`,
          isError: true,
        };
      }

      // 检查唯一性
      const secondIdx = original.indexOf(oldStr, firstIdx + 1);
      if (secondIdx !== -1) {
        const lineNum = original.slice(0, firstIdx).split('\n').length;
        return {
          content:
            `错误：old_str 在文件 ${filePath} 中出现了多次（首次在第 ${lineNum} 行附近）。\n` +
            `请提供更多上下文使其唯一，以避免歧义。`,
          isError: true,
        };
      }

      // 执行替换
      const updated = original.slice(0, firstIdx) + newStr + original.slice(firstIdx + oldStr.length);
      fs.writeFileSync(absPath, updated, 'utf-8');

      const oldLines = oldStr.split('\n').length;
      const newLines = newStr.split('\n').length;
      const lineNum = original.slice(0, firstIdx).split('\n').length;

      return {
        content:
          `✓ 编辑成功：${filePath}\n` +
          `  位置：第 ${lineNum} 行附近\n` +
          `  变化：${oldLines} 行 → ${newLines} 行`,
      };
    } catch (err) {
      return {
        content: `编辑文件失败：${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
};

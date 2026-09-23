/**
 * MCP 工具适配器 — 将 MCP 工具 Schema 转为 EasyCode ToolDefinition
 *
 * 参考 DSH 的 hooks-codex 工具桥模式：
 *   MCP Tool → EasyCode ToolDefinition → ToolRegistry
 *
 * MCP 工具的 concurrency 默认标注为 'exclusive'（副作用不可预知）。
 */

import type { ToolDefinition, JSONSchema } from '@easycode/ai';
import type { EasycodeMcpClient, McpToolInfo } from './client.js';

/**
 * 将单个 MCP 工具转为 EasyCode ToolDefinition。
 * execute 函数通过 MCP Client 的 callTool 执行远程工具。
 */
export function bridgeMcpTool(
  toolInfo: McpToolInfo,
  client: EasycodeMcpClient,
  serverLabel: string
): ToolDefinition {
  return {
    name: toolInfo.name,
    description: [
      toolInfo.description ?? `MCP 工具：${toolInfo.name}`,
      `（来源：${serverLabel}）`,
    ].join(' '),
    parameters: (toolInfo.inputSchema as JSONSchema) ?? {
      type: 'object',
      properties: {},
    },
    // MCP 工具副作用不可预知，默认 exclusive
    concurrency: 'exclusive',

    async execute(input) {
      try {
        const result = await client.callTool(toolInfo.name, input);
        return result;
      } catch (err) {
        return {
          content: `MCP 工具调用失败：${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  };
}

/**
 * 连接 MCP Server，获取所有工具并批量转为 EasyCode ToolDefinition[]。
 *
 * @param client      已创建但未连接的 EasycodeMcpClient
 * @param config      传输配置（由 parseMcpArg 解析）
 * @param serverLabel 服务器标签（用于工具描述中显示来源）
 */
export async function loadMcpTools(
  client: EasycodeMcpClient,
  config: Parameters<EasycodeMcpClient['connect']>[0],
  serverLabel: string
): Promise<ToolDefinition[]> {
  await client.connect(config);
  const toolInfos = await client.listTools();
  return toolInfos.map((info) => bridgeMcpTool(info, client, serverLabel));
}

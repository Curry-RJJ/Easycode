/**
 * MCP Client — Model Context Protocol 客户端
 *
 * 支持两种传输方式：
 *   - stdio：启动子进程通过 stdin/stdout 通信（最常见）
 *   - http：通过 HTTP/SSE 连接远程 MCP Server
 *
 * 参考 Codex 的 MCP 接入方式：使用 @modelcontextprotocol/sdk 标准 SDK。
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// ─── 类型定义 ─────────────────────────────────────────────────────────

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export type McpTransportConfig =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> };

// ─── EasycodeMcpClient ────────────────────────────────────────────────

export class EasycodeMcpClient {
  private client: Client;
  private connected = false;

  constructor() {
    this.client = new Client(
      { name: 'easycode', version: '0.1.0' },
      // 声明客户端支持工具调用
      { capabilities: {} }
    );
  }

  /**
   * 连接到 MCP Server（stdio 或 HTTP）
   */
  async connect(config: McpTransportConfig): Promise<void> {
    if (this.connected) return;

    let transport;

    if (config.type === 'stdio') {
      // 解析命令和参数
      const parts = config.command.split(/\s+/);
      const cmd = parts[0];
      const args = [...(parts.slice(1)), ...(config.args ?? [])];

      transport = new StdioClientTransport({
        command: cmd,
        args,
        env: config.env,
      });
    } else {
      transport = new StreamableHTTPClientTransport(
        new URL(config.url),
        { requestInit: { headers: config.headers } }
      );
    }

    await this.client.connect(transport);
    this.connected = true;
  }

  /**
   * 获取 MCP Server 提供的工具列表
   */
  async listTools(): Promise<McpToolInfo[]> {
    this.assertConnected();
    const result = await this.client.listTools();
    return result.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
    }));
  }

  /**
   * 调用 MCP Server 上的工具
   */
  async callTool(
    name: string,
    input: Record<string, unknown>
  ): Promise<{ content: string; isError: boolean }> {
    this.assertConnected();

    const result = await this.client.callTool({ name, arguments: input });

    // 聚合 content 数组
    const parts: string[] = [];
    let isError = !!result.isError;
    const contentArr = result.content as Array<Record<string, unknown>>;

    for (const c of contentArr) {
      if (c['type'] === 'text') {
        parts.push(String(c['text'] ?? ''));
      } else if (c['type'] === 'image') {
        parts.push(`[图片: ${String(c['mimeType'] ?? 'image')}]`);
      } else if (c['type'] === 'resource') {
        const res = c['resource'] as Record<string, unknown> | undefined;
        if (res && 'text' in res) {
          parts.push(String(res['text'] ?? ''));
        } else {
          parts.push(`[二进制资源: ${String(res?.['mimeType'] ?? 'binary')}]`);
        }
      }
    }

    return {
      content: parts.join('\n') || '（工具执行完成，无输出）',
      isError,
    };
  }

  /**
   * 断开连接并释放资源
   */
  async disconnect(): Promise<void> {
    if (this.connected) {
      await this.client.close();
      this.connected = false;
    }
  }

  private assertConnected(): void {
    if (!this.connected) {
      throw new Error('MCP Client 尚未连接，请先调用 connect()');
    }
  }
}

// ─── 解析 --mcp 参数格式 ──────────────────────────────────────────────

/**
 * 解析 CLI 的 --mcp 参数为 McpTransportConfig。
 *
 * 支持格式：
 *   stdio:"npx @mcp/server-filesystem ."
 *   http://localhost:3000
 *   https://my-mcp-server.com/mcp
 */
export function parseMcpArg(arg: string): McpTransportConfig {
  // stdio: 前缀
  const stdioMatch = arg.match(/^stdio:\s*"?(.+?)"?\s*$/);
  if (stdioMatch) {
    return { type: 'stdio', command: stdioMatch[1] };
  }

  // 直接是 stdio 命令（不含协议前缀，且不是 http）
  if (!arg.startsWith('http://') && !arg.startsWith('https://')) {
    return { type: 'stdio', command: arg };
  }

  // HTTP/SSE
  return { type: 'http', url: arg };
}

import type { HarnessRunSpec } from "@claudexor/schema";
import { browserMcpCommand } from "@claudexor/core";

/**
 * Inject engine-owned MCP servers via `--mcp-config` inline JSON (no disk
 * write — fits the scoped HOME and works under `--bare`): the Playwright
 * browser MCP and every `extra_mcp_servers` entry (the delegation belt, etc.)
 * merged into one `mcpServers` map. The browser rides `external_context_policy`
 * (live egress, dropped under `off`); extra servers are engine-owned local
 * processes, not web egress, so they inject regardless of web policy. Empty
 * when nothing is to be injected.
 */
export function claudeMcpArgs(spec: HarnessRunSpec): string[] {
  const mcpServers: Record<
    string,
    { command: string; args: string[]; env?: Record<string, string> }
  > = {};
  if (spec.browser && spec.external_context_policy !== "off") {
    mcpServers["browser"] = browserMcpCommand(spec.browser);
  }
  for (const server of spec.extra_mcp_servers ?? []) {
    mcpServers[server.name] = {
      command: server.command,
      args: server.args,
      ...(Object.keys(server.env).length > 0 ? { env: server.env } : {}),
    };
  }
  if (Object.keys(mcpServers).length === 0) return [];
  return ["--mcp-config", JSON.stringify({ mcpServers })];
}

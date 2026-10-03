import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultNativeCodexHome } from "./auth.js";
/**
 * A TOML basic-string literal for a `-c key=value` override. `developer_instructions`
 * is a documented additive Codex config key (layered as a developer block BEFORE
 * AGENTS.md, not a replacement); passing per-invocation `-c` keeps it isolated
 * to this run (never a shared-config mutation). Instructions may contain quotes
 * and newlines, so they are TOML-escaped.
 */
export function tomlBasicString(value: string): string {
  // TOML basic-string escapes, built by code point so the SOURCE carries no
  // literal control characters: a backslash and quote are escaped, a literal
  // newline/tab/CR become their escapes (a raw newline is invalid in a basic
  // string), other control chars become \uXXXX, and everything else is literal.
  let out = '"';
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (code === 10) out += "\\n";
    else if (code === 13) out += "\\r";
    else if (code === 9) out += "\\t";
    else if (code < 32 || code === 127) out += "\\u" + code.toString(16).padStart(4, "0");
    else out += ch;
  }
  return out + '"';
}

/**
 * True only when the config codex WILL load (the scoped `CODEX_HOME` if set,
 * else `~/.codex`) actually defines `[mcp_servers.node_repl]`. We only ever
 * disable node_repl when it already exists — a `-c mcp_servers.node_repl.*`
 * override against a config that has NO node_repl creates a partial entry with
 * no transport and codex refuses to load it ("invalid transport in
 * mcp_servers.node_repl"), which broke every scoped-home / api_key / MCP run.
 */
export function codexConfigHasNodeRepl(codexHome: string | null | undefined): boolean {
  const cfg = join(codexHome || defaultNativeCodexHome(), "config.toml");
  try {
    return existsSync(cfg) && readFileSync(cfg, "utf8").includes("[mcp_servers.node_repl]");
  } catch {
    return false;
  }
}

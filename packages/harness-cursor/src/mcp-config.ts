import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtraMcpServer } from "@claudexor/schema";
import { redactSecrets } from "@claudexor/util";

/**
 * Engine-owned MCP injection for cursor-agent (the delegation belt, and any
 * future engine-owned server). Unlike claude (inline `--mcp-config` JSON) and
 * codex (`-c mcp_servers.*` overrides), cursor-agent has no stateless
 * transport: it reads `mcp.json` from its config dir. Claudexor already owns
 * the per-lane `CURSOR_CONFIG_DIR` (a Claudexor-created state dir under the
 * lane/profile HOME — INV-063: scoped vendor state stays outside every
 * worktree), so injection writes `<CURSOR_CONFIG_DIR>/mcp.json` there and the
 * run adds `--approve-mcps` so the headless agent does not stall on an
 * approval prompt.
 *
 * The write is a RECONCILE, not a blind overwrite: a sidecar manifest
 * (claudexor-managed-mcp.json) records exactly which server names Claudexor
 * injected, so a later run without `extra_mcp_servers` removes ONLY those
 * entries (a stale belt must never ride a non-delegate run — that would be an
 * undisclosed injection), while entries written by the vendor or a human are
 * structurally preserved (re-serialized through JSON, so formatting/key order
 * normalize; their content is never dropped). Failure honesty: an UNREADABLE
 * mcp.json is never silently deleted — cleanup preserves it with a typed
 * disclosure, injection quarantines the bytes aside before writing fresh; an
 * unreadable manifest falls back to the deterministic engine-owned names so a
 * stale belt cannot ride orphaned; a readable-manifest miss on a same-named
 * foreign entry refuses injection typed instead of adopting-then-deleting it.
 */

const MANAGED_MANIFEST = "claudexor-managed-mcp.json";

/** Deterministic engine-owned server names (the delegation-belt descriptor's
 * name — packages/cli/src/delegation-belt-descriptor.ts). Used ONLY as the
 * corrupt-manifest fallback, so a lost/unreadable manifest can never orphan a
 * stale engine entry into non-delegate runs. */
const ENGINE_OWNED_MCP_NAMES: readonly string[] = ["claudexor"];

/** The lane config dir cursor-agent will actually read `mcp.json` from:
 * the explicit CURSOR_CONFIG_DIR when the env carries one (profile routes),
 * else the scoped HOME's `.cursor` (cursor's own default resolution). Null
 * when the env has neither — the HOST ~/.cursor is never touched. */
export function resolveCursorMcpConfigDir(
  env: Record<string, string | null | undefined>,
): string | null {
  const explicit = env["CURSOR_CONFIG_DIR"];
  if (typeof explicit === "string" && explicit.trim()) return explicit;
  const home = env["HOME"];
  if (typeof home === "string" && home.trim()) return join(home, ".cursor");
  return null;
}

type McpJson = { mcpServers: Record<string, unknown> } & Record<string, unknown>;

/** Read a JSON object file, distinguishing missing / readable / CORRUPT:
 * a present-but-unparseable file must never be conflated with an empty one
 * (that conflation is how bytes get silently dropped or a stale belt gets
 * orphaned). */
function readJsonObjectFile(path: string): {
  exists: boolean;
  corrupt: boolean;
  value: Record<string, unknown>;
} {
  if (!existsSync(path)) return { exists: false, corrupt: false, value: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? { exists: true, corrupt: false, value: parsed as Record<string, unknown> }
      : { exists: true, corrupt: true, value: {} };
  } catch {
    return { exists: true, corrupt: true, value: {} };
  }
}

function readManagedManifest(dir: string): {
  exists: boolean;
  corrupt: boolean;
  names: string[];
} {
  const file = readJsonObjectFile(join(dir, MANAGED_MANIFEST));
  if (!file.exists) return { exists: false, corrupt: false, names: [] };
  if (!file.corrupt && file.value["version"] === 1 && Array.isArray(file.value["names"])) {
    return {
      exists: true,
      corrupt: false,
      names: (file.value["names"] as unknown[]).filter(
        (name): name is string => typeof name === "string",
      ),
    };
  }
  return { exists: true, corrupt: true, names: [] };
}

function writeFileAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

function writeManifest(dir: string, names: readonly string[]): void {
  writeFileAtomic(
    join(dir, MANAGED_MANIFEST),
    `${JSON.stringify({ version: 1, names }, null, 2)}\n`,
  );
}

/**
 * Reconcile `<dir>/mcp.json` so it contains EXACTLY the requested engine
 * servers among the Claudexor-managed entries: previously managed names are
 * removed, the requested servers written, and foreign entries preserved.
 * Returns typed disclosure lines for anything it deliberately left alone.
 * Failure semantics (each pinned by a test):
 * - unreadable MANIFEST: fall back to removing the deterministic engine-owned
 *   names (plus the requested ones) so a stale belt never rides orphaned; the
 *   manifest is deleted only once nothing managed can still ride;
 * - unreadable MCP.JSON on cleanup: preserved untouched (bytes are not ours
 *   to delete) with a disclosure, and the manifest is KEPT — its entry may
 *   still ride inside the unreadable file;
 * - unreadable MCP.JSON on injection: the bytes are quarantined aside
 *   (mcp.json.invalid-<ts>), never deleted, then a fresh file is written;
 * - a FOREIGN entry squatting a requested engine name (readable manifest
 *   that does not list it): throws — the caller refuses injection typed
 *   rather than adopting and later destroying someone else's entry.
 * Write order is crash-safe: the manifest (union of old and new names) lands
 * BEFORE mcp.json, so a crash between the two leaves an over-wide manifest
 * (harmless: removing an absent key is a no-op) instead of an untracked belt.
 * Throws on an unwritable dir — the caller surfaces that typed (INV-030:
 * never a silent drop).
 */
export function syncCursorMcpServers(dir: string, servers: readonly ExtraMcpServer[]): string[] {
  const disclosures: string[] = [];
  const manifest = readManagedManifest(dir);
  const mcpPath = join(dir, "mcp.json");
  if (servers.length === 0 && !manifest.exists) {
    // An engine-named entry with NO manifest is formally foreign, so
    // preservation wins over deletion — but it is exactly the
    // stale-or-squatted belt shape (pre-hardening crash window, manual
    // manifest deletion), so a run passing through must say so LOUDLY
    // instead of riding past it silently, every time.
    const orphaned = readJsonObjectFile(mcpPath);
    if (orphaned.corrupt) {
      // The disclosure contract (final-gate finding) holds here too: an
      // unreadable lane file is preserved untouched, but never silently.
      disclosures.push(
        `cursor mcp.json at ${mcpPath} is unreadable and has NO Claudexor managed manifest — it was preserved untouched (bytes are not ours to delete); whether an engine-named MCP entry rides inside is unknown: repair or remove it by hand`,
      );
      return disclosures;
    }
    const orphanServers =
      orphaned.value["mcpServers"] !== null &&
      typeof orphaned.value["mcpServers"] === "object" &&
      !Array.isArray(orphaned.value["mcpServers"])
        ? (orphaned.value["mcpServers"] as Record<string, unknown>)
        : {};
    const riding = ENGINE_OWNED_MCP_NAMES.filter((name) => name in orphanServers);
    if (riding.length > 0) {
      disclosures.push(
        `cursor mcp.json at ${mcpPath} carries engine-named MCP entr${riding.length > 1 ? "ies" : "y"} (${riding.join(", ")}) with NO Claudexor managed manifest — stale or foreign; it was NOT auto-removed: remove it by hand, or run a delegate turn to re-adopt it`,
      );
    }
    return disclosures;
  }
  const managedNames = manifest.corrupt
    ? [...new Set([...ENGINE_OWNED_MCP_NAMES, ...servers.map((server) => server.name)])]
    : manifest.names;
  const mcpFile = readJsonObjectFile(mcpPath);
  if (mcpFile.corrupt) {
    if (servers.length === 0) {
      // Cleanup must never delete bytes it could not read; the manifest is
      // kept too — its entry may still ride inside the unreadable file.
      disclosures.push(
        `cursor mcp.json at ${mcpPath} is unreadable; cleanup skipped and the file preserved (repair or remove it by hand)`,
      );
      return disclosures;
    }
    const quarantine = `${mcpPath}.invalid-${Date.now()}`;
    renameSync(mcpPath, quarantine);
    disclosures.push(
      `cursor mcp.json at ${mcpPath} was unreadable; original bytes preserved at ${quarantine} before writing the engine config`,
    );
  }
  const currentServers =
    mcpFile.corrupt ||
    mcpFile.value["mcpServers"] === null ||
    typeof mcpFile.value["mcpServers"] !== "object" ||
    Array.isArray(mcpFile.value["mcpServers"])
      ? {}
      : { ...(mcpFile.value["mcpServers"] as Record<string, unknown>) };
  // A readable manifest is the adoption authority: a same-named entry it does
  // not list belongs to someone else — refuse instead of adopt-then-delete.
  // (With a CORRUPT manifest the engine names are treated as previously
  // managed — the deterministic-name fallback above — never as foreign.)
  for (const server of servers) {
    if (server.name in currentServers && !managedNames.includes(server.name)) {
      throw new Error(
        `cursor mcp.json already defines "${server.name}" and the Claudexor manifest does not own it; refusing to overwrite a foreign MCP entry (remove or rename it in ${mcpPath})`,
      );
    }
  }
  for (const name of managedNames) delete currentServers[name];
  for (const server of servers) {
    currentServers[server.name] = {
      command: server.command,
      args: server.args,
      ...(Object.keys(server.env).length > 0 ? { env: server.env } : {}),
    };
  }
  const base = mcpFile.corrupt ? {} : mcpFile.value;
  const next: McpJson = { ...base, mcpServers: currentServers };
  const empty =
    Object.keys(currentServers).length === 0 &&
    Object.keys(next).every((key) => key === "mcpServers");
  if (empty) {
    rmSync(mcpPath, { force: true });
    rmSync(join(dir, MANAGED_MANIFEST), { force: true });
    return disclosures;
  }
  mkdirSync(dir, { recursive: true });
  const names = servers.map((server) => server.name);
  if (names.length > 0) {
    // Manifest FIRST (union of old and new): a crash before the mcp.json
    // write leaves an over-wide manifest, never an untracked belt entry.
    writeManifest(dir, [...new Set([...managedNames, ...names])]);
  }
  writeFileAtomic(mcpPath, `${JSON.stringify(next, null, 2)}\n`);
  if (names.length > 0) {
    writeManifest(dir, names);
  } else {
    rmSync(join(dir, MANAGED_MANIFEST), { force: true });
  }
  return disclosures;
}

/**
 * One pre-spawn decision for runCursor: reconcile the lane's mcp.json —
 * writing the requested servers, or removing previously managed ones so a
 * stale belt never rides a non-delegate run — and report whether the run
 * must add `--approve-mcps`, plus typed disclosures for anything the
 * reconcile deliberately preserved. A run that REQUESTED injection but has
 * no Claudexor-owned config dir to write into refuses loudly (the host
 * ~/.cursor is never written, and a silent drop would fake a capability —
 * INV-030/INV-063). On approval the env is pinned to the exact dir written.
 */
export function prepareCursorMcpInjection(
  env: Record<string, string | null | undefined>,
  servers: readonly ExtraMcpServer[],
): { approved: boolean; disclosures: string[] } | { refusal: string } {
  const dir = resolveCursorMcpConfigDir(env);
  let disclosures: string[] = [];
  try {
    if (servers.length > 0 && dir === null) {
      return {
        refusal:
          "cursor MCP injection requires a Claudexor-owned lane config dir (CURSOR_CONFIG_DIR or a scoped HOME); the host ~/.cursor is never written",
      };
    }
    if (dir !== null) disclosures = syncCursorMcpServers(dir, servers);
  } catch (err) {
    return {
      refusal: `cursor MCP injection failed before spawn: ${redactSecrets(
        err instanceof Error ? err.message : String(err),
      )}`,
    };
  }
  if (servers.length > 0) {
    env["CURSOR_CONFIG_DIR"] = dir;
    return { approved: true, disclosures };
  }
  return { approved: false, disclosures };
}

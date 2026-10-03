import { connectDaemonIfRunning, ensureDaemon } from "./daemon-run.js";
import { controlApiFetch } from "./live.js";
import { BELT_DAEMON_LOST } from "./mcp-daemon-unavailable.js";

export async function catalogQuery(
  mode: "__status" | "__capabilities" | "__accounts",
  beltContext = false,
  options: { fresh?: boolean } = {},
): Promise<Record<string, unknown>> {
  const connection = beltContext ? await connectDaemonIfRunning() : await ensureDaemon();
  if (!connection) throw new Error(BELT_DAEMON_LOST);
  const { addr } = connection;
  // __accounts defaults to the CACHED credential-profiles read (15s TTL
  // server-side). The snapshot form is the explicit, expensive refresh — a
  // live probe per profile, a full doctor sweep, and the vendor quota
  // fan-out — and is requested only by fresh:true (which itself honors the
  // per-vendor rate-limit cooldowns server-side).
  const path =
    mode === "__status"
      ? "/harnesses"
      : mode === "__accounts"
        ? options.fresh === true
          ? "/credential-profiles?snapshot=true"
          : "/credential-profiles"
        : "/agent-capabilities";
  const response = await controlApiFetch(addr, path);
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(`control API ${path} failed (HTTP ${response.status})`);
  if (mode !== "__status") return body;
  const harnesses = Array.isArray(body["harnesses"])
    ? (body["harnesses"] as Record<string, unknown>[])
    : [];
  return {
    ...body,
    available: harnesses.filter((item) => item["status"] === "ok").map((item) => item["id"]),
  };
}

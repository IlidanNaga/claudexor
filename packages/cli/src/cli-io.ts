/**
 * CLI output helpers: one owner for stdout/JSON purity. `--json` mode emits
 * exactly one JSON object on stdout; usage errors go to stderr (text mode)
 * or a typed {ok:false,exitCode,error} object (json mode).
 */
export function print(s: string): void {
  process.stdout.write(s + "\n");
}

export function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

/** One COMPACT JSON object per line — the NDJSON contract (--json-stream). A
 *  pretty multi-line object would break `for line in stream: json.loads(line)`. */
export function printJsonLine(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + "\n");
}

/** How long a finished command's event loop may stay alive on a stray handle
 *  before the backstop forces termination. The clean path never waits for it. */
const STRAY_HANDLE_EXIT_GRACE_MS = 1_000;

export function exitAfterOutputFlush(code: number): void {
  // JSON projections such as `doctor --all` can exceed a pipe's 64 KiB high-water
  // mark. A direct process.exit() discards that buffered tail while still reporting
  // success. Empty writes queue behind every prior write; exit only after both pipes
  // have drained.
  //
  // The clean path is a natural exit: an empty loop lets Node dispose the isolate,
  // which joins V8's background work (the WASM compiles behind fetch()), before the
  // platform shuts down. process.exit() shuts the platform down under that work, and
  // on Windows libuv then aborts with 0xC0000409 after the JSON was written
  // (`!(handle->flags & UV_HANDLE_CLOSING)`, nodejs/node#56645; fixed by #61999 in
  // Node 24.20.0). The unref'd backstop fires only when a stray handle keeps the
  // loop alive, so termination stays finite.
  process.exitCode = code;
  let pending = 2;
  const flushed = () => {
    pending -= 1;
    if (pending === 0) setTimeout(() => process.exit(code), STRAY_HANDLE_EXIT_GRACE_MS).unref();
  };
  process.stdout.write("", flushed);
  process.stderr.write("", flushed);
}

/**
 * A usage/validation failure (exit 2). The JSON envelope aligns with the D-7
 * projector shape ({ok, exitCode, code, message}) while keeping the legacy
 * `error` alias for existing consumers. The `code` uses the SAME vocabulary the
 * projector stamps for this class (`invalid_argument`, matching `minIntError`
 * and the Zod path) so a machine consumer never sees two names for one failure.
 * Typed failures (field errors, domain codes) go through `renderCliFailure` in
 * cli-error.ts instead.
 */
export function printUsageError(json: boolean, error: string): number {
  if (json) printJson({ ok: false, exitCode: 2, code: "invalid_argument", message: error, error });
  else process.stderr.write(`${error}\n`);
  return 2;
}

export function statusGlyph(status: string): string {
  return status === "ok" ? "[ok]" : status === "degraded" ? "[degraded]" : "[unavailable]";
}

export function authSourceAvailability(status: {
  authSources?: {
    source: string;
    availability: "available" | "unavailable" | "unknown";
    verification: "passed" | "failed" | "not_run";
  }[];
}): string {
  const sources = status.authSources ?? [];
  if (sources.length === 0) return "readiness-not-reported";
  return sources
    .map(
      (source) =>
        `${source.source}[availability=${source.availability},verification=${source.verification}]`,
    )
    .join(", ");
}

export function checksSummary(status: {
  checks?: { id: string; status: string; detail?: string }[];
}): string {
  const checks = status.checks ?? [];
  if (checks.length === 0) return "none";
  return checks.map((c) => `${c.id}:${c.status}`).join(", ");
}

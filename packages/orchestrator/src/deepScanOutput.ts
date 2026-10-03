import type { DeepScanSynthesis } from "@claudexor/schema";
import { toolWarnings, type AttemptTelemetry } from "./attemptTelemetry.js";

/** Honest attributed fallback; never presents raw scout reports as a merge. */
export function rawScoutBundle(args: {
  succeeded: {
    attemptId: string;
    harnessId: string;
    report: string;
    telemetry: AttemptTelemetry;
  }[];
  unsuccessful: { attemptId: string; harnessId: string; status: string; error: string | null }[];
  status: DeepScanSynthesis | null;
}): string {
  const total = args.succeeded.length + args.unsuccessful.length;
  const intro =
    args.status?.status === "skipped"
      ? [
          "## Raw scout report (single scout — no merge needed)",
          "",
          "Only one scout produced a report, so no synthesis reducer was run.",
        ]
      : [
          "## Raw scout bundle — NOT a merged synthesis",
          "",
          `The bounded synthesis reducer did not produce a merge (${args.status?.reason ?? "synthesis unavailable"}). The scout reports below are raw and unmerged; claims are not deduplicated and disagreements are not reconciled.`,
        ];
  return [
    ...intro,
    "",
    `Explorers succeeded: ${args.succeeded.length}/${total}.`,
    "",
    "## Scout reports (raw, not merged)",
    ...args.succeeded.map((a) => {
      const warnings = toolWarnings(a.telemetry);
      const warningText = warnings.length
        ? `\n\n> Tool warnings: ${warnings.map((e) => `${e.tool}: ${e.summary}`).join("; ")}`
        : "";
      return `\n### ${a.attemptId} / ${a.harnessId}\n\n${a.report}${warningText}`;
    }),
    "",
    "## Omissions / Uncertainty",
    ...(args.unsuccessful.length
      ? args.unsuccessful.map((a) => `- ${a.attemptId} / ${a.harnessId} ${a.status}: ${a.error}`)
      : [
          "- No explorer failures recorded. Claims still need evidence review before edit execution.",
        ]),
  ].join("\n");
}

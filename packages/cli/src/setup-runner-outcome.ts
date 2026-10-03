import type { ControlHarnessSetupHarness } from "@claudexor/schema";
import { deviceAuthUnsupportedMessage } from "./setup-client-pty.js";
import type { SetupLoginRunnerResult } from "./setup-login-protocol.js";

export type SetupRunnerFailureOutcome = readonly [
  state: "not_supported" | "failed",
  reason: "not_supported" | "launch_failed" | "command_failed",
  message: string,
];

/** Exact durable outcome for every typed pre-start or transport receipt. */
export function setupRunnerFailureOutcome(
  harness: ControlHarnessSetupHarness,
  result: SetupLoginRunnerResult,
  platform: NodeJS.Platform,
): SetupRunnerFailureOutcome | null {
  if (result.commandStarted && result.errorCode !== "terminal_transport_failed") return null;
  switch (result.errorCode) {
    case "device_auth_unsupported":
      return ["not_supported", "not_supported", deviceAuthUnsupportedMessage(harness, platform)];
    case "terminal_transport_unavailable":
      return [
        "not_supported",
        "not_supported",
        `${harness} daemon terminal transport became unavailable before the vendor command started; use the external-terminal flow.`,
      ];
    case "terminal_transport_unsupported":
      return [
        "not_supported",
        "not_supported",
        `${harness} daemon terminal transport is unsupported on this host; use the external-terminal flow.`,
      ];
    case "terminal_transport_probe_failed":
      return [
        "failed",
        "launch_failed",
        `${harness} terminal transport capability probe failed before the vendor command started.`,
      ];
    case "terminal_transport_failed":
      return result.commandStarted
        ? [
            "failed",
            "command_failed",
            `${harness} terminal transport failed after the vendor command started; use the external-terminal flow.`,
          ]
        : [
            "failed",
            "launch_failed",
            `${harness} terminal transport failed before the vendor command started.`,
          ];
    default:
      return [
        "failed",
        "launch_failed",
        result.errorCode === "permit_timeout"
          ? `${harness} login worker timed out before a durable execution permit was issued.`
          : `${harness} login command could not be spawned after authorization.`,
      ];
  }
}

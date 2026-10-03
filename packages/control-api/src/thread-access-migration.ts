import { RETIRED_EXTERNAL_SANDBOX_FULL } from "@claudexor/schema";

/** A historical sticky access value remains readable but cannot authorize a new turn. */
export function assertActiveThreadAccessOverride(
  threadAccess: string | null | undefined,
  requestedAccess: unknown,
): void {
  if (threadAccess !== RETIRED_EXTERNAL_SANDBOX_FULL || requestedAccess !== undefined) return;
  throw Object.assign(
    new Error(
      "this historical thread uses retired external_sandbox_full access; choose an active access profile for this turn or update the thread first",
    ),
    {
      status: 409,
      code: "retired_access_profile",
      retryable: false,
      requiredActions: [
        "PATCH the thread access to workspace_write or trusted full, or send an explicit active access override on this turn.",
      ],
    },
  );
}

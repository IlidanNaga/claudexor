import { describe, expect, it } from "vitest";
import type { HarnessAdapter } from "@claudexor/core";
import type { CredentialUnusableObservation, HarnessRunSpec } from "@claudexor/schema";
import {
  OrchestratorCredentials,
  type CredentialResolutionHost,
} from "./orchestrator-credentials.js";
import {
  preProgressRefusalSubject,
  type PreProgressRefusalMemory,
} from "./pre-progress-refusal.js";
import type { TransientFailureObservation } from "./transientClassify.js";

// #363: the A7 differential verdict about a try's CURRENT subject is recorded
// only while the credential that try bound is still the account's current one.

const authRefusal: TransientFailureObservation = {
  kind: "unknown",
  category: "auth_failed",
  retryable: false,
  retryDelayMs: null,
  httpStatus: null,
  signal: null,
  adapterCode: "auth_required",
};

function fixture() {
  const recorded: CredentialUnusableObservation[] = [];
  let generation = 0;
  const memory: PreProgressRefusalMemory = {
    live: () => [],
    generation: () => generation,
    record: () => {},
    clear: () => {},
  };
  const host = {
    quotaSnapshots: () => [],
    quotaAbsences: () => [],
    credentialUnusable: () => [],
    recordCredentialUnusable: (obs: CredentialUnusableObservation) => void recorded.push(obs),
    preProgressRefusals: () => memory,
  } as unknown as CredentialResolutionHost;
  const spec = {
    model_hint: "m",
    credential_profile: {
      profile_id: "a",
      harness_id: "cursor",
      display_name: "a",
      credential_kind: "config_dir_login",
      isolation_locator: "/tmp/cursor-a",
      secret_ref: null,
      enabled: true,
      created_at: null,
    },
  } as unknown as HarnessRunSpec;
  const credentials = new OrchestratorCredentials(host);
  const adapter = { id: "cursor" } as HarnessAdapter;
  return {
    recorded,
    change: (next: number) => (generation = next),
    verdict: async (bindAt: number) => {
      generation = bindAt;
      const refusal = preProgressRefusalSubject(memory, "cursor", spec);
      return (subjectAfter: number) => {
        generation = subjectAfter;
        return credentials
          .rotationObservations(adapter, spec, [authRefusal], refusal)
          .probeCurrentSubject();
      };
    },
  };
}

describe("OrchestratorCredentials differential verdict fence (#363)", () => {
  it("records the verdict while the bound credential is current", async () => {
    const f = fixture();
    const probe = await f.verdict(3);
    expect(await probe(3)).toMatchObject({ code: "auth_revoked", profile_id: "a" });
    expect(f.recorded).toHaveLength(1);
  });

  it.each([
    ["a credential change since the try spawned", 4],
    ["an open login window (generation is no number)", Number.NaN],
  ])("does not record it after %s", async (_label, after) => {
    const f = fixture();
    const probe = await f.verdict(3);
    // The rotation decision still sees the verdict; only the memory refuses it.
    expect(await probe(after)).toMatchObject({ code: "auth_revoked" });
    expect(f.recorded).toEqual([]);
  });
});

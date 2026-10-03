import { describe, expect, it } from "vitest";
import { HarnessRunSpec, type CredentialProfile } from "@claudexor/schema";
import {
  credentialProfileUnpinned,
  stampCredentialProfileSelection,
} from "./credential-selection.js";

const profile = (profile_id: string): CredentialProfile => ({
  profile_id,
  harness_id: "cursor",
  display_name: profile_id,
  credential_kind: "config_dir_login",
  isolation_locator: `/tmp/cursor-${profile_id}`,
  secret_ref: null,
  enabled: true,
  created_at: null,
});

const spec = (credential_profile: CredentialProfile | null): HarnessRunSpec =>
  HarnessRunSpec.parse({
    session_id: "s-selection",
    intent: "implement",
    prompt: "go",
    cwd: "/repo",
    credential_profile,
  });

describe("credential profile selection stamp (INV-135 #363)", () => {
  it("reads unpinned only for the profile the engine stamped as an unpinned choice", () => {
    const pooled = spec(profile("a"));
    stampCredentialProfileSelection(pooled, { pinned: false });
    expect(credentialProfileUnpinned(pooled)).toBe(true);
    // Same profile, no engine fact: the strict pin contract.
    expect(credentialProfileUnpinned(spec(profile("a")))).toBe(false);
  });

  it("an explicit pin clears an earlier unpinned stamp", () => {
    const s = spec(profile("a"));
    stampCredentialProfileSelection(s, { pinned: false });
    stampCredentialProfileSelection(s, { pinned: true });
    expect(credentialProfileUnpinned(s)).toBe(false);
  });

  it("a stamp never follows a spec onto another profile, and survives a spec clone", () => {
    const s = spec(profile("a"));
    stampCredentialProfileSelection(s, { pinned: false });
    const clone = HarnessRunSpec.parse({ ...s, extra: { ...s.extra } });
    expect(credentialProfileUnpinned(clone)).toBe(true);
    expect(credentialProfileUnpinned({ ...s, credential_profile: profile("b") })).toBe(false);
  });

  it("a profile-less spec carries no stamp", () => {
    const s = spec(null);
    stampCredentialProfileSelection(s, { pinned: false });
    expect(s.extra).toEqual({});
    expect(credentialProfileUnpinned(s)).toBe(false);
  });
});

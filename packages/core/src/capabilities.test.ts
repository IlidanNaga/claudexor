import { describe, expect, it } from "vitest";
import { HarnessCapabilityProfile } from "@claudexor/schema";
import { needsPrivatePerProfileKeychain, needsScopedHomeKeychainBridge } from "./capabilities.js";

function profile(platforms?: Array<"darwin" | "linux" | "win32">) {
  return HarnessCapabilityProfile.parse({
    auth: {
      supported_sources: ["native_session"],
      credential_transports: [
        {
          source: "native_session",
          kind: "os_keychain",
          relocatable_by: ["HOME"],
          ...(platforms ? { platforms } : {}),
        },
      ],
    },
    isolation: { supported_containment: ["scoped_home_keychain_bridge"] },
  });
}

describe("needsScopedHomeKeychainBridge", () => {
  it("consumes the declared platform filter", () => {
    const darwinOnly = profile(["darwin"]);
    expect(needsScopedHomeKeychainBridge(darwinOnly, "darwin")).toBe(true);
    expect(needsScopedHomeKeychainBridge(darwinOnly, "linux")).toBe(false);
    expect(needsScopedHomeKeychainBridge(darwinOnly, "win32")).toBe(false);
  });

  it("preserves legacy platformless transports and rejects undeclared hosts", () => {
    const legacy = profile();
    expect(needsScopedHomeKeychainBridge(legacy, "linux")).toBe(true);
    expect(needsScopedHomeKeychainBridge(legacy, "freebsd")).toBe(false);
  });
});

describe("needsPrivatePerProfileKeychain", () => {
  it("recognizes only the explicit private containment on its declared platform", () => {
    const profile = HarnessCapabilityProfile.parse({
      auth: {
        supported_sources: ["native_session"],
        credential_transports: [
          {
            source: "native_session",
            kind: "os_keychain",
            relocatable_by: ["HOME"],
            platforms: ["darwin"],
          },
        ],
      },
      isolation: { supported_containment: ["private_per_profile_keychain"] },
    });
    expect(needsPrivatePerProfileKeychain(profile, "darwin")).toBe(true);
    expect(needsPrivatePerProfileKeychain(profile, "linux")).toBe(false);
    expect(needsPrivatePerProfileKeychain(profile, "win32")).toBe(false);
    expect(needsScopedHomeKeychainBridge(profile, "darwin")).toBe(false);
  });
});

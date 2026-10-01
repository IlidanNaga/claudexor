import { afterEach, describe, expect, it } from "vitest";
import {
  bindCredentialMutationWindow,
  credentialMutationWindowOpen,
} from "./credential-mutation-window.js";

describe("credential-mutation window reader (#363)", () => {
  afterEach(() => bindCredentialMutationWindow(null));

  it("reads closed while no daemon lifecycle is bound", () => {
    expect(credentialMutationWindowOpen("cursor")).toBe(false);
    expect(credentialMutationWindowOpen()).toBe(false);
  });

  it("answers from the bound lifecycle, per harness or for any harness", () => {
    const asked: Array<string | undefined> = [];
    bindCredentialMutationWindow((harness) => {
      asked.push(harness);
      return harness === undefined || harness === "cursor";
    });
    expect(credentialMutationWindowOpen("cursor")).toBe(true);
    expect(credentialMutationWindowOpen("claude")).toBe(false);
    expect(credentialMutationWindowOpen()).toBe(true);
    expect(asked).toEqual(["cursor", "claude", undefined]);
  });

  it("reads open when the bound lifecycle cannot answer (unreadable journal, unbound generation)", () => {
    bindCredentialMutationWindow(() => {
      throw new Error("setup journal requires recovery");
    });
    expect(credentialMutationWindowOpen("cursor")).toBe(true);
    expect(credentialMutationWindowOpen()).toBe(true);
  });
});

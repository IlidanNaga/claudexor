import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireHarnessInstallLease } from "./harness-install-lease.js";

describe("harness install lease", () => {
  it("gives a safe manual remedy when a live-looking lock stays busy", () => {
    const home = mkdtempSync(join(tmpdir(), "claudexor-install-lease-remedy-"));
    const first = acquireHarnessInstallLease(home, 0);
    try {
      expect(() => acquireHarnessInstallLease(home, 0)).toThrow(
        /if this persists after that installer exits, verify no installer is running, remove that exact directory, and retry/,
      );
    } finally {
      first.release();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

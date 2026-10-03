import { afterEach, describe, expect, it, vi } from "vitest";
import { createCursorStatusCoordinator } from "./status-cache.js";

const clock = vi.hoisted(() => ({ uptime: 1_000 }));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  uptime: () => clock.uptime,
}));
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => Object.defineProperty(process, "platform", originalPlatform));
const ENV = { HOME: "/offline/row", AGENT_CLI_CREDENTIAL_STORE: "file", CURSOR_API_KEY: null };

describe("Linux status freshness includes suspend", () => {
  it("uses suspend-inclusive uptime with a conservative bound and ignores wall-clock steps", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    clock.uptime = 1_000;
    let wall = Date.parse("2026-09-28T00:00:00Z");
    let calls = 0;
    const coordinator = createCursorStatusCoordinator({
      wallMs: () => wall,
      probe: async () =>
        ++calls === 1 ? { kind: "authenticated" } : { kind: "unknown", timedOut: true },
    });
    const fresh = await coordinator.status(ENV);
    clock.uptime += 58.999;
    wall += 86_400_000;
    expect(await coordinator.status(ENV)).toEqual(fresh);
    expect(calls).toBe(1);
    clock.uptime = 1_059; // upper age bound 60s: fresh reuse must end
    expect(await coordinator.status(ENV)).toMatchObject({
      kind: "unknown",
      lastPositive: { ageMs: 60_000 },
    });
    clock.uptime = 1_298.999;
    wall -= 2 * 86_400_000;
    expect(await coordinator.status(ENV)).toMatchObject({
      kind: "unknown",
      lastPositive: { ageMs: 299_999 },
    });
    clock.uptime = 1_299; // upper age bound 300s: stale reuse must end
    expect(await coordinator.status(ENV)).toEqual({ kind: "unknown", timedOut: true });
  });

  it("never reuses a pre-suspend positive after the host's uptime advances past its bound", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    clock.uptime = 1_000;
    let calls = 0;
    const coordinator = createCursorStatusCoordinator({
      probe: async () =>
        ++calls === 1 ? { kind: "authenticated" } : { kind: "unknown", timedOut: true },
    });
    await coordinator.status(ENV);
    // No JS/performance-clock delay; this models the kernel clock's sleep jump.
    clock.uptime += 600;
    expect(await coordinator.status(ENV)).toEqual({ kind: "unknown", timedOut: true });
    expect(calls).toBe(2);
  });
});

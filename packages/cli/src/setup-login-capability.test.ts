import { describe, expect, it, vi } from "vitest";
import type { HarnessAdapter } from "@claudexor/core";
import {
  assertSetupLoginAdmission,
  effectiveSetupLoginCapability,
  projectSetupLoginCapability,
} from "./setup-login-capability.js";

function adapter(stdin: "none" | "pipe" | "terminal" | null): HarnessAdapter {
  return {
    capabilityProfile: stdin
      ? ({ auth: { managed_login: { stdin } } } as HarnessAdapter["capabilityProfile"])
      : ({ auth: { managed_login: null } } as HarnessAdapter["capabilityProfile"]),
  } as HarnessAdapter;
}

const loginSpec = () => ({
  binary: "/exact/agy",
  args: ["-p", "/model"],
  displayCommand: "agy login",
  loginMode: "url_disclosure_with_input" as const,
  ptyStdin: true,
});

describe("effective setup-login capability", () => {
  it("publishes null for no declaration or no exact vendor command", async () => {
    await expect(
      effectiveSetupLoginCapability("agy", {
        getAdapter: () => adapter(null),
        resolveLoginSpec: loginSpec,
      }),
    ).resolves.toBeNull();
    await expect(
      effectiveSetupLoginCapability("agy", {
        getAdapter: () => adapter("terminal"),
        resolveLoginSpec: () => null,
      }),
    ).resolves.toBeNull();
  });

  it.each(["none", "pipe"] as const)(
    "publishes in_app/direct for %s stdin without a terminal probe",
    async (stdin) => {
      const terminal = vi.fn();
      const projection = await projectSetupLoginCapability("claude", {
        getAdapter: () => adapter(stdin),
        resolveLoginSpec: loginSpec,
        resolveTerminalTransport: terminal,
      });
      expect(projection).toMatchObject({
        status: "ready",
        backend: "direct",
        capability: { mode: "in_app" },
      });
      expect(terminal).not.toHaveBeenCalled();
    },
  );

  it("publishes in_app only after the shared terminal resolver is ready", async () => {
    const terminal = vi.fn(async () => ({
      status: "ready" as const,
      backend: "windows_conpty" as const,
      command: { binary: "/helper.exe", args: ["--", "/exact/agy"] },
      helperControlStderr: true,
    }));
    const projection = await projectSetupLoginCapability("agy", {
      getAdapter: () => adapter("terminal"),
      resolveLoginSpec: loginSpec,
      resolveTerminalTransport: terminal,
    });
    expect(terminal).toHaveBeenCalledWith("/exact/agy", ["-p", "/model"]);
    expect(projection).toMatchObject({
      status: "ready",
      backend: "windows_conpty",
      capability: { mode: "in_app" },
    });
  });

  it.each([
    {
      resolution: {
        status: "unavailable" as const,
        backend: "windows_conpty" as const,
        errorCode: "terminal_transport_unavailable" as const,
        detail: "safe unavailable",
      },
      httpStatus: 409,
      retryable: false,
    },
    {
      resolution: {
        status: "unsupported" as const,
        backend: "windows_conpty" as const,
        errorCode: "terminal_transport_unsupported" as const,
        detail: "safe unsupported",
      },
      httpStatus: 409,
      retryable: false,
    },
    {
      resolution: {
        status: "probe_failed" as const,
        backend: "windows_conpty" as const,
        errorCode: "terminal_transport_probe_failed" as const,
        detail: "safe probe_failed",
      },
      httpStatus: 503,
      retryable: true,
    },
  ])(
    "projects resolver %s as external_terminal and the frozen problem",
    async ({ resolution, httpStatus, retryable }) => {
      const projection = await projectSetupLoginCapability("agy", {
        getAdapter: () => adapter("terminal"),
        resolveLoginSpec: loginSpec,
        resolveTerminalTransport: async () => resolution,
      });
      expect(projection).toMatchObject({
        status: `terminal_transport_${resolution.status}`,
        backend: "windows_conpty",
        capability: { mode: "external_terminal" },
        errorCode: resolution.errorCode,
      });
      expect(() => assertSetupLoginAdmission(projection)).toThrow(
        expect.objectContaining({
          status: httpStatus,
          code: resolution.errorCode,
          retryable,
          fieldErrors: { "/transport": [expect.any(String)] },
          requiredActions: retryable
            ? ["retry_setup_login", "use_external_terminal"]
            : ["use_external_terminal"],
        }),
      );
    },
  );

  it("requires the vendor command but bypasses the daemon resolver for client_pty", async () => {
    const terminal = vi.fn();
    const ready = await projectSetupLoginCapability("agy", {
      transport: "client_pty",
      getAdapter: () => adapter("terminal"),
      resolveLoginSpec: loginSpec,
      resolveTerminalTransport: terminal,
    });
    expect(ready).toMatchObject({
      status: "ready",
      backend: null,
      capability: { mode: "external_terminal" },
    });
    expect(terminal).not.toHaveBeenCalled();

    const missing = await projectSetupLoginCapability("agy", {
      transport: "client_pty",
      getAdapter: () => adapter("terminal"),
      resolveLoginSpec: () => null,
      resolveTerminalTransport: terminal,
    });
    expect(missing).toMatchObject({
      status: "vendor_binary_unavailable",
      capability: null,
    });
  });
});

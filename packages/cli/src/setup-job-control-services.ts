import type { createSetupJobManager } from "./setup-jobs.js";
import { preflightSetupJobCreateRequest } from "./setup-job-support.js";
import {
  assertSetupLoginAdmission,
  projectSetupLoginCapability,
} from "./setup-login-capability.js";

type SetupJobManager = ReturnType<typeof createSetupJobManager>;

/** Thin Control API bindings over setup-job admission and durable lifecycle operations. */
export function setupJobControlServices(setupJobs: () => SetupJobManager) {
  return {
    createSetupJob: async (input: {
      request: unknown;
      idempotencyKey: string;
      clientId: string;
    }) => {
      // No helper/vendor probe and no bootstrap/durable mutation can precede
      // request, named-profile, required-profile, and D13 validation.
      const request = preflightSetupJobCreateRequest(input.request);
      const capability = await projectSetupLoginCapability(request.harness, {
        transport: request.transport,
        loginFlow: request.loginFlow,
      });
      assertSetupLoginAdmission(capability);
      return setupJobs().create(request, {
        key: input.idempotencyKey,
        client: input.clientId,
      });
    },
    listSetupJobs: async (input?: unknown) => {
      const jobs = setupJobs();
      return { jobs: jobs.list(input as Parameters<typeof jobs.list>[0]) };
    },
    setupJobStatus: async (input: unknown) => setupJobs().status(input),
    setupJobSnapshot: async (input: unknown) => setupJobs().snapshot(input),
    setupJobEvents: async (input: unknown) => setupJobs().events(input),
    cancelSetupJob: async (input: unknown) => setupJobs().cancel(input),
    setupJobInput: async (input: unknown) => setupJobs().input(input),
    reconcileSetupJob: async (input: unknown) => setupJobs().reconcile(input),
    extendSetupJob: async (input: unknown) => setupJobs().extend(input),
  };
}

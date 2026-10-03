import type { DurableJournal } from "@claudexor/journal";
import type { QuotaPacerStateStore } from "./quota-poll-pacer.js";
import type { QuotaRefresher, QuotaVendorRefresher } from "./quota-poll-lanes.js";
import { QuotaRegistry, type QuotaSubjectUniverse } from "./quota-registry.js";

export function quotaProjection(
  refreshers: readonly (QuotaRefresher | QuotaVendorRefresher)[] = [],
  subjects?: QuotaSubjectUniverse,
  now: () => Date = () => new Date(),
  pacerStore?: QuotaPacerStateStore,
) {
  return {
    name: "quota",
    create: (journal: DurableJournal) =>
      new QuotaRegistry(journal, refreshers, now, subjects, pacerStore),
    validate: (registry: QuotaRegistry) => registry.validateProjection(),
    recover: (registry: QuotaRegistry) => registry.recoverAfterStartup(),
  };
}

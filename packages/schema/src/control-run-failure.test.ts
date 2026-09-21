import { describe, expect, it } from "vitest";
import { RunFailure, VendorFailureEvidence } from "./control-run-failure.js";

const legacy = {
  phase: "harness",
  category: "harness_error",
  safeMessage: "Selected model is at capacity. Please try a different model.",
};
const evidence = {
  code: "server_overloaded",
  message: "Selected model is at capacity. Please try a different model.",
  source: "codex_rollout",
};

describe("RunFailure.vendorFailure", () => {
  it("defaults to null for a record written before the field existed", () => {
    expect(RunFailure.parse(legacy).vendorFailure).toBeNull();
    expect(RunFailure.parse({ ...legacy, vendorFailure: null }).vendorFailure).toBeNull();
  });

  it("round-trips vendor evidence verbatim, with either part null", () => {
    expect(RunFailure.parse({ ...legacy, vendorFailure: evidence }).vendorFailure).toEqual(
      evidence,
    );
    for (const partial of [
      { ...evidence, code: null },
      { ...evidence, message: null },
    ]) {
      expect(VendorFailureEvidence.parse(partial)).toEqual(partial);
    }
  });

  it("keeps `code` and `source` OPEN vocabularies: values Claudexor has never seen still parse", () => {
    const unseen = { code: "brand_new_code_2031", message: null, source: "some_future_channel" };
    expect(RunFailure.parse({ ...legacy, vendorFailure: unseen }).vendorFailure).toEqual(unseen);
  });

  it("rejects what is not evidence: an empty or oversize code, a missing or empty source, a bare string", () => {
    for (const bad of [
      { ...evidence, code: "" },
      { ...evidence, code: "x".repeat(129) },
      { ...evidence, message: "w".repeat(4001) },
      { ...evidence, source: "" },
      { code: "server_overloaded", message: null },
      "server_overloaded",
    ]) {
      expect(VendorFailureEvidence.safeParse(bad).success, JSON.stringify(bad).slice(0, 60)).toBe(
        false,
      );
    }
  });
});

import { describe, expect, it } from "vitest";

import { DelegatedEvidenceIncompleteError, DelegatedHomeUnavailableError } from "@claudexor/core";
import { RunFailureCode } from "@claudexor/schema";
import { declaredFailure } from "./runTerminalResults.js";
describe("delegated evidence refusals and historical codes survive as typed terminals", () => {
  it("keeps the code and category a delegated refusal declared", () => {
    // These travel as exceptions from deep inside the attempt loop. Before they
    // were listed in RunFailureCode, `declaredFailure` validated them away and
    // the terminal said `code: null` — less than the thrower knew.
    expect(declaredFailure(new DelegatedHomeUnavailableError("no scoped home"))).toEqual({
      category: "internal",
      code: "delegated_home_unavailable",
      resetsAt: null,
    });
    expect(declaredFailure(new DelegatedEvidenceIncompleteError("unauditable"))).toEqual({
      category: "internal",
      code: "delegated_evidence_incomplete",
      resetsAt: null,
    });
  });

  it("keeps delegated_confinement_unavailable as a decoder-only historical code", () => {
    expect(RunFailureCode.parse("delegated_confinement_unavailable")).toBe(
      "delegated_confinement_unavailable",
    );
  });
});

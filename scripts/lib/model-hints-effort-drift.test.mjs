import { describe, expect, it } from "vitest";
import { compareRecordedEfforts } from "./model-hints-effort-drift.mjs";

describe("recorded effort freshness", () => {
  const common = "low,medium,high|medium";
  const spark = "low,medium,high,xhigh|high";
  const gpt52 = "low,medium,high,xhigh|medium";
  const recorded = { common, spark, "gpt-5.2": gpt52 };

  it("accepts either account-scoped membership subset when every live entry matches", () => {
    expect(compareRecordedEfforts(recorded, { common, spark }, { accountScoped: true })).toEqual({
      drifted: [],
      recordedOnly: ["gpt-5.2"],
      liveOnly: [],
    });
    expect(
      compareRecordedEfforts(recorded, { common, "gpt-5.2": gpt52 }, { accountScoped: true }),
    ).toEqual({ drifted: [], recordedOnly: ["spark"], liveOnly: [] });
  });

  it("still rejects a live-only model and a changed recorded ladder or default", () => {
    expect(
      compareRecordedEfforts(recorded, { common, future: "low|low" }, { accountScoped: true }),
    ).toMatchObject({ drifted: ["future"], liveOnly: ["future"] });
    expect(
      compareRecordedEfforts(recorded, { common: "low,high|medium" }, { accountScoped: true }),
    ).toMatchObject({ drifted: ["common"] });
    expect(
      compareRecordedEfforts(recorded, { common: "low,medium,high|high" }, { accountScoped: true }),
    ).toMatchObject({ drifted: ["common"] });
  });

  it("keeps exact membership comparison for non-account-scoped snapshots", () => {
    expect(compareRecordedEfforts(recorded, { common, spark })).toMatchObject({
      drifted: ["gpt-5.2"],
      recordedOnly: ["gpt-5.2"],
    });
  });
});

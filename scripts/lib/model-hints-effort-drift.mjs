/**
 * Compare one recorded effort fallback with one live catalog.
 *
 * Most vendor ladders have one global membership set, so exact key equality is
 * meaningful. Codex `model/list` belongs to the resolved CODEX_HOME account:
 * the recorded fallback is coverage across observed accounts, and a live route
 * may legitimately omit entries another account advertises. In that mode every
 * LIVE entry must still exist and match exactly; only recorded-only membership
 * is ignored.
 */
export function compareRecordedEfforts(recorded, live, { accountScoped = false } = {}) {
  const recordedKeys = Object.keys(recorded).sort();
  const liveKeys = Object.keys(live).sort();
  const comparedKeys = accountScoped
    ? liveKeys
    : [...new Set([...recordedKeys, ...liveKeys])].sort();
  return {
    drifted: comparedKeys.filter((key) => recorded[key] !== live[key]),
    recordedOnly: recordedKeys.filter((key) => !(key in live)),
    liveOnly: liveKeys.filter((key) => !(key in recorded)),
  };
}

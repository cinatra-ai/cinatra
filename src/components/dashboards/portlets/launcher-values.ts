// Pure derivation for the workflow-launcher's placeholder values. Extracted
// from the client component so unit tests don't have to import React/UI
// primitives. Locks the invalidation contract: non-dirty fields TRACK upstream
// inputs (late-arriving selections seed automatically); dirty fields keep their
// overlay (operator picker state wins on launch); upstream clears INVALIDATE
// non-dirty values (no stale launch).
export function computeLauncherValues(
  placeholderKeys: readonly string[],
  inputs: Record<string, unknown>,
  dirty: ReadonlySet<string>,
  overlay: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of placeholderKeys) {
    if (dirty.has(k)) {
      out[k] = overlay[k] ?? "";
    } else {
      const v = inputs[k];
      out[k] = typeof v === "string" ? v : "";
    }
  }
  return out;
}

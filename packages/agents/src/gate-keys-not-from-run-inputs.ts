// ---------------------------------------------------------------------------
// A gate's own keys are never filled from the run's stored inputs (cinatra#4457).
//
// A WayFlow gate that sets `metadata.cinatra.surfaceGateInputs` to true hands
// its input values to the host only as its own message: the loader writes that
// message as one JSON object with a key for each input the gate declares
// (docker/wayflow/agent_loader.py). The host builds the review values from the
// run's stored inputs first and lays the gate's values over them. When the
// message is absent or does not parse, nothing lays over a stored input that has
// the name of a gate key, and the review screen shows the stored value as the
// gate's own. A person can then approve one value while the next step of the
// flow receives another.
//
// So, for such a gate, a run input never fills one of the gate's keys: the key
// takes the gate's own value (its parsed message or its pendingApproval), or it
// is absent. The host writes the keys it left absent into the gate's schema
// under GATE_KEYS_NOT_FROM_RUN_INPUTS, so that the readers which merge the run's
// inputs under the stored gate values again (hitl-context.ts, on the interrupt
// road and on the durable road) leave them out too. The schema is the carrier
// because both roads store it whole (the `x-` hint road of cinatra#3582): no
// protocol argument, no column and no migration. A consumer that does not know
// the key ignores it.
// ---------------------------------------------------------------------------

/** Schema key that lists the gate keys a run input must not fill. */
export const GATE_KEYS_NOT_FROM_RUN_INPUTS = "x-gate-keys-not-from-run-inputs";

/** The string entries of a list, or none when the value is not a list. */
export function readKeyList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((k): k is string => typeof k === "string" && k.length > 0);
}

/** The keys a gate's schema says a run input must not fill. */
export function readGateKeysNotFromRunInputs(schema: unknown): string[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
  return readKeyList((schema as Record<string, unknown>)[GATE_KEYS_NOT_FROM_RUN_INPUTS]);
}

/** A copy of `values` without the named keys. */
export function withoutKeys(
  values: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  if (keys.length === 0) return values;
  const drop = new Set(keys);
  return Object.fromEntries(Object.entries(values).filter(([k]) => !drop.has(k)));
}

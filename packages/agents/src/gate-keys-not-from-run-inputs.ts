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
// the key ignores it. Only the host writes the key: a schema that already holds
// it (a gate's pendingApproval, which is the schema when the step has none, or
// a pack's own step schema) loses it before the host writes its own list.
//
// FAIL CLOSED. A list is an array of strings. When a list is present but is
// not one (a stored step's list, or the schema's), nothing can say which keys
// are the gate's, so no run input fills the gate: the host withholds every run
// input, and a reader that meets such a schema list merges none. The same holds
// when the host cannot read the gate's step at all (the template read fails,
// the template is absent, its steps are not a list). When the host reads the
// template but cannot tell which step the gate is (a context ask, a fault of
// the renderer-gate index, an index past the last gate), it withholds every key
// that any step of the template lists. Absence keeps the present behaviour: a
// step without a list is a gate without the flag.
// ---------------------------------------------------------------------------

/** Schema key that lists the gate keys a run input must not fill. */
export const GATE_KEYS_NOT_FROM_RUN_INPUTS = "x-gate-keys-not-from-run-inputs";

/** The string entries of a list, or none when the value is not a list. */
export function readKeyList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((k): k is string => typeof k === "string" && k.length > 0);
}

/**
 * A stored key list: none when it is absent; the list when it is an array of
 * strings; null (unreadable: withhold every run input) for any other value.
 */
export function readStoredKeyList(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((k) => typeof k === "string")) return null;
  return [...(value as string[])];
}

/**
 * Every key that any step of a template lists, in step order; null when the
 * steps are not a list or one step's list is unreadable.
 */
export function readTemplateGateKeys(steps: unknown): string[] | null {
  if (!Array.isArray(steps)) return null;
  const keys = new Set<string>();
  for (const step of steps) {
    if (!step || typeof step !== "object") continue;
    const list = readStoredKeyList((step as Record<string, unknown>).surfaceGateInputKeys);
    if (list === null) return null;
    for (const k of list) keys.add(k);
  }
  return [...keys];
}

/**
 * The keys a gate's schema says a run input must not fill: none when the
 * schema has no list; null (every run input) when its list is unreadable.
 */
export function readGateKeysNotFromRunInputs(schema: unknown): string[] | null {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
  return readStoredKeyList((schema as Record<string, unknown>)[GATE_KEYS_NOT_FROM_RUN_INPUTS]);
}

/** The run inputs a reader may merge under a stored gate's values. */
export function runInputsForGate(
  runInputs: Record<string, unknown>,
  schema: unknown,
): Record<string, unknown> {
  const keys = readGateKeysNotFromRunInputs(schema);
  return keys === null ? {} : withoutKeys(runInputs, keys);
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

/** The schema without the list key, so that only the host writes it; the same object when it has none. */
export function withoutGateKeysList(schema: Record<string, unknown>): Record<string, unknown> {
  if (!Object.prototype.hasOwnProperty.call(schema, GATE_KEYS_NOT_FROM_RUN_INPUTS)) return schema;
  return withoutKeys(schema, [GATE_KEYS_NOT_FROM_RUN_INPUTS]);
}

// ---------------------------------------------------------------------------
// WHAT A STEP'S OWN RECORD NAMES IT BY (cinatra#3226).
//
// The ratified drawing, agent run and review surface, "The step rail — merged
// steps and gate entries": "A work step shows what it did", and its drawn rail
// names every entry by the work done — "Fetched Q3 cohort", "Drafted
// re-engagement email" — never by its position. An ordinal defeats the glance:
// it is legible only by counting.
//
// THE ELECTED LADDER, in order: the executed step's own recorded name; then its
// recorded description; then the name of the work that step produced, as the
// run's own record of that step carries it (`output_data.title` / `.name`, the
// structured outputs a WayFlow or external run records). Where none of the
// three resolves the answer is `null`, and the caller does not compose an
// ordinal in its place — a step the run has no record of is not a step the
// rail can show at a glance. Identifiers are never read as names: a package
// name, an output id or an artifact id is an id, and an id never stands where
// a name belongs. A materialization outcome (`artifact_materializations[]`)
// carries ONLY identifiers — output id, node id, extension, artifact id,
// revision id — so it is never read: a rung that reads a field no real record
// carries is a rung that is dead, and a dead rung is a claim the code does not
// keep.
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** The record's own name, then its description. */
function recordedName(record: Rec): string | null {
  return text(record.name) ?? text(record.title);
}

function recordedDescription(record: Rec): string | null {
  return text(record.description);
}

/**
 * The name of the work the step produced, as the record carries it: a named
 * structured output (`output_data.title` / `.name`).
 */
function producedWorkName(record: Rec): string | null {
  const output = record.output_data;
  if (!isRecord(output)) return null;
  return text(output.title) ?? text(output.name);
}

/**
 * The label a rail entry takes from a step's own record, or `null` where the
 * record names nothing. Never an ordinal.
 */
export function stepRecordWorkName(record: unknown): string | null {
  if (!isRecord(record)) return null;
  return recordedName(record) ?? recordedDescription(record) ?? producedWorkName(record);
}

// ---------------------------------------------------------------------------
// The two readings of the scheduling step's recurrence surfaces that a value
// check alone cannot make (design#212), shared by the browser drivers
// (contract.ts, recurrenceSelectorsDriver) and the mount's unit test
// (src/app/design-fixtures/conformance/__tests__/scheduling-recurrence-
// fixtures.test.tsx), so both refuse the same things.
//
// 1. DISTINCT SENTINELS. A field that reads the wrong source field is caught
//    only when the two sources hold different values: with nthWeek 2 and
//    monthlyWeekday 2, a weekday select bound to nthWeek still draws "Tue".
//    The selects stringify what they read, so two fields hold one value when
//    their texts are equal, whether or not the surface draws them. The rule
//    covers every field of the selection, not a list of known pairs. A drawn
//    reading keeps the drawing's words even where they share a value (the
//    2nd Tuesday); it then needs an anti-alias probe of the same fields whose
//    every field holds its own value (recurrenceAliasProblems).
//
// 2. DECLARED FIELDS ONLY. A surface draws no `data-field` outside the set
//    its manifest declares. The rule reads every rendered name, not a list of
//    known recurrence names, so a name nobody listed is refused too.
// ---------------------------------------------------------------------------

/**
 * Every reason a reading's selection cannot tell its source fields apart:
 * a bound source that is not a field of the selection, a field that holds no
 * finite number or string, and every pair of fields that hold the same value
 * as text. Empty when every source is a field and every value is its own.
 */
export function recurrenceSourceCollisions(
  selection: Readonly<Record<string, unknown>>,
  boundSources: readonly string[],
): string[] {
  const { malformed, shared } = readSelection(selection, boundSources);
  return [...malformed, ...shared];
}

function readSelection(
  selection: Readonly<Record<string, unknown>>,
  boundSources: readonly string[],
): { malformed: string[]; shared: string[] } {
  const malformed: string[] = [];
  const shared: string[] = [];
  for (const source of boundSources) {
    const key = source.startsWith("selection.") ? source.slice("selection.".length) : "";
    if (key === "" || !Object.prototype.hasOwnProperty.call(selection, key)) {
      malformed.push(`${source} is not a field of the selection`);
    }
  }
  const holder = new Map<string, string>();
  for (const [key, value] of Object.entries(selection)) {
    const readable =
      (typeof value === "number" && Number.isFinite(value)) || (typeof value === "string" && value !== "");
    if (!readable) {
      malformed.push(`selection.${key} holds no finite number or non-empty string`);
      continue;
    }
    const text = String(value);
    const first = holder.get(text);
    if (first !== undefined) {
      shared.push(`selection.${first} and selection.${key} share the value "${text}"`);
    } else {
      holder.set(text, key);
    }
  }
  return { malformed, shared };
}

/**
 * Every reason a drawn reading cannot tell its source fields apart, probe
 * included. A malformed reading is refused whatever its probe. A reading whose
 * fields share a value passes only with a probe (`probeSelection`, the
 * selection of the probe that draws exactly the reading's fields) whose every
 * field holds its own value. Empty when the reading, or its probe, can tell
 * every source apart.
 */
export function recurrenceAliasProblems(
  readingSelection: Readonly<Record<string, unknown>>,
  probeSelection: Readonly<Record<string, unknown>> | undefined,
  boundSources: readonly string[],
): string[] {
  const own = readSelection(readingSelection, boundSources);
  if (own.malformed.length > 0) return [...own.malformed, ...own.shared];
  if (own.shared.length === 0) return [];
  if (probeSelection === undefined) return [...own.shared, "no anti-alias probe draws the reading's fields"];
  return recurrenceSourceCollisions(probeSelection, boundSources).map((problem) => `probe: ${problem}`);
}

/** The rendered `data-field` names outside the declared set, each once, sorted. */
export function undeclaredFieldNames(rendered: readonly (string | null)[], declared: readonly string[]): string[] {
  const allowed = new Set(declared);
  return [...new Set(rendered.map((name) => name ?? ""))].filter((name) => !allowed.has(name)).sort();
}

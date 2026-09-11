/**
 * THE `?onComplete` QUERY HALF OF THE RETURN CONTRACT (cinatra#3369,
 * acceptance item 2).
 *
 * The list picker's "Build a list with AI" CTA states, beside the link itself
 * (`list-picker-renderer.tsx`), the contract this module serves:
 *
 *   "Deep-links to a NEW list-curator-agent run. The operator completes the
 *    curator's two HITL gates (scrape-schema-review + final-list-review) there;
 *    on completion they return to this picker with the new listId pre-selected
 *    via the ?onComplete query param."
 *
 * Two halves, and a proof round on a development boot measured that NEITHER
 * existed: the launcher minted the run and redirected to its address with no
 * query at all, so `onComplete` never reached the run; and no module anywhere
 * read `onComplete` back out, so a curator run that finished changed nothing
 * about the picker it was launched from.
 *
 * WHERE THE TWO HALVES LIVE, and why they are not one module. This one is the
 * QUERY: the param, its one accepted value, and the two plain functions the
 * launcher (`instance-screens.tsx`) spells it with. The HAND-BACK -- the key a
 * finished curator run leaves its finish under and the two functions that write
 * and take it -- lives in `list-picker-renderer.tsx`, the module that owns the
 * CTA and reads the hand-back back.
 *
 * That split is MEASURED, not stylistic. `scripts/route-graph.mjs` counts the
 * reachable first-party module graph of the locked routes, and
 * `list-picker-renderer.tsx` is already inside the graph of all four tracked
 * application routes (/api/mcp, /chat, /api/a2a, /api/llm-bridge) through the
 * field-renderer registry, while this launcher-side module is inside none of
 * them. A leaf imported by the picker is therefore a new module on every one of
 * those four graphs -- measured at exactly +1 on each, over their pinned
 * ceilings -- whereas the same functions in the picker's own module are +0. The
 * hand-back is the picker's own contract anyway, so it is stated where it is
 * read.
 */

/** The query param the CTA carries, verbatim. */
export const ON_COMPLETE_PARAM = "onComplete";

/** The ONE destination the product defines for it. */
export const LIST_PICKER_ON_COMPLETE = "list-picker";

export type OnCompleteDestination = typeof LIST_PICKER_ON_COMPLETE;

/**
 * The destination a launch was opened for, or `null`.
 *
 * A CLOSED SET, never an echo of what the URL carried: the value is compared
 * against the one destination the product defines before anything is done with
 * it, so an unknown, repeated or hostile `?onComplete=` is read as "no
 * destination" rather than travelling onto the fresh run's own address.
 */
export function readOnCompleteDestination(
  searchParams: Record<string, string | string[] | undefined> | undefined,
): OnCompleteDestination | null {
  const raw = searchParams?.[ON_COMPLETE_PARAM];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === LIST_PICKER_ON_COMPLETE ? LIST_PICKER_ON_COMPLETE : null;
}

/**
 * The same path, carrying the destination the launch was opened for.
 *
 * Appended BESIDE `buildAgentInstancePath` rather than through it: the shared
 * path helper is what several other callers (notifications, the MCP handlers,
 * the chat, the dashboards) address a run by, and this query belongs to one
 * launch road, not to the grammar of an agent's address.
 */
export function withOnCompleteDestination(
  path: string,
  destination: OnCompleteDestination | null,
): string {
  if (destination === null) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}${ON_COMPLETE_PARAM}=${encodeURIComponent(destination)}`;
}

// ---------------------------------------------------------------------------
// The access-scope token vocabulary: the ONE definition of a visibility token
// and of the rule that canonicalises a set of them.
//
// WHY IT LIVES HERE. The access picker draws these tokens and canonicalises a
// selection live on every click, and the picker is a shared control this
// package now owns (cinatra#3385). The rule is a pure array transform: no
// schema, no store, no session, no authorization call. Keeping it beside the
// picker is what lets the picker ship without a dependency on the agent core,
// which already depends on this package.
//
// WHAT STAYS IN THE AGENT CORE. The policy SHAPE, its zod schema and every
// authorization decision stay in `@cinatra-ai/agents/auth-policy-types`, which
// re-exports the three names below under its own names so its callers are
// unchanged. A picker may canonicalise a set; only the server decides whether
// the resulting grant is allowed, and it re-derives that for itself.
// ---------------------------------------------------------------------------

/**
 * One visibility token. A backward-compatible superset of the original
 * "owner" | "org" | "admin" set: JSONB columns accept the wider string
 * literal range without a database change.
 */
export type AccessVisibility =
  | "owner"
  | "org"
  | `org:${string}`
  | "admin"
  | "workspace"
  | `team:${string}`
  | `project:${string}`;

/**
 * A visibility SELECTION: a NON-EMPTY array of tokens. Multi-scope access
 * (#1069) makes each access field a union of grants: an actor matching ANY
 * token is admitted.
 *
 * Non-emptiness is encoded as a tuple `[T, ...T[]]` so that `selection[0]` is
 * always a defined token (never `T | undefined`) and the empty selection is
 * structurally unrepresentable. Every write is an array; a stored scalar
 * policy coerces to a one-element array at parse time.
 */
export type AccessVisibilitySelection = [AccessVisibility, ...AccessVisibility[]];

/**
 * Canonicalize a visibility selection to its stored form.
 *
 * Invariants (#1069 / #1070):
 *   - dedupe, preserving first-seen order
 *   - `workspace` present  ⇒  the selection is exactly `["workspace"]`
 *     (workspace = "everyone in the workspace"; any narrower token is subsumed)
 *   - `owner` mixed with ANY other token is stripped, because the owner always retains
 *     access, so listing `owner` alongside a wider grant is redundant. `owner`
 *     alone stays `["owner"]`.
 *   - `admin` IS mixable (an owner-aware positive grant, e.g. `admin + team:X`
 *     is a meaningful union) and is never stripped.
 *   - NO upward collapse: an explicit set of team/project tokens is never
 *     rewritten to `org:<id>`; org-implied team tokens are never stripped.
 *   - the result is ALWAYS non-empty (an all-`owner` or empty input yields
 *     `["owner"]`).
 *
 * This does NOT validate token shape: callers pass already-typed tokens (the
 * schema owns shape validation). It canonicalizes the SET only.
 */
export function normalizeVisibilitySelection(
  input: readonly AccessVisibility[],
): AccessVisibilitySelection {
  // Dedupe, preserving first-seen order.
  const deduped: AccessVisibility[] = [];
  for (const tok of input) {
    if (!deduped.includes(tok)) deduped.push(tok);
  }

  // `workspace` subsumes every narrower token, so collapse to exactly workspace.
  if (deduped.includes("workspace")) return ["workspace"];

  // Strip `owner` when mixed with any other token (the owner always retains
  // access). `owner` alone is preserved. `admin` and every scoped token stay:
  // no upward collapse, no implied-token stripping.
  const hasOther = deduped.some((t) => t !== "owner");
  const result = hasOther ? deduped.filter((t) => t !== "owner") : deduped;

  // Non-empty guarantee: an all-`owner` selection (or an empty input) is
  // `["owner"]`.
  if (result.length === 0) return ["owner"];
  return result as AccessVisibilitySelection;
}

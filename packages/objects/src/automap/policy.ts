// ---------------------------------------------------------------------------
// Per-type CRUD policy.
// ---------------------------------------------------------------------------
//
// Every object type statically registers may declare a `crudPolicy`
// describing how the agent-output dispatcher (`./dispatcher.ts`) should route
// freshly-classified agent output. Without a policy the dispatcher always
// emits HITL — the system never silently guesses.
//
// The policy is consumed by `decideDispatch` and (when classifier confidence
// drops below `hitlConfidenceThreshold` OR a required field is missing OR the
// data has no `identityKey`) the dispatcher falls back to a structured HITL
// event instead of writing.

/** What to do when `identityKey(data)` resolves AND a matching object exists. */
export type AutomapOnMatch = "update" | "merge" | "skip";

/** What to do when no existing object matches (or `identityKey` returns null). */
export type AutomapOnNoMatch = "create" | "hitl";

export type AutomapCrudPolicy = {
  /** Operation to use when an existing object matches the `identityKey`. */
  onMatch: AutomapOnMatch;
  /**
   * Operation to use when no existing object matches OR the data has no
   * resolvable identity. `hitl` surfaces the ambiguity rather than guessing.
   */
  onNoMatch: AutomapOnNoMatch;
  /**
   * For `onMatch: "merge"`: the data field paths that may be combined on the
   * merged record (non-listed fields fall back to `update` semantics: the new
   * value replaces the existing).
   */
  mergeableFields?: readonly string[];
  /**
   * For `onMatch: "update"`: the field paths that are intentionally
   * preserved on the existing record even if the incoming output sets them.
   * Use case: `createdAt` should never be overwritten by an agent update.
   */
  preserveOnUpdate?: readonly string[];
  /**
   * Minimum classifier confidence (0..1) required to auto-route. Below this
   * threshold the dispatcher emits a `hitl` event with the original output
   * attached. Default 0.6 when the policy omits it.
   */
  hitlConfidenceThreshold?: number;
  /**
   * Fields the output MUST carry for the dispatcher to write — missing any
   * one routes to `hitl`. (`identityKey` resolution is implicit and uses the
   * type's `identityKey` fn; this lets each type declare additional must-
   * haves like `email` for contacts or `companyUrl` for accounts.)
   */
  requiredFields?: readonly string[];
};

/** The default `hitlConfidenceThreshold` used when a policy omits one. */
export const DEFAULT_HITL_CONFIDENCE_THRESHOLD = 0.6;

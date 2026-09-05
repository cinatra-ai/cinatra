// THE canonical inventory of direct production callers of the run-creation
// primitives (cinatra#2813 S1, epic #2812; consumed by the per-scope-surfaces
// epic for its launch anchors).
//
// WHY THIS FILE EXISTS. Two epics need to say "every way a run is created does
// X" and have that be checkable rather than asserted. `RUN_PRODUCERS`
// (lifecycle-coordinator.ts) already names every way a run is BORN; this file
// names every place the run-creation PRIMITIVES are actually called, which is
// a different and much shorter list — and it carries, per entry, the two
// dispositions the epics ask about:
//
//   * `snapshot` — where the run's immutable assignment-scope snapshot comes
//     from at this call site;
//   * `launchAnchor` — which launch the site is anchored to;
//   * `anchor` + `anchorWhy` — whether the run created here carries a
//     LAUNCH SCOPE ANCHOR (cinatra#2809, epic #2806), or deliberately carries
//     none. Added by the per-scope-surfaces slice as a FIELD on this one
//     inventory rather than as a second list, because the issue that needs it
//     says so: "no second inventory is permitted".
//
// A NEW writer that calls a run-creation primitive without appearing here
// fails `run-creation-call-sites.test.ts`. That is the whole point: the
// inventory cannot rot quietly, because the test walks the source.
//
// GROUNDED SHAPE (verified against the tree this slice was built on): run
// creation is FUNNELLED. `launchAgentRun` is the single fence every producer
// goes through, and it is the only module that calls `createAgentRun` /
// `createAgentRunPendingInput` in production code. The snapshot is therefore
// derived ONCE, inside the store, from the org/project/actor the launch
// already resolved — so a producer cannot forget it, and a producer added
// tomorrow gets it for free. Entries whose `snapshot` is `derived_at_store`
// are making exactly that statement.

import { RUN_PRODUCERS } from "../lifecycle-coordinator";

/** Where the run's assignment-scope snapshot comes from at a call site. */
export type SnapshotDisposition =
  /** The store derives it from the org / project / actor of the create input. */
  | "derived_at_store"
  /** The call site computes and supplies it explicitly. */
  | "supplied_by_caller";

/**
 * Whether a run created at this site carries a launch scope anchor
 * (cinatra#2809): the vantage the launch was made from, which decides the
 * run's one canonical address.
 */
export const ANCHOR_DISPOSITIONS = Object.freeze([
  /** The launch fence threads the anchor the launching ROUTE decided. */
  "threaded_from_launch",
  /** This site launches from no vantage of ours and persists NO anchor. */
  "explicitly_unanchored",
] as const);

export type AnchorDisposition = (typeof ANCHOR_DISPOSITIONS)[number];

export type RunCreationCallSite = {
  /** The run-creation primitive this site calls. */
  readonly entry: "createAgentRun" | "createAgentRunPendingInput";
  /** The module the call lives in. */
  readonly module: string;
  /** Where the immutable assignment-scope snapshot comes from here. */
  readonly snapshot: SnapshotDisposition;
  /** The launch this site is anchored to. Never empty. */
  readonly launchAnchor: string;
  /** Whether the created run carries a launch scope anchor (cinatra#2809). */
  readonly anchor: AnchorDisposition;
  /** One line: WHY that disposition. Never empty. */
  readonly anchorWhy: string;
  /** One line: what this call site is for. */
  readonly what: string;
};

export const RUN_CREATION_CALL_SITES: readonly RunCreationCallSite[] = Object.freeze([
  {
    entry: "createAgentRunPendingInput",
    module: "packages/agents/src/lifecycle-coordinator.ts",
    snapshot: "derived_at_store",
    launchAnchor: "launchAgentRun (create.kind: pre_dispatch)",
    anchor: "threaded_from_launch",
    anchorWhy:
      "the fence passes LaunchInput.launchScopeAnchor straight through to the primitive; a producer that launched from no vantage of ours omits it and the run stays unanchored, which is the honest record rather than an inferred home",
    what: "the pre-dispatch half of the launch fence — a run created and left waiting for its trigger or its Run button",
  },
  {
    entry: "createAgentRun",
    module: "packages/agents/src/lifecycle-coordinator.ts",
    snapshot: "derived_at_store",
    launchAnchor: "launchAgentRun (create.kind: full)",
    anchor: "threaded_from_launch",
    anchorWhy:
      "the same single fence, on the create-and-start half — so a composed or recurring descendant inherits its parent's anchor by handing the parent's value back in here",
    what: "the create-and-start half of the launch fence — every producer that starts a run now",
  },
]);

/**
 * The producers each call site stands for.
 *
 * Every entry of `RUN_PRODUCERS` reaches the primitives through the launch
 * fence, so the mapping is total by construction — the inventory test proves
 * it rather than trusting this comment.
 */
export const PRODUCERS_BEHIND_CALL_SITES: readonly string[] = Object.freeze(
  RUN_PRODUCERS.map((p) => p.key),
);

/** The primitive names the source scan looks for. */
export const RUN_CREATION_PRIMITIVES = Object.freeze([
  "createAgentRun",
  "createAgentRunPendingInput",
] as const);

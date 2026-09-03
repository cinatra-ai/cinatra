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
//   * `launchAnchor` — which launch the site is anchored to.
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

export type RunCreationCallSite = {
  /** The run-creation primitive this site calls. */
  readonly entry: "createAgentRun" | "createAgentRunPendingInput";
  /** The module the call lives in. */
  readonly module: string;
  /** Where the immutable assignment-scope snapshot comes from here. */
  readonly snapshot: SnapshotDisposition;
  /** The launch this site is anchored to. Never empty. */
  readonly launchAnchor: string;
  /** One line: what this call site is for. */
  readonly what: string;
};

export const RUN_CREATION_CALL_SITES: readonly RunCreationCallSite[] = Object.freeze([
  {
    entry: "createAgentRunPendingInput",
    module: "packages/agents/src/lifecycle-coordinator.ts",
    snapshot: "derived_at_store",
    launchAnchor: "launchAgentRun (create.kind: pre_dispatch)",
    what: "the pre-dispatch half of the launch fence — a run created and left waiting for its trigger or its Run button",
  },
  {
    entry: "createAgentRun",
    module: "packages/agents/src/lifecycle-coordinator.ts",
    snapshot: "derived_at_store",
    launchAnchor: "launchAgentRun (create.kind: full)",
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

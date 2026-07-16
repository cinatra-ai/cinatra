// G2 — artifact-UI per-arm CUTOVER MATRIX (epic #1620 / #1624 S6).
//
// The consumable contract every migration wave (S4/S7/S8/S9) runs an arm
// through BEFORE it deletes the legacy host-side arm. The boundary is only safe
// to shrink (drop a G1 baseline entry) once its replacement is proven to
// dispatch correctly in EVERY world-state — otherwise a half-cut arm blanks the
// surface. This module is PURE (types only, no React/DB/registry singletons) so
// a wave can import it and drive its OWN dispatch through it, in the app or in a
// package (chat/agents), without a heavy dependency.
//
// The matrix is deliberately SYSTEM-AWARE. The dispatch spine (S2) has two
// arbitration systems that NEVER share a keyspace:
//   - a REPRESENTATION viewer resolves via the org-scoped representation-provider
//     registry (a first-party host default sits underneath — the floor);
//   - a SEMANTIC renderer resolves via the per-org EFFECTIVE IDENTITY winner.
// A migration must select through the CORRECT system for its arm; a
// cross-applied selection (a viewer resolved as a semantic winner, or vice
// versa) is always a failure — that is how a losing claimant's module would leak.
//
// Usage (a wave):
//   const report = evaluateArmCutover({
//     system: "representation-viewer",
//     arm: "application/pdf",
//     observe: (caseId) => driveMyDispatchForCase(caseId),  // wave's real probe
//   });
//   expect(report.ready).toBe(true);   // only then delete the legacy arm

/** The two arbitration systems of the dispatch spine. */
export type CutoverSystem = "representation-viewer" | "semantic-renderer";

/** The matrix columns — the world-states a cutover must survive. */
export type CutoverCaseId =
  | "provider-registered"
  | "enabled-and-selected"
  | "selected-via-correct-registry"
  | "precedence"
  | "disabled"
  | "uninstalled"
  | "incompatible"
  | "failing"
  | "floor-recovery"
  | "single-module-executes";

/** The observable dispatch OUTCOME for a case, in system-neutral terms. */
export type CutoverOutcome =
  /** the extension-shipped renderer/viewer resolved + executed */
  | "extension"
  /** a resolved-but-unbuilt claimant degraded to generic + "requires rebuild" */
  | "requires-rebuild"
  /** the always-effective first-party host default (representation floor) */
  | "first-party-floor"
  /** the generic read-only structured-data view (terminal floor) */
  | "generic-floor"
  /** the arm was selected through the WRONG system (viewer↔semantic) — a leak */
  | "cross-applied"
  /** nothing resolved (used only where the matrix expects a floor) */
  | "none";

export interface CutoverCase {
  id: CutoverCaseId;
  title: string;
  /** What must hold before the legacy arm may be removed. */
  requirement: string;
}

/** The canonical, ordered matrix. Extending it TIGHTENS every wave's proof. */
export const ARTIFACT_UI_CUTOVER_MATRIX: readonly CutoverCase[] = [
  {
    id: "provider-registered",
    title: "Provider registered",
    requirement:
      "The extension-shipped renderer/viewer is registered in its system's registry (representation-provider registry for a viewer; semantic-type registry bound to effective identity for a semantic renderer).",
  },
  {
    id: "enabled-and-selected",
    title: "Enabled AND selected",
    requirement:
      "With the provider enabled and effective for the org, the arm's row RESOLVES to the extension module (not merely registered — actually selected).",
  },
  {
    id: "selected-via-correct-registry",
    title: "Selected via the correct registry (never cross-applied)",
    requirement:
      "A viewer resolves via the representation-provider registry ONLY; a semantic renderer via effective identity ONLY. A cross-applied resolution is a hard failure.",
  },
  {
    id: "precedence",
    title: "Precedence",
    requirement:
      "When multiple candidates match, the correct one wins the documented precedence (semantic winner over representation; exact over wildcard over catch-all within representations).",
  },
  {
    id: "disabled",
    title: "Disabled provider",
    requirement:
      "With the provider present but DISABLED for the org, the row falls to the always-effective first-party host default (viewer) / generic floor (semantic) — never blank.",
  },
  {
    id: "uninstalled",
    title: "Uninstalled provider",
    requirement:
      "With no provider installed, the row falls deterministically to the floor (first-party host default or generic).",
  },
  {
    id: "incompatible",
    title: "Incompatible / not built",
    requirement:
      "A runtime-installed claimant whose module is ABSENT from this build degrades to the generic renderer + a 'requires rebuild' diagnostic (never blank).",
  },
  {
    id: "failing",
    title: "Failing renderer",
    requirement:
      "A renderer that fails (pre-render error) degrades to the generic floor + a sanitized diagnostic; it never crashes the route or blanks the surface.",
  },
  {
    id: "floor-recovery",
    title: "Deterministic floor recovery",
    requirement:
      "The explicit generic-floor escape (e.g. ?renderer=generic / the route-segment error boundary) always yields the generic read-only view.",
  },
  {
    id: "single-module-executes",
    title: "Only the resolved module executes",
    requirement:
      "Exactly ONE concrete renderer module runs for the resolved row — no losing claimant's module and no double-mount.",
  },
];

const CASE_IDS = ARTIFACT_UI_CUTOVER_MATRIX.map((c) => c.id);

/**
 * The REQUIRED outcome for a (system, case). This is the matrix's truth table —
 * a wave's observed outcome must equal it (and `single-module-executes` also
 * requires exactly one module to have executed). `cross-applied` is never a
 * required outcome, so observing it always fails.
 */
export function requiredOutcome(system: CutoverSystem, caseId: CutoverCaseId): CutoverOutcome {
  switch (caseId) {
    case "provider-registered":
    case "enabled-and-selected":
    case "selected-via-correct-registry":
    case "precedence":
    case "single-module-executes":
      return "extension";
    case "disabled":
    case "uninstalled":
      return system === "representation-viewer" ? "first-party-floor" : "generic-floor";
    case "incompatible":
      return "requires-rebuild";
    case "failing":
    case "floor-recovery":
      return "generic-floor";
    default: {
      const _exhaustive: never = caseId;
      return _exhaustive;
    }
  }
}

/** What a wave OBSERVES for a case by driving its real dispatch. */
export interface CutoverObservation {
  outcome: CutoverOutcome;
  /** How many concrete renderer modules executed (checked by
   * `single-module-executes`). Omit where not measured; the single-module case
   * then fails, since the invariant is unproven. */
  modulesExecuted?: number;
  detail?: string;
}

export interface CutoverCaseResult {
  id: CutoverCaseId;
  ok: boolean;
  expected: CutoverOutcome;
  observed: CutoverOutcome;
  detail?: string;
}

export interface CutoverReport {
  system: CutoverSystem;
  arm: string;
  ready: boolean;
  cases: CutoverCaseResult[];
  unmet: CutoverCaseId[];
}

/**
 * Evaluate an arm against the whole matrix. `observe(caseId)` is the wave's
 * probe: it sets up the case's world-state, drives the REAL dispatch, and
 * reports what happened. The wave asserts `report.ready` before removing the
 * legacy arm (and dropping the arm's G1 baseline entry in the same PR).
 */
export function evaluateArmCutover(args: {
  system: CutoverSystem;
  arm: string;
  observe: (caseId: CutoverCaseId) => CutoverObservation;
}): CutoverReport {
  const cases: CutoverCaseResult[] = CASE_IDS.map((id) => {
    const expected = requiredOutcome(args.system, id);
    let observation: CutoverObservation;
    try {
      observation = args.observe(id);
    } catch (err) {
      observation = { outcome: "none", detail: `probe threw: ${(err as Error)?.message ?? String(err)}` };
    }
    let ok = observation.outcome === expected;
    // The single-module invariant additionally requires exactly one module.
    if (ok && id === "single-module-executes") ok = observation.modulesExecuted === 1;
    return { id, ok, expected, observed: observation.outcome, detail: observation.detail };
  });
  const unmet = cases.filter((c) => !c.ok).map((c) => c.id);
  return { system: args.system, arm: args.arm, ready: unmet.length === 0, cases, unmet };
}

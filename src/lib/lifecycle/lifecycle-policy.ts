/**
 * The lifecycle-interceptions POLICY LATTICE (cinatra#2038, epic #2037 S0).
 *
 * Core intercepts the artifact lifecycle at three checkpoints — skill
 * recommendation (R, pre-production), review (V, post-production), and
 * post-change verification (A) — for EVERY producing agent, without any agent
 * composing its own recommender/reviewer/auditor. WHETHER a checkpoint fires for
 * a given produced artifact is decided by this lattice, not by agent wiring.
 *
 * THE LATTICE (four layers, outer beats inner):
 *
 *   1. ORG BOUNDS — an org-scoped rule per (checkpoint, artifact type,
 *      destination class, originKind): `required` (the gate MUST fire; a floor on
 *      review) or `forbidden` (the gate MUST NOT fire; a ceiling). `silent` = the
 *      org expresses no bound → the UNCONSTRAINED region where the inner layers
 *      decide. A bound is absolute: nothing below can weaken `required` or fire a
 *      `forbidden` gate.
 *   2. CORE DEFAULTS (normative — see `coreDefault`) — apply ONLY in the
 *      unconstrained (org-silent) region.
 *   3. AGENT-MANIFEST DECLARATIONS — refine WITHIN bounds: a manifest may request
 *      a checkpoint SKIP, which takes effect ONLY where the org is silent AND the
 *      class is NOT an external-effect class (external-effect gates fail closed —
 *      a manifest can never skip them). A manifest can never fire a `forbidden`
 *      gate nor skip a `required` one.
 *   4. PER-RUN USER ELEVATION — ELEVATES ONLY: a present human may force a
 *      checkpoint ON that the defaults/manifest left off. There is NO API to
 *      weaken — a run choice can never skip a `required` gate (nor any gate the
 *      lattice fired).
 *
 * FAIL-CLOSED: when the checkpoint's core default is INDETERMINATE at
 * produced-event time (e.g. verification, which depends on a later
 * `changes_requested` signal) the outcome is `policy_unresolved` on an
 * external-effect class (the protected effect is BLOCKED until an explicit later
 * policy decision) and a plain ungated `skip` on a non-external class.
 *
 * PURE (no React / DB / server-only): the lattice is a total function of its
 * inputs so it is exhaustively matrix-testable and shared by every emitter's
 * evaluate-then-continue seam (S1). The org-rule LOOKUP + the compiled-manifest
 * READ are injected — the store side lives in
 * `packages/agents/src/lifecycle-policy-store.ts`.
 */

import type { ArtifactOriginKind } from "@cinatra-ai/artifacts";

// ---------------------------------------------------------------------------
// Axes.
// ---------------------------------------------------------------------------

/** The three interception checkpoints (Point R / V / A). "verification" is the
 * name of the third interception — never "audit" (epic decision 5). */
export type LifecycleCheckpoint = "recommendation" | "review" | "verification";

export const LIFECYCLE_CHECKPOINTS: readonly LifecycleCheckpoint[] = [
  "recommendation",
  "review",
  "verification",
] as const;

/**
 * The destination-effect class of a produced artifact — the axis the external-
 * effect fail-closed rule keys on. `none` is a plain durable LOCAL artifact with
 * no external effect; the other three are the typed effect classes the async
 * effects-gated continuation holds (external publish/apply, visibility promotion,
 * pipeline hand-off).
 */
export type DestinationClass =
  | "none"
  | "external_publish"
  | "visibility_promotion"
  | "pipeline_handoff";

export const DESTINATION_CLASSES: readonly DestinationClass[] = [
  "none",
  "external_publish",
  "visibility_promotion",
  "pipeline_handoff",
] as const;

const EXTERNAL_EFFECT_CLASSES: ReadonlySet<DestinationClass> = new Set<DestinationClass>([
  "external_publish",
  "visibility_promotion",
  "pipeline_handoff",
]);

/** An external-effect class fails CLOSED on unevaluable policy — its protected
 * effect is blocked until an explicit policy decision. `none` never blocks. */
export function isExternalEffectClass(dest: DestinationClass): boolean {
  return EXTERNAL_EFFECT_CLASSES.has(dest);
}

/**
 * The provenance/durability axis the lattice keys on. Deliberately a SUPERSET of
 * the physical `ArtifactOriginKind`: the lattice reasons about durable
 * agent-produced vs human-provided vs ephemeral/intermediate, which S1 derives
 * from the emitter's `ArtifactOriginKind` via `lifecycleOriginKind`.
 */
export type LifecycleOriginKind = "agent_produced" | "user_provided" | "intermediate";

export const LIFECYCLE_ORIGIN_KINDS: readonly LifecycleOriginKind[] = [
  "agent_produced",
  "user_provided",
  "intermediate",
] as const;

/** Map a physical `ArtifactOriginKind` onto the lattice's provenance axis. S1's
 * emitters carry the physical kind; the lattice reasons on this coarse axis. */
export function lifecycleOriginKind(kind: ArtifactOriginKind): LifecycleOriginKind {
  switch (kind) {
    case "agent_generated":
      return "agent_produced";
    case "live_generator":
      return "intermediate";
    case "upload":
    case "email_attachment":
    case "external_link":
      return "user_provided";
    default: {
      // Exhaustiveness guard: a NEW ArtifactOriginKind must be classified here
      // deliberately, not silently defaulted. Fail toward the conservative
      // (durable) class so a novel kind is reviewed, never silently skipped.
      const _exhaustive: never = kind;
      void _exhaustive;
      return "agent_produced";
    }
  }
}

// ---------------------------------------------------------------------------
// Org bounds.
// ---------------------------------------------------------------------------

/** An org bound value. `silent` is the ABSENCE of a bound (the unconstrained
 * region) — it is never persisted as a row; the lookup returns it as the
 * no-rule signal. */
export type PolicyBound = "required" | "forbidden" | "silent";

/** The key an org rule is stored + looked up under. */
export interface PolicyRuleKey {
  checkpoint: LifecycleCheckpoint;
  artifactType: string;
  destinationClass: DestinationClass;
  originKind: LifecycleOriginKind;
}

/** The org bound for a key + whether the org opted INTO self-approval on its
 * `required` gates (SoD default is that the producing actor may NOT be the sole
 * approver; an explicit opt-in relaxes it). */
export interface OrgPolicyRule {
  bound: PolicyBound;
  /** Only meaningful for `required`; ignored otherwise. Default false. */
  selfApprovalOptIn?: boolean;
}

/** The injected org-rule lookup — the store resolves the most-specific matching
 * rule (or `silent` when none). Pure callers pass a plain function. */
export type OrgPolicyLookup = (key: PolicyRuleKey) => OrgPolicyRule;

// ---------------------------------------------------------------------------
// Compiled agent-manifest declarations (trigger-style: compiled onto
// agent_templates by the manifest compiler, read here).
// ---------------------------------------------------------------------------

/** The lifecycle block an agent manifest declares, compiled onto
 * `agent_templates.lifecycle_config` exactly as `trigger_mode`/`gated_steps`
 * are. Refines WITHIN org bounds only. */
export interface CompiledManifestLifecycle {
  /** Checkpoints the agent requests SKIPPED. Honored ONLY where the org is
   * silent AND the class is non-external. */
  requestedSkips?: LifecycleCheckpoint[];
  /** Artifact types this agent declares it produces (informational; S1 uses it
   * for emitter fan-out, the lattice does not gate on it). */
  producedTypes?: string[];
  /** Whether this producer can implement a typed repair (S2). Recorded here;
   * unused by the lattice at S0. */
  repairCapable?: boolean;
}

// ---------------------------------------------------------------------------
// Per-run user elevation (ELEVATES ONLY).
// ---------------------------------------------------------------------------

/** A present human's per-run choice. Structurally can ONLY strengthen: it forces
 * checkpoints ON. There is deliberately no "requestOff" field — a run choice can
 * never weaken a gate the lattice fired (nor a `required` bound). */
export interface RunElevation {
  forceOn?: LifecycleCheckpoint[];
}

// ---------------------------------------------------------------------------
// Evaluation input + output.
// ---------------------------------------------------------------------------

export interface EvaluatePolicyInput {
  checkpoint: LifecycleCheckpoint;
  artifactType: string;
  destinationClass: DestinationClass;
  originKind: LifecycleOriginKind;
  /** A human is present on the run (recommendation runs for human-present only;
   * headless auto-applies/skips and NEVER parks — epic decision 6). */
  humanPresent: boolean;
  /** The `changes_requested` signal, when known — makes verification fire. At
   * produced-event time it is typically undefined (the signal is later), so
   * verification defaults to INDETERMINATE. */
  changesRequestedOccurred?: boolean;
  orgRule: OrgPolicyRule;
  manifest?: CompiledManifestLifecycle;
  elevation?: RunElevation;
}

/** The lattice verdict. `fired` is the single boolean every emitter branches on;
 * the rest is provenance for the run-timeline record + the SoD downstream. */
export type PolicyOutcome =
  /** Org-`required`: the gate fires and SoD applies (producer not sole approver
   * unless org opt-in). */
  | "required"
  /** The gate fires by default/manifest/elevation (self-approval allowed). */
  | "fire"
  /** The gate does not fire (default/manifest skip, or a non-external
   * indeterminate default). */
  | "skip"
  /** Org-`forbidden`: the gate is barred (a hard non-fire). */
  | "forbidden"
  /** Unevaluable policy on an EXTERNAL-effect class: the protected effect is
   * BLOCKED (fail-closed) until an explicit later policy decision. */
  | "policy_unresolved";

export interface PolicyDecision {
  outcome: PolicyOutcome;
  /** Convenience: the checkpoint's gate actually fires. */
  fired: boolean;
  /** True only when the outcome is `required` (org floor) and the org did NOT
   * opt into self-approval — the SoD constraint the decision-submit re-check
   * enforces (producer never the sole approver). */
  separationOfDutiesRequired: boolean;
  /** A stable, human-readable reason for the run-timeline record. */
  reason: string;
  /** Which lattice layer produced the outcome (for observability). */
  decidedBy: "org-bound" | "core-default" | "manifest" | "elevation" | "fail-closed";
}

// ---------------------------------------------------------------------------
// Core defaults (NORMATIVE — the lattice is implementable from this alone).
// ---------------------------------------------------------------------------

/** A core-default verdict before the external-effect fail-closed resolution.
 * `indeterminate` = the default cannot decide at produced-event time (it
 * depends on a later signal); the caller resolves it to `policy_unresolved`
 * (external) or `skip` (non-external). */
export type CoreDefault = "fire" | "skip" | "indeterminate";

/**
 * The normative core default for a checkpoint in the UNCONSTRAINED region.
 *
 *   recommendation — ON for human-present runs (skip-when-empty is a downstream
 *     concern; the lattice fires it), OFF (skip) for headless runs.
 *   review — ON for durable agent-produced artifacts AND for anything with an
 *     external-effect class; OFF for ephemeral/intermediate; OFF (skip) for a
 *     plain human-provided local artifact.
 *   verification — ON on a remote apply (external_publish) and whenever
 *     `changes_requested` occurred; otherwise INDETERMINATE (the signal is
 *     later).
 */
export function coreDefault(input: {
  checkpoint: LifecycleCheckpoint;
  destinationClass: DestinationClass;
  originKind: LifecycleOriginKind;
  humanPresent: boolean;
  changesRequestedOccurred?: boolean;
}): CoreDefault {
  const { checkpoint, destinationClass, originKind, humanPresent } = input;
  switch (checkpoint) {
    case "recommendation":
      return humanPresent ? "fire" : "skip";
    case "review":
      if (isExternalEffectClass(destinationClass)) return "fire";
      if (originKind === "intermediate") return "skip";
      if (originKind === "agent_produced") return "fire";
      return "skip"; // user_provided, non-external, durable
    case "verification":
      if (input.changesRequestedOccurred) return "fire";
      if (destinationClass === "external_publish") return "fire"; // remote apply
      return "indeterminate";
    default: {
      const _exhaustive: never = checkpoint;
      void _exhaustive;
      return "indeterminate";
    }
  }
}

// ---------------------------------------------------------------------------
// The lattice evaluator.
// ---------------------------------------------------------------------------

/**
 * Evaluate the four-layer lattice for one checkpoint. Total + deterministic.
 *
 * Precedence: org bound (required/forbidden are absolute) → core default (silent
 * region) → manifest skip (silent, non-external only) → per-run elevation
 * (force-on only) → external-effect fail-closed for an indeterminate default.
 */
export function evaluatePolicy(input: EvaluatePolicyInput): PolicyDecision {
  const {
    checkpoint,
    destinationClass,
    originKind,
    humanPresent,
    changesRequestedOccurred,
    orgRule,
    manifest,
    elevation,
  } = input;

  // Layer 1 — ORG BOUNDS beat everything.
  if (orgRule.bound === "required") {
    // Nothing below can weaken a required gate (elevation only strengthens; a
    // manifest skip is ignored). SoD applies unless the org opted in.
    return {
      outcome: "required",
      fired: true,
      separationOfDutiesRequired: orgRule.selfApprovalOptIn !== true,
      reason: `org policy requires ${checkpoint} for this class`,
      decidedBy: "org-bound",
    };
  }
  if (orgRule.bound === "forbidden") {
    // A hard non-fire: no manifest/elevation can fire a forbidden gate.
    return {
      outcome: "forbidden",
      fired: false,
      separationOfDutiesRequired: false,
      reason: `org policy forbids ${checkpoint} for this class`,
      decidedBy: "org-bound",
    };
  }

  // Layer 2 — CORE DEFAULT (org is silent → the unconstrained region).
  const base = coreDefault({
    checkpoint,
    destinationClass,
    originKind,
    humanPresent,
    changesRequestedOccurred,
  });

  // Resolve an INDETERMINATE default via the external-effect fail-closed rule
  // BEFORE manifest/elevation: an unevaluable external-effect gate blocks (and a
  // manifest may never skip it); a non-external one proceeds ungated but an
  // elevation may still force it on.
  if (base === "indeterminate") {
    if (isExternalEffectClass(destinationClass)) {
      // Elevation cannot resolve an unevaluable external effect — the block is
      // released only by an explicit later policy decision.
      return {
        outcome: "policy_unresolved",
        fired: false,
        separationOfDutiesRequired: false,
        reason: `${checkpoint} policy is unevaluable for an external-effect class — blocked pending an explicit decision`,
        decidedBy: "fail-closed",
      };
    }
    // Non-external + indeterminate → proceed ungated, unless the run elevates.
    if (elevation?.forceOn?.includes(checkpoint)) {
      return {
        outcome: "fire",
        fired: true,
        separationOfDutiesRequired: false,
        reason: `per-run elevation forced ${checkpoint} on`,
        decidedBy: "elevation",
      };
    }
    return {
      outcome: "skip",
      fired: false,
      separationOfDutiesRequired: false,
      reason: `${checkpoint} default is indeterminate for a non-external class — proceed ungated`,
      decidedBy: "core-default",
    };
  }

  // Layer 3 — MANIFEST refinement (silent region, non-external only). A manifest
  // skip on an external-effect class is IGNORED (external gates fail closed).
  let outcome: PolicyOutcome = base === "fire" ? "fire" : "skip";
  let decidedBy: PolicyDecision["decidedBy"] = "core-default";
  let reason =
    base === "fire"
      ? `core default fires ${checkpoint}`
      : `core default skips ${checkpoint}`;

  const manifestWantsSkip = manifest?.requestedSkips?.includes(checkpoint) === true;
  if (manifestWantsSkip && base === "fire" && !isExternalEffectClass(destinationClass)) {
    outcome = "skip";
    decidedBy = "manifest";
    reason = `agent manifest requested ${checkpoint} skipped (org silent, non-external)`;
  }

  // Layer 4 — PER-RUN ELEVATION (force-on only; strengthens, never weakens).
  if (elevation?.forceOn?.includes(checkpoint) && outcome === "skip") {
    outcome = "fire";
    decidedBy = "elevation";
    reason = `per-run elevation forced ${checkpoint} on`;
  }

  // At this point `outcome` is only ever "fire" or "skip": org bounds
  // (required/forbidden) and the fail-closed (policy_unresolved) all returned
  // earlier, so a fired gate here is exactly "fire".
  return {
    outcome,
    fired: outcome === "fire",
    separationOfDutiesRequired: false,
    reason,
    decidedBy,
  };
}

// ---------------------------------------------------------------------------
// ADMIN INPUT PARSING (cinatra#2047 defect D-3).
//
// The lattice's top layer finally has a write path, so untrusted operator input
// has to become a well-formed policy key. Parsing lives HERE, with the vocabulary
// it validates against, so the admitted values can never drift from the axes the
// evaluator branches on — and so the whole parse is unit-testable without a DB,
// a session or a form runtime.
//
// FAIL-CLOSED BY OMISSION: `silent` is not a storable bound (it is the ABSENCE of
// a row), so it is rejected here rather than silently coerced — retracting a
// bound is a DELETE, a distinct operator intent.
// ---------------------------------------------------------------------------

/** The wildcard artifact-type token. Mirrors `POLICY_ARTIFACT_TYPE_WILDCARD` in
 * the store; duplicated (not imported) so this pure module stays DB-free. */
export const POLICY_ARTIFACT_TYPE_WILDCARD_TOKEN = "*";

/** A parsed, validated org bound ready for `upsertLifecyclePolicyRule`. */
export interface ParsedPolicyBoundInput {
  checkpoint: LifecycleCheckpoint;
  artifactType: string;
  destinationClass: DestinationClass;
  originKind: LifecycleOriginKind;
  bound: "required" | "forbidden";
  selfApprovalOptIn: boolean;
}

/** A parsed policy KEY (no bound) — what a delete needs. */
export type ParsedPolicyKeyInput = Pick<
  ParsedPolicyBoundInput,
  "checkpoint" | "artifactType" | "destinationClass" | "originKind"
>;

export type PolicyInputParse<T> = { ok: true; value: T } | { ok: false; error: string };

/** The raw, untrusted shape a form / route hands in. */
export type RawPolicyInput = Record<string, unknown>;

function readString(raw: RawPolicyInput, key: string): string {
  const v = raw[key];
  return typeof v === "string" ? v.trim() : "";
}

function parseKey(raw: RawPolicyInput): PolicyInputParse<ParsedPolicyKeyInput> {
  const checkpoint = readString(raw, "checkpoint");
  if (!(LIFECYCLE_CHECKPOINTS as readonly string[]).includes(checkpoint)) {
    return { ok: false, error: `Unknown checkpoint "${checkpoint || "(empty)"}".` };
  }
  const destinationClass = readString(raw, "destinationClass");
  if (!(DESTINATION_CLASSES as readonly string[]).includes(destinationClass)) {
    return { ok: false, error: `Unknown destination class "${destinationClass || "(empty)"}".` };
  }
  const originKind = readString(raw, "originKind");
  if (!(LIFECYCLE_ORIGIN_KINDS as readonly string[]).includes(originKind)) {
    return { ok: false, error: `Unknown origin kind "${originKind || "(empty)"}".` };
  }
  // `artifact_type` is free text (any installed extension may define a type), so
  // it is validated for SHAPE only: non-empty, bounded, no whitespace-only value.
  // `*` is legal and means "every type for this (checkpoint, destination, origin)"
  // — an exact type always beats it at resolve time.
  const artifactType = readString(raw, "artifactType");
  if (!artifactType) return { ok: false, error: "Artifact type is required (use * for all types)." };
  if (artifactType.length > 200) return { ok: false, error: "Artifact type is too long." };
  if (/\s/.test(artifactType)) return { ok: false, error: "Artifact type cannot contain spaces." };

  return {
    ok: true,
    value: {
      checkpoint: checkpoint as LifecycleCheckpoint,
      artifactType,
      destinationClass: destinationClass as DestinationClass,
      originKind: originKind as LifecycleOriginKind,
    },
  };
}

/** Parse + validate an operator's bound. Rejects `silent` (retracting a bound is
 * a delete) and any out-of-vocabulary axis value. */
export function parsePolicyBoundInput(
  raw: RawPolicyInput,
): PolicyInputParse<ParsedPolicyBoundInput> {
  const key = parseKey(raw);
  if (!key.ok) return key;

  const bound = readString(raw, "bound");
  if (bound !== "required" && bound !== "forbidden") {
    return {
      ok: false,
      error:
        bound === "silent"
          ? "Silent is the absence of a bound — remove the rule instead of saving it as silent."
          : `Bound must be "required" or "forbidden".`,
    };
  }

  const rawOptIn = raw.selfApprovalOptIn;
  const selfApprovalOptIn =
    rawOptIn === true || rawOptIn === "on" || rawOptIn === "true";

  return { ok: true, value: { ...key.value, bound, selfApprovalOptIn } };
}

/** Parse + validate the KEY of a bound to retract. */
export function parsePolicyKeyInput(raw: RawPolicyInput): PolicyInputParse<ParsedPolicyKeyInput> {
  return parseKey(raw);
}

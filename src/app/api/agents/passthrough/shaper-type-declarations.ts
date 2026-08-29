// The PASSTHROUGH SHAPER TYPE-DECLARATION CONTRACT (enabler 0.16 of
// `PLAN: Agents Lifecycle (C)`, cinatra#3028 / epic #3023 — the host half of
// cinatra#2960).
//
// THE PLAN'S SENTENCE, VERBATIM: "The host's passthrough shapers are inside the
// rule: a shaper declares the types it saves through a contract the compiler
// reads, exactly as an agent does, and a shaper never persists a transform of a
// run value — a projection is a deterministic, non-persisting step."
//
// WHAT IT FIXES, VERBATIM: "a run fails one frame after its gate with an opaque
// error because a host shaper saves an intermediate value under a type nothing
// defines — two such writes exist on the blog pipeline's road, neither visible
// in the agent's own declarations."
//
// WHY A DECLARATION AND NOT A GREP. An agent's saves are visible to the
// compiler because the agent declares them; a host shaper's were visible to
// nobody, which is the second half of the sentence "neither visible in the
// agent's own declarations". This module is the shaper's `produces`: one entry
// per shaper, naming the types it saves and whether it persists a transform of a
// run value, so the same ownership classifier that refuses a save can be run
// over the host's own writes.
//
// THE TWO BLOG WRITES STAY. This slice does not remove them — the plan gives
// their removal to W10 (`the selected-idea save and the persisted draft
// projection`), and cinatra#2960 closes only when both halves have landed. What
// this slice adds is that they are DECLARED and the audit NAMES them, so the
// removal is measurable rather than remembered.
//
// PURE: no `server-only`, no registry import. The two registry questions arrive
// as ports, exactly as the classifier takes them.

import {
  classifyArtifactTypeOwnership,
  unownedArtifactTypeMessage,
  type ArtifactTypeOwnershipPorts,
  type UnownedArtifactTypeReason,
} from "@cinatra-ai/objects/namespace";

/** One shaper's declaration of what it saves. The shaper's `produces`. */
export interface PassthroughShaperDeclaration {
  /** `<module>:<shape>` — stable, and unique across the passthrough. */
  readonly shaperId: string;
  /** Where the shaper lives, for a reader following the audit back to code. */
  readonly module: string;
  /** The object types this shaper saves. Declared, exactly as an agent declares
   *  the types it produces. */
  readonly savesTypes: readonly string[];
  /**
   * TRUE when the shaper PERSISTS a transform of a run value — the thing the
   * plan forbids. A projection is a deterministic, non-persisting step; a
   * shaper that writes one to the objects store is a persistence the agent
   * never declared.
   */
  readonly persistsRunValueTransform: boolean;
  /** The slice that retires the persistence, when one is scheduled. Recorded so
   *  the audit's finding is a countdown, not a standing complaint. */
  readonly retiredBy?: string;
}

/**
 * Every shaper on `/api/agents/passthrough` that saves an object, declared.
 *
 * Kept beside the shapers themselves rather than derived from them: a
 * declaration a human writes is the artefact the compiler reads, and a shaper
 * added without an entry here is caught by the parity test that walks the
 * passthrough's shaper modules.
 */
export const PASSTHROUGH_SHAPER_DECLARATIONS: readonly PassthroughShaperDeclaration[] = [
  {
    shaperId: "blog-pipeline-seam:blog_pipeline_selected_idea",
    module: "src/app/api/agents/passthrough/blog-pipeline-seam.ts",
    savesTypes: ["@dynamic/types:blog-pipeline-selected-idea"],
    // The gate's chosen idea, reshaped and written back. A run value's
    // transform, persisted.
    persistsRunValueTransform: true,
    retiredBy: "cinatra#3034",
  },
  {
    shaperId: "blog-pipeline-seam:blog_pipeline_draft_projection",
    module: "src/app/api/agents/passthrough/blog-pipeline-seam.ts",
    savesTypes: ["@dynamic/types:blog-pipeline-draft-projection"],
    // The draft, projected into three strings and written back.
    persistsRunValueTransform: true,
    retiredBy: "cinatra#3034",
  },
  {
    shaperId: "route:campaigns_context_setup",
    module: "src/app/api/agents/passthrough/route.ts",
    savesTypes: ["@cinatra-ai/campaigns:context"],
    // The campaign's context row is the SUBSTANCE the step exists to create,
    // not a transform of a value the run already carried.
    persistsRunValueTransform: false,
  },
] as const;

/** One audit finding against the shaper declarations. */
export interface PassthroughShaperFinding {
  readonly shaperId: string;
  readonly module: string;
  readonly kind: "unowned-type" | "persists-run-value-transform";
  /** The type the finding is about; absent for a persistence finding. */
  readonly objectType?: string;
  /** The named ownership reason; present only on an `unowned-type` finding. */
  readonly reason?: UnownedArtifactTypeReason;
  readonly message: string;
  /** The slice that retires the write, when one is scheduled. */
  readonly retiredBy?: string;
}

/**
 * Run the save boundary's own ownership rule over the host's shapers, and name
 * every shaper that persists a transform of a run value.
 *
 * The audit is a VALUE, never a throw: it is read by a test and by the fleet's
 * readiness counting, and both want the whole list, not the first failure.
 */
export function auditPassthroughShaperDeclarations(
  ports: ArtifactTypeOwnershipPorts,
  declarations: readonly PassthroughShaperDeclaration[] = PASSTHROUGH_SHAPER_DECLARATIONS,
): PassthroughShaperFinding[] {
  const findings: PassthroughShaperFinding[] = [];
  for (const d of declarations) {
    for (const objectType of d.savesTypes) {
      const ownership = classifyArtifactTypeOwnership(objectType, ports);
      if (ownership.owned) continue;
      findings.push({
        shaperId: d.shaperId,
        module: d.module,
        kind: "unowned-type",
        objectType,
        reason: ownership.reason,
        message: `passthrough shaper "${d.shaperId}" saves ${unownedArtifactTypeMessage(objectType, ownership)}`,
        ...(d.retiredBy ? { retiredBy: d.retiredBy } : {}),
      });
    }
    if (d.persistsRunValueTransform) {
      findings.push({
        shaperId: d.shaperId,
        module: d.module,
        kind: "persists-run-value-transform",
        message: `passthrough shaper "${d.shaperId}" persists a transform of a run value; a projection is a deterministic, non-persisting step`,
        ...(d.retiredBy ? { retiredBy: d.retiredBy } : {}),
      });
    }
  }
  return findings;
}

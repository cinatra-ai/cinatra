import "server-only";

// ---------------------------------------------------------------------------
// blog-post-repair-producer (cinatra#2040, epic #2037 S2)
//
// The FIRST repairing producer. The blog pipeline produces draft body artifacts;
// when a reviewer returns `changes_requested`, this producer implements the typed
// repair round-trip end-to-end: it materializes the repaired markdown into a
// SUCCESSOR body artifact (a new pinned revision) and submits the typed repair
// response through the repair store, which pins the successor in a NEW gate (never
// repin under the reviewer) and re-points the held effect onto it.
//
// A producer opts INTO the repair loop by declaring `repairCapable` in its
// compiled manifest lifecycle (`agent_templates.lifecycle_config`); the review
// orchestration reads it to ROUTE a `changes_requested` to the producer (vs a
// human / org route). `BLOG_POST_LIFECYCLE_CONFIG` is that declaration for the
// blog pipeline.
//
// FENCED with the rest of S2 — nothing here runs until the S1 activation fence is
// on and a policy fires a review gate on a blog draft.
// ---------------------------------------------------------------------------

import { materializeBlogPostBodyArtifact } from "@/lib/blog-post-artifact-materializer";
import type { CompiledManifestLifecycle } from "@/lib/lifecycle/lifecycle-policy";
import type { RepairFindingOutcome } from "@/lib/lifecycle/lifecycle-repair";

import { submitRepairResponse, readRepair, type SubmitRepairResponseResult } from "./lifecycle-repair-store";

/** The compiled lifecycle declaration for the blog pipeline — it PRODUCES blog
 * post body artifacts and CAN REPAIR them (the repair loop routes
 * `changes_requested` to this producer). Seeded onto the blog agent template's
 * `lifecycle_config` (JSON-as-text), trigger-style. */
export const BLOG_POST_LIFECYCLE: CompiledManifestLifecycle = {
  producedTypes: ["artifact-blog-post-body"],
  repairCapable: true,
};

/** The JSON-as-text form persisted on `agent_templates.lifecycle_config`. */
export const BLOG_POST_LIFECYCLE_CONFIG = JSON.stringify(BLOG_POST_LIFECYCLE);

export interface RepairBlogPostDraftInput {
  /** The open repair (status 'requested'/'dispatched') to fulfil. */
  repairId: string;
  /** The producer's repaired markdown body (the regenerated draft addressing the
   * findings). */
  repairedMarkdown: string;
  /** Optional title for the successor artifact. */
  title?: string;
  /** Per-finding applied/skipped outcomes the producer reports. */
  findingOutcomes: RepairFindingOutcome[];
  /** A human-readable summary of what changed. */
  changeSummary: string;
  /** The LIVE current revision of the BASE artifact at repair time (the caller
   * resolves it; null ⇒ tombstoned → the repair is rejected as stale). */
  currentBaseRevisionId: string | null;
  /** Live re-authorization verdict at repair dispatch (actor / org-binding /
   * connector use) — the captured request context is provenance-only. */
  reauthorized: boolean;
  /** The producing run id (stamped on the successor artifact provenance). */
  producerRunId?: string | null;
}

export type RepairBlogPostDraftResult =
  | { ok: true; successorArtifactId: string; successorGateId: string; successorTaskId: string }
  | { ok: false; code: string; error: string };

/**
 * Fulfil a `changes_requested` repair for a blog draft: materialize the repaired
 * markdown into a SUCCESSOR body artifact (a new pinned revision), then submit the
 * typed repair response through the store (lineage + base-revision CAS + live
 * re-auth are enforced there). Returns the successor gate the repaired revision is
 * pinned into.
 */
export async function repairBlogPostDraft(
  input: RepairBlogPostDraftInput,
): Promise<RepairBlogPostDraftResult> {
  const repair = await readRepair(input.repairId);
  if (!repair) return { ok: false, code: "not-found", error: `repair ${input.repairId} not found` };

  // Materialize the repaired draft into a NEW body artifact (the successor pinned
  // revision). createSemanticArtifact under the hood produces a fresh artifact +
  // representation revision.
  const successor = await materializeBlogPostBodyArtifact({
    content: input.repairedMarkdown,
    title: input.title,
    createdByRunId: input.producerRunId ?? null,
  });

  const result: SubmitRepairResponseResult = await submitRepairResponse({
    repairId: input.repairId,
    currentBaseRevisionId: input.currentBaseRevisionId,
    reauthorized: input.reauthorized,
    response: {
      gateId: repair.gateId,
      baseTarget: {
        artifactId: repair.baseArtifactId,
        representationRevisionId: repair.baseRepresentationRevisionId,
      },
      successorTarget: {
        artifactId: successor.artifactId,
        representationRevisionId: successor.representationRevisionId,
      },
      findingOutcomes: input.findingOutcomes,
      changeSummary: input.changeSummary,
      producerProvenance: { runId: input.producerRunId ?? null, agentId: null },
    },
  });

  if (!result.ok) return { ok: false, code: result.code, error: result.error };
  return {
    ok: true,
    successorArtifactId: successor.artifactId,
    successorGateId: result.successorGateId,
    successorTaskId: result.successorTaskId,
  };
}

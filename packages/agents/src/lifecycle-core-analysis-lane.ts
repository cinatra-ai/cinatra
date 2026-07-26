import "server-only";

// ---------------------------------------------------------------------------
// lifecycle-core-analysis-lane (cinatra#2042, epic #2037 — S4 core advisor lane).
//
// The store-writing half of the "Core analysis" advisor lane that REPLACES the
// reviewer-agent's rendering advisor. It builds the core analysis over an
// authorized, disclosed content projection (lifecycle-core-analysis) and WRITES it
// through the zero-authority advisory seam (lifecycle-advisory-store) as a
// provenance-stamped, decision-free advisory comment the run's verification view
// displays under the "Core analysis" chrome.
//
// Author kind is `service` (a CORE lane, not an agent); author id is the lane id.
// Idempotent per (gate, projection digest): re-running the lane over the SAME
// disclosed projection returns the existing comment (no duplicate).
// ---------------------------------------------------------------------------

import { attachAdvisoryComment } from "./lifecycle-advisory-store";
import {
  buildCoreAnalysis,
  CORE_ANALYSIS_LANE_ID,
  type CoreAnalysisAuthzDecision,
  type CoreAnalysisProjection,
  type CoreAnalysisProvenance,
  type CoreAnalysisTarget,
} from "@/lib/lifecycle/lifecycle-core-analysis";

export interface RunCoreAnalysisLaneInput {
  gateId: string;
  target: CoreAnalysisTarget;
  projection: CoreAnalysisProjection;
  authzDecision: CoreAnalysisAuthzDecision;
  /** The run that occasioned the analysis (provenance/causation only). */
  runCausation?: string | null;
}

export interface RunCoreAnalysisLaneResult {
  advisoryCommentId: string;
  created: boolean;
  provenance: CoreAnalysisProvenance;
  summary: string;
}

/**
 * Run the core analysis lane against a gate: build the analysis over the
 * authorized projection, then attach it as a provenance-stamped advisory comment.
 * The chrome labels it "Core analysis". Idempotent per (gate, projection digest).
 */
export async function runCoreAnalysisLane(
  input: RunCoreAnalysisLaneInput,
): Promise<RunCoreAnalysisLaneResult> {
  const analysis = buildCoreAnalysis({
    target: input.target,
    projection: input.projection,
    authzDecision: input.authzDecision,
    laneId: CORE_ANALYSIS_LANE_ID,
  });

  const attach = await attachAdvisoryComment({
    gateId: input.gateId,
    author: { id: CORE_ANALYSIS_LANE_ID, kind: "service" },
    body: analysis.body,
    // Deterministic per (gate, projection) — a re-run over the same disclosed
    // projection is a no-op (the digest binds the exact content analyzed).
    idempotencyKey: `core-analysis:${analysis.provenance.projectionDigest}`,
    runCausation: input.runCausation ?? null,
  });

  return {
    advisoryCommentId: attach.comment.id,
    created: attach.created,
    provenance: analysis.provenance,
    summary: analysis.summary,
  };
}

import "server-only";

// ---------------------------------------------------------------------------
// The verification-record READ, as its own leaf (cinatra#2567, epic #2564 S3).
//
// WHY IT IS SEPARATE FROM `lifecycle-verification-store.ts`. That store owns the
// verification WRITE lane — computing a verdict, recording a repair, opening the
// reopen gate, and (through a lazy hop) running the core-analysis lane. Reading
// one already-written row needs none of it: this is a single indexed select and
// a projection.
//
// The split is a graph narrowing, not a taste preference. `readVerificationRecordForGate`
// is what the lifecycle CARD refetch calls to decide whether a verification
// reading exists, and that refetch is reachable from the MCP surface — which
// every route that mounts the app's auth plugins carries. Importing it through
// the write store pulled the whole verification lane (the core-analysis lane,
// the advisory store and their app-side cores: EIGHT modules) onto five locked
// first-party-graph budgets to answer "is there a row?". Through this leaf it
// costs one.
//
// `lifecycle-verification-store` RE-EXPORTS this reader, so every existing
// caller — the review page, the integration suites — is untouched and there is
// still exactly one implementation.
// ---------------------------------------------------------------------------

import { eq } from "drizzle-orm";

import { db } from "./db";
import { artifactVerificationRecords } from "./schema";
// Type-only: erased at build, so the verification core does not enter the graph.
import type { VerificationScopeManifest } from "@/lib/lifecycle/lifecycle-verification";

/** A pinned target — the exact reviewed / repaired revision. */
export interface VerificationTargetRef {
  artifactId: string;
  representationRevisionId: string;
}

/** One persisted verification record, as readers consume it. */
export interface VerificationRecordRead {
  id: string;
  gateId: string;
  reviewedTarget: VerificationTargetRef;
  repairedTarget: VerificationTargetRef;
  scopeManifest: VerificationScopeManifest;
  fieldDiff: { field: string; before?: string; after?: string }[];
  outcome: string;
  createdAt: Date;
}

/** Read a gate's verification record (the "Core analysis" the run rail opens). */
export async function readVerificationRecordForGate(
  gateId: string,
): Promise<VerificationRecordRead | null> {
  const [r] = await db
    .select()
    .from(artifactVerificationRecords)
    .where(eq(artifactVerificationRecords.gateId, gateId))
    .limit(1);
  if (!r) return null;
  return {
    id: r.id,
    gateId: r.gateId,
    reviewedTarget: {
      artifactId: r.reviewedArtifactId,
      representationRevisionId: r.reviewedRepresentationRevisionId,
    },
    repairedTarget: {
      artifactId: r.repairedArtifactId,
      representationRevisionId: r.repairedRepresentationRevisionId,
    },
    scopeManifest: (r.scopeManifest as VerificationScopeManifest) ?? { paths: [] },
    fieldDiff: (r.fieldDiff as { field: string; before?: string; after?: string }[]) ?? [],
    outcome: r.outcome,
    createdAt: r.createdAt,
  };
}

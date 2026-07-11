import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "./db";
import { projectInstances } from "./schema";

// ---------------------------------------------------------------------------
// project-instance-store (cinatra#1032 deliverable 3)
// ---------------------------------------------------------------------------
// Pure DB layer for the `project_instances` table — the STICKY
// instantiation-time binding record keyed (org_id, project_ref). The store is
// deliberately POLICY-FREE: the sticky-vs-drift decision (an existing row that
// matches is idempotent success; one that differs is a loud refusal) belongs
// to the instantiation primitive (src/lib/project-instantiation.ts), which
// runs the full drift predicate over whatever row this store returns.
//
//   - createProjectInstance: single-statement INSERT … ON CONFLICT DO NOTHING
//     + read-back. Returns `{ created }` discriminating whether THIS call
//     inserted the row or a concurrent/prior instantiation won the key — the
//     caller re-applies its drift predicate to the returned row either way,
//     so a lost race converges to the same sticky semantics.
//   - readProjectInstance: point read by (org_id, project_ref).
//
// Rows are IMMUTABLE once written (provider stickiness; the future
// role-rebinding valve is an explicit versioned migration, never an in-place
// update) — no update writer is exported.
// Server-only: never imported by client bundles.
// ---------------------------------------------------------------------------

export type ProjectInstanceRecord = {
  orgId: string;
  projectRef: string;
  /** Nullable cinatra project refinement (mirrors agent_runs.project_id). */
  projectId: string | null;
  /** The installed agent package whose template the project instantiated. */
  templatePackage: string;
  /** The template's stable id (pinned; dispatch refuses a swap). */
  templateId: string;
  /** The finalized-install digest the template was read from at instantiation.
   *  PROVENANCE only — deliberately not a dispatch gate (the merged dispatch
   *  semantics allow template evolution; the ledger's immutable attempt
   *  identity refuses binding drift under the same action version). The
   *  future rebinding/migration valve verifies against this. */
  templateDigest: string;
  /** The PM SEAT — the pm-work-store-bound agent package. */
  pmAgentPackage: string;
  /** The once-selected PM work-store provider. */
  providerId: string;
  /** How the provider was selected. */
  providerMode: "configured" | "auto";
  createdAt: Date;
  updatedAt: Date;
};

function deserialize(row: typeof projectInstances.$inferSelect): ProjectInstanceRecord {
  return {
    orgId:           row.orgId,
    projectRef:      row.projectRef,
    projectId:       row.projectId ?? null,
    templatePackage: row.templatePackage,
    templateId:      row.templateId,
    templateDigest:  row.templateDigest,
    pmAgentPackage:  row.pmAgentPackage,
    providerId:      row.providerId,
    providerMode:    row.providerMode as "configured" | "auto",
    createdAt:       row.createdAt,
    updatedAt:       row.updatedAt,
  };
}

export async function readProjectInstance(
  orgId: string,
  projectRef: string,
): Promise<ProjectInstanceRecord | null> {
  const [row] = await db
    .select()
    .from(projectInstances)
    .where(and(eq(projectInstances.orgId, orgId), eq(projectInstances.projectRef, projectRef)));
  return row ? deserialize(row) : null;
}

export type CreateProjectInstanceInput = {
  orgId: string;
  projectRef: string;
  projectId?: string | null;
  templatePackage: string;
  templateId: string;
  templateDigest: string;
  pmAgentPackage: string;
  providerId: string;
  providerMode: "configured" | "auto";
};

export type CreateProjectInstanceResult = {
  /** True when THIS call inserted the row; false when an existing row won the
   *  (org_id, project_ref) key (prior instantiation or a lost concurrent
   *  race) — `instance` is then the PERSISTED row, which the caller must run
   *  its drift predicate over. */
  created: boolean;
  instance: ProjectInstanceRecord;
};

/**
 * Atomically create the project instance, converging on the existing row when
 * the key is already taken. INSERT … ON CONFLICT DO NOTHING never overwrites:
 * the persisted binding (template, seat, provider) is immutable, so a
 * concurrent instantiation can never flip a project to a different PM tool or
 * seat — the loser reads the winner's row back and judges drift caller-side.
 * Throws only on a real DB failure (the instantiation primitive maps that to
 * its structured catch-all).
 */
export async function createProjectInstance(
  input: CreateProjectInstanceInput,
): Promise<CreateProjectInstanceResult> {
  const inserted = await db
    .insert(projectInstances)
    .values({
      orgId:           input.orgId,
      projectRef:      input.projectRef,
      projectId:       input.projectId ?? null,
      templatePackage: input.templatePackage,
      templateId:      input.templateId,
      templateDigest:  input.templateDigest,
      pmAgentPackage:  input.pmAgentPackage,
      providerId:      input.providerId,
      providerMode:    input.providerMode,
    })
    .onConflictDoNothing({ target: [projectInstances.orgId, projectInstances.projectRef] })
    .returning();
  if (inserted.length > 0) {
    return { created: true, instance: deserialize(inserted[0]) };
  }
  const existing = await readProjectInstance(input.orgId, input.projectRef);
  if (!existing) {
    // Conflict with no readable row: the winning row vanished between the
    // insert and the read-back (e.g. a concurrent teardown). Surface loudly —
    // returning "created" here would fabricate a persistence claim.
    throw new Error(
      `project instance (${input.orgId}, ${input.projectRef}) hit ON CONFLICT but no row is readable`,
    );
  }
  return { created: false, instance: existing };
}

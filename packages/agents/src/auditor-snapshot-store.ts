import "server-only";

// ---------------------------------------------------------------------------
// auditor-snapshot-store (cinatra#1625)
//
// The immutable per-run proposal snapshot access layer.
//
// cinatra#1796 / #2047 row 8 — the RETIREMENT teardown removed the legacy
// single-use Separation-of-Duties APPROVAL-RECEIPT path (`mintApprovalReceipt` /
// `consumeApprovalReceipt`) together with the `/api/auditor/apply` +
// `/api/auditor/exclude` endpoints that were its only callers. That receipt was
// a second approval-bearing store on the lifecycle surface, outside the gate
// store — the exact "parallel decision path" #2047 row 8 forbids. Approval on
// this surface is now recorded ONLY by the gate store
// (`artifact-review-gate-store`) and its gate-anchored S4 child
// `suggestion_decision_ledger`, which stay untouched.
//
// The `auditor_approval_receipts` TABLE is deliberately left in place: dropping
// it needs a migration (high-risk, owner-gated) and it carries no live writer
// after this change. It is inert, not load-bearing.
//
//   writeProposalSnapshot      — idempotent upsert keyed by agent_run_id.
//                                Same input digest → returns the stored snapshot
//                                (idempotent retry). DIFFERENT digest for an
//                                existing run → fail closed (throws).
//                                Malformed patches (empty, duplicate/blank ids)
//                                → fail closed.
//   readProposalSnapshotForRun — the single snapshot for a run, or null.
// ---------------------------------------------------------------------------

import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { auditorApprovalSnapshotError } from "./auditor-snapshot-errors";
import { auditorProposalSnapshots } from "./schema";
import type { SuggestionPatch } from "./auditor-apply";

// A proposal patch as surfaced to the reviewer (the { id, fieldPath, op, message }
// view carried on preview.patches — value is intentionally NOT surfaced).
export type AuditProposalPatch = {
  id: string;
  fieldPath: string;
  op: string;
  message: string;
};

export type AuditSkillPreview = {
  id?: string;
  name: string;
  description: string;
  content: string;
  basedOnSkillIds?: string[];
  patches: AuditProposalPatch[];
};

export type ProposalSnapshot = {
  id: string;
  agentRunId: string;
  preview: AuditSkillPreview;
  patches: SuggestionPatch[];
  patchIds: string[];
  inputDataDigest: string;
  snapshotHash: string;
  edited: string;
  createdAt: Date;
};

// Stable canonical JSON — sort object keys so the hash is order-independent.
function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(v as Record<string, unknown>).sort()) {
        out[key] = (v as Record<string, unknown>)[key];
      }
      return out;
    }
    return v;
  });
}

export function computeInputDigest(inputData: unknown): string {
  return createHash("sha256").update(canonical(inputData ?? null)).digest("hex");
}

// Bind the preview + the authoritative patch content + the stable id set into
// one hash. The approval receipt is minted against this hash, so a re-generated
// snapshot (different suggestions) cannot be approved by a stale receipt.
export function computeSnapshotHash(
  preview: AuditSkillPreview,
  patches: SuggestionPatch[],
): string {
  return createHash("sha256")
    .update(canonical({ preview, patches }))
    .digest("hex");
}

function assertWellFormedPatches(patches: SuggestionPatch[]): void {
  const seen = new Set<string>();
  for (const p of patches) {
    if (typeof p.id !== "string" || p.id.length === 0) {
      throw auditorApprovalSnapshotError(
        "malformed_snapshot",
        "Proposal patch is missing a stable id",
      );
    }
    if (seen.has(p.id)) {
      throw auditorApprovalSnapshotError(
        "malformed_snapshot",
        `Duplicate proposal patch id: ${p.id}`,
      );
    }
    seen.add(p.id);
  }
}

function rowToSnapshot(row: typeof auditorProposalSnapshots.$inferSelect): ProposalSnapshot {
  return {
    id: row.id,
    agentRunId: row.agentRunId,
    preview: row.preview as AuditSkillPreview,
    patches: row.patches as SuggestionPatch[],
    patchIds: row.patchIds as string[],
    inputDataDigest: row.inputDataDigest,
    snapshotHash: row.snapshotHash,
    edited: row.edited,
    createdAt: row.createdAt,
  };
}

/**
 * Idempotent write of the immutable per-run proposal snapshot.
 *
 * - patches malformed (empty id, duplicate id) → throws (fail closed).
 * - agent_run_id already has a snapshot with the SAME input_data_digest →
 *   returns the STORED snapshot (idempotent retry; the run re-ran identically).
 * - agent_run_id already has a snapshot with a DIFFERENT digest → throws
 *   (fail closed): the run re-ran against different data; never silently
 *   overwrite a snapshot a receipt may already be bound to.
 */
export async function writeProposalSnapshot(args: {
  agentRunId: string;
  preview: AuditSkillPreview;
  patches: SuggestionPatch[];
  inputData: unknown;
  edited: string;
}): Promise<ProposalSnapshot> {
  const { agentRunId, preview, patches, inputData, edited } = args;
  assertWellFormedPatches(patches);

  const patchIds = patches.map((p) => p.id);
  const inputDataDigest = computeInputDigest(inputData);
  const snapshotHash = computeSnapshotHash(preview, patches);

  const [inserted] = await db
    .insert(auditorProposalSnapshots)
    .values({
      id: randomUUID(),
      agentRunId,
      preview,
      patches,
      patchIds,
      inputDataDigest,
      snapshotHash,
      edited,
    })
    .onConflictDoNothing({ target: auditorProposalSnapshots.agentRunId })
    .returning();

  if (inserted) return rowToSnapshot(inserted);

  // Conflict: a snapshot already exists for this run. Idempotent iff the digest
  // matches; otherwise fail closed.
  const existing = await readProposalSnapshotForRun(agentRunId);
  if (!existing) {
    // Extremely narrow race (row vanished between insert-conflict and read).
    throw auditorApprovalSnapshotError(
      "snapshot_conflict",
      "Snapshot conflict could not be reconciled for run",
    );
  }
  if (existing.inputDataDigest !== inputDataDigest) {
    throw auditorApprovalSnapshotError(
      "snapshot_conflict",
      "A different proposal snapshot already exists for this run",
    );
  }
  return existing;
}

export async function readProposalSnapshotForRun(
  agentRunId: string,
): Promise<ProposalSnapshot | null> {
  const rows = await db
    .select()
    .from(auditorProposalSnapshots)
    .where(eq(auditorProposalSnapshots.agentRunId, agentRunId))
    .limit(1);
  return rows[0] ? rowToSnapshot(rows[0]) : null;
}

/** Whether a proposal snapshot exists for the run. */
export async function hasPendingAuditorSnapshot(agentRunId: string): Promise<boolean> {
  const snap = await readProposalSnapshotForRun(agentRunId);
  return snap != null;
}

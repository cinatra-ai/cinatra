import "server-only";

// ---------------------------------------------------------------------------
// auditor-snapshot-store (cinatra#1625)
//
// The immutable per-run proposal snapshot + single-use approval-receipt access
// layer for the auditor HITL flow. This is the trust-boundary core: /api/auditor
// /run-skills WRITES exactly one snapshot per run; /api/auditor/apply READS that
// one snapshot (never a union) to bound which patches may apply, and CONSUMES a
// single-use Separation-of-Duties receipt minted by the admin-gated approval.
//
//   writeProposalSnapshot      — idempotent upsert keyed by agent_run_id.
//                                Same input digest → returns the stored snapshot
//                                (idempotent retry). DIFFERENT digest for an
//                                existing run → fail closed (throws): never
//                                overwrite a snapshot a receipt may be bound to.
//                                Malformed patches (empty, duplicate/blank ids)
//                                → fail closed.
//   readProposalSnapshotForRun — the single snapshot for a run, or null.
//   mintApprovalReceipt        — insert a LIVE receipt (agent_run_id,
//                                snapshot_hash, reviewer_id). Idempotent on the
//                                live-uniq index (a re-mint is a no-op).
//   consumeApprovalReceipt     — single-shot CAS: consume the LIVE receipt whose
//                                snapshot_hash matches. Returns the consumed row
//                                or null (already consumed / none / hash drift).
// ---------------------------------------------------------------------------

import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "./db";
import { auditorApprovalSnapshotError } from "./auditor-snapshot-errors";
import {
  auditorApprovalReceipts,
  auditorProposalSnapshots,
} from "./schema";
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

export type ApprovalReceipt = {
  id: string;
  agentRunId: string;
  snapshotHash: string;
  reviewerId: string;
  acceptedPatchIds: string[] | null;
  dismissedPatchIds: string[] | null;
  consumedAt: Date | null;
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

function rowToReceipt(row: typeof auditorApprovalReceipts.$inferSelect): ApprovalReceipt {
  return {
    id: row.id,
    agentRunId: row.agentRunId,
    snapshotHash: row.snapshotHash,
    reviewerId: row.reviewerId,
    acceptedPatchIds: (row.acceptedPatchIds as string[] | null) ?? null,
    dismissedPatchIds: (row.dismissedPatchIds as string[] | null) ?? null,
    consumedAt: row.consumedAt,
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

/**
 * Mint a LIVE single-use approval receipt bound to (run, snapshot_hash,
 * reviewer). Idempotent: the live-uniq index means a second live mint for the
 * same run is a no-op (returns the existing live receipt). A hash mismatch on
 * an existing live receipt is surfaced by the caller at consume time (the CAS
 * matches on snapshot_hash), so mint stays a simple upsert.
 */
export async function mintApprovalReceipt(args: {
  agentRunId: string;
  snapshotHash: string;
  reviewerId: string;
  acceptedPatchIds?: string[];
  dismissedPatchIds?: string[];
}): Promise<ApprovalReceipt> {
  const { agentRunId, snapshotHash, reviewerId } = args;
  const [inserted] = await db
    .insert(auditorApprovalReceipts)
    .values({
      id: randomUUID(),
      agentRunId,
      snapshotHash,
      reviewerId,
      acceptedPatchIds: args.acceptedPatchIds ?? null,
      dismissedPatchIds: args.dismissedPatchIds ?? null,
    })
    // Partial-unique on (agent_run_id) WHERE consumed_at IS NULL — one live
    // receipt per run.
    .onConflictDoNothing()
    .returning();

  if (inserted) return rowToReceipt(inserted);

  const existing = await db
    .select()
    .from(auditorApprovalReceipts)
    .where(
      and(
        eq(auditorApprovalReceipts.agentRunId, agentRunId),
        isNull(auditorApprovalReceipts.consumedAt),
      ),
    )
    .limit(1);
  if (existing[0]) return rowToReceipt(existing[0]);
  throw auditorApprovalSnapshotError(
    "receipt_mint_failed",
    "Approval receipt could not be minted or reconciled for run",
  );
}

/**
 * Single-shot CAS consume of the LIVE receipt whose snapshot_hash matches.
 * Returns the consumed receipt, or null if there is no live receipt for the run
 * or its hash does not match (already consumed, never minted, or snapshot
 * drifted). The DB WHERE consumed_at IS NULL guard makes a concurrent double
 * consume impossible.
 */
export async function consumeApprovalReceipt(args: {
  agentRunId: string;
  snapshotHash: string;
}): Promise<ApprovalReceipt | null> {
  const { agentRunId, snapshotHash } = args;
  const [consumed] = await db
    .update(auditorApprovalReceipts)
    .set({ consumedAt: sql`now()` })
    .where(
      and(
        eq(auditorApprovalReceipts.agentRunId, agentRunId),
        eq(auditorApprovalReceipts.snapshotHash, snapshotHash),
        isNull(auditorApprovalReceipts.consumedAt),
      ),
    )
    .returning();
  return consumed ? rowToReceipt(consumed) : null;
}

/** Whether a pending (never-consumed) auditor snapshot+receipt-eligible run exists. */
export async function hasPendingAuditorSnapshot(agentRunId: string): Promise<boolean> {
  const snap = await readProposalSnapshotForRun(agentRunId);
  return snap != null;
}

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
// cinatra#2570 (epic #2564 S6a) — the WRITER is retired too, and for the same
// reason one step later: `/api/auditor/apply` was this store's only reader, so
// once it went the per-run snapshot was being written for nobody. Suggestions
// are now minted GATE-BOUND against the exact pinned revision
// (`gate_suggestion_snapshots`, written by `lifecycle-suggestion-producer-lane`).
// `auditor_proposal_snapshots` joins `auditor_approval_receipts` as an INERT
// table: no writer, dropping it needs an owner-gated migration.
//
//   writeProposalSnapshot      — RETIRED. Throws `legacy_writer_retired`; kept
//                                as the runtime assert that no path re-opens the
//                                run-scoped write.
//   readProposalSnapshotForRun — the single snapshot for a run, or null. Reads
//                                whatever a pre-retirement deployment already
//                                stored; mints nothing.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
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
 * RETIRED (cinatra#2570, epic #2564 S6a). This function no longer writes.
 *
 * It used to persist one immutable proposal snapshot per run so
 * `/api/auditor/apply` could replay-validate the accepted patch ids against the
 * surfaced set. That consumer was deleted with the receipt path (#2047 row 8),
 * leaving a store with a writer, no reader, and a fail-closed conflict branch
 * that could 409 an audit run over rows nobody would ever look at.
 *
 * Suggestions are now produced GATE-BOUND — frozen against the exact pinned
 * `{artifactId, representationRevisionId}` a review gate froze, hash-bound and
 * immutable, in `gate_suggestion_snapshots`
 * (`lifecycle-suggestion-producer-lane`). That is the snapshot S6b's decision
 * partition validates `accepted ⊆ surfaced` against.
 *
 * IT REFUSES RATHER THAN DISAPPEARING, on purpose. Deleting the symbol would
 * make a resurrected caller a compile error today and an easy re-implementation
 * tomorrow; a throwing writer is the RUNTIME assert that "zero writes to
 * `auditor_proposal_snapshots`" stays true no matter which path finds its way
 * back here. The companion structural test proves no production module calls it.
 *
 * The TABLE stays in place and inert — dropping it is a migration, and
 * migrations are owner-gated.
 *
 * @deprecated Retired writer. Use the gate-bound producer lane.
 */
export async function writeProposalSnapshot(
  // The argument shape is kept so a resurrected caller still type-checks and
  // then fails at RUNTIME with a reason, instead of failing to compile with a
  // hint to "just re-add the write".
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _args: {
    agentRunId: string;
    preview: AuditSkillPreview;
    patches: SuggestionPatch[];
    inputData: unknown;
    edited: string;
  },
): Promise<never> {
  throw auditorApprovalSnapshotError(
    "legacy_writer_retired",
    "The run-scoped auditor proposal writer is retired; suggestions are produced gate-bound.",
  );
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

import "server-only";

// ---------------------------------------------------------------------------
// lifecycle-advisory-store (cinatra#2038, epic #2037 S0)
//
// The persistence half of the zero-authority ADVISORY SEAM. Gate-bound,
// provenance-stamped, idempotent, STRUCTURALLY decision-free — the rows live WITH
// the gate (`gate_advisory_comments` FKs `artifact_review_gates` ON DELETE
// CASCADE) and the table carries no decision/disposition column. Core advisor
// lanes are its first writers (S4); any agent may attach through it.
//
// attach — idempotent per (gate, idempotencyKey): a re-attach returns the
//          existing comment (no duplicate, no overwrite).
// list   — the gate's advisory comments, oldest-first.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";

import { db } from "./db";
import { gateAdvisoryComments } from "./schema";
import {
  validateAdvisoryAttach,
  type AdvisoryAttachRequest,
  type AdvisoryComment,
} from "@/lib/lifecycle/lifecycle-advisory-seam";

export class AdvisorySeamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdvisorySeamError";
  }
}

export interface AttachAdvisoryResult {
  comment: AdvisoryComment;
  /** True when THIS call created the row; false when the (gate, idempotencyKey)
   * already existed (idempotent re-attach). */
  created: boolean;
}

/**
 * Attach an advisory comment to a gate. Validated FIRST (the decision-free +
 * provenance contract). Idempotent per (gate, idempotencyKey): a re-attach of the
 * same key returns the existing comment unchanged.
 */
export async function attachAdvisoryComment(
  req: AdvisoryAttachRequest,
): Promise<AttachAdvisoryResult> {
  const valid = validateAdvisoryAttach(req);
  if (!valid.ok) throw new AdvisorySeamError(valid.error);

  const id = randomUUID();
  const [inserted] = await db
    .insert(gateAdvisoryComments)
    .values({
      id,
      gateId: req.gateId,
      authorId: req.author.id,
      authorKind: req.author.kind,
      body: req.body,
      idempotencyKey: req.idempotencyKey,
      runCausation: req.runCausation ?? null,
    })
    .onConflictDoNothing({
      target: [gateAdvisoryComments.gateId, gateAdvisoryComments.idempotencyKey],
    })
    .returning();

  if (inserted) {
    return { comment: toComment(inserted), created: true };
  }
  // Idempotent hit — return the existing comment.
  const existing = await db
    .select()
    .from(gateAdvisoryComments)
    .where(
      and(
        eq(gateAdvisoryComments.gateId, req.gateId),
        eq(gateAdvisoryComments.idempotencyKey, req.idempotencyKey),
      ),
    )
    .limit(1);
  const row = existing[0];
  if (!row) {
    throw new AdvisorySeamError(
      `advisory attach for gate ${req.gateId} could not be reconciled after a conflict`,
    );
  }
  return { comment: toComment(row), created: false };
}

export async function listAdvisoryComments(gateId: string): Promise<AdvisoryComment[]> {
  const rows = await db
    .select()
    .from(gateAdvisoryComments)
    .where(eq(gateAdvisoryComments.gateId, gateId))
    .orderBy(asc(gateAdvisoryComments.createdAt));
  return rows.map(toComment);
}

function toComment(r: typeof gateAdvisoryComments.$inferSelect): AdvisoryComment {
  return {
    id: r.id,
    gateId: r.gateId,
    authorId: r.authorId,
    authorKind: r.authorKind as AdvisoryComment["authorKind"],
    body: r.body,
    idempotencyKey: r.idempotencyKey,
    runCausation: r.runCausation,
    createdAt: r.createdAt,
  };
}

/**
 * The zero-authority ADVISORY SEAM contract (cinatra#2038, epic #2037 S0).
 *
 * Core is the sole authority on gates. ONE seam remains through which any agent
 * may attach an ADVISORY comment to a gate — with NO authority, NO decision, NO
 * separate store. This contract is STRUCTURALLY decision-free: there is no
 * disposition field, no approve/reject/verdict, no parallel authority — the
 * advisory rows live WITH the gate (a child of the gate id). Core advisor lanes
 * are its first writers (S4); any agent may attach through it.
 *
 * The contract is provenance-stamped (author identity + timestamp + optional run
 * causation) and idempotent (an `idempotencyKey` per gate makes a re-attach a
 * no-op). PURE (no DB): the validation + provenance-stamp shape; the attach/list
 * store lives in `packages/agents/src/lifecycle-advisory-store.ts`.
 */

/** WHO attached an advisory comment — an authenticated identity. `kind`
 * distinguishes a human author from an agent/service author for display + audit;
 * NEITHER carries any decision authority. */
export interface AdvisoryAuthor {
  id: string;
  kind: "user" | "agent" | "service";
}

/**
 * An advisory comment attach request. STRUCTURALLY decision-free — the type
 * admits no disposition/verdict field by construction. `runCausation` records the
 * run that prompted the comment (optional provenance). `idempotencyKey` makes the
 * attach idempotent per (gate, key).
 */
export interface AdvisoryAttachRequest {
  gateId: string;
  author: AdvisoryAuthor;
  body: string;
  idempotencyKey: string;
  runCausation?: string | null;
}

/** A stored advisory comment — the attach request + the server-stamped
 * provenance (timestamp). Still decision-free. */
export interface AdvisoryComment {
  id: string;
  gateId: string;
  authorId: string;
  authorKind: AdvisoryAuthor["kind"];
  body: string;
  idempotencyKey: string;
  runCausation: string | null;
  createdAt: Date;
}

export type ValidateAdvisoryResult =
  | { ok: true }
  | { ok: false; error: string };

const MAX_ADVISORY_BODY = 20_000;

/**
 * Validate an advisory attach request. Requires a gate id, an authenticated
 * author (id + valid kind), a non-empty bounded body, and an idempotency key. The
 * DECISION-FREE invariant is enforced at the TYPE level (the request shape admits
 * no verdict field); this runtime check additionally rejects an object that
 * smuggled a `disposition`/`decision`/`verdict`/`approve` field through an
 * untyped boundary — the seam must never carry authority.
 */
export function validateAdvisoryAttach(req: AdvisoryAttachRequest): ValidateAdvisoryResult {
  if (!req.gateId) return { ok: false, error: "gateId is required" };
  if (!req.author?.id) return { ok: false, error: "an authenticated author id is required" };
  if (req.author.kind !== "user" && req.author.kind !== "agent" && req.author.kind !== "service") {
    return { ok: false, error: `unknown author kind "${req.author?.kind}"` };
  }
  if (typeof req.body !== "string" || req.body.trim().length === 0) {
    return { ok: false, error: "advisory body must be a non-empty string" };
  }
  if (req.body.length > MAX_ADVISORY_BODY) {
    return { ok: false, error: `advisory body exceeds ${MAX_ADVISORY_BODY} chars` };
  }
  if (!req.idempotencyKey) return { ok: false, error: "idempotencyKey is required" };
  // Decision-free guard: an untyped boundary object must not smuggle authority.
  const forbidden = ["disposition", "decision", "verdict", "approve", "reject"];
  for (const f of forbidden) {
    if (Object.prototype.hasOwnProperty.call(req, f)) {
      return { ok: false, error: `advisory attach must be decision-free — forbidden field "${f}"` };
    }
  }
  return { ok: true };
}

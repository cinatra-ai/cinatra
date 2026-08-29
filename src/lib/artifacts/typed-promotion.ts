// THE TYPED PROMOTION ROAD (enabler 0.14 of `PLAN: Agents Lifecycle (C)`,
// cinatra#3028 / epic #3023).
//
// THE ENABLER, IN THE PLAN'S OWN WORDS: "The typed promotion road: a matched
// base-type row — an upload the matcher associated with an extension — is
// promoted into that extension's own type as a new revision sharing the content,
// on the matcher's assertion at its threshold and with the person's confirmation
// where the product already asks for one; the promote request that exists today
// becomes the road's entry, and the base row keeps its history; the
// matcher-associated extensions are the first consumers, wired in the sibling
// plan. This is what lets every display register for its own type only: the
// durable claim registry admits one live claimant per type and scope, so
// shared-base claims by many extensions cannot coexist."
//
// WHAT IT FIXES, IN THE PLAN'S OWN WORDS: "the matcher-associated extensions'
// work arrives as base-typed uploads that the matcher labels without retyping,
// so under the one-claimant rule no extension display can ever win for them."
//
// THE ROAD, IN FOUR FACTS:
//
//   1. THE MATCHER'S ASSERTION AT ITS THRESHOLD. The matcher already writes a
//      DRAFT assertion when its confidence clears the extension's declared
//      threshold (`matcher-runtime.ts`). The road reads that assertion; it never
//      re-runs a classification and never lowers a threshold.
//   2. THE PERSON'S CONFIRMATION WHERE THE PRODUCT ALREADY ASKS FOR ONE. That is
//      the library's §VI.1 Confirm (`assertUploadMeaning`), which writes the
//      USER-sourced meaning assertion. No new confirmation surface is invented:
//      the plan says "where the product already asks for one", and this is the
//      one place it does.
//   3. A NEW REVISION SHARING THE CONTENT. The promotion appends a revision over
//      the SAME resource the base revision already points at — no bytes are
//      re-read, re-hashed or re-stored, because the content did not change; only
//      what the product calls it did.
//   4. THE BASE ROW KEEPS ITS HISTORY. The append-only representation table is
//      never rewritten: every earlier revision stays exactly where it was, and
//      the promotion is the next revision, not a replacement of the last.
//
// PURE HALF / STORE HALF. `planTypedPromotion` is a total function over facts a
// caller has already read: every refusal is a NAMED value, so a surface can say
// WHY a confirmation did not retype anything instead of silently doing nothing.
// `buildTypedPromotionQueries` is the compare-and-set that applies it.

import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// The refusals — closed and named.
// ---------------------------------------------------------------------------

export type TypedPromotionRefusal =
  /** No such row in this organization, or it is tombstoned. */
  | "row-not-found"
  /** The row carries no content revision to share. */
  | "no-content"
  /** The extension owns no type of its own to promote into. */
  | "extension-owns-no-type"
  /** The row already carries the extension's own type — nothing to promote. */
  | "already-promoted"
  /** No matcher assertion associates this row with the extension. */
  | "no-matcher-assertion"
  /** The matcher's confidence is below the extension's declared threshold. */
  | "below-threshold"
  /** The person has not confirmed. */
  | "not-confirmed"
  /** The extension's own type does not accept the content's form. */
  | "form-not-accepted";

// ---------------------------------------------------------------------------
// The facts the planner is handed.
// ---------------------------------------------------------------------------

/** The base-typed row as the caller read it. */
export interface PromotableRow {
  objectType: string;
  /** The optimistic version the promotion's compare-and-set anchors on. */
  version: number;
  /** The latest content revision — the one whose resource the new revision
   *  shares. Null for a row with no content at all. */
  latestRevision: {
    representationRevisionId: string;
    resourceId: string;
    form: "file" | "connectorRef" | "dashboard";
    /** The detected mime of the shared content, re-validated against the target
     *  type's accepted forms. */
    mime: string;
  } | null;
}

/** The extension's OWN type, and what it accepts. */
export interface ExtensionOwnType {
  typeId: string;
  /** The mimes the type declares it accepts. Empty ⇒ the type declares no file
   *  form, and a file-backed row cannot be promoted into it. */
  acceptsMimes: readonly string[];
}

/** The matcher's association, as the assertion store recorded it. */
export interface MatcherAssociation {
  confidence: number;
  /** The extension's own declared threshold at the time of the match. */
  threshold: number;
}

export type TypedPromotionPlan =
  | {
      ok: true;
      fromType: string;
      toType: string;
      /** The resource the NEW revision shares with the base revision. */
      sharedResourceId: string;
      /** The revision the shared content came from — recorded so the audit can
       *  say what the promotion was derived from. */
      baseRevisionId: string;
      form: "file" | "connectorRef" | "dashboard";
      /** The `objects.version` the compare-and-set anchors on. */
      expectedVersion: number;
    }
  | { ok: false; reason: TypedPromotionRefusal };

/**
 * Decide whether a matched base-typed row may be promoted into the extension's
 * own type.
 *
 * ORDER IS LOAD-BEARING, because more than one refusal can be true and the first
 * is the honest one: a row that does not exist is not "unconfirmed", and a row
 * that already carries the target type is not "below threshold". The two
 * AUTHORITIES — the matcher's assertion and the person's confirmation — are
 * checked LAST and BOTH, because the plan requires both and neither substitutes
 * for the other: a high-confidence match without a confirmation retypes nothing,
 * and a confirmation on a row the matcher never associated retypes nothing
 * either.
 */
export function planTypedPromotion(input: {
  row: PromotableRow | null;
  ownType: ExtensionOwnType | null;
  matcher: MatcherAssociation | null;
  /** The person's confirmation, from the surface that already asks for one. */
  confirmed: boolean;
}): TypedPromotionPlan {
  const refuse = (reason: TypedPromotionRefusal): TypedPromotionPlan => ({ ok: false, reason });

  if (!input.row) return refuse("row-not-found");
  if (!input.ownType) return refuse("extension-owns-no-type");
  if (input.row.objectType === input.ownType.typeId) return refuse("already-promoted");
  if (!input.row.latestRevision) return refuse("no-content");

  if (!input.matcher) return refuse("no-matcher-assertion");
  if (input.matcher.confidence < input.matcher.threshold) return refuse("below-threshold");
  if (!input.confirmed) return refuse("not-confirmed");

  // RE-VALIDATED AGAINST THE TARGET TYPE, not against the base's. The content is
  // shared unchanged, so the type it lands under must actually accept it — the
  // same rule the write path applies to a fresh write.
  if (!mimeAccepted(input.ownType.acceptsMimes, input.row.latestRevision.mime)) {
    return refuse("form-not-accepted");
  }

  return {
    ok: true,
    fromType: input.row.objectType,
    toType: input.ownType.typeId,
    sharedResourceId: input.row.latestRevision.resourceId,
    baseRevisionId: input.row.latestRevision.representationRevisionId,
    form: input.row.latestRevision.form,
    expectedVersion: input.row.version,
  };
}

/**
 * Does the target type accept this mime? A `*` wildcard and a `type/*` prefix
 * are honoured, matching the accepts grammar the upload map already reads;
 * parameters (`; charset=…`) are stripped, because a charset is not a form.
 */
export function mimeAccepted(accepts: readonly string[], mime: string): boolean {
  if (accepts.length === 0) return false;
  const normalized = mime.toLowerCase().split(";")[0]!.trim();
  const family = normalized.split("/")[0];
  return accepts.some((raw) => {
    const a = raw.toLowerCase().trim();
    if (a === "*" || a === "*/*") return true;
    if (a === normalized) return true;
    return a.endsWith("/*") && a.slice(0, -2) === family;
  });
}

// ---------------------------------------------------------------------------
// The compare-and-set that applies the plan.
// ---------------------------------------------------------------------------

export interface TypedPromotionQueries {
  /** The revision id the promotion will append, pre-allocated so the caller can
   *  report it without a second read. */
  newRepresentationRevisionId: string;
  queries: Array<{ text: string; values: unknown[] }>;
}

/**
 * Build the promotion's ONE transaction: the row is retyped under a
 * compare-and-set on its own version AND its current type, and the new revision
 * is appended only if that retype actually happened.
 *
 * THE COMPARE-AND-SET IS THE WHOLE SAFETY. Between the read the plan was made
 * from and this write, the row can be retyped by another confirmation, or its
 * content can move. Anchoring on `(version, type)` makes a lost race a no-op —
 * the update matches nothing, the guarded insert writes nothing, and the caller
 * is told the row moved — instead of stacking a second promotion revision under
 * a type somebody else chose.
 *
 * THE NEW REVISION SHARES THE CONTENT: it points at the SAME `resource_id` the
 * base revision does. No bytes are copied, and the content-addressed store sees
 * one resource with two representations, which is exactly the multi-artifact
 * attribution it already supports.
 *
 * THE BASE ROW KEEPS ITS HISTORY: `representation` is append-only (a trigger
 * forbids UPDATE and DELETE), and this appends. Nothing earlier is touched.
 */
export function buildTypedPromotionQueries(
  schema: string,
  input: {
    orgId: string;
    artifactId: string;
    plan: Extract<TypedPromotionPlan, { ok: true }>;
    createdBy: string | null;
  },
): TypedPromotionQueries {
  const s = schema.replaceAll('"', '""');
  const newRepresentationRevisionId = randomUUID();
  return {
    newRepresentationRevisionId,
    queries: [
      // Serialize promotions of ONE row against each other, and against the
      // revision allocation below — the same per-artifact lock the append-only
      // representation store takes for exactly this reason.
      { text: `SELECT pg_advisory_xact_lock(hashtext($1))`, values: [input.artifactId] },
      {
        text: `UPDATE "${s}"."objects"
SET type = $4::text, version = version + 1, updated_at = now()
WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL
  AND type = $3::text AND version = $5::bigint
RETURNING id`,
        values: [
          input.artifactId,
          input.orgId,
          input.plan.fromType,
          input.plan.toType,
          input.plan.expectedVersion,
        ],
      },
      {
        // GUARDED ON THE RETYPE. A revision appended without it would announce a
        // promotion that did not happen.
        text: `INSERT INTO "${s}"."representation"
  (id, org_id, artifact_id, resource_id, revision, form, created_by)
SELECT $1::text, $2::text, $3::text, $4::text,
  COALESCE((SELECT MAX(revision) FROM "${s}"."representation" WHERE org_id = $2 AND artifact_id = $3), 0) + 1,
  $5::text, $6
WHERE EXISTS (
  SELECT 1 FROM "${s}"."objects"
  WHERE id = $3 AND org_id = $2 AND type = $7::text AND deleted_at IS NULL
)
RETURNING id, revision`,
        values: [
          newRepresentationRevisionId,
          input.orgId,
          input.artifactId,
          input.plan.sharedResourceId,
          input.plan.form,
          input.createdBy,
          input.plan.toType,
        ],
      },
    ],
  };
}

export type ApplyTypedPromotionResult =
  | { ok: true; representationRevisionId: string; revision: number; toType: string }
  | { ok: false; reason: "row-moved" };

/**
 * Read the transaction's results into an outcome. Separated from the query
 * building so the whole compare-and-set is provable without a database, and the
 * runner is the two lines that actually touch one.
 */
export function readTypedPromotionResult(
  results: ReadonlyArray<{ rows?: unknown[] } | undefined>,
  input: { newRepresentationRevisionId: string; toType: string },
): ApplyTypedPromotionResult {
  // results: [0] the lock, [1] the retype, [2] the guarded append.
  const retyped = (results[1]?.rows?.length ?? 0) > 0;
  const appended = results[2]?.rows?.[0] as { id?: unknown; revision?: unknown } | undefined;
  if (!retyped || !appended) return { ok: false, reason: "row-moved" };
  return {
    ok: true,
    representationRevisionId: String(appended.id ?? input.newRepresentationRevisionId),
    revision: Number(appended.revision ?? 0),
    toType: input.toType,
  };
}

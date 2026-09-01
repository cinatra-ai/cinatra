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
// The store half applies it in two writes, and the order is the contract:
//
//   1. THE RETYPE goes through the canonical history-aware objects writer, whose
//      compare-and-set on the row's own version is what makes a lost race a
//      no-op — and whose change event is what puts the promotion in the row's
//      history rather than only in the reader's memory. This module never writes
//      the objects table itself.
//   2. THE APPEND gives the promoted row its new revision over the SAME
//      resource. It is keyed deterministically and inserts on conflict-do-
//      nothing, so an interrupted promotion CONVERGES on a later call instead of
//      stranding a retyped row with no revision or stacking a second one.

import { createHash } from "node:crypto";

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
  /** The row's own data. Written back UNCHANGED by the retype: a promotion
   *  renames the work, it does not change it. */
  data: unknown;
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

/**
 * THE ROAD'S ENTRY, and the reason it has one.
 *
 * The road runs against ONE type: the type the confirmed extension owns. The
 * surface resolves that from the object-type registry, and the count it finds is
 * not always one — so the entry is a decision, not a lookup, and every outcome
 * of it is named:
 *
 *   - EXACTLY ONE registered artifact type: the road runs against it.
 *   - SEVERAL: a package-keyed confirmation cannot say which type was meant, so
 *     the road is left alone rather than guessing.
 *   - NONE, and the pack ships no display for an unregistered type: a pure
 *     matcher pack. There is nothing to promote INTO and nothing worth
 *     reporting — the road does not apply.
 *   - NONE, and the pack DOES ship a display for a type no package registers:
 *     the pack owns nothing to promote into AND carries an UNREACHABLE display
 *     — its target type is registered by no installed package, so no row can
 *     ever carry it. This is deliberately stated as the CONDITION and not as a
 *     diagnosis of intent: a cross-namespace display target is a supported
 *     shape, so this reading cannot tell "the pack meant to own the type and
 *     used the wrong namespace" apart from "the package that owns the target
 *     type is not installed". Both are broken installations from the road's
 *     seat and both earn the same answer — the road's own named refusal,
 *     `extension-owns-no-type`, instead of silence. Naming WHICH of the two it
 *     is needs manifest and dependency evidence this leaf is not handed.
 *
 * The last case is the one the wave-3 proof leg measured: a deck confirmation that
 * retyped nothing and reported nothing.
 */
export type PromotionEntryPlan =
  | { kind: "run"; typeId: string }
  | { kind: "refuse"; reason: TypedPromotionRefusal }
  | { kind: "not-applicable" };

export function planPromotionEntry(input: {
  /** The artifact types this package actually registered, read from the
   *  object-type registry. */
  ownedRegisteredTypes: readonly string[];
  /** True when the package registered a semantic display whose target object
   *  type NO installed package registers — an unreachable display, whether the
   *  target was a refused self-claim or an absent owner's type. */
  shipsDisplayForUnregisteredType: boolean;
}): PromotionEntryPlan {
  if (input.ownedRegisteredTypes.length === 1) {
    return { kind: "run", typeId: input.ownedRegisteredTypes[0]! };
  }
  if (input.ownedRegisteredTypes.length === 0 && input.shipsDisplayForUnregisteredType) {
    return { kind: "refuse", reason: "extension-owns-no-type" };
  }
  return { kind: "not-applicable" };
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
// The revision the promotion appends.
// ---------------------------------------------------------------------------

/**
 * The promotion revision's DETERMINISTIC id — the same (artifact, shared
 * content, target type) always names the same row.
 *
 * WHY DETERMINISTIC, and not a fresh uuid. The retype and the append are two
 * writes: the retype must go through the canonical history-aware objects writer
 * (which owns its own transaction, its change event and its Graphiti outbox
 * row), so the append cannot ride inside it. A deterministic id plus
 * `ON CONFLICT DO NOTHING` makes the append IDEMPOTENT, which is what lets an
 * interrupted promotion CONVERGE: a later call finds the row already retyped and
 * re-runs the append, which either lands the missing revision or does nothing.
 * A fresh uuid would append a second identical revision on every retry instead.
 */
export function promotionRevisionId(input: {
  artifactId: string;
  sharedResourceId: string;
  toType: string;
}): string {
  const material = [input.artifactId, input.sharedResourceId, input.toType].join("\u0000");
  return `rep_${createHash("sha256").update(material).digest("hex").slice(0, 32)}`;
}

/**
 * The append that gives the promoted row its new revision SHARING the content.
 *
 * It touches `representation` and nothing else — no `objects` reference at all,
 * because the retype that precedes it is the guard: this statement runs only
 * after the canonical writer's compare-and-set has already committed the type
 * change, so a lost race never reaches here.
 *
 * THE BASE ROW KEEPS ITS HISTORY: the table is append-only (a trigger forbids
 * UPDATE and DELETE) and the revision is `MAX + 1`, so nothing earlier moves.
 * The resource is the BASE revision's own — the content is shared, never copied.
 */
export function buildPromotionRepresentationAppend(
  schema: string,
  input: {
    orgId: string;
    artifactId: string;
    representationRevisionId: string;
    sharedResourceId: string;
    form: "file" | "connectorRef" | "dashboard";
    createdBy: string | null;
  },
): { text: string; values: unknown[] } {
  const s = schema.replaceAll('"', '""');
  return {
    text: `INSERT INTO "${s}"."representation"
  (id, org_id, artifact_id, resource_id, revision, form, created_by)
SELECT $1::text, $2::text, $3::text, $4::text,
  COALESCE((SELECT MAX(revision) FROM "${s}"."representation" WHERE org_id = $2 AND artifact_id = $3), 0) + 1,
  $5::text, $6
ON CONFLICT (id) DO NOTHING
RETURNING id, revision`,
    values: [
      input.representationRevisionId,
      input.orgId,
      input.artifactId,
      input.sharedResourceId,
      input.form,
      input.createdBy,
    ],
  };
}

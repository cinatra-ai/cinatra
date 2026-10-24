import "server-only";

// The TYPED PROMOTION ROAD's store half (enabler 0.14 of
// `PLAN: Agents Lifecycle (C)`, cinatra#3028 / epic #3023).
//
// The decision and the compare-and-set are the pure module beside this one
// (`typed-promotion.ts`); this leaf reads the four facts the decision needs and
// runs the transaction. Kept apart so the road's whole contract — every named
// refusal, the shared resource, the guarded append — is provable without a
// database, and so the parts that DO touch one are these two functions and
// nothing else.

import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
import { listActiveAssertions, type AssertionRecord } from "./semantic-assertion-store";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { buildArtifactWriterWitnessOpIfAbsent } from "./artifact-writer-witness";

import type { OrgWriteAuthority } from "@cinatra-ai/org-write-kernel";

import {
  buildPromotionRepresentationAppend,
  mimeAccepted,
  planTypedPromotion,
  promotionRevisionId,
  type ExtensionOwnType,
  type MatcherAssociation,
  type PromotableRow,
  type TypedPromotionRefusal,
} from "./typed-promotion";

const conn = (): string => getPostgresConnectionString();
const schema = (): string => postgresSchema.replaceAll('"', '""');

/**
 * The base-typed row plus its latest content revision, in one read.
 *
 * The MIME comes from the blob the resource points at — the sniffer's own
 * verdict, never a caller claim — because the promotion re-validates the shared
 * content against the target type's accepted forms.
 */
export function readPromotableRow(input: {
  orgId: string;
  artifactId: string;
}): PromotableRow | null {
  ensurePostgresSchema();
  const s = schema();
  const [res] = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `SELECT o.type, o.version, o.data,
  rep.id AS rep_id, rep.resource_id, rep.form,
  COALESCE(b.mime_detected, r.mime, '') AS mime
FROM "${s}"."objects" o
LEFT JOIN LATERAL (
  SELECT id, resource_id, form FROM "${s}"."representation"
  WHERE org_id = o.org_id AND artifact_id = o.id
  ORDER BY revision DESC LIMIT 1
) rep ON TRUE
LEFT JOIN "${s}"."resource" r ON r.id = rep.resource_id AND r.org_id = o.org_id
LEFT JOIN "${s}"."artifact_blobs" b
  ON b.org_id = o.org_id AND b.id = (r.metadata->>'blobId')
WHERE o.id = $1 AND o.org_id = $2 AND o.deleted_at IS NULL
LIMIT 1`,
        values: [input.artifactId, input.orgId],
      },
    ],
  });
  const row = res?.rows?.[0] as
    | {
        type: string;
        version: number | string;
        data: unknown;
        rep_id: string | null;
        resource_id: string | null;
        form: string | null;
        mime: string | null;
      }
    | undefined;
  if (!row) return null;
  return {
    objectType: String(row.type),
    data: row.data ?? null,
    version: Number(row.version ?? 0),
    latestRevision:
      row.rep_id && row.resource_id && row.form
        ? {
            representationRevisionId: String(row.rep_id),
            resourceId: String(row.resource_id),
            form: row.form as "file" | "connectorRef" | "dashboard",
            mime: String(row.mime ?? ""),
          }
        : null,
  };
}

/**
 * The matcher's association for one (row, extension), as the assertion store
 * recorded it.
 *
 * ONLY a `matcher` assertion counts. A user's or an agent's assertion is not a
 * match — the plan's authority is "the matcher's assertion at its threshold" —
 * and reading any assertion here would let a confirmation promote a row nothing
 * ever classified.
 */
export function readMatcherAssociation(input: {
  orgId: string;
  artifactId: string;
  extension: string;
  threshold: number;
}): MatcherAssociation | null {
  ensurePostgresSchema();
  const s = schema();
  const [res] = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `SELECT confidence FROM "${s}"."semantic_assertion"
WHERE org_id = $1 AND artifact_id = $2 AND extension = $3
  AND asserted_by = 'matcher' AND eligibility <> 'archived'
ORDER BY asserted_at DESC LIMIT 1`,
        values: [input.orgId, input.artifactId, input.extension],
      },
    ],
  });
  const row = res?.rows?.[0] as { confidence: number | string | null } | undefined;
  if (!row) return null;
  return {
    // A matcher row with NO recorded confidence cannot clear a threshold, and
    // treating an absent number as a pass is exactly the kind of default this
    // road must not have.
    confidence: row.confidence === null ? -1 : Number(row.confidence),
    threshold: input.threshold,
  };
}

/**
 * THE PERSON'S OWN ASSERTION for one (row, extension), as the assertion store
 * recorded it — the second road §XI.10 gives onto the promotion.
 *
 * IT ASKS THE ASSERTION STORE RATHER THAN THE DATABASE. The store already reads
 * a row's active assertions for the assertion primitive; a second statement of
 * its own here would be a second reading of the same table that can drift from
 * the first, and this module's whole shape is that the parts touching a database
 * are few and named.
 *
 * ONLY a `user` assertion counts. An agent's and an authoring skill's are classic
 * assertions too, but the drawing's sentence is about the PERSON: "or on the
 * person's own assertion, which outranks the matcher". A `binding` row is what
 * every upload already carries for its base, so counting one here would promote
 * every row the moment anybody confirmed anything.
 *
 * AND IT IS THE ACTING PERSON'S OWN. The drawing's word is "own", and the road
 * reaches the promotion through a branch that runs BESIDE the per-actor
 * extension-access gate rather than behind it: a reading that accepted any
 * person's assertion would let a second person, who cannot address that
 * extension at all, spend somebody else's assertion as their authority. The
 * assertion store records who asserted, so the comparison is available and the
 * road takes it.
 */
export function isPersonsOwnAssertion(
  assertion: Pick<
    AssertionRecord,
    "extension" | "assertedBy" | "assertionBasis" | "assertedByPrincipal"
  >,
  who: { extension: string; principal: string | null },
): boolean {
  return (
    assertion.extension === who.extension &&
    assertion.assertedBy === "user" &&
    assertion.assertionBasis === "classic" &&
    assertion.assertedByPrincipal === who.principal
  );
}

export function readPersonAssertion(input: {
  orgId: string;
  artifactId: string;
  extension: string;
  /** The acting principal, as the surface derived it. */
  principal: string | null;
}): boolean {
  return listActiveAssertions(input.orgId, input.artifactId).some((a) =>
    isPersonsOwnAssertion(a, { extension: input.extension, principal: input.principal }),
  );
}

export type PromoteMatchedArtifactTypeResult =
  | {
      ok: true;
      representationRevisionId: string;
      /** The revision number the append landed, or null when the revision was
       *  already present (a converging re-run of an interrupted promotion). */
      revision: number | null;
      toType: string;
      /** FALSE when the row was already retyped and this call only completed the
       *  append an interrupted promotion left behind. */
      retyped: boolean;
    }
  | {
      ok: false;
      /** `promotion-unproven`: the retype committed, but the row's latest type
       *  change is not this promotion's own keyed retype, so nothing was
       *  appended. */
      reason: TypedPromotionRefusal | "row-moved" | "not-authorized" | "promotion-unproven";
    };

/**
 * THE KEY A PROMOTION'S OWN RETYPE RECORDS on its change event (cinatra#3319,
 * cinatra#4266). Only this module makes it, and only for the retype it runs:
 * the promotion revision's own id plus the version the retype's compare-and-set
 * was anchored on. Every other writer of a type change (a restore, a merge, the
 * CMS state machine, a native create) records another key, so its event is
 * never read as a promotion.
 */
function promotionRetypeKey(input: {
  artifactId: string;
  sharedResourceId: string;
  toType: string;
  baseVersion: number;
}): string {
  return `typed-promotion:${promotionRevisionId(input)}:${input.baseVersion}`;
}

/** A version column as the driver answers it (an integer, or its text). */
function readVersion(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return Number(value);
  return null;
}

/** One type-change event of the row, as the proof read selects it. */
type TypeChangeEvent = {
  object_type: unknown;
  before_type: unknown;
  base_version: unknown;
  result_version: unknown;
  idempotency_key: unknown;
  org_id: unknown;
};

/**
 * Does the row's history PROVE that this promotion retyped it?
 *
 * Only the row's LATEST type change counts (the highest result version): an
 * older promotion that a restore, a merge or another move later overwrote is no
 * proof. It proves only when it landed in the target type, in this
 * organization, and carries exactly the key this promotion's retype records
 * for that event's own base version. A restore, a merge, a native type, the
 * person's standing assertion or a later move away is therefore never a proof.
 * A failed read throws: an error is never a proof.
 */
function readPromotionProof(input: {
  orgId: string;
  artifactId: string;
  sharedResourceId: string;
  toType: string;
}): boolean {
  ensurePostgresSchema();
  const s = schema();
  const [res] = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `SELECT object_type, before_snapshot->>'type' AS before_type,
  base_version, result_version, idempotency_key, org_id
FROM "${s}"."object_change_event"
WHERE object_id = $1 AND org_id = $2
  AND (before_snapshot->>'type') IS DISTINCT FROM object_type
ORDER BY result_version DESC, created_at DESC, sequence DESC
LIMIT 1`,
        values: [input.artifactId, input.orgId],
      },
    ],
  });
  let latest: { event: TypeChangeEvent; version: number } | null = null;
  for (const event of (res?.rows ?? []) as TypeChangeEvent[]) {
    if (event.before_type === event.object_type) continue;
    const version = readVersion(event.result_version);
    if (version === null) continue;
    if (latest === null || version > latest.version) latest = { event, version };
  }
  if (latest === null) return false;
  const { event } = latest;
  const baseVersion = readVersion(event.base_version);
  return (
    event.org_id === input.orgId &&
    event.object_type === input.toType &&
    baseVersion !== null &&
    event.idempotency_key ===
      promotionRetypeKey({
        artifactId: input.artifactId,
        sharedResourceId: input.sharedResourceId,
        toType: input.toType,
        baseVersion,
      })
  );
}

/**
 * THE ONLY ROAD TO THE APPEND: the promotion revision is appended only when the
 * row's history proves that this promotion retyped it ({@link readPromotionProof}).
 * Without that proof it writes nothing and answers null. Both the fresh
 * promotion and the converging completion of an interrupted one append here.
 */
function appendProvenPromotionRevision(
  input: Parameters<typeof appendPromotionRevision>[0],
): ReturnType<typeof appendPromotionRevision> | null {
  const proven = readPromotionProof({
    orgId: input.orgId,
    artifactId: input.artifactId,
    sharedResourceId: input.sharedResourceId,
    toType: input.toType,
  });
  return proven ? appendPromotionRevision(input) : null;
}

/**
 * THE ROAD, END TO END: read the row, read the matcher's association, decide,
 * and — only on a decision that says yes — retype through the canonical
 * history-aware writer and append the revision that shares the content.
 *
 * `confirmed` is the caller's: this leaf never decides that a person agreed. The
 * one surface that asks (`assertUploadMeaning`, the library's §VI.1 Confirm)
 * passes true after it has written the person's own meaning assertion.
 *
 * CONVERGENT ON `already-promoted`. The two writes are two transactions, because
 * the canonical objects writer owns its own; an interruption between them leaves
 * a retyped row whose promotion revision is missing. So the `already-promoted`
 * branch does not simply refuse: it re-runs the idempotent append first, and
 * refuses only when there was nothing left to do.
 */
export async function promoteMatchedArtifactType(input: {
  orgId: string;
  artifactId: string;
  extension: string;
  ownType: ExtensionOwnType | null;
  /** The extension's own declared matcher threshold, or NULL where the pack
   *  declares no matcher machinery at all — in which case the matcher road does
   *  not exist for it and only the person's own assertion can promote. */
  threshold: number | null;
  confirmed: boolean;
  createdBy?: string | null;
  /** WHO IS ACTING. The person's own road (§XI.10) is the ACTING person's own,
   *  so the road needs the acting principal and not merely the row's author.
   *  Defaults to `createdBy`, which every production surface passes the same
   *  principal into. */
  principal?: string | null;
  /** The acting principal, for the history event the retype records. */
  actor: { userId: string; orgId: string };
  /** The org-write kernel authority, minted host-side by the calling surface —
   *  this leaf never mints one. */
  authority: OrgWriteAuthority;
  /**
   * The retype itself. Defaults to the canonical history-aware objects writer,
   * which is the ONLY road this module ever takes in production.
   *
   * Injectable because that writer's module graph reaches the application boot
   * (the session module, the connector registry), which a node-tier real-database
   * proof of the promotion's DATA effects must not pull in. A test substitutes
   * the same compare-and-set; nothing else does.
   */
  retype?: TypedPromotionRetype;
}): Promise<PromoteMatchedArtifactTypeResult> {
  const row = readPromotableRow({ orgId: input.orgId, artifactId: input.artifactId });
  const matcher =
    input.threshold === null
      ? null
      : readMatcherAssociation({
          orgId: input.orgId,
          artifactId: input.artifactId,
          extension: input.extension,
          threshold: input.threshold,
        });
  const personAsserted = readPersonAssertion({
    orgId: input.orgId,
    artifactId: input.artifactId,
    extension: input.extension,
    principal: input.principal !== undefined ? input.principal : (input.createdBy ?? null),
  });
  const plan = planTypedPromotion({
    row,
    ownType: input.ownType,
    matcher,
    confirmed: input.confirmed,
    personAsserted,
  });

  if (!plan.ok) {
    // THE CONVERGING BRANCH. An `already-promoted` row may be one an earlier
    // call retyped and never got to append for. Everything else is a refusal.
    //
    // IT CARRIES THE SAME AUTHORITIES AS THE PROMOTION ITSELF, and the same form
    // re-validation. A row that simply CARRIES the target type — written that way
    // from the start, or promoted under some other road — was never this
    // promotion, and appending a revision to it on a bare confirmation would be a
    // write nobody asserted for: the completion of an interrupted promotion is
    // only a completion when the promotion's own conditions still hold. Both
    // roads count here for the same reason they count above — a promotion the
    // person's own assertion authorized is exactly as interruptible as one the
    // matcher's did.
    if (
      plan.reason === "already-promoted" &&
      row?.latestRevision &&
      input.ownType &&
      row.objectType === input.ownType.typeId &&
      // BOTH ROADS ANSWER TO THE CONFIRMATION. The plan refuses an unconfirmed
      // caller on either road, and the completion of an interrupted promotion
      // can be no cheaper than the promotion it completes; the person's road
      // read as if it stood on its own here, which is an asymmetry and not a
      // second rule.
      input.confirmed &&
      (personAsserted || (matcher !== null && matcher.confidence >= matcher.threshold)) &&
      mimeAccepted(input.ownType.acceptsMimes, row.latestRevision.mime)
    ) {
      // AND ONLY ON PROOF (cinatra#3319, cinatra#4266): the conditions above
      // also hold for a row that carried this type from the start, or that a
      // restore moved back into it. Only this promotion's own keyed retype,
      // still the row's latest type change, makes the row an interrupted one.
      const landed = appendProvenPromotionRevision({
        orgId: input.orgId,
        artifactId: input.artifactId,
        sharedResourceId: row.latestRevision.resourceId,
        toType: input.ownType.typeId,
        form: row.latestRevision.form,
        createdBy: input.createdBy ?? null,
        mime: row.latestRevision.mime,
      });
      if (landed !== null && landed.revision !== null) {
        return { ok: true, ...landed, toType: input.ownType.typeId, retyped: false };
      }
    }
    return { ok: false, reason: plan.reason };
  }

  // 1. THE RETYPE, through the canonical history-aware writer. Its
  //    compare-and-set on the row's own version is the whole race safety, and
  //    its change event is what puts the promotion in the row's history.
  const retype = input.retype ?? canonicalRetype;
  const retyped = await retype({
    orgId: input.orgId,
    artifactId: input.artifactId,
    data: row!.data,
    toType: plan.toType,
    expectedVersion: plan.expectedVersion,
    // The key its change event records: what makes this retype readable as the
    // promotion's own, now and on a later converging confirmation.
    idempotencyKey: promotionRetypeKey({
      artifactId: input.artifactId,
      sharedResourceId: plan.sharedResourceId,
      toType: plan.toType,
      baseVersion: plan.expectedVersion,
    }),
    actor: input.actor,
    authority: input.authority,
  });
  if (!retyped.ok) return { ok: false, reason: retyped.reason };

  // 2. THE APPEND, on the same proof as the converging road: another writer may
  //    have moved the row between the retype and here, and then the revision
  //    would name a type change this promotion no longer made.
  const landed = appendProvenPromotionRevision({
    orgId: input.orgId,
    artifactId: input.artifactId,
    sharedResourceId: plan.sharedResourceId,
    toType: plan.toType,
    form: plan.form,
    createdBy: input.createdBy ?? null,
    mime: row?.latestRevision?.mime ?? null,
  });
  if (landed === null) return { ok: false, reason: "promotion-unproven" };
  return {
    ok: true,
    representationRevisionId: landed.representationRevisionId,
    revision: landed.revision,
    toType: plan.toType,
    retyped: true,
  };
}

/** The retype half, as a port. */
export type TypedPromotionRetype = (input: {
  orgId: string;
  artifactId: string;
  data: unknown;
  toType: string;
  expectedVersion: number;
  /** The key the retype's change event must record (`typed-promotion:…`). */
  idempotencyKey: string;
  actor: { userId: string; orgId: string };
  authority: OrgWriteAuthority;
}) => Promise<{ ok: true } | { ok: false; reason: "row-moved" | "not-authorized" }>;

/**
 * THE PRODUCTION RETYPE: the canonical history-aware objects writer.
 *
 * This module never writes the objects table itself — a type change is an
 * application-visible mutation, so it belongs in the row's own history with a
 * change event and a Graphiti outbox row, which is exactly what this writer
 * commits alongside it. Its compare-and-set on the row's version is the race
 * safety: a concurrent confirmation that already retyped the row moved the
 * version, and this call answers `row-moved` having written nothing.
 */
const canonicalRetype: TypedPromotionRetype = async (input) => {
  const { historyAwareUpsert } = await import("@/lib/object-history/canonical-writer");
  const { VersionConflictError } = await import("@/lib/object-history/errors");
  const { OrgWriteAuthorityError } = await import("@/lib/org-write/authority");
  try {
    historyAwareUpsert(
      {
        id: input.artifactId,
        // ONLY THE TYPE MOVES. The data is written back exactly as it was read,
        // because a promotion renames the work, it does not change it.
        type: input.toType,
        data: input.data,
        orgId: input.orgId,
      },
      {
        actor: { actorId: input.actor.userId, actorKind: "user", orgId: input.actor.orgId },
        historyEffect: "reversible-internal",
        expectedBaseVersion: input.expectedVersion,
        idempotencyKey: input.idempotencyKey,
        authority: input.authority,
      },
    );
    return { ok: true };
  } catch (error) {
    if (error instanceof VersionConflictError) return { ok: false, reason: "row-moved" };
    if (error instanceof OrgWriteAuthorityError) return { ok: false, reason: "not-authorized" };
    throw error;
  }
};

/** Append the promotion's revision, idempotently, under the per-artifact lock
 *  the append-only representation store takes for the same reason. */
/**
 * THE APPEND'S WHOLE TRANSACTION, as a pure list — the row lock, the shared-
 * content representation, and the ARTIFACT-WRITER PROVENANCE WITNESS for it.
 *
 * THE WITNESS IS NOT OPTIONAL HERE, and `artifact-writer-witness.ts` says why in
 * its own words: "every host writer that mints a blob-backed representation
 * emits the witness, and every claimed-row read path (serve, context candidacy,
 * selection finalization) tests for it". This road IS such a writer — its append
 * mints a blob-backed representation on a PACK-TYPED row, and the serve arm
 * admits a pack-typed row's direct representation only when the witness attests
 * it. Without it the promotion committed bytes that every read path refused: the
 * promoted revision answered 404 on `/preview` and on `/content` while the base
 * revision it shares its resource with answered 200, so the artifact page drew
 * its header over an empty plate.
 *
 * The witness is the CONVERGING form because the representation INSERT is: both
 * halves of a re-run promotion must be able to land exactly once, and a
 * revision an earlier promotion appended without a witness is repaired by the
 * same re-run (a re-run that the row's history proves, cinatra#3319).
 *
 * Pure so the one-transaction composition is fixture-provable, the same shape
 * the other host writers' witness proofs take.
 */
export function buildPromotionAppendQueries(
  schema: string,
  input: {
    orgId: string;
    artifactId: string;
    representationRevisionId: string;
    sharedResourceId: string;
    form: "file" | "connectorRef" | "dashboard";
    createdBy: string | null;
    toType: string;
    mime?: string | null;
  },
): Array<{ text: string; values: unknown[] }> {
  const s = schema.replaceAll('"', '""');
  return [
    { text: `SELECT pg_advisory_xact_lock(hashtext($1))`, values: [input.artifactId] },
    buildPromotionRepresentationAppend(schema, {
      orgId: input.orgId,
      artifactId: input.artifactId,
      representationRevisionId: input.representationRevisionId,
      sharedResourceId: input.sharedResourceId,
      form: input.form,
      createdBy: input.createdBy,
    }),
    buildArtifactWriterWitnessOpIfAbsent(s, {
      orgId: input.orgId,
      artifactId: input.artifactId,
      representationRevisionId: input.representationRevisionId,
      actor: input.createdBy,
      // Provenance detail only — the witness is the EXISTENCE of the row, never
      // its payload.
      detail: { road: "typed-promotion", toType: input.toType, mime: input.mime ?? null },
    }),
  ];
}

function appendPromotionRevision(input: {
  orgId: string;
  artifactId: string;
  sharedResourceId: string;
  toType: string;
  form: "file" | "connectorRef" | "dashboard";
  createdBy: string | null;
  /** The shared content's MIME, for the witness's provenance detail. */
  mime?: string | null;
}): { representationRevisionId: string; revision: number | null } {
  ensurePostgresSchema();
  const representationRevisionId = promotionRevisionId({
    artifactId: input.artifactId,
    sharedResourceId: input.sharedResourceId,
    toType: input.toType,
  });
  const results = runPostgresQueriesSync({
    connectionString: conn(),
    transaction: true,
    queries: buildPromotionAppendQueries(postgresSchema, {
      orgId: input.orgId,
      artifactId: input.artifactId,
      representationRevisionId,
      sharedResourceId: input.sharedResourceId,
      form: input.form,
      createdBy: input.createdBy,
      toType: input.toType,
      mime: input.mime ?? null,
    }),
  });
  const appended = results?.[1]?.rows?.[0] as { revision?: unknown } | undefined;
  return {
    representationRevisionId,
    revision: appended ? Number(appended.revision) : null,
  };
}

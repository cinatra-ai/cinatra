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
import { listActiveAssertions } from "./semantic-assertion-store";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";

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
 */
export function readPersonAssertion(input: {
  orgId: string;
  artifactId: string;
  extension: string;
}): boolean {
  return listActiveAssertions(input.orgId, input.artifactId).some(
    (a) =>
      a.extension === input.extension &&
      a.assertedBy === "user" &&
      a.assertionBasis === "classic",
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
  | { ok: false; reason: TypedPromotionRefusal | "row-moved" | "not-authorized" };

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
      (personAsserted ||
        (input.confirmed && matcher !== null && matcher.confidence >= matcher.threshold)) &&
      mimeAccepted(input.ownType.acceptsMimes, row.latestRevision.mime)
    ) {
      const landed = appendPromotionRevision({
        orgId: input.orgId,
        artifactId: input.artifactId,
        sharedResourceId: row.latestRevision.resourceId,
        toType: input.ownType.typeId,
        form: row.latestRevision.form,
        createdBy: input.createdBy ?? null,
      });
      if (landed.revision !== null) {
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
    actor: input.actor,
    authority: input.authority,
  });
  if (!retyped.ok) return { ok: false, reason: retyped.reason };

  // 2. THE APPEND. The retype has committed, so the row carries the target type
  //    and this needs no guard of its own.
  const landed = appendPromotionRevision({
    orgId: input.orgId,
    artifactId: input.artifactId,
    sharedResourceId: plan.sharedResourceId,
    toType: plan.toType,
    form: plan.form,
    createdBy: input.createdBy ?? null,
  });
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
function appendPromotionRevision(input: {
  orgId: string;
  artifactId: string;
  sharedResourceId: string;
  toType: string;
  form: "file" | "connectorRef" | "dashboard";
  createdBy: string | null;
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
    queries: [
      { text: `SELECT pg_advisory_xact_lock(hashtext($1))`, values: [input.artifactId] },
      buildPromotionRepresentationAppend(postgresSchema, {
        orgId: input.orgId,
        artifactId: input.artifactId,
        representationRevisionId,
        sharedResourceId: input.sharedResourceId,
        form: input.form,
        createdBy: input.createdBy,
      }),
    ],
  });
  const appended = results?.[1]?.rows?.[0] as { revision?: unknown } | undefined;
  return {
    representationRevisionId,
    revision: appended ? Number(appended.revision) : null,
  };
}

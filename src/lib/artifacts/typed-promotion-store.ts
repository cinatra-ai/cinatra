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
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";

import {
  buildTypedPromotionQueries,
  planTypedPromotion,
  readTypedPromotionResult,
  type ApplyTypedPromotionResult,
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
        text: `SELECT o.type, o.version,
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
        rep_id: string | null;
        resource_id: string | null;
        form: string | null;
        mime: string | null;
      }
    | undefined;
  if (!row) return null;
  return {
    objectType: String(row.type),
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

export type PromoteMatchedArtifactTypeResult =
  | ({ ok: true } & Extract<ApplyTypedPromotionResult, { ok: true }>)
  | { ok: false; reason: TypedPromotionRefusal | "row-moved" };

/**
 * THE ROAD, END TO END: read the row, read the matcher's association, decide,
 * and — only on a decision that says yes — retype under a compare-and-set and
 * append the revision that shares the content.
 *
 * `confirmed` is the caller's: this leaf never decides that a person agreed. The
 * one surface that asks (`assertUploadMeaning`, the library's §VI.1 Confirm)
 * passes true after it has written the person's own meaning assertion.
 */
export function promoteMatchedArtifactType(input: {
  orgId: string;
  artifactId: string;
  extension: string;
  ownType: ExtensionOwnType | null;
  threshold: number;
  confirmed: boolean;
  createdBy?: string | null;
}): PromoteMatchedArtifactTypeResult {
  const row = readPromotableRow({ orgId: input.orgId, artifactId: input.artifactId });
  const matcher = readMatcherAssociation({
    orgId: input.orgId,
    artifactId: input.artifactId,
    extension: input.extension,
    threshold: input.threshold,
  });
  const plan = planTypedPromotion({
    row,
    ownType: input.ownType,
    matcher,
    confirmed: input.confirmed,
  });
  if (!plan.ok) return { ok: false, reason: plan.reason };

  const built = buildTypedPromotionQueries(postgresSchema, {
    orgId: input.orgId,
    artifactId: input.artifactId,
    plan,
    createdBy: input.createdBy ?? null,
  });
  const results = runPostgresQueriesSync({
    connectionString: conn(),
    transaction: true,
    queries: built.queries,
  });
  const applied = readTypedPromotionResult(results ?? [], {
    newRepresentationRevisionId: built.newRepresentationRevisionId,
    toType: plan.toType,
  });
  return applied.ok ? { ...applied, ok: true } : { ok: false, reason: applied.reason };
}

// THE OBJECT-BACKED CONTRACT, IMPLEMENTED (enabler 0.13 of
// `PLAN: Agents Lifecycle (C)`, cinatra#3028 / epic #3023).
//
// THE ENABLER, IN THE PLAN'S OWN WORDS: "The object-backed contract,
// implemented: the host and SDK props union (the live object projection, or a
// minted snapshot revision, discriminated); the authorized live-object read; the
// snapshot mint-or-reuse transaction; the produced event emitted at the mint;
// the review-request trigger; and the binding of the minted revision into the
// review target. Its first consumers — the email record types — are wired in the
// sibling plan."
//
// WHAT IT FIXES, IN THE PLAN'S OWN WORDS: "an object-backed row has no
// representation to pin, so nothing about it can be reviewed today and no
// display can say whether it shows live data or a snapshot."
//
// §2, ON WHAT AN OBJECT-BACKED ARTIFACT IS: "Object-backed. The entry's own
// structured data is the substance — an 'entry in the objects database': an
// email record, a dashboard's configuration row. It may be mutable and may carry
// no representation at first. Before anything is decided about it — a review, an
// approval, a pinned context — an immutable snapshot revision is minted (or an
// existing one reused) and the decision binds that snapshot, never the live row."
//
// §3, ON THE CONTRACT: "An object-backed type declares its object-data schema.
// Its display receives a discriminated projection — the live object data, or a
// minted snapshot revision — and says which of the two it is showing. Minting
// the snapshot is what makes a row reviewable, and the produced event is emitted
// at the mint, never at the raw row write."
//
// PURE OVER PORTS, the W3 shape. The road's ORDER — read authorized, then mint
// or reuse, then emit, then hand back the target the gate will pin — is the
// contract, and it is provable without a database. The server binder at the foot
// of this file supplies the three real ports and nothing else.
//
// THE MINT-OR-REUSE TRANSACTION IS NOT NEW. `captureObjectContentSnapshot`
// (cinatra#1430) already mints one immutable JSON snapshot per
// (object, content, claimant) key under an advisory lock and reuses an existing
// one on the same key; it was built for context pinning. What this contract adds
// is the three things a REVIEW needs and pinning never did: the produced event
// at the mint, the discriminated projection, and the target the gate binds.

import { createHash } from "node:crypto";

import { producedEventId } from "@/lib/lifecycle/lifecycle-produced-event";
import type { ArtifactReviewTarget } from "@/lib/artifacts/artifact-review-target";
import type { ArtifactOriginKind } from "@cinatra-ai/artifacts";

// ---------------------------------------------------------------------------
// The refusals — a closed set, named.
// ---------------------------------------------------------------------------

/** Why the object-backed road produced no reviewable target. Closed, and
 *  identifier-free: a caller branches on the token. */
export type ObjectBackedRefusal =
  /** No such row in this organization, or it is tombstoned. */
  | "not-found"
  /** The actor may not read the row. Indistinguishable from `not-found` to an
   *  UNAUTHORIZED caller by the caller's own choice; kept distinct here because
   *  the host needs to tell them apart in its own logs. */
  | "denied"
  /** The row's type is not object-backed, so this road does not apply to it. */
  | "not-object-backed"
  /** The mint-or-reuse transaction produced no snapshot (the row changed under
   *  the capture, or its content is not snapshottable). */
  | "snapshot-unavailable";

// ---------------------------------------------------------------------------
// The authorized live-object read.
// ---------------------------------------------------------------------------

/** One live object row, as the ports hand it back. */
export interface LiveObjectRow {
  objectType: string;
  /** The entry's own structured data — the substance. */
  data: unknown;
  /** The row's optimistic version at the read. */
  version: number;
}

export interface ObjectBackedReadPorts {
  /** The live row, ALREADY tenant-scoped by the caller's `orgId`. Null for an
   *  absent or tombstoned row. */
  readLiveObject(input: {
    orgId: string;
    objectId: string;
  }): LiveObjectRow | null | Promise<LiveObjectRow | null>;
  /** Does this type declare an object-data substance? A type whose substance is
   *  a file is representation-backed and takes the other road entirely. */
  isObjectBackedType(objectType: string): boolean;
  /** The actor's read decision on the row. Asked AFTER the row is found, so the
   *  decision is made against the real type rather than a caller claim. */
  authorizeRead(input: {
    orgId: string;
    objectId: string;
    objectType: string;
  }): boolean | Promise<boolean>;
}

export type AuthorizedLiveObjectResult =
  | { ok: true; objectType: string; data: unknown; version: number }
  | { ok: false; reason: Exclude<ObjectBackedRefusal, "snapshot-unavailable"> };

/**
 * THE AUTHORIZED LIVE-OBJECT READ.
 *
 * Order is load-bearing and is the whole security content of this function: the
 * row is found first (so the type is the substrate's, never the caller's), the
 * type is checked second (so this road refuses a file-backed artifact instead of
 * projecting one), and the authorization decision is asked LAST, against the
 * real (organization, object, type) triple.
 */
export async function readAuthorizedLiveObject(
  input: { orgId: string; objectId: string },
  ports: ObjectBackedReadPorts,
): Promise<AuthorizedLiveObjectResult> {
  const row = await ports.readLiveObject(input);
  if (!row) return { ok: false, reason: "not-found" };
  if (!ports.isObjectBackedType(row.objectType)) {
    return { ok: false, reason: "not-object-backed" };
  }
  const allowed = await ports.authorizeRead({
    orgId: input.orgId,
    objectId: input.objectId,
    objectType: row.objectType,
  });
  if (!allowed) return { ok: false, reason: "denied" };
  return { ok: true, objectType: row.objectType, data: row.data, version: row.version };
}

// ---------------------------------------------------------------------------
// The mint-or-reuse road, and the target it binds.
// ---------------------------------------------------------------------------

/** What the mint-or-reuse transaction hands back. Mirrors the #1430 capture
 *  result, narrowed to what this road reads. */
export interface MintedObjectSnapshot {
  representationRevisionId: string;
  /** sha256 of the normalized snapshot data. */
  contentDigest: string;
  /** TRUE when an existing snapshot for the exact key was reused — no mint. */
  reused: boolean;
  /** The object's type at capture. */
  effectiveBaseType: string;
}

export interface ObjectBackedReviewPorts extends ObjectBackedReadPorts {
  /**
   * The snapshot mint-or-reuse transaction. It emits the produced event ITSELF
   * on the mint arm, in the capture's own transaction — the plan's "the produced
   * event emitted at the mint" — which is why this road does not emit for a
   * fresh mint.
   */
  mintOrReuseSnapshot(input: {
    orgId: string;
    objectId: string;
    createdBy: string | null;
    createdByRunId: string | null;
  }): Promise<MintedObjectSnapshot | null>;
  /**
   * Ensure the produced event exists for a snapshot that was REUSED rather than
   * minted here.
   *
   * A reuse is not a mint, so the capture's own same-transaction emit does not
   * fire — and a snapshot minted earlier for CONTEXT PINNING carries no produced
   * event at all, because pinning a row as context is not asking anyone to
   * decide about it. Without this the first review of a row that had already
   * been pinned would open no gate. Idempotent on the deterministic event id, so
   * a second reviewer of the same snapshot adds nothing.
   */
  ensureProducedEventForReusedSnapshot(input: {
    orgId: string;
    artifactId: string;
    representationRevisionId: string;
  }): Promise<void>;
}

export type OpenObjectBackedReviewResult =
  | {
      ok: true;
      /** THE BINDING OF THE MINTED REVISION INTO THE REVIEW TARGET — the exact
       *  `{artifactId, representationRevisionId}` the gate will pin, and the
       *  same tuple the produced event carries. */
      target: ArtifactReviewTarget;
      /** FALSE when an existing snapshot for the key was reused. */
      minted: boolean;
      contentDigest: string;
      objectType: string;
      /** The deterministic produced-event id for the bound revision — the
       *  review-request trigger's own row id, so a caller can assert the request
       *  exists without re-deriving the hash. */
      producedEventId: string;
    }
  | { ok: false; reason: ObjectBackedRefusal };

/**
 * OPEN A REVIEW ON AN OBJECT-BACKED ROW: read it authorized, mint or reuse its
 * immutable snapshot, make sure the produced event that requests the review
 * exists for exactly that revision, and hand back the target the gate binds.
 *
 * WHAT THIS FUNCTION DELIBERATELY DOES NOT DO: open the gate. The produced event
 * IS the review-request trigger — the orchestration sweep drains it and pins the
 * target — and a second road that created gates directly would be a parallel
 * decision path over the same revision.
 */
export async function openObjectBackedReview(
  input: {
    orgId: string;
    objectId: string;
    /** The principal on whose behalf the snapshot is captured. */
    createdBy?: string | null;
    /** The run that asked, when a run asked. */
    createdByRunId?: string | null;
  },
  ports: ObjectBackedReviewPorts,
): Promise<OpenObjectBackedReviewResult> {
  const live = await readAuthorizedLiveObject(
    { orgId: input.orgId, objectId: input.objectId },
    ports,
  );
  if (!live.ok) return { ok: false, reason: live.reason };

  const snapshot = await ports.mintOrReuseSnapshot({
    orgId: input.orgId,
    objectId: input.objectId,
    createdBy: input.createdBy ?? null,
    createdByRunId: input.createdByRunId ?? null,
  });
  if (!snapshot) return { ok: false, reason: "snapshot-unavailable" };

  if (snapshot.reused) {
    await ports.ensureProducedEventForReusedSnapshot({
      orgId: input.orgId,
      artifactId: input.objectId,
      representationRevisionId: snapshot.representationRevisionId,
    });
  }

  return {
    ok: true,
    target: {
      artifactId: input.objectId,
      representationRevisionId: snapshot.representationRevisionId,
    },
    minted: !snapshot.reused,
    contentDigest: snapshot.contentDigest,
    objectType: snapshot.effectiveBaseType,
    producedEventId: producedEventId(
      input.objectId,
      snapshot.representationRevisionId,
      "artifact_produced",
    ),
  };
}

// ---------------------------------------------------------------------------
// The digest a live projection carries.
// ---------------------------------------------------------------------------

/**
 * A stable digest over the projected object data.
 *
 * A SNAPSHOT projection carries the capture's own content digest, so the display
 * and the decision provably speak about the same bytes. A LIVE projection has no
 * capture to borrow from, so it hashes what it is actually carrying — which is
 * the honest statement, because a live row's digest is only ever a statement
 * about this read.
 */
export function objectProjectionDigest(data: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(data ?? null) ?? "null";
  } catch {
    // A circular structure has no stable serialization and therefore no digest
    // this function may claim. The projection builder refuses it as over-cap.
    return "";
  }
  return createHash("sha256").update(serialized).digest("hex");
}

// ---------------------------------------------------------------------------
// The server binder.
// ---------------------------------------------------------------------------

/**
 * The three real ports, bound to the host's stores.
 *
 * Every store is imported DYNAMICALLY so this module's static graph stays free
 * of `server-only` leaves — the same reason the suggestion lane's default
 * projector reaches for the representation store the same way. A unit test
 * substitutes ports and never reaches any of this.
 */
export async function serverObjectBackedReviewPorts(opts: {
  /**
   * The ROW'S OWN physical origin, named by the caller.
   *
   * REQUIRED, with no default, because this road cannot know it and a default
   * would decide the review policy silently: the lattice maps `live_generator`
   * to `intermediate`, which the policy skips by default, so a wrong guess here
   * would quietly stop opening the very reviews this enabler exists to open.
   */
  originKind: ArtifactOriginKind;
  /** The actor's read decision. Defaults to REFUSING: a caller that has not said
   *  who is asking has not authorized anything, and a default-open read here
   *  would be the whole gate. */
  authorizeRead?: ObjectBackedReviewPorts["authorizeRead"];
}): Promise<ObjectBackedReviewPorts> {
  const [{ getObjectById }, { objectTypeRegistry }, snapshotModule, emitModule] =
    await Promise.all([
      import("@/lib/objects-store"),
      import("@cinatra-ai/objects/registry"),
      import("./object-content-snapshot"),
      import("@/lib/lifecycle/lifecycle-emit"),
    ]);

  return {
    readLiveObject: ({ orgId, objectId }) => {
      const row = getObjectById(objectId, { orgId });
      if (!row || row.deletedAt) return null;
      return {
        objectType: String(row.type),
        data: row.data,
        version: Number(row.version ?? 0),
      };
    },
    // OBJECT-BACKED means the entry's own structured data is the substance: the
    // type is registered, and it declares no FILE form to hold bytes in. A type
    // that accepts files is representation-backed and takes the other road.
    isObjectBackedType: (objectType) => {
      const def = objectTypeRegistry.resolve(objectType);
      if (!def) return false;
      const fileAccepts = def.isArtifact?.accepts?.file?.mimeTypes;
      return !Array.isArray(fileAccepts) || fileAccepts.length === 0;
    },
    authorizeRead: opts.authorizeRead ?? (() => false),
    mintOrReuseSnapshot: async ({ orgId, objectId, createdBy, createdByRunId }) => {
      const captured = await snapshotModule.captureObjectContentSnapshot({
        orgId,
        objectId,
        createdBy,
        createdByRunId,
        // The mint's own produced event, in the capture's transaction.
        emitProducedEventAtMint: {
          originKind: opts.originKind,
          producerRunId: createdByRunId,
        },
      });
      if (!captured) return null;
      return {
        representationRevisionId: captured.representationRevisionId,
        contentDigest: captured.contentDigest,
        reused: captured.reused,
        effectiveBaseType: captured.effectiveBaseType,
      };
    },
    ensureProducedEventForReusedSnapshot: async ({
      orgId,
      artifactId,
      representationRevisionId,
    }) => {
      const op = emitModule.maybeBuildProducedEventInsertOp(
        (await import("@/lib/postgres-config")).postgresSchema.replaceAll('"', '""'),
        {
          orgId,
          artifactId,
          representationRevisionId,
          emitter: "object_snapshot_mint",
          originKind: opts.originKind,
        },
      );
      if (!op) return;
      const { runPostgresQueriesSync } = await import("@/lib/postgres-sync");
      const { getPostgresConnectionString } = await import("@/lib/postgres-config");
      runPostgresQueriesSync({
        connectionString: getPostgresConnectionString(),
        queries: [op],
      });
    },
  };
}

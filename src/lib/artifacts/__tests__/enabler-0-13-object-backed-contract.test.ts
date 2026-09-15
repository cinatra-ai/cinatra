/**
 * ENABLER 0.13 — THE OBJECT-BACKED CONTRACT, IMPLEMENTED
 * (`PLAN: Agents Lifecycle (C)` §4.1, cinatra#3028 / epic #3023).
 *
 * THE PLAN'S SENTENCE, VERBATIM: "The object-backed contract, implemented: the
 * host and SDK props union (the live object projection, or a minted snapshot
 * revision, discriminated); the authorized live-object read; the snapshot
 * mint-or-reuse transaction; the produced event emitted at the mint; the
 * review-request trigger; and the binding of the minted revision into the review
 * target. Its first consumers — the email record types — are wired in the
 * sibling plan."
 *
 * WHAT IT FIXES, VERBATIM: "an object-backed row has no representation to pin,
 * so nothing about it can be reviewed today and no display can say whether it
 * shows live data or a snapshot."
 *
 * THIS IS ACCEPTANCE ITEM 1: "An object-backed artifact opens a review on a
 * minted snapshot." The real-database half — the mint's produced event actually
 * committing with the capture, and the orchestration pinning that revision — is
 * `lifecycle-c-w4-object-backed-review.integration.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";

import {
  objectProjectionDigest,
  openObjectBackedReview,
  readAuthorizedLiveObject,
  type ObjectBackedReviewPorts,
} from "@/lib/artifacts/object-backed-contract";
import { buildObjectContentProjection } from "@/lib/artifacts/artifact-content-channel";
import {
  ARTIFACT_CONTENT_CHANNEL_VERSION,
  artifactContentCapFor,
  type ArtifactContentProjection,
} from "@cinatra-ai/sdk-extensions/artifact-content-channel";
import { producedEventId } from "@/lib/lifecycle/lifecycle-produced-event";
import {
  PRODUCED_EVENT_EMITTERS,
  isProducedEventEmitter,
} from "@/lib/lifecycle/lifecycle-produced-event";
import { buildProducedEventInsertOp } from "@/lib/lifecycle/lifecycle-emit";

const ORG = "org-3028";
const OBJECT = "obj-3028";
const EMAIL_TYPE = "@cinatra-ai/email:record";

function ports(overrides: Partial<ObjectBackedReviewPorts> = {}): ObjectBackedReviewPorts {
  return {
    readLiveObject: () => ({ objectType: EMAIL_TYPE, data: { subject: "Hello" }, version: 3 }),
    isObjectBackedType: (t) => t === EMAIL_TYPE,
    authorizeRead: () => true,
    mintOrReuseSnapshot: async () => ({
      representationRevisionId: "rev-minted",
      contentDigest: "digest-1",
      reused: false,
      effectiveBaseType: EMAIL_TYPE,
    }),
    ensureProducedEventForReusedSnapshot: async () => {},
    ...overrides,
  };
}

describe("0.13 — the authorized live-object read", () => {
  it("reads the live row's own data when the actor is authorized", async () => {
    const out = await readAuthorizedLiveObject({ orgId: ORG, objectId: OBJECT }, ports());
    expect(out).toEqual({ ok: true, objectType: EMAIL_TYPE, data: { subject: "Hello" }, version: 3 });
  });

  it("refuses an absent or tombstoned row as not-found", async () => {
    const out = await readAuthorizedLiveObject(
      { orgId: ORG, objectId: OBJECT },
      ports({ readLiveObject: () => null }),
    );
    expect(out).toEqual({ ok: false, reason: "not-found" });
  });

  it("refuses a type that is not object-backed — this road does not apply", async () => {
    const out = await readAuthorizedLiveObject(
      { orgId: ORG, objectId: OBJECT },
      ports({ isObjectBackedType: () => false }),
    );
    expect(out).toEqual({ ok: false, reason: "not-object-backed" });
  });

  it("asks the authorization decision against the substrate's own type", async () => {
    const authorizeRead = vi.fn(() => false);
    const out = await readAuthorizedLiveObject({ orgId: ORG, objectId: OBJECT }, ports({ authorizeRead }));
    expect(out).toEqual({ ok: false, reason: "denied" });
    expect(authorizeRead).toHaveBeenCalledWith({
      orgId: ORG,
      objectId: OBJECT,
      objectType: EMAIL_TYPE,
    });
  });

  it("tells an unauthorized actor `denied` for a FILE-backed row too — never its class", async () => {
    // The existence oracle this order closes: an actor who may not read the row
    // must not be able to separate "an existing row on the other road" from "no
    // such row" by the refusal it gets back.
    const out = await readAuthorizedLiveObject(
      { orgId: ORG, objectId: OBJECT },
      ports({ isObjectBackedType: () => false, authorizeRead: () => false }),
    );
    expect(out).toEqual({ ok: false, reason: "denied" });
  });

  it("never asks the row's CLASS for an actor that may not read it", async () => {
    const isObjectBackedType = vi.fn(() => true);
    await readAuthorizedLiveObject(
      { orgId: ORG, objectId: OBJECT },
      ports({ authorizeRead: () => false, isObjectBackedType }),
    );
    expect(isObjectBackedType).not.toHaveBeenCalled();
  });

  it("never asks the authorization decision for a row it could not find", async () => {
    const authorizeRead = vi.fn(() => true);
    await readAuthorizedLiveObject(
      { orgId: ORG, objectId: OBJECT },
      ports({ readLiveObject: () => null, authorizeRead }),
    );
    expect(authorizeRead).not.toHaveBeenCalled();
  });
});

describe("0.13 — the mint-or-reuse road binds the minted revision into the review target", () => {
  it("opens a review on the MINTED snapshot, never on the live row", async () => {
    const out = await openObjectBackedReview({ orgId: ORG, objectId: OBJECT }, ports());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.target).toEqual({ artifactId: OBJECT, representationRevisionId: "rev-minted" });
    expect(out.minted).toBe(true);
    // THE REVIEW-REQUEST TRIGGER: the produced event's deterministic id for the
    // exact revision the target binds — the same tuple the gate will pin.
    expect(out.producedEventId).toBe(producedEventId(OBJECT, "rev-minted", "artifact_produced"));
  });

  it("reuses an existing snapshot and ensures the trigger exists for it", async () => {
    const ensure = vi.fn(async () => {});
    const out = await openObjectBackedReview(
      { orgId: ORG, objectId: OBJECT },
      ports({
        mintOrReuseSnapshot: async () => ({
          representationRevisionId: "rev-pinned-earlier",
          contentDigest: "digest-1",
          reused: true,
          effectiveBaseType: EMAIL_TYPE,
        }),
        ensureProducedEventForReusedSnapshot: ensure,
      }),
    );
    expect(out.ok && out.minted).toBe(false);
    // A snapshot minted earlier for CONTEXT PINNING carries no produced event —
    // pinning a row as context asks nobody to decide about it — so the first
    // review of that row would open no gate without this.
    expect(ensure).toHaveBeenCalledWith({
      orgId: ORG,
      artifactId: OBJECT,
      representationRevisionId: "rev-pinned-earlier",
    });
  });

  it("does NOT re-emit for a fresh mint — the capture's own transaction did", async () => {
    const ensure = vi.fn(async () => {});
    await openObjectBackedReview(
      { orgId: ORG, objectId: OBJECT },
      ports({ ensureProducedEventForReusedSnapshot: ensure }),
    );
    expect(ensure).not.toHaveBeenCalled();
  });

  it("never mints for a row the actor may not read", async () => {
    const mint = vi.fn(async () => null);
    const out = await openObjectBackedReview(
      { orgId: ORG, objectId: OBJECT },
      ports({ authorizeRead: () => false, mintOrReuseSnapshot: mint }),
    );
    expect(out).toEqual({ ok: false, reason: "denied" });
    expect(mint).not.toHaveBeenCalled();
  });

  it("names a capture that produced no snapshot", async () => {
    const out = await openObjectBackedReview(
      { orgId: ORG, objectId: OBJECT },
      ports({ mintOrReuseSnapshot: async () => null }),
    );
    expect(out).toEqual({ ok: false, reason: "snapshot-unavailable" });
  });
});

describe("0.13 — the props union says which of the two it is showing", () => {
  it("a snapshot projection names the pinned revision and carries the capture's digest", () => {
    const p = buildObjectContentProjection({
      objectType: EMAIL_TYPE,
      data: { subject: "Hello" },
      source: "snapshot",
      representationRevisionId: "rev-minted",
      digest: "digest-1",
    });
    expect(p.kind).toBe("object");
    if (p.kind !== "object") return;
    expect(p.source).toBe("snapshot");
    expect(p.representationRevisionId).toBe("rev-minted");
    expect(p.digest).toBe("digest-1");
    expect(p.projectedByteLength).toBeLessThanOrEqual(p.cap);
  });

  it("a live projection names NO pinned revision and hashes what it carries", () => {
    const data = { subject: "Hello" };
    const p = buildObjectContentProjection({ objectType: EMAIL_TYPE, data, source: "live" });
    expect(p.kind === "object" && p.source).toBe("live");
    expect(p.kind === "object" && p.representationRevisionId).toBeNull();
    expect(p.kind === "object" && p.digest).toBe(objectProjectionDigest(data));
  });

  it("refuses a live projection that names a pinned revision — the confusion the discriminator prevents", () => {
    expect(() =>
      buildObjectContentProjection({
        objectType: EMAIL_TYPE,
        data: {},
        source: "live",
        representationRevisionId: "rev-minted",
      }),
    ).toThrow(/must name no pinned revision/);
  });

  it("a snapshot projection with no revision is a named absence, never a silent live read", () => {
    const p = buildObjectContentProjection({
      objectType: EMAIL_TYPE,
      data: {},
      source: "snapshot",
      representationRevisionId: null,
    });
    expect(p).toMatchObject({ kind: "none", reason: "absent" });
  });

  it("STATES the discriminator in the type: neither wrong combination is expressible", () => {
    // A type-level case, checked by the fleet-pinned compiler on this file: the
    // `live` arm's revision is null BY THE TYPE and the `snapshot` arm's is a
    // string, so a display that has checked `source` has already narrowed it and
    // a projection that mixes the two does not compile at all.
    const snapshot: ArtifactContentProjection = {
      kind: "object",
      channelVersion: ARTIFACT_CONTENT_CHANNEL_VERSION,
      source: "snapshot",
      representationRevisionId: "rev-minted",
      objectType: EMAIL_TYPE,
      data: {},
      digest: "d",
      byteLength: 2,
      projectedByteLength: 2,
      cap: artifactContentCapFor("object"),
    };
    if (snapshot.kind === "object" && snapshot.source === "snapshot") {
      const pinned: string = snapshot.representationRevisionId;
      expect(pinned).toBe("rev-minted");
    }
    // AND THE LIVE ARM'S REVISION IS NULL BY THE TYPE. Extracting each arm by
    // its own `source` is what proves the union is DISCRIMINATED: over a single
    // member declaring `source: "live" | "snapshot"` neither extraction names a
    // member at all, and neither of these two declarations compiles.
    type LiveArm = Extract<ArtifactContentProjection, { kind: "object"; source: "live" }>;
    type SnapshotArm = Extract<ArtifactContentProjection, { kind: "object"; source: "snapshot" }>;
    const liveRevision: LiveArm["representationRevisionId"] = null;
    const snapshotRevision: SnapshotArm["representationRevisionId"] = "rev-minted";
    expect(liveRevision).toBeNull();
    expect(snapshotRevision).toBe("rev-minted");
  });

  it("an over-cap object is a named absence — half a record is a wrong record", () => {
    const p = buildObjectContentProjection({
      objectType: EMAIL_TYPE,
      data: { body: "x".repeat(300 * 1024) },
      source: "live",
    });
    expect(p).toMatchObject({ kind: "none", reason: "over-cap" });
  });
});

describe("0.13 — the produced event is emitted at the mint", () => {
  it("the mint's emitter is in the closed set", () => {
    expect(PRODUCED_EVENT_EMITTERS).toContain("object_snapshot_mint");
    expect(isProducedEventEmitter("object_snapshot_mint")).toBe(true);
  });

  it("a guarded emit inserts only when the mint's representation row exists", () => {
    const op = buildProducedEventInsertOp(
      "app",
      {
        orgId: ORG,
        artifactId: OBJECT,
        representationRevisionId: "rev-minted",
        emitter: "object_snapshot_mint",
        originKind: "upload",
      },
      {
        whereExistsSql: `EXISTS (SELECT 1 FROM "app"."representation" WHERE id = $4::text AND org_id = $2::text AND artifact_id = $3::text)`,
      },
    );
    expect(op.text).toContain("SELECT $1::text");
    expect(op.text).toContain("WHERE EXISTS");
    expect(op.text).toContain("ON CONFLICT (event_id) DO NOTHING");
    // The guard binds ONLY this builder's own parameters.
    expect(op.values[0]).toBe(producedEventId(OBJECT, "rev-minted", "artifact_produced"));
    expect(op.values[3]).toBe("rev-minted");
  });

  it("an unguarded emit is byte-identical to the one every existing choke point splices", () => {
    const op = buildProducedEventInsertOp("app", {
      orgId: ORG,
      artifactId: OBJECT,
      representationRevisionId: "rev-minted",
      emitter: "createSemanticArtifact",
      originKind: "agent_generated",
    });
    expect(op.text).toContain("VALUES ($1::text");
    expect(op.text).not.toContain("WHERE EXISTS");
  });
});

/**
 * cinatra#2043 (epic #2037 S5) - PURE unit proofs of the CMS capture writer's
 * transaction query-list composition. No DB, no blob I/O: the writer's
 * `buildCmsSnapshotCaptureQueries` is a total function over resolved facts, so the
 * S0 same-tx ordering (content write + produced event + apply-binding row, one
 * atomic list) is fixture-provable.
 */
import { describe, it, expect } from "vitest";

import {
  buildCmsSnapshotCaptureQueries,
  type CmsSnapshotCaptureFacts,
} from "../cms-content-snapshot-capture";
import { producedEventId } from "@/lib/lifecycle/lifecycle-produced-event";

const SCHEMA = "cinatra_test";

function facts(over: Partial<CmsSnapshotCaptureFacts> = {}): CmsSnapshotCaptureFacts {
  return {
    orgId: "org-1",
    artifactId: "art-1",
    representationRevisionId: "rev-1",
    resourceId: "res-1",
    blobId: "blob-1",
    snapshotTargetId: "tgt-1",
    substanceKey: "blob:deadbeef",
    storageKey: "orgs/org-1/sha256/de/deadbeef.bin",
    sha256: "deadbeef",
    mimeDetected: "text/html",
    declaredMime: "application/vnd.cinatra.cms-fields+json",
    sizeBytes: 1234,
    createdBy: "user-1",
    producerRunId: "run-1",
    producerAgentId: "agent-1",
    connectorInstance: "wordpress-mcp-connector:inst-9",
    resourceType: "post",
    cmsResourceId: "42",
    baseRemoteRevisionRef: "etag-abc",
    operationId: "op-1",
    scopeManifest: { paths: ["title", "body"] },
    objectData: { title: "Hello Post", connectorId: "wordpress-mcp-connector" },
    emitProducedEvent: true,
    ...over,
  };
}

describe("cinatra#2043 - buildCmsSnapshotCaptureQueries", () => {
  it("composes FIVE ops when the produced event is active: objects, content write, writer witness, produced event, apply-binding row - in that order", () => {
    const ops = buildCmsSnapshotCaptureQueries(SCHEMA, facts({ emitProducedEvent: true }));
    expect(ops).toHaveLength(5);

    // [0] the objects row (the artifact identity the gate pins + orchestration classifies).
    expect(ops[0].text).toContain(`"${SCHEMA}"."objects"`);
    expect(ops[0].values).toContain("@cinatra-ai/objects:cms-content-snapshot");

    // [1] the content write touches resource + artifact_blobs + representation.
    // Its position is LOAD-BEARING: the writer reads results[1] for the
    // RETURNING row, so nothing may be spliced ahead of it.
    expect(ops[1].text).toContain(`"${SCHEMA}"."resource"`);
    expect(ops[1].text).toContain(`"${SCHEMA}"."artifact_blobs"`);
    expect(ops[1].text).toContain(`"${SCHEMA}"."representation"`);

    // [2] the artifact-writer PROVENANCE WITNESS for the representation [1]
    // just minted (cinatra#2139).
    expect(ops[2].text).toContain(`"${SCHEMA}"."artifact_audit"`);
    expect(ops[2].text).toContain("'create'");

    // [3] the transactional ArtifactProduced event, enumerated emitter.
    expect(ops[3].text).toContain(`"${SCHEMA}"."artifact_produced_outbox"`);
    expect(ops[3].values).toContain("object_cms_snapshot_capture");

    // [4] the cms_snapshot_targets apply binding.
    expect(ops[4].text).toContain(`"${SCHEMA}"."cms_snapshot_targets"`);
  });

  it("omits the produced-event op when the caller-level fence is off (4 ops, no outbox write)", () => {
    const ops = buildCmsSnapshotCaptureQueries(SCHEMA, facts({ emitProducedEvent: false }));
    expect(ops).toHaveLength(4);
    expect(ops.some((o) => o.text.includes("artifact_produced_outbox"))).toBe(false);
    // The apply-binding row is ALWAYS present (the capture is real even fenced-off).
    expect(ops[ops.length - 1].text).toContain(`"${SCHEMA}"."cms_snapshot_targets"`);
    // The objects row + content write are still present and first.
    expect(ops[0].text).toContain(`"${SCHEMA}"."objects"`);
    expect(ops[1].text).toContain(`"${SCHEMA}"."representation"`);
  });

  // -------------------------------------------------------------------------
  // cinatra#2139 residual (b) — the WITNESS is unconditional.
  //
  // A captured CMS snapshot is a host-authored FILE representation on an
  // `isArtifact`-registered type, so the pack-typed serve arm governs it exactly
  // as it governs a materializer's output. It shipped WITHOUT the witness, so a
  // claim reserved over the snapshot type would have stranded the capture on its
  // own review surface. The witness is not lifecycle-fenced: it rides every
  // capture, fenced or not.
  // -------------------------------------------------------------------------
  it("emits the writer-provenance witness for the snapshot representation, fence ON or OFF", () => {
    for (const emitProducedEvent of [true, false]) {
      const f = facts({ emitProducedEvent, artifactId: "art-W", representationRevisionId: "rev-W" });
      const ops = buildCmsSnapshotCaptureQueries(SCHEMA, f);
      const witness = ops.filter((o) => o.text.includes(`"${SCHEMA}"."artifact_audit"`));
      expect(witness).toHaveLength(1);
      // Keyed to the EXACT representation the content write minted, in the SAME
      // transaction (one op list = one tx) — a witness that could commit without
      // its representation would not be a witness.
      expect(witness[0].values).toContain("art-W");
      expect(witness[0].values).toContain("rev-W");
      expect(witness[0].values).toContain("org-1");
      expect(witness[0].text).toContain("'create'");
      // It rides AFTER the content write, never before it.
      expect(ops.indexOf(witness[0])).toBeGreaterThan(1);
    }
  });

  it("the produced-event op carries external_publish + the deterministic event id for the snapshot revision", () => {
    const f = facts({ emitProducedEvent: true });
    const ops = buildCmsSnapshotCaptureQueries(SCHEMA, f);
    const eventOp = ops.find((o) => o.text.includes("artifact_produced_outbox"))!;
    // The remote-apply external-effect class that fires the review checkpoint.
    expect(eventOp.values).toContain("external_publish");
    // Deterministic event id = producedEventId(artifactId, representationRevisionId).
    expect(eventOp.values[0]).toBe(producedEventId(f.artifactId, f.representationRevisionId));
    // Provenance carried through.
    expect(eventOp.values).toContain(f.producerRunId);
    expect(eventOp.values).toContain(f.producerAgentId);
  });

  it("the apply-binding row carries the STORED scope manifest + connector identity + idempotency key", () => {
    const f = facts({ scopeManifest: { paths: ["title", "body"] } });
    const ops = buildCmsSnapshotCaptureQueries(SCHEMA, f);
    const targetOp = ops.find((o) => o.text.includes("cms_snapshot_targets"))!;
    // scope_manifest serialized as jsonb text.
    expect(targetOp.values).toContain(JSON.stringify({ paths: ["title", "body"] }));
    expect(targetOp.values).toContain("wordpress-mcp-connector:inst-9");
    expect(targetOp.values).toContain("post");
    expect(targetOp.values).toContain("etag-abc");
    // PLAIN insert: a duplicate operation_id RAISES + rolls back the whole set
    // (true idempotency is the writer's pre-read fast path), never a silent drop.
    expect(targetOp.text).not.toContain("DO NOTHING");
    expect(targetOp.text).toContain("cms_snapshot_targets");
    expect(targetOp.values).toContain("op-1");
  });

  it("binds the SAME artifact + snapshot revision across the content write, the event, and the apply row (one atomic set)", () => {
    const f = facts({ artifactId: "art-X", representationRevisionId: "rev-X" });
    const ops = buildCmsSnapshotCaptureQueries(SCHEMA, f);
    // objects row references art-X (the artifact identity)
    expect(ops[0].text).toContain(`"${SCHEMA}"."objects"`);
    expect(ops[0].values).toContain("art-X");
    // content write references art-X + rev-X
    expect(ops[1].values).toContain("art-X");
    expect(ops[1].values).toContain("rev-X");
    // event references art-X + rev-X
    const eventOp = ops.find((o) => o.text.includes("artifact_produced_outbox"))!;
    expect(eventOp.values).toContain("art-X");
    expect(eventOp.values).toContain("rev-X");
    // apply row references art-X (artifact) + rev-X (snapshot_revision_id)
    const targetOp = ops.find((o) => o.text.includes("cms_snapshot_targets"))!;
    expect(targetOp.values).toContain("art-X");
    expect(targetOp.values).toContain("rev-X");
  });

  it("defaults an absent scope manifest to the closed empty set (authorizes no change)", () => {
    const ops = buildCmsSnapshotCaptureQueries(
      SCHEMA,
      facts({ scopeManifest: undefined as unknown as { paths: string[] } }),
    );
    const targetOp = ops.find((o) => o.text.includes("cms_snapshot_targets"))!;
    expect(targetOp.values).toContain(JSON.stringify({ paths: [] }));
  });
});

// ---------------------------------------------------------------------------
// The representation's MIME IDENTITY (cinatra#2044 S6 L-A3 live-walk finding).
//
// `resource.mime` is the key EVERY downstream MIME-keyed consumer reads:
// `resolveArtifactVersionForServe` (and therefore the review target's
// `revisionMember`), the renderer representation dispatch, and the preview
// route's transport eligibility. It must be the connector's DECLARED
// serialization mime, never the blob store's sniff — a CMS-fields snapshot is
// JSON TEXT, so the sniffer reports `text/plain`, and writing that made every
// captured snapshot resolve as `text/plain`: the CMS representation renderer
// could never be selected for a review target, whatever provider was bound.
// `artifact_blobs.mime_detected` keeps the sniff — that column IS the sniff.
// ---------------------------------------------------------------------------
describe("representation mime identity vs blob sniff", () => {
  function contentWriteOp() {
    const ops = buildCmsSnapshotCaptureQueries(SCHEMA, facts());
    const op = ops.find((o) => o.text.includes('INSERT INTO "cinatra_test"."resource"'));
    if (!op) throw new Error("content-write op not found");
    return op;
  }

  it("writes the DECLARED mime into resource.mime", () => {
    const op = contentWriteOp();
    // $4 is the resource insert's `mime` column.
    expect(op.values[3]).toBe("application/vnd.cinatra.cms-fields+json");
  });

  it("writes the SNIFFED mime into artifact_blobs.mime_detected", () => {
    const op = contentWriteOp();
    // $13 is the blob insert's `mime_detected` column.
    expect(op.values[12]).toBe("text/html");
    expect(op.text).toContain("$13::text");
  });

  it("the two are independent — a sniff change never moves the representation identity", () => {
    const ops = buildCmsSnapshotCaptureQueries(
      SCHEMA,
      facts({ mimeDetected: "application/octet-stream" }),
    );
    const op = ops.find((o) => o.text.includes('INSERT INTO "cinatra_test"."resource"'));
    expect(op?.values[3]).toBe("application/vnd.cinatra.cms-fields+json");
    expect(op?.values[12]).toBe("application/octet-stream");
  });
});

/**
 * cinatra#2139 residual (b) — the pinned preview-capture writer emits the
 * artifact-writer PROVENANCE WITNESS for the PNG representation it mints, in the
 * SAME transaction, and emits NOTHING for a degraded record (which has no
 * representation for a witness to vouch for).
 *
 * WHY IT MATTERS HERE. `@cinatra-ai/objects:cms-preview-capture` registers an
 * `isArtifact` descriptor — that descriptor is precisely what admits the PNG to
 * the host's version-pinned byte-serving resolver, and that resolver's pack-typed
 * arm admits a CLAIMED row's representation only when the witness attests it.
 * Shipped without the witness, the reviewer's own pinned picture would stop
 * resolving the moment a claim was reserved over the capture type.
 *
 * PURE unit proofs: `buildPreviewCaptureQueries` is a total function over
 * resolved facts, so the one-transaction composition is fixture-provable.
 */
import { describe, expect, it } from "vitest";

import {
  buildPreviewCaptureQueries,
  type CmsPreviewCaptureRecordData,
  type PreviewCaptureWriteFacts,
} from "../cms-preview-capture-store";

const SCHEMA = "cinatra_test";

function data(over: Partial<CmsPreviewCaptureRecordData> = {}): CmsPreviewCaptureRecordData {
  return {
    role: "before",
    status: "captured",
    degradedReason: null,
    boundArtifactId: "bound-art",
    boundSnapshotRevisionId: "bound-rev",
    sourceOrigin: "https://blog.example.com",
    postId: 42,
    capturedAt: "2026-07-27T10:00:00.000Z",
    geometry: null,
    sanitization: null,
    network: null,
    captureDigest: null,
    title: "Hello Post",
    ...over,
  };
}

function facts(over: Partial<PreviewCaptureWriteFacts> = {}): PreviewCaptureWriteFacts {
  return {
    orgId: "org-1",
    captureArtifactId: "cap-1",
    createdBy: "user-1",
    producerRunId: "run-1",
    data: data(),
    image: {
      representationRevisionId: "rev-1",
      resourceId: "res-1",
      blobId: "blob-1",
      substanceKey: "blob:deadbeef",
      storageKey: "orgs/org-1/sha256/de/deadbeef.png",
      sha256: "deadbeef",
      sizeBytes: 4096,
    },
    ...over,
  };
}

const witnessOps = (ops: Array<{ text: string; values?: unknown[] }>) =>
  ops.filter((o) => o.text.includes(`"${SCHEMA}"."artifact_audit"`));

describe("cinatra#2139 — pinned preview capture rides the writer-provenance witness", () => {
  it("composes THREE ops for a captured record: objects, PNG content write, witness", () => {
    const ops = buildPreviewCaptureQueries(SCHEMA, facts());
    expect(ops).toHaveLength(3);
    expect(ops[0].text).toContain(`"${SCHEMA}"."objects"`);
    expect(ops[1].text).toContain(`"${SCHEMA}"."representation"`);
    expect(ops[2].text).toContain(`"${SCHEMA}"."artifact_audit"`);
  });

  it("keys the witness to the EXACT capture artifact + PNG representation", () => {
    const ops = buildPreviewCaptureQueries(
      SCHEMA,
      facts({
        captureArtifactId: "cap-X",
        image: { ...facts().image!, representationRevisionId: "rev-X" },
      }),
    );
    const [witness] = witnessOps(ops);
    expect(witness.values).toContain("org-1");
    expect(witness.values).toContain("cap-X");
    expect(witness.values).toContain("rev-X");
    expect(witness.text).toContain("'create'");
  });

  it("a DEGRADED record writes the objects row ALONE — no representation, so no witness", () => {
    const ops = buildPreviewCaptureQueries(
      SCHEMA,
      facts({
        image: null,
        data: data({ status: "degraded", degradedReason: "renderer-timeout" }),
      }),
    );
    expect(ops).toHaveLength(1);
    expect(ops[0].text).toContain(`"${SCHEMA}"."objects"`);
    expect(witnessOps(ops)).toHaveLength(0);
    // The honest-fallback rule: the gap is stated on the gate, never papered over
    // with a witness for bytes that do not exist.
    expect(ops.some((o) => o.text.includes(`"${SCHEMA}"."representation"`))).toBe(false);
  });

  it("emits exactly ONE witness per capture (never a duplicate for the same revision)", () => {
    expect(witnessOps(buildPreviewCaptureQueries(SCHEMA, facts()))).toHaveLength(1);
  });
});

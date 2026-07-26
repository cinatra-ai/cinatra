/**
 * cinatra#2043 (epic #2037 S5) — unit proof of the host `@cinatra-ai/host:cms-review`
 * capability BINDING. The binding is a thin, identity-threading delegation over the
 * core capture + effect-disposition + read-back seams, so these tests inject stubs
 * for those seams and prove:
 *   - each of the four members delegates to the right core function;
 *   - the trusted identity (org / run / actor) is threaded from the FRAME into the
 *     capture — never from connector input — and the produced-event emission is
 *     gated on the review fence;
 *   - the disposition passes through (with the snapshot revision mapped to the
 *     verification revision id);
 *   - the read-back projects the STORED proposal as the reviewed base and the
 *     connector's post-apply re-read as the repaired target, with no accepted
 *     findings, and maps the core verdict to the connector's result shape.
 */
import { describe, it, expect, vi } from "vitest";

import {
  buildCmsReviewHostSeam,
  type CmsReviewHostSeamDeps,
  type CmsReviewIdentity,
  type CmsReviewVerificationResult,
} from "@/lib/cms-review-host-seam";
import type {
  ConnectorRefPointer,
  ConnectorRefResolvedContent,
} from "@cinatra-ai/objects/connector-ref";

const POINTER: ConnectorRefPointer = {
  url: "https://wp.example/?p=42",
  connectorId: "@cinatra-ai/wordpress-mcp-connector",
  externalId: "inst-1:42",
  resolvedMimeType: "application/vnd.cinatra.cms-fields+json",
  state: "linked",
  title: "Hello",
};

const RESOLVED: ConnectorRefResolvedContent = {
  mime: "application/vnd.cinatra.cms-fields+json",
  text: JSON.stringify({ title: "New Title", content: "body", excerpt: "", status: "publish" }),
  sizeBytes: 64,
  title: "New Title",
};

function captureInput(overrides: Record<string, unknown> = {}) {
  return {
    pointer: POINTER,
    resolved: RESOLVED,
    capturedAt: "2026-07-26T00:00:00.000Z",
    scopeManifest: { paths: ["title"] },
    connectorInstance: "inst-1",
    resourceType: "post",
    cmsResourceId: "42",
    baseRemoteRevisionRef: "etag-1",
    operationId: "op-1",
    title: "New Title",
    ...overrides,
  };
}

/** A deps object with sensible defaults; each test overrides the members it asserts. */
function makeDeps(over: Partial<CmsReviewHostSeamDeps> = {}): CmsReviewHostSeamDeps {
  const identity: CmsReviewIdentity = { orgId: "org-1", runId: "run-1", createdBy: "user-1" };
  return {
    isReviewActive: () => true,
    resolveIdentity: async () => identity,
    captureCmsContentSnapshot: async () => ({
      artifactId: "art-1",
      snapshotRevisionId: "rev-1",
      snapshotTargetId: "tgt-1",
      producedEventId: "ev-1",
    }),
    resolveArtifactEffectDisposition: async () => ({
      disposition: "held",
      gate: { gateId: "gate-1", runId: "run-1" },
    }),
    readCmsSnapshotTargetByOperation: async () => ({
      artifactId: "art-1",
      snapshotRevisionId: "rev-1",
      scopeManifest: { paths: ["title"] },
    }),
    readCmsSnapshotProposedFields: async () => ({
      title: "New Title",
      content: "body",
      excerpt: "",
      status: "publish",
    }),
    recordCmsApplyVerification: async () => ({
      ok: true,
      verdict: { outcome: "verified", outOfScopePaths: [] },
    }),
    ...over,
  };
}

describe("cinatra#2043 — host cms-review capability binding", () => {
  it("isReviewActive delegates to the injected fence", () => {
    expect(buildCmsReviewHostSeam(makeDeps({ isReviewActive: () => false })).isReviewActive()).toBe(false);
    expect(buildCmsReviewHostSeam(makeDeps({ isReviewActive: () => true })).isReviewActive()).toBe(true);
  });

  it("captureStagedWrite threads the FRAME identity into the capture and gates the event on the fence", async () => {
    const capture = vi.fn<CmsReviewHostSeamDeps["captureCmsContentSnapshot"]>(async () => ({
      artifactId: "art-9",
      snapshotRevisionId: "rev-9",
      snapshotTargetId: "tgt-9",
      producedEventId: "ev-9",
    }));
    const seam = buildCmsReviewHostSeam(
      makeDeps({
        isReviewActive: () => true,
        resolveIdentity: async () => ({ orgId: "org-42", runId: "run-42", createdBy: "user-42" }),
        captureCmsContentSnapshot: capture,
      }),
    );
    const res = await seam.captureStagedWrite(captureInput());
    // Result mapped from the core capture + the connector's own operationId.
    expect(res).toEqual({
      artifactId: "art-9",
      snapshotRevisionId: "rev-9",
      snapshotTargetId: "tgt-9",
      operationId: "op-1",
      producedEventId: "ev-9",
    });
    // Identity came from the FRAME, not the (identity-free) connector input.
    const arg = capture.mock.calls[0][0];
    expect(arg.orgId).toBe("org-42");
    expect(arg.producerRunId).toBe("run-42");
    expect(arg.createdBy).toBe("user-42");
    // Fence ON → the produced event is emitted in the capture tx.
    expect(arg.emitProducedEvent).toBe(true);
    // Non-identity coordinates are passed through verbatim.
    expect(arg.operationId).toBe("op-1");
    expect(arg.scopeManifest).toEqual({ paths: ["title"] });
    expect(arg.baseRemoteRevisionRef).toBe("etag-1");
  });

  it("captureStagedWrite gates the produced event OFF when the fence is off", async () => {
    const capture = vi.fn<CmsReviewHostSeamDeps["captureCmsContentSnapshot"]>(async () => ({
      artifactId: "a",
      snapshotRevisionId: "r",
      snapshotTargetId: "t",
      producedEventId: null,
    }));
    const seam = buildCmsReviewHostSeam(
      makeDeps({ isReviewActive: () => false, captureCmsContentSnapshot: capture }),
    );
    await seam.captureStagedWrite(captureInput());
    expect(capture.mock.calls[0][0].emitProducedEvent).toBe(false);
  });

  it("captureStagedWrite refuses fail-closed when no org resolves from the frame", async () => {
    const capture = vi.fn();
    const seam = buildCmsReviewHostSeam(
      makeDeps({
        resolveIdentity: async () => ({ orgId: null, runId: null, createdBy: null }),
        captureCmsContentSnapshot: capture as never,
      }),
    );
    await expect(seam.captureStagedWrite(captureInput())).rejects.toThrow(/no organization/i);
    expect(capture).not.toHaveBeenCalled();
  });

  it("resolveDisposition delegates, mapping snapshotRevisionId → the revision id", async () => {
    const resolve = vi.fn<CmsReviewHostSeamDeps["resolveArtifactEffectDisposition"]>(async () => ({
      disposition: "approved" as const,
      gate: { gateId: "g-7", runId: "run-7" },
    }));
    const seam = buildCmsReviewHostSeam(makeDeps({ resolveArtifactEffectDisposition: resolve }));
    const res = await seam.resolveDisposition({ artifactId: "art-1", snapshotRevisionId: "rev-1" });
    expect(res).toEqual({ disposition: "approved", gate: { gateId: "g-7", runId: "run-7" } });
    expect(resolve.mock.calls[0][0]).toEqual({ artifactId: "art-1", representationRevisionId: "rev-1" });
  });

  it("recordApplyVerification projects the STORED proposal as base and the read-back as repaired, no findings", async () => {
    const record = vi.fn<CmsReviewHostSeamDeps["recordCmsApplyVerification"]>(
      async (): Promise<CmsReviewVerificationResult> => ({
        ok: true,
        verdict: { outcome: "verified", outOfScopePaths: [] },
      }),
    );
    const proposed = { title: "New Title", content: "body", excerpt: "", status: "publish" };
    const seam = buildCmsReviewHostSeam(
      makeDeps({
        readCmsSnapshotTargetByOperation: async () => ({
      artifactId: "art-1",
      snapshotRevisionId: "rev-1",
      scopeManifest: { paths: ["title"] },
    }),
        readCmsSnapshotProposedFields: async () => proposed,
        recordCmsApplyVerification: record,
      }),
    );
    const postApply = { title: "New Title", content: "body", excerpt: "", status: "publish" };
    const res = await seam.recordApplyVerification({
      operationId: "op-1",
      gateId: "gate-1",
      runId: "run-1",
      postApplyFields: postApply,
    });
    expect(res).toEqual({ ok: true, outcome: "verified", outOfScope: [] });

    const arg = record.mock.calls[0][0];
    expect(arg.orgId).toBe("org-1");
    expect(arg.gateId).toBe("gate-1");
    expect(arg.runId).toBe("run-1");
    expect(arg.acceptedFindings).toEqual([]);
    // Faithful in-scope apply (postApply title === proposal title) → matches true.
    expect(arg.representationMatches).toBe(true);
    // Repaired target is a synthetic post-apply revision distinct from the snapshot.
    expect(arg.repairedTarget.artifactId).toBe("art-1");
    expect(arg.repairedTarget.representationRevisionId).not.toBe("rev-1");
    // The projector returns the STORED proposal for the reviewed (snapshot) revision
    // and the connector's post-apply re-read for the repaired revision.
    expect(arg.projectFields({ artifactId: "art-1", representationRevisionId: "rev-1" })).toBe(proposed);
    expect(arg.projectFields(arg.repairedTarget)).toBe(postApply);
  });

  it("recordApplyVerification forces representationMatches:false on an IN-SCOPE tamper (plugin rewrote the approved field)", async () => {
    const record = vi.fn<CmsReviewHostSeamDeps["recordCmsApplyVerification"]>(
      async (): Promise<CmsReviewVerificationResult> => ({
        ok: true,
        verdict: { outcome: "unmet", outOfScopePaths: [] },
      }),
    );
    const seam = buildCmsReviewHostSeam(
      makeDeps({
        readCmsSnapshotTargetByOperation: async () => ({
          artifactId: "art-1",
          snapshotRevisionId: "rev-1",
          scopeManifest: { paths: ["title"] },
        }),
        readCmsSnapshotProposedFields: async () => ({ title: "Approved", content: "body" }),
        recordCmsApplyVerification: record,
      }),
    );
    await seam.recordApplyVerification({
      operationId: "op-1",
      gateId: "gate-1",
      runId: "run-1",
      // WordPress stored a DIFFERENT title than the approved one — an in-scope tamper.
      postApplyFields: { title: "Tampered", content: "body" },
    });
    expect(record.mock.calls[0][0].representationMatches).toBe(false);
  });

  it("recordApplyVerification treats a MISSING in-scope post-apply field as unfaithful (strict equality, not nullish-normalized)", async () => {
    const record = vi.fn<CmsReviewHostSeamDeps["recordCmsApplyVerification"]>(
      async (): Promise<CmsReviewVerificationResult> => ({
        ok: true,
        verdict: { outcome: "unmet", outOfScopePaths: [] },
      }),
    );
    const seam = buildCmsReviewHostSeam(
      makeDeps({
        readCmsSnapshotTargetByOperation: async () => ({
          artifactId: "art-1",
          snapshotRevisionId: "rev-1",
          scopeManifest: { paths: ["excerpt"] },
        }),
        // Approved an empty excerpt; the read-back is MISSING excerpt entirely.
        readCmsSnapshotProposedFields: async () => ({ excerpt: "" }),
        recordCmsApplyVerification: record,
      }),
    );
    await seam.recordApplyVerification({
      operationId: "op-1",
      gateId: "gate-1",
      runId: "run-1",
      postApplyFields: { title: "x" },
    });
    // `undefined` !== `""` → unfaithful (would have falsely verified under `?? ""`).
    expect(record.mock.calls[0][0].representationMatches).toBe(false);
  });

  it("recordApplyVerification treats a scope path absent from BOTH sides as unfaithful (own-property presence required)", async () => {
    const record = vi.fn<CmsReviewHostSeamDeps["recordCmsApplyVerification"]>(
      async (): Promise<CmsReviewVerificationResult> => ({
        ok: true,
        verdict: { outcome: "unmet", outOfScopePaths: [] },
      }),
    );
    const seam = buildCmsReviewHostSeam(
      makeDeps({
        readCmsSnapshotTargetByOperation: async () => ({
          artifactId: "art-1",
          snapshotRevisionId: "rev-1",
          // `status` is in scope but present on NEITHER the proposal nor read-back.
          scopeManifest: { paths: ["status"] },
        }),
        readCmsSnapshotProposedFields: async () => ({ title: "Approved" }),
        recordCmsApplyVerification: record,
      }),
    );
    await seam.recordApplyVerification({
      operationId: "op-1",
      gateId: "gate-1",
      runId: "run-1",
      postApplyFields: { title: "Approved" },
    });
    // `undefined === undefined` must NOT read as faithful.
    expect(record.mock.calls[0][0].representationMatches).toBe(false);
  });

  it("recordApplyVerification fails closed (proposal-unreadable) when the stored proposal cannot be read", async () => {
    const record = vi.fn();
    const seam = buildCmsReviewHostSeam(
      makeDeps({
        readCmsSnapshotProposedFields: async () => null,
        recordCmsApplyVerification: record as never,
      }),
    );
    const res = await seam.recordApplyVerification({
      operationId: "op-1",
      gateId: "gate-1",
      runId: "run-1",
      postApplyFields: { title: "anything" },
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("proposal-unreadable");
    // Never records a verification against a guessed empty base.
    expect(record).not.toHaveBeenCalled();
  });

  it("recordApplyVerification maps a drifted verdict (out-of-scope plugin rewrite)", async () => {
    const seam = buildCmsReviewHostSeam(
      makeDeps({
        recordCmsApplyVerification: async () => ({
          ok: true,
          verdict: { outcome: "drifted", outOfScopePaths: ["content"] },
        }),
      }),
    );
    const res = await seam.recordApplyVerification({
      operationId: "op-1",
      gateId: "gate-1",
      runId: "run-1",
      postApplyFields: { title: "New Title", content: "body [rewritten by plugin]" },
    });
    expect(res).toEqual({ ok: true, outcome: "drifted", outOfScope: ["content"] });
  });

  it("recordApplyVerification returns target-not-found for an unknown operation", async () => {
    const seam = buildCmsReviewHostSeam(
      makeDeps({ readCmsSnapshotTargetByOperation: async () => null }),
    );
    const res = await seam.recordApplyVerification({
      operationId: "missing",
      gateId: "g",
      runId: "r",
      postApplyFields: {},
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("target-not-found");
  });

  it("recordApplyVerification fails closed when no org resolves", async () => {
    const seam = buildCmsReviewHostSeam(
      makeDeps({ resolveIdentity: async () => ({ orgId: null, runId: null, createdBy: null }) }),
    );
    const res = await seam.recordApplyVerification({
      operationId: "op-1",
      gateId: "g",
      runId: "r",
      postApplyFields: {},
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("no-org");
  });

  it("recordApplyVerification propagates a core failure code (e.g. gate-target-mismatch)", async () => {
    const seam = buildCmsReviewHostSeam(
      makeDeps({
        recordCmsApplyVerification: async () => ({
          ok: false,
          code: "gate-target-mismatch",
          error: "gate does not pin the snapshot",
        }),
      }),
    );
    const res = await seam.recordApplyVerification({
      operationId: "op-1",
      gateId: "wrong-gate",
      runId: "run-1",
      postApplyFields: {},
    });
    expect(res).toEqual({ ok: false, code: "gate-target-mismatch", error: "gate does not pin the snapshot" });
  });
});

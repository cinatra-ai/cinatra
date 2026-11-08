/**
 * cinatra#3978 — the CMS read-back seam records the apply's EFFECT, and only
 * after a verified read-back. Unit proof over injected core seams:
 *   - an input without `effect` behaves exactly as before (no write, no key);
 *   - a verified read-back hands the writer the FRAME's org and the input's
 *     operation, gate, run and result unchanged, and reports its answer;
 *   - drifted / unmet record nothing; every earlier refusal or throw of the
 *     read-back runs no write;
 *   - a write that fails never fails the verification, logs a fixed text and a
 *     fixed class only, and is independent of the post-apply preview.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildCmsReviewHostSeam,
  type CmsReviewCaptureInput,
  type CmsReviewHostSeamDeps,
  type CmsReviewReadbackInput,
} from "@/lib/cms-review-host-seam";

const RESULT = { remoteId: "42", remoteStatus: "published", remotePublishedAt: "2026-11-03T09:20:00.000Z" };
const INPUT: CmsReviewReadbackInput = {
  operationId: "op-1",
  gateId: "gate-1",
  runId: "run-1",
  postApplyFields: { title: "New Title" },
  effect: RESULT,
};

type EffectWriter = NonNullable<CmsReviewHostSeamDeps["recordCmsApplyEffect"]>;

function makeDeps(over: Partial<CmsReviewHostSeamDeps> = {}): CmsReviewHostSeamDeps {
  return {
    isReviewActive: () => true,
    resolveIdentity: async () => ({ orgId: "org-frame", runId: "run-frame", createdBy: "user-1" }),
    captureCmsContentSnapshot: async () => ({
      artifactId: "art-1",
      snapshotRevisionId: "rev-1",
      snapshotTargetId: "tgt-1",
      producedEventId: "ev-1",
    }),
    resolveArtifactEffectDisposition: async () => ({ disposition: "approved", gate: { gateId: "gate-1", runId: "run-1" } }),
    readCmsSnapshotTargetByOperation: async () => ({
      artifactId: "art-1",
      snapshotRevisionId: "rev-1",
      scopeManifest: { paths: ["title"] },
    }),
    readCmsSnapshotProposedFields: async () => ({ title: "New Title" }),
    recordCmsApplyVerification: async () => ({ ok: true, verdict: { outcome: "verified", outOfScopePaths: [] } }),
    ...over,
  };
}

function writer(answer: Awaited<ReturnType<EffectWriter>> = { ok: true, status: "recorded" }) {
  return vi.fn<EffectWriter>(async () => answer);
}

afterEach(() => vi.restoreAllMocks());

describe("cinatra#3978 — the read-back records the apply effect", () => {
  it("an input without effect runs no write and returns exactly the old shape", async () => {
    const write = writer();
    const plain: CmsReviewReadbackInput = {
      operationId: INPUT.operationId,
      gateId: INPUT.gateId,
      runId: INPUT.runId,
      postApplyFields: INPUT.postApplyFields,
    };
    const res = await buildCmsReviewHostSeam(makeDeps({ recordCmsApplyEffect: write })).recordApplyVerification(plain);
    expect(res).toEqual({ ok: true, outcome: "verified", outOfScope: [] });
    expect(res).not.toHaveProperty("effect");
    expect(write).not.toHaveBeenCalled();
  });

  it("a verified read-back hands the writer the FRAME's org and the input's coordinates unchanged", async () => {
    const write = writer();
    const res = await buildCmsReviewHostSeam(makeDeps({ recordCmsApplyEffect: write })).recordApplyVerification(INPUT);
    expect(res).toEqual({ ok: true, outcome: "verified", outOfScope: [], effect: "recorded" });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toEqual({
      orgId: "org-frame",
      runId: "run-1",
      gateId: "gate-1",
      operationId: "op-1",
      result: RESULT,
    });
    expect(write.mock.calls[0][0].result).toBe(RESULT);
  });

  it("reports an identical retry as already-recorded", async () => {
    const seam = buildCmsReviewHostSeam(makeDeps({ recordCmsApplyEffect: writer({ ok: true, status: "already-recorded" }) }));
    expect((await seam.recordApplyVerification(INPUT)).effect).toBe("already-recorded");
  });

  it.each([["conflict"], ["invalid-result"], ["gate-not-approved"], ["target-not-pinned"], ["not-verified"]])(
    "reports a writer refusal (%s) as refused, and the verification stands",
    async (code) => {
      const seam = buildCmsReviewHostSeam(makeDeps({ recordCmsApplyEffect: writer({ ok: false, code }) }));
      expect(await seam.recordApplyVerification(INPUT)).toEqual({ ok: true, outcome: "verified", outOfScope: [], effect: "refused" });
    },
  );

  it.each([["drifted", ["content"]], ["unmet", []]] as const)(
    "a %s read-back records nothing and reports refused",
    async (outcome, outOfScopePaths) => {
      const write = writer();
      const seam = buildCmsReviewHostSeam(
        makeDeps({
          recordCmsApplyEffect: write,
          recordCmsApplyVerification: async () => ({ ok: true, verdict: { outcome, outOfScopePaths: [...outOfScopePaths] } }),
        }),
      );
      expect(await seam.recordApplyVerification(INPUT)).toEqual({
        ok: true,
        outcome,
        outOfScope: [...outOfScopePaths],
        effect: "refused",
      });
      expect(write).not.toHaveBeenCalled();
    },
  );

  it("an outcome it does not know records nothing and reports refused", async () => {
    const write = writer();
    const seam = buildCmsReviewHostSeam(
      makeDeps({
        recordCmsApplyEffect: write,
        recordCmsApplyVerification: async () =>
          ({ ok: true, verdict: { outcome: "partial", outOfScopePaths: [] } }) as unknown as Awaited<
            ReturnType<CmsReviewHostSeamDeps["recordCmsApplyVerification"]>
          >,
      }),
    );
    expect((await seam.recordApplyVerification(INPUT)).effect).toBe("refused");
    expect(write).not.toHaveBeenCalled();
  });

  it.each([
    ["no org in the frame", { resolveIdentity: async () => ({ orgId: null, runId: null, createdBy: null }) }, "no-org"],
    ["no captured target", { readCmsSnapshotTargetByOperation: async () => null }, "target-not-found"],
    ["an unreadable proposal", { readCmsSnapshotProposedFields: async () => null }, "proposal-unreadable"],
    [
      "a core refusal",
      { recordCmsApplyVerification: async () => ({ ok: false as const, code: "gate-target-mismatch", error: "e" }) },
      "gate-target-mismatch",
    ],
  ] as const)("%s runs no write and keeps the old refusal shape", async (_n, over, code) => {
    const write = writer();
    const res = await buildCmsReviewHostSeam(makeDeps({ ...over, recordCmsApplyEffect: write } as Partial<CmsReviewHostSeamDeps>))
      .recordApplyVerification(INPUT);
    expect(res.ok).toBe(false);
    expect(res.code).toBe(code);
    expect(res).not.toHaveProperty("effect");
    expect(write).not.toHaveBeenCalled();
  });

  it("a core throw propagates as before and runs no write", async () => {
    const write = writer();
    const seam = buildCmsReviewHostSeam(
      makeDeps({ recordCmsApplyEffect: write, recordCmsApplyVerification: async () => { throw new Error("db down"); } }),
    );
    await expect(seam.recordApplyVerification(INPUT)).rejects.toThrow("db down");
    expect(write).not.toHaveBeenCalled();
  });

  it("an absent writer leaves the effect unrecorded", async () => {
    expect((await buildCmsReviewHostSeam(makeDeps()).recordApplyVerification(INPUT)).effect).toBe("unrecorded");
  });

  const hostile = {
    get name(): string { throw new Error("name read"); },
    get message(): string { throw new Error("message read"); },
    toString() { return "sk-live-SECRET"; },
  };
  // A thrown proxy whose prototype read throws: even `instanceof` cannot read it.
  const unreadable = new Proxy({}, { getPrototypeOf() { throw new Error("prototype read"); } });
  it.each([
    ["an Error", new Error("connection to db-host:5432 refused, password=hunter2"), "error"],
    ["a non-Error", "sk-live-SECRET", "non-error"],
    ["a hostile object", hostile, "non-error"],
    ["a proxy whose prototype cannot be read", unreadable, "non-error"],
  ])("a writer that throws %s leaves the verification standing and logs a fixed text and class only", async (_n, thrown, cls) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const seam = buildCmsReviewHostSeam(makeDeps({ recordCmsApplyEffect: async () => { throw thrown; } }));
    expect(await seam.recordApplyVerification(INPUT)).toEqual({ ok: true, outcome: "verified", outOfScope: [], effect: "unrecorded" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toEqual([
      "[cms-review] the apply effect could not be recorded (the verification is unaffected):",
      cls,
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/hunter2|SECRET|db-host/);
  });

  it("the effect is written whether or not the post-apply preview fails, and the preview runs whether or not the effect fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const write = writer();
    const preview = vi.fn(async () => { throw new Error("browser gone"); });
    const a = await buildCmsReviewHostSeam(makeDeps({ recordCmsApplyEffect: write, capturePostApplyPreview: preview }))
      .recordApplyVerification(INPUT);
    expect(a.effect).toBe("recorded");
    expect(write).toHaveBeenCalledTimes(1);
    expect(preview).toHaveBeenCalledTimes(1);

    const preview2 = vi.fn(async () => ({ status: "captured" as const }));
    const b = await buildCmsReviewHostSeam(
      makeDeps({ recordCmsApplyEffect: async () => { throw new Error("x"); }, capturePostApplyPreview: preview2 }),
    ).recordApplyVerification(INPUT);
    expect(b.effect).toBe("unrecorded");
    expect(preview2).toHaveBeenCalledTimes(1);
  });

  it("writes the effect before it takes the post-apply preview", async () => {
    const order: string[] = [];
    await buildCmsReviewHostSeam(
      makeDeps({
        recordCmsApplyEffect: async () => { order.push("effect"); return { ok: true, status: "recorded" }; },
        capturePostApplyPreview: async () => { order.push("preview"); return { status: "captured" }; },
      }),
    ).recordApplyVerification(INPUT);
    expect(order).toEqual(["effect", "preview"]);
  });

  it.each([
    ["an Error with private text", new Error("connection to db-host:5432 refused, password=hunter2"), "error"],
    ["a hostile object", hostile, "non-error"],
    ["a proxy whose prototype cannot be read", unreadable, "non-error"],
  ])("a post-apply preview that throws %s leaves the verification standing and logs a fixed text and class only", async (_n, thrown, cls) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const seam = buildCmsReviewHostSeam(
      makeDeps({ recordCmsApplyEffect: writer(), capturePostApplyPreview: async () => { throw thrown; } }),
    );
    expect(await seam.recordApplyVerification(INPUT)).toEqual({ ok: true, outcome: "verified", outOfScope: [], effect: "recorded" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toEqual([
      "[cms-review] post-apply preview capture failed (the verification is unaffected):",
      cls,
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/hunter2|SECRET|db-host/);
  });
});

describe("cinatra#3978 — the operation id a capture binds is 1 to 256 UTF-8 bytes, the domain of the effect's source", () => {
  function captureInput(operationId: string): CmsReviewCaptureInput {
    return {
      pointer: { connectorId: "site-connector", externalId: "42", url: "https://site.example/?p=42" } as CmsReviewCaptureInput["pointer"],
      resolved: { text: "{}" } as CmsReviewCaptureInput["resolved"],
      capturedAt: "2026-11-03T09:20:00.000Z",
      scopeManifest: { paths: ["title"] },
      connectorInstance: "site-connector:inst-1",
      resourceType: "post",
      cmsResourceId: "42",
      baseRemoteRevisionRef: null,
      operationId,
    };
  }

  it.each([
    ["an empty id", ""],
    ["an id of 257 bytes", "a".repeat(257)],
    ["an id of 129 characters and 257 bytes", `${"ü".repeat(128)}a`],
    ["a non-string id", 42 as unknown as string],
  ])("refuses %s before any capture", async (_n, operationId) => {
    const capture = vi.fn<CmsReviewHostSeamDeps["captureCmsContentSnapshot"]>();
    const seam = buildCmsReviewHostSeam(makeDeps({ captureCmsContentSnapshot: capture }));
    await expect(seam.captureStagedWrite(captureInput(operationId))).rejects.toThrow(/operation id/);
    expect(capture).not.toHaveBeenCalled();
  });

  it.each([
    ["one byte", "a"],
    ["256 bytes", "a".repeat(256)],
    ["128 two-byte characters", "ü".repeat(128)],
  ])("captures an id of %s", async (_n, operationId) => {
    const capture = vi.fn<CmsReviewHostSeamDeps["captureCmsContentSnapshot"]>(async () => ({
      artifactId: "art-1",
      snapshotRevisionId: "rev-1",
      snapshotTargetId: "tgt-1",
      producedEventId: "ev-1",
    }));
    const seam = buildCmsReviewHostSeam(makeDeps({ captureCmsContentSnapshot: capture }));
    await expect(seam.captureStagedWrite(captureInput(operationId))).resolves.toMatchObject({ operationId });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0][0].operationId).toBe(operationId);
  });
});

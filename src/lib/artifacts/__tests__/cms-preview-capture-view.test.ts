/**
 * cinatra#2044 S6 (L-B) — the NO-LIVE-FETCH contract.
 *
 * #2044's acceptance criterion: "No live remote document is fetched at view time
 * (network assertion in test)". This is that assertion. It drives the REAL view
 * path — the store read plus the projection the review surface consumes — with
 * every outbound network primitive replaced by a spy that fails the test if it
 * is called at all:
 *
 *   * `globalThis.fetch`             (the app's own HTTP client)
 *   * `node:http` / `node:https`     (any library that bypasses fetch)
 *   * `net.Socket.prototype.connect` (undici, pg, and anything else — this catches
 *                                     an outbound TCP connection no matter which
 *                                     client library opened it)
 *
 * It also asserts the produced model contains no remote document URL, so the
 * surface cannot become live by rendering something the model handed it.
 */
import net from "node:net";
import http from "node:http";
import https from "node:https";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rows: Array<Record<string, unknown>> = [];

vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: () => [{ rows }],
}));
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: () => {} }));
vi.mock("@/lib/postgres-config", () => ({
  // A deliberately unusable connection string: the store call is mocked out
  // above, so nothing ever dials it (and it carries no credential shape).
  getPostgresConnectionString: () => "postgres://127.0.0.1:1/none",
  postgresSchema: "public",
}));

import {
  readPinnedPreviewCaptures,
  type CmsPreviewCaptureRecordData,
} from "@/lib/artifacts/cms-preview-capture-store";
import {
  buildPinnedCapturePair,
  buildPinnedCaptureViews,
  buildPinnedRepairPair,
  findRemoteDocumentUrls,
  pinnedCaptureImageUrl,
} from "@/lib/artifacts/cms-preview-capture-view";

const capturedData: CmsPreviewCaptureRecordData = {
  role: "current",
  status: "captured",
  degradedReason: null,
  boundArtifactId: "art-1",
  boundSnapshotRevisionId: "rev-a",
  sourceOrigin: "https://blog.example.com",
  postId: 42,
  capturedAt: "2026-07-26T10:00:00.000Z",
  geometry: {
    regions: [{ region: "content", postId: "42", x: 0, y: 180, width: 640, height: 360 }],
    contentHeight: 1800,
    viewport: { width: 1280, height: 900 },
  },
  sanitization: { scripts: 2, frames: 1, eventHandlers: 3, navigations: 0, unsafeUrls: 0 },
  network: { blockedRequests: 4, allowedRequests: 9 },
  captureDigest: "a".repeat(64),
  title: "Hello Post",
};

let spies: Array<{ restore: () => void; calls: () => number }> = [];

beforeEach(() => {
  rows.length = 0;
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation((() => {
      throw new Error("the view path made a network fetch");
    }) as typeof fetch);
  const httpSpy = vi.spyOn(http, "request").mockImplementation((() => {
    throw new Error("the view path opened an http request");
  }) as typeof http.request);
  const httpsSpy = vi.spyOn(https, "request").mockImplementation((() => {
    throw new Error("the view path opened an https request");
  }) as typeof https.request);
  const socketSpy = vi
    .spyOn(net.Socket.prototype, "connect")
    .mockImplementation(function connectBlocked(this: net.Socket) {
      throw new Error("the view path opened a TCP connection");
    } as never);
  spies = [fetchSpy, httpSpy, httpsSpy, socketSpy].map((s) => ({
    restore: () => s.mockRestore(),
    calls: () => s.mock.calls.length,
  }));
});

afterEach(() => {
  for (const s of spies) s.restore();
});

function expectNoNetwork() {
  for (const s of spies) expect(s.calls()).toBe(0);
}

describe("cinatra#2044 L-B — the review view path performs NO network fetch", () => {
  it("serves a pinned capture from the store alone — zero network calls", () => {
    rows.push({
      id: "cap-1",
      data: capturedData,
      representation_revision_id: "png-rev-1",
    });

    const stored = readPinnedPreviewCaptures({
      orgId: "org-1",
      boundArtifactId: "art-1",
      boundSnapshotRevisionId: "rev-a",
    });
    const views = buildPinnedCaptureViews(stored);

    expect(views).toHaveLength(1);
    expect(views[0].status).toBe("captured");
    // The ONLY url is the host's own version-pinned byte route.
    expect(views[0].imageUrl).toBe(pinnedCaptureImageUrl("cap-1", "png-rev-1"));
    expect(findRemoteDocumentUrls(views)).toEqual([]);
    expectNoNetwork();
  });

  it("never emits the remote site's URL into the surface model", () => {
    rows.push({ id: "cap-1", data: capturedData, representation_revision_id: "png-rev-1" });
    const views = buildPinnedCaptureViews(
      readPinnedPreviewCaptures({
        orgId: "org-1",
        boundArtifactId: "art-1",
        boundSnapshotRevisionId: "rev-a",
      }),
    );
    const serialized = JSON.stringify(views);
    // The origin is shown as PROVENANCE text, but never as a loadable URL.
    expect(views[0].sourceOrigin).toBe("https://blog.example.com");
    expect(serialized).not.toContain("https://blog.example.com/wp-json");
    expect(views[0].imageUrl?.startsWith("/api/artifacts/")).toBe(true);
    expectNoNetwork();
  });

  it("a DEGRADED capture yields no image url and the named reason — still no network", () => {
    rows.push({
      id: "cap-2",
      data: {
        ...capturedData,
        status: "degraded",
        degradedReason: "preview-unreachable",
        geometry: null,
        sanitization: null,
        network: null,
        captureDigest: null,
      },
      representation_revision_id: null,
    });
    const views = buildPinnedCaptureViews(
      readPinnedPreviewCaptures({
        orgId: "org-1",
        boundArtifactId: "art-1",
        boundSnapshotRevisionId: "rev-a",
      }),
    );
    expect(views[0]).toMatchObject({
      status: "degraded",
      imageUrl: null,
      degradedReason: "preview-unreachable",
      regions: [],
    });
    expectNoNetwork();
  });

  it("projects adapter region anchors as percentages of the captured image", () => {
    rows.push({ id: "cap-1", data: capturedData, representation_revision_id: "png-rev-1" });
    const [view] = buildPinnedCaptureViews(
      readPinnedPreviewCaptures({
        orgId: "org-1",
        boundArtifactId: "art-1",
        boundSnapshotRevisionId: "rev-a",
      }),
    );
    expect(view.regions).toEqual([
      { region: "content", leftPct: 0, topPct: 10, widthPct: 50, heightPct: 20 },
    ]);
    expect(view.removedConstructs).toBe(6);
    expect(view.blockedSubresources).toBe(4);
    expectNoNetwork();
  });

  it("a remote document url in the model is a CONTRACT FAILURE the assertion catches", () => {
    // The guard has teeth: hand it a model that names a remote page and it names it.
    expect(
      findRemoteDocumentUrls([
        {
          ...buildPinnedCaptureViews([
            { captureArtifactId: "c", representationRevisionId: "r", data: capturedData },
          ])[0],
          imageUrl: "https://blog.example.com/wp-json/cinatra/v1/preview/42",
        },
      ]),
    ).toEqual(["https://blog.example.com/wp-json/cinatra/v1/preview/42"]);
  });

  // -------------------------------------------------------------------------
  // L-D — the PAIR projection. The comparison's reading order, the missing-side
  // states, and the drift marking are DATA, so the whole matrix is proven here
  // (and the no-live-fetch spy still holds across every arm).
  // -------------------------------------------------------------------------

  it("projects the REVIEW pair in reading order: the live page, then the composed proposal", () => {
    rows.push(
      { id: "cap-b", data: { ...capturedData, role: "before" }, representation_revision_id: "png-b" },
      {
        id: "cap-c",
        data: {
          ...capturedData,
          role: "current",
          composition: { substitutedRegions: ["content"], unplacedFields: ["status"] },
        },
        representation_revision_id: "png-c",
      },
    );
    const views = buildPinnedCaptureViews(
      readPinnedPreviewCaptures({
        orgId: "org-1",
        boundArtifactId: "art-1",
        boundSnapshotRevisionId: "rev-a",
      }),
    );
    const pair = buildPinnedCapturePair(views, "review");
    expect(pair).not.toBeNull();
    expect(pair!.left!.role).toBe("before");
    expect(pair!.right!.role).toBe("current");
    // Only the composed side carries composition provenance — that is what lets
    // the surface distinguish a photograph from a composition without hedging.
    expect(pair!.left!.composition).toBeNull();
    expect(pair!.right!.composition).toEqual({
      substitutedRegions: ["content"],
      unplacedFields: ["status"],
    });
    expect(findRemoteDocumentUrls(views)).toEqual([]);
    expectNoNetwork();
  });

  it("projects the VERIFICATION pair as reviewed vs applied, marking DRIFT from the record's own paths", () => {
    rows.push(
      { id: "cap-c", data: { ...capturedData, role: "current" }, representation_revision_id: "png-c" },
      { id: "cap-a", data: { ...capturedData, role: "applied" }, representation_revision_id: "png-a" },
    );
    const views = buildPinnedCaptureViews(
      readPinnedPreviewCaptures({
        orgId: "org-1",
        boundArtifactId: "art-1",
        boundSnapshotRevisionId: "rev-a",
      }),
    );
    const pair = buildPinnedCapturePair(views, "verification", ["content"]);
    expect(pair!.left!.role).toBe("current");
    expect(pair!.right!.role).toBe("applied");
    // The drift outline is applied to the APPLIED side only, and only for the
    // regions the read-back itself named — never inferred from the pictures.
    expect(pair!.right!.regions[0].drifted).toBe(true);
    expect(pair!.left!.regions[0].drifted).toBeUndefined();
    expectNoNetwork();
  });

  it("one missing half still renders the comparison (the other picture is never withheld)", () => {
    rows.push({ id: "cap-b", data: { ...capturedData, role: "before" }, representation_revision_id: "png-b" });
    const views = buildPinnedCaptureViews(
      readPinnedPreviewCaptures({
        orgId: "org-1",
        boundArtifactId: "art-1",
        boundSnapshotRevisionId: "rev-a",
      }),
    );
    const pair = buildPinnedCapturePair(views, "review");
    expect(pair!.left!.role).toBe("before");
    expect(pair!.right).toBeNull();
    expectNoNetwork();
  });

  it("no captures at all ⇒ no pair (the surface renders nothing, not an empty frame)", () => {
    expect(buildPinnedCapturePair([], "review")).toBeNull();
    expectNoNetwork();
  });

  // -------------------------------------------------------------------------
  // cinatra#2286 S10 (PR1) — `buildPinnedRepairPair`'s one-sided-degrade
  // matrix. Unlike `review`/`verification`, the two sides come from TWO
  // DIFFERENT targets' own capture reads (the repair's base and its
  // successor — `review-gate-ports.ts`'s `loadPinnedRepairPair`), so this
  // proves the merge + pick + drift logic directly against two independent
  // view lists rather than one shared list.
  // -------------------------------------------------------------------------

  it("projects the REPAIR pair: the base target's `current` vs the successor target's `repaired`", () => {
    const baseViews = buildPinnedCaptureViews([
      { captureArtifactId: "cap-base", representationRevisionId: "png-base", data: { ...capturedData, role: "current" } },
    ]);
    const successorViews = buildPinnedCaptureViews([
      { captureArtifactId: "cap-successor", representationRevisionId: "png-successor", data: { ...capturedData, role: "repaired" } },
    ]);
    const pair = buildPinnedRepairPair(baseViews, successorViews);
    expect(pair).not.toBeNull();
    expect(pair!.kind).toBe("repair");
    expect(pair!.left!.role).toBe("current");
    expect(pair!.left!.captureArtifactId).toBe("cap-base");
    expect(pair!.right!.role).toBe("repaired");
    expect(pair!.right!.captureArtifactId).toBe("cap-successor");
    expect(pair!.leftLabel).toBe("Reviewed — what you approved");
    expect(pair!.rightLabel).toBe("Repaired — the producer's fix");
    expectNoNetwork();
  });

  it("REPAIR pair — only the base side has a capture: renders left, right is honestly null", () => {
    const baseViews = buildPinnedCaptureViews([
      { captureArtifactId: "cap-base", representationRevisionId: "png-base", data: { ...capturedData, role: "current" } },
    ]);
    const pair = buildPinnedRepairPair(baseViews, []);
    expect(pair).not.toBeNull();
    expect(pair!.left!.role).toBe("current");
    expect(pair!.right).toBeNull();
    expectNoNetwork();
  });

  it("REPAIR pair — only the successor side has a capture: renders right, left is honestly null", () => {
    const successorViews = buildPinnedCaptureViews([
      { captureArtifactId: "cap-successor", representationRevisionId: "png-successor", data: { ...capturedData, role: "repaired" } },
    ]);
    const pair = buildPinnedRepairPair([], successorViews);
    expect(pair).not.toBeNull();
    expect(pair!.left).toBeNull();
    expect(pair!.right!.role).toBe("repaired");
    expectNoNetwork();
  });

  it("REPAIR pair — neither side has a capture ⇒ no pair", () => {
    expect(buildPinnedRepairPair([], [])).toBeNull();
    expectNoNetwork();
  });

  it("REPAIR pair — drift regions mark only the successor (right) side, exactly like the other pair kinds", () => {
    const baseViews = buildPinnedCaptureViews([
      { captureArtifactId: "cap-base", representationRevisionId: "png-base", data: { ...capturedData, role: "current" } },
    ]);
    const successorViews = buildPinnedCaptureViews([
      { captureArtifactId: "cap-successor", representationRevisionId: "png-successor", data: { ...capturedData, role: "repaired" } },
    ]);
    const pair = buildPinnedRepairPair(baseViews, successorViews, ["content"]);
    expect(pair!.right!.regions[0].drifted).toBe(true);
    expect(pair!.left!.regions[0].drifted).toBeUndefined();
    expectNoNetwork();
  });

  it("REPAIR pair ignores an irrelevant role on either side (e.g. a stray `before`/`applied` capture)", () => {
    // A base target can carry `before` too; a successor target's re-stage
    // capture pipeline can also leave `before`/`current` at its own
    // coordinates — the repair pair must pick ONLY `current` (base) and
    // `repaired` (successor), never accidentally pair an unrelated role.
    const baseViews = buildPinnedCaptureViews([
      { captureArtifactId: "cap-base-before", representationRevisionId: "png-1", data: { ...capturedData, role: "before" } },
      { captureArtifactId: "cap-base-current", representationRevisionId: "png-2", data: { ...capturedData, role: "current" } },
    ]);
    const successorViews = buildPinnedCaptureViews([
      { captureArtifactId: "cap-successor-current", representationRevisionId: "png-3", data: { ...capturedData, role: "current" } },
      { captureArtifactId: "cap-successor-repaired", representationRevisionId: "png-4", data: { ...capturedData, role: "repaired" } },
    ]);
    const pair = buildPinnedRepairPair(baseViews, successorViews);
    expect(pair!.left!.captureArtifactId).toBe("cap-base-current");
    expect(pair!.right!.captureArtifactId).toBe("cap-successor-repaired");
    expectNoNetwork();
  });

  // -------------------------------------------------------------------------
  // Regression: adding the `repair` pair kind changes nothing about the
  // pre-existing `review` / `verification` projections — same PAIR_ROLES
  // entries, same labels, same shape, byte-unchanged.
  // -------------------------------------------------------------------------

  it("REGRESSION — `review` and `verification` pairs are byte-unchanged after adding the `repair` kind", () => {
    const views = buildPinnedCaptureViews([
      { captureArtifactId: "cap-b", representationRevisionId: "png-b", data: { ...capturedData, role: "before" } },
      { captureArtifactId: "cap-c", representationRevisionId: "png-c", data: { ...capturedData, role: "current" } },
      { captureArtifactId: "cap-a", representationRevisionId: "png-a", data: { ...capturedData, role: "applied" } },
    ]);

    const review = buildPinnedCapturePair(views, "review");
    expect(review).toEqual({
      kind: "review",
      left: expect.objectContaining({ role: "before", captureArtifactId: "cap-b" }),
      right: expect.objectContaining({ role: "current", captureArtifactId: "cap-c" }),
      leftLabel: "Now — the published page",
      rightLabel: "After this change — proposed",
    });

    const verification = buildPinnedCapturePair(views, "verification");
    expect(verification).toEqual({
      kind: "verification",
      left: expect.objectContaining({ role: "current", captureArtifactId: "cap-c" }),
      right: expect.objectContaining({ role: "applied", captureArtifactId: "cap-a" }),
      leftLabel: "Reviewed — what you approved",
      rightLabel: "Applied — what the site now shows",
    });
    expectNoNetwork();
  });
});

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
  buildPinnedCaptureViews,
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
});

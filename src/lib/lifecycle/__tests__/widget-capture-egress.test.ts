/**
 * cinatra#2576 (epic #2564 S8c) — the MINT half of the widget capture egress.
 *
 * Two properties are proven here, and they are the two that matter:
 *
 *   1. A broker surface addresses captures through the capability route and
 *      through NOTHING ELSE. Not the session preview route, not `/content`, not
 *      a renderer bundle, not a remote page. The assertion is over the produced
 *      model AND over the module source, because a URL that never appears in a
 *      test fixture can still be constructible in code.
 *   2. The pair projection is the SAME one the first-party review surface uses.
 *      Only the URL differs; the comparison, its reading order and its
 *      missing-side degrade are shared, so the two tiers cannot drift into
 *      showing different things.
 *
 * The no-live-fetch spy from #2044 rides along: the broker tier must be exactly
 * as inert as the first-party one.
 */
import net from "node:net";
import http from "node:http";
import https from "node:https";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rows: Array<Record<string, unknown>> = [];

vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: () => [{ rows }],
  quotePostgresIdentifier: (s: string) => `"${s}"`,
}));
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: () => {} }));
vi.mock("@/lib/postgres-config", () => ({
  getPostgresConnectionString: () => "postgres://127.0.0.1:1/none",
  postgresSchema: "public",
}));

import { readFileSync } from "node:fs";
import path from "node:path";

import type { CmsPreviewCaptureRecordData } from "@/lib/artifacts/cms-preview-capture-store";
import { findRemoteDocumentUrls } from "@/lib/artifacts/cms-preview-capture-view";
import {
  CAPTURE_CAPABILITY_QUERY_PARAM,
  CAPTURE_CAPABILITY_ROUTE,
  verifyCaptureCapability,
} from "@/lib/lifecycle/capture-capability";
import {
  buildBrokerCapturePair,
  buildCaptureCapabilityMinter,
  type WidgetCapturePrincipal,
} from "@/lib/lifecycle/widget-capture-egress";

const PRINCIPAL: WidgetCapturePrincipal = {
  orgId: "org-1",
  userId: "user-1",
  jti: "jti-1",
  siteId: "site-1",
  client: "wordpress",
  instanceId: "inst-1",
  agentSlug: "wordpress-assistant",
};

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
    viewport: { width: 1280, height: 800 },
  },
  sanitization: { scripts: 2 },
  network: { blockedRequests: 1, allowedRequests: 3 },
  captureDigest: "sha256:abc",
  title: "Hello",
  composition: null,
};

/** Read the capability out of a minted `<img src>`. */
function openUrl(url: string) {
  const parsed = new URL(url, "https://app.example.com");
  const sealed = parsed.searchParams.get(CAPTURE_CAPABILITY_QUERY_PARAM);
  return sealed ? verifyCaptureCapability(sealed) : null;
}

describe("widget capture egress — the mint half", () => {
  const originalSecret = process.env.BETTER_AUTH_SECRET;
  const netSpy = vi.fn();

  beforeEach(() => {
    process.env.BETTER_AUTH_SECRET = "test-secret-for-capture-egress";
    rows.length = 0;
    netSpy.mockReset();
    // #2044's inert-by-contract spies: nothing in the broker tier may dial out.
    vi.spyOn(globalThis, "fetch").mockImplementation((() => {
      netSpy("fetch");
      throw new Error("network call during the broker capture path");
    }) as typeof fetch);
    vi.spyOn(http, "request").mockImplementation((() => {
      netSpy("http");
      throw new Error("http.request during the broker capture path");
    }) as typeof http.request);
    vi.spyOn(https, "request").mockImplementation((() => {
      netSpy("https");
      throw new Error("https.request during the broker capture path");
    }) as typeof https.request);
    vi.spyOn(net.Socket.prototype, "connect").mockImplementation((() => {
      netSpy("socket");
      throw new Error("socket connect during the broker capture path");
    }) as typeof net.Socket.prototype.connect);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = originalSecret;
  });

  it("addresses each picture through the CAPABILITY route, sealing the gate and the principal", () => {
    rows.push(
      { id: "cap-b", data: { ...capturedData, role: "before" }, representation_revision_id: "png-b" },
      { id: "cap-c", data: { ...capturedData, role: "current" }, representation_revision_id: "png-c" },
    );
    const pair = buildBrokerCapturePair({
      principal: PRINCIPAL,
      runId: "run-1",
      reviewTaskId: "gate-1",
      target: { artifactId: "art-1", representationRevisionId: "rev-a" },
      kind: "review",
    });
    expect(pair).not.toBeNull();
    expect(pair!.left!.role).toBe("before");
    expect(pair!.right!.role).toBe("current");

    for (const [side, expected] of [
      [pair!.left!, { captureArtifactId: "cap-b", representationRevisionId: "png-b" }],
      [pair!.right!, { captureArtifactId: "cap-c", representationRevisionId: "png-c" }],
    ] as const) {
      expect(side.imageUrl!.startsWith(`${CAPTURE_CAPABILITY_ROUTE}?`)).toBe(true);
      const opened = openUrl(side.imageUrl!);
      expect(opened).toMatchObject({
        ...PRINCIPAL,
        runId: "run-1",
        reviewTaskId: "gate-1",
        ...expected,
      });
    }
    expect(netSpy).not.toHaveBeenCalled();
  });

  it("NEVER emits a session byte-route URL, a /content URL or a remote page", () => {
    rows.push({
      id: "cap-c",
      data: { ...capturedData, role: "current" },
      representation_revision_id: "png-c",
    });
    const pair = buildBrokerCapturePair({
      principal: PRINCIPAL,
      runId: "run-1",
      reviewTaskId: "gate-1",
      target: { artifactId: "art-1", representationRevisionId: "rev-a" },
      kind: "review",
    })!;
    const urls = [pair.left?.imageUrl, pair.right?.imageUrl].filter(
      (u): u is string => typeof u === "string",
    );
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url).not.toContain("/api/artifacts/");
      expect(url).not.toContain("/content");
      expect(url).not.toContain("/preview");
      expect(url).not.toContain("/api/artifact-renderer-assets/");
      expect(url.startsWith("/")).toBe(true);
    }
    // The inert-by-contract guard still holds for the broker tier's URLs.
    expect(findRemoteDocumentUrls([pair.left, pair.right].filter((v) => v !== null))).toEqual([]);
  });

  it("the URL guard has TEETH — it names any address that is not one of the two capture paths", () => {
    // The guard used to be a `/api/artifacts/` prefix test, which passed the
    // arbitrary-download route just as happily as the capture byte route. It
    // now matches the WHOLE path, so a faulty minter cannot point the surface at
    // `/content`, at a renderer bundle, or off-host, and stay green.
    rows.push({
      id: "cap-c",
      data: { ...capturedData, role: "current" },
      representation_revision_id: "png-c",
    });
    const base = buildBrokerCapturePair({
      principal: PRINCIPAL,
      runId: "run-1",
      reviewTaskId: "gate-1",
      target: { artifactId: "art-1", representationRevisionId: "rev-a" },
      kind: "review",
    })!.right!;

    const offenders = [
      "/api/artifacts/cap-c/versions/png-c/content",
      "/api/artifacts/cap-c/versions/png-c/preview/extra",
      "/api/artifact-renderer-assets/artifact/x/abc/entry.js",
      "/api/lifecycle-views/resolve",
      "//evil.example/capture.png",
      "https://blog.example.com/wp-json/cinatra/v1/preview/42",
      "javascript:alert(1)",
    ];
    for (const imageUrl of offenders) {
      expect(findRemoteDocumentUrls([{ ...base, imageUrl }]), imageUrl).toEqual([imageUrl]);
    }
    // ...and the two legitimate shapes are still accepted.
    for (const imageUrl of [
      "/api/artifacts/cap-c/versions/png-c/preview",
      base.imageUrl!,
    ]) {
      expect(findRemoteDocumentUrls([{ ...base, imageUrl }]), imageUrl).toEqual([]);
    }
  });

  it("STRUCTURAL: the mint module names no artifact byte route and no renderer-asset route", () => {
    // A URL that never appears in a fixture can still be constructible in code.
    // The module has exactly one URL builder, and it is the capability route's.
    const source = readFileSync(
      path.join(process.cwd(), "src/lib/lifecycle/widget-capture-egress.ts"),
      "utf8",
    );
    expect(source).not.toContain("/api/artifacts/");
    expect(source).not.toContain("/api/artifact-renderer-assets");
    expect(source).not.toContain("pinnedCaptureImageUrl");
    expect(source).toContain("captureCapabilityUrl");
  });

  it("fixes the principal and the gate across every picture in a pair", () => {
    // One closure, one reader, one gate: a projection walking a capture list
    // cannot vary who or what the pictures are minted for.
    const mint = buildCaptureCapabilityMinter({
      principal: PRINCIPAL,
      runId: "run-1",
      reviewTaskId: "gate-1",
    });
    const a = openUrl(mint({ captureArtifactId: "cap-1", representationRevisionId: "png-1" })!);
    const b = openUrl(mint({ captureArtifactId: "cap-2", representationRevisionId: "png-2" })!);
    expect(a!.reviewTaskId).toBe(b!.reviewTaskId);
    expect(a!.jti).toBe(b!.jti);
    expect(a!.captureArtifactId).toBe("cap-1");
    expect(b!.captureArtifactId).toBe("cap-2");
  });

  it("a capability that cannot be sealed degrades to NO PICTURE, never a broken image", () => {
    delete process.env.BETTER_AUTH_SECRET;
    rows.push({
      id: "cap-c",
      data: { ...capturedData, role: "current" },
      representation_revision_id: "png-c",
    });
    const pair = buildBrokerCapturePair({
      principal: PRINCIPAL,
      runId: "run-1",
      reviewTaskId: "gate-1",
      target: { artifactId: "art-1", representationRevisionId: "rev-a" },
      kind: "review",
    })!;
    expect(pair.right!.imageUrl).toBeNull();
    // The honest-fallback rule: the side still renders, saying there is no
    // picture — it does not vanish and it does not point at a dead URL.
    expect(pair.right!.status).toBe("captured");
  });

  it("a DEGRADED capture still has no URL on the broker tier either", () => {
    rows.push({
      id: "cap-d",
      data: { ...capturedData, role: "current", status: "degraded", degradedReason: "timeout" },
      representation_revision_id: null,
    });
    const pair = buildBrokerCapturePair({
      principal: PRINCIPAL,
      runId: "run-1",
      reviewTaskId: "gate-1",
      target: { artifactId: "art-1", representationRevisionId: "rev-a" },
      kind: "review",
    })!;
    expect(pair.right!.imageUrl).toBeNull();
    expect(pair.right!.degradedReason).toBe("timeout");
  });

  it("no captures for the target is null — the decision still renders without pictures", () => {
    expect(
      buildBrokerCapturePair({
        principal: PRINCIPAL,
        runId: "run-1",
        reviewTaskId: "gate-1",
        target: { artifactId: "art-1", representationRevisionId: "rev-a" },
        kind: "review",
      }),
    ).toBeNull();
  });
});

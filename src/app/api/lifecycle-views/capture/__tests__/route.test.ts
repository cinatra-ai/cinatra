import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// The SHELL contract of GET /api/lifecycle-views/capture (cinatra#2576, S8c).
//
// The admission matrix itself lives in `capture-capability-serving.test.ts`
// (pure, port-injected). What is proven HERE is what only a route can get
// wrong: that every refusal is the SAME 404 with the SAME headers, that a
// served capture carries the same-origin CORP + no-store + nosniff set, that the
// bytes come from the resolved storage key, and that the run-access re-check
// runs as the sealed principal with NO role hints.
// ---------------------------------------------------------------------------

const readReviewGate = vi.fn();
const enforceReviewRunAccess = vi.fn();
const resolveArtifactVersionForServe = vi.fn();
const readPinnedPreviewCapture = vi.fn();
const readLiveWidgetCapturePrincipal = vi.fn();
const openByStorageKey = vi.fn();

vi.mock("@cinatra-ai/agents/artifact-review-gate-store", () => ({
  readReviewGate: (...a: unknown[]) => readReviewGate(...a),
  enforceReviewRunAccess: (...a: unknown[]) => enforceReviewRunAccess(...a),
}));
vi.mock("@/lib/artifacts/artifact-read", () => ({
  resolveArtifactVersionForServe: (i: unknown) => resolveArtifactVersionForServe(i),
}));
vi.mock("@/lib/artifacts/cms-preview-capture-store", () => ({
  readPinnedPreviewCapture: (...a: unknown[]) => readPinnedPreviewCapture(...a),
}));
vi.mock("@/lib/lifecycle/widget-capture-principal", () => ({
  readLiveWidgetCapturePrincipal: (jti: string) => readLiveWidgetCapturePrincipal(jti),
}));
vi.mock("@/lib/artifacts/local-disk-blob-store", () => ({
  createLocalDiskBlobStore: () => ({ openByStorageKey }),
}));

import {
  captureCapabilityUrl,
  mintCaptureCapability,
  type CaptureCapabilityPayload,
} from "@/lib/lifecycle/capture-capability";

const PAYLOAD: CaptureCapabilityPayload = {
  orgId: "org-1",
  userId: "user-1",
  jti: "jti-1",
  siteId: "site-1",
  client: "wordpress",
  instanceId: "inst-1",
  runId: "run-1",
  reviewTaskId: "gate-1",
  captureArtifactId: "cap-1",
  representationRevisionId: "png-1",
};

function streamOf(s: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(s));
      c.close();
    },
  });
}

async function GET(opts: { capability?: string | null; headers?: Record<string, string> } = {}) {
  const { GET: handler } = await import("../route");
  const headers = new Headers(
    opts.headers ?? {
      "sec-fetch-dest": "image",
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "no-cors",
    },
  );
  const suffix =
    opts.capability === null ? "" : captureCapabilityUrl(opts.capability ?? sealedCapability);
  const url = opts.capability === null ? "/api/lifecycle-views/capture" : suffix;
  return handler(new Request(`http://localhost:3000${url}`, { headers }));
}

let sealedCapability: string;

describe("GET /api/lifecycle-views/capture", () => {
  const originalSecret = process.env.BETTER_AUTH_SECRET;

  beforeEach(() => {
    process.env.BETTER_AUTH_SECRET = "test-secret-for-capture-route";
    sealedCapability = mintCaptureCapability(PAYLOAD)!;
    readReviewGate.mockReset();
    enforceReviewRunAccess.mockReset();
    resolveArtifactVersionForServe.mockReset();
    readPinnedPreviewCapture.mockReset();
    readLiveWidgetCapturePrincipal.mockReset();
    openByStorageKey.mockReset();

    readLiveWidgetCapturePrincipal.mockReturnValue({
      userId: "user-1",
      orgId: "org-1",
      siteId: "site-1",
      client: "wordpress",
      instanceId: "inst-1",
      siteOrigin: "https://blog.example.com",
    });
    enforceReviewRunAccess.mockResolvedValue({ ok: true });
    readReviewGate.mockResolvedValue({
      pinnedTargets: [{ artifactId: "art-1", representationRevisionId: "rev-a" }],
    });
    readPinnedPreviewCapture.mockReturnValue({
      captureArtifactId: "cap-1",
      representationRevisionId: "png-1",
      data: {
        status: "captured",
        boundArtifactId: "art-1",
        boundSnapshotRevisionId: "rev-a",
      },
    });
    resolveArtifactVersionForServe.mockReturnValue({
      mime: "image/png",
      storageKey: "blobs/aa/bb",
      sizeBytes: 4096,
    });
    openByStorageKey.mockResolvedValue({ stream: streamOf("PNGBYTES"), sizeBytes: 4096 });
  });

  afterEach(() => {
    vi.resetModules();
    if (originalSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = originalSecret;
  });

  it("serves the capture PNG with the same-origin transport header set", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Content-Disposition")).toMatch(/^inline;/);
    expect(res.headers.get("Content-Length")).toBe("4096");
    // The property the whole slice exists for.
    expect(res.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    // No cache anywhere may serve a same-origin image answer to a navigation.
    expect(res.headers.get("Vary")).toBe("Sec-Fetch-Site, Sec-Fetch-Dest");
    // A capture is one PNG painted by one <img>; range support would only widen
    // what a capability reaches.
    expect(res.headers.get("Accept-Ranges")).toBeNull();
    expect(await res.text()).toBe("PNGBYTES");
  });

  it("streams from the RESOLVED storage key, scoped to the sealed org", async () => {
    await GET();
    expect(resolveArtifactVersionForServe).toHaveBeenCalledWith({
      orgId: "org-1",
      artifactId: "cap-1",
      representationRevisionId: "png-1",
      // The tombstoned-pin replay override belongs to the actor-gated session
      // routes; the broker tier never gets it.
      liveOnly: true,
    });
    expect(openByStorageKey).toHaveBeenCalledWith({
      orgId: "org-1",
      storageKey: "blobs/aa/bb",
    });
  });

  it("re-checks run READ as the sealed principal with NO role hints", async () => {
    await GET();
    expect(enforceReviewRunAccess).toHaveBeenCalledTimes(1);
    const [runId, actor, op] = enforceReviewRunAccess.mock.calls[0];
    expect(runId).toBe("run-1");
    expect(op).toBe("read");
    expect(actor).toEqual({
      actorType: "human",
      source: "route",
      userId: "user-1",
      orgId: "org-1",
    });
    // No role hints: the narrowest reading of the principal, strictly a subset
    // of anything S8a can widen it to.
    expect(enforceReviewRunAccess.mock.calls[0][3]).toBeUndefined();
  });

  it("every refusal is the SAME 404 with the SAME headers and an empty body", async () => {
    const arms: Array<[string, () => void]> = [
      ["no capability", () => {}],
      ["dead principal", () => readLiveWidgetCapturePrincipal.mockReturnValue(null)],
      ["no run access", () => enforceReviewRunAccess.mockResolvedValue({ ok: false, status: 403 })],
      ["gate gone", () => readReviewGate.mockResolvedValue(null)],
      ["capture not a capture row", () => readPinnedPreviewCapture.mockReturnValue(null)],
      ["bytes unresolvable", () => resolveArtifactVersionForServe.mockReturnValue(null)],
      [
        "blob read failed",
        () => openByStorageKey.mockRejectedValue(new Error("missing blob")),
      ],
    ];
    for (const [label, arrange] of arms) {
      arrange();
      const res = label === "no capability" ? await GET({ capability: null }) : await GET();
      expect(res.status, label).toBe(404);
      expect(await res.text(), label).toBe("");
      expect(res.headers.get("Cross-Origin-Resource-Policy"), label).toBe("same-origin");
      expect(res.headers.get("Cache-Control"), label).toBe("private, no-store");
      // A refusal never carries the bytes' content headers.
      expect(res.headers.get("Content-Type"), label).toBeNull();
      expect(res.headers.get("Content-Disposition"), label).toBeNull();
      // reset for the next arm
      readLiveWidgetCapturePrincipal.mockReturnValue({
        userId: "user-1",
        orgId: "org-1",
        siteId: "site-1",
        client: "wordpress",
        instanceId: "inst-1",
        siteOrigin: "https://blog.example.com",
      });
      enforceReviewRunAccess.mockResolvedValue({ ok: true });
      readReviewGate.mockResolvedValue({
        pinnedTargets: [{ artifactId: "art-1", representationRevisionId: "rev-a" }],
      });
      readPinnedPreviewCapture.mockReturnValue({
        captureArtifactId: "cap-1",
        representationRevisionId: "png-1",
        data: { status: "captured", boundArtifactId: "art-1", boundSnapshotRevisionId: "rev-a" },
      });
      resolveArtifactVersionForServe.mockReturnValue({
        mime: "image/png",
        storageKey: "blobs/aa/bb",
        sizeBytes: 4096,
      });
      openByStorageKey.mockResolvedValue({ stream: streamOf("PNGBYTES"), sizeBytes: 4096 });
    }
  });

  it("a PASTED link 404s without touching a single store", async () => {
    const res = await GET({
      headers: {
        "sec-fetch-dest": "document",
        "sec-fetch-site": "none",
        "sec-fetch-mode": "navigate",
      },
    });
    expect(res.status).toBe(404);
    expect(readLiveWidgetCapturePrincipal).not.toHaveBeenCalled();
    expect(enforceReviewRunAccess).not.toHaveBeenCalled();
    expect(readPinnedPreviewCapture).not.toHaveBeenCalled();
    expect(openByStorageKey).not.toHaveBeenCalled();
  });

  it("a capability for gate A cannot fetch a capture bound to another gate", async () => {
    // Gate A's frozen pinned set does not contain the capture's bound target.
    readPinnedPreviewCapture.mockReturnValue({
      captureArtifactId: "cap-1",
      representationRevisionId: "png-1",
      data: { status: "captured", boundArtifactId: "art-B", boundSnapshotRevisionId: "rev-B" },
    });
    const res = await GET();
    expect(res.status).toBe(404);
    expect(resolveArtifactVersionForServe).not.toHaveBeenCalled();
    expect(openByStorageKey).not.toHaveBeenCalled();
  });

  it("refuses bytes that are not a PNG, whatever the capture row claims", async () => {
    resolveArtifactVersionForServe.mockReturnValue({
      mime: "text/html",
      storageKey: "blobs/aa/bb",
      sizeBytes: 10,
    });
    expect((await GET()).status).toBe(404);
    expect(openByStorageKey).not.toHaveBeenCalled();
  });
});

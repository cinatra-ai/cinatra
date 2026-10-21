/**
 * cinatra#4223 — THE SCREENSHOT TOOL'S CAPTURE REFUSALS AND ITS FILED FACTS.
 *
 * The tool captures one page of an org's active connect-registered site through
 * the REAL `captureRegisteredPage` (the guarded fetch, the sanitizer and the
 * isolated renderer are its seams, stubbed here). Every named capture refusal
 * must reach the caller unchanged, with nothing claimed on the ledger and
 * nothing written; the two origin refusals must also send no fetch at all. A
 * capture that succeeds files the renderer's reported viewport and the time the
 * renderer returned, as the object's data.
 *
 * PURE TIER. The ledger claim and the artifact write are spies; the write itself
 * is proved against a real Postgres in
 * `artifacts/__tests__/lifecycle-c-screenshot-tool-4223.integration.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  resolveBoundArtifactTarget: vi.fn(),
  claimMaterialization: vi.fn(),
  createSemanticArtifact: vi.fn(),
  enqueueArtifactMatchRun: vi.fn(async () => undefined),
}));

vi.mock("@/lib/artifacts/resolve-bound-artifact-type", () => ({
  resolveBoundArtifactTarget: h.resolveBoundArtifactTarget,
}));
vi.mock("@/lib/artifacts/artifact-extension-access", () => ({
  isArtifactExtensionWriteAllowed: async () => true,
}));
vi.mock("@/lib/register-all-object-types", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/register-all-object-types")>()),
  registerAllObjectTypes: vi.fn(),
}));
vi.mock("@/lib/artifacts/materialization-ledger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/artifacts/materialization-ledger")>()),
  claimMaterialization: h.claimMaterialization,
}));
vi.mock("@/lib/artifacts/artifact-creation", () => ({
  createSemanticArtifact: h.createSemanticArtifact,
}));
vi.mock("@/lib/artifacts/matcher-enqueue", () => ({
  enqueueArtifactMatchRun: h.enqueueArtifactMatchRun,
}));

import {
  captureArtifactPage,
  type ArtifactPageCaptureToolDeps,
} from "@/lib/artifact-page-capture-tool";
import { captureDegradeCopy, type CaptureDegradeReason } from "@/lib/artifacts/cms-preview-capture";
import {
  captureRegisteredPage,
  type CaptureRegisteredPageDeps,
} from "@/lib/artifacts/registered-page-capture";

const SHOT = "@cinatra-ai/screenshot-artifact";
/** The type the screenshot pack declares; the tool itself names no type. */
const SCREENSHOT_OBJECT_TYPE = "@cinatra-ai/screenshot-artifact:screenshot";
const ORIGIN = "https://blog.example.com";
const PAGE_URL = `${ORIGIN}/about/`;
const CLOCK = new Date("2026-10-17T16:30:00.000Z");
const PAGE = "<html><body><p>about</p></body></html>";

const call = {
  runId: "run-1",
  orgId: "org-1",
  templateId: "tpl-1",
  packageVersion: "1.0.0",
  createdBy: "user-1",
  nodeId: "capture_page",
  extension: SHOT,
  title: "The about page",
  url: PAGE_URL,
};

type Events = string[];

/** The capture seams, stubbed in the style of `cms-preview-capture.test.ts`. */
function captureDeps(
  events: Events,
  over: Partial<CaptureRegisteredPageDeps> = {},
): {
  deps: CaptureRegisteredPageDeps;
  fetches: Array<{ url: string; headers: Record<string, string> }>;
  renders: Array<{ documentUrl: string; allowedOrigin: string; pinnedAddresses: string[] }>;
} {
  const fetches: Array<{ url: string; headers: Record<string, string> }> = [];
  const renders: Array<{ documentUrl: string; allowedOrigin: string; pinnedAddresses: string[] }> =
    [];
  const deps: CaptureRegisteredPageDeps = {
    listRegisteredSites: async () => {
      events.push("sites");
      return [{ siteId: "site-1", client: "wordpress", origin: ORIGIN }];
    },
    fetchPreview: async ({ url, headers }) => {
      events.push("fetch");
      fetches.push({ url, headers });
      return { ok: true, html: PAGE, pinnedAddresses: ["2001:db8::10"] };
    },
    renderIsolated: async ({ documentUrl, allowedOrigin, pinnedAddresses }) => {
      events.push("render");
      renders.push({ documentUrl, allowedOrigin, pinnedAddresses: [...pinnedAddresses] });
      return {
        ok: true,
        screenshot: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
        geometry: { regions: [], contentHeight: 900, viewport: { width: 1280, height: 900 } },
        network: { blockedRequests: 0, allowedRequests: 0 },
      };
    },
    now: () => {
      events.push("now");
      return CLOCK;
    },
    ...over,
  };
  return { deps, fetches, renders };
}

/** The tool's seams, with `capturePage` bound to the REAL entry point. */
function toolDeps(capture: CaptureRegisteredPageDeps): ArtifactPageCaptureToolDeps {
  return {
    loadProducesRefs: async () => [
      { extension: SHOT, objectTypeId: SCREENSHOT_OBJECT_TYPE },
    ],
    resolveOwnership: async () => ({
      ownerLevel: "organization",
      ownerId: "org-1",
      visibility: "organization",
      projectId: null,
    }),
    capturePage: (i) => captureRegisteredPage({ ...i, deps: capture }),
  };
}

type Written = {
  input: Record<string, unknown>;
  bytes: Buffer;
  tx2: Array<{ text: string; values: unknown[] }>;
};
let written: Written[] = [];

beforeEach(() => {
  written = [];
  h.resolveBoundArtifactTarget.mockResolvedValue({
    ok: true,
    target: {
      objectTypeId: SCREENSHOT_OBJECT_TYPE,
      acceptedFileMimeTypes: ["image/png", "image/jpeg", "image/webp"],
    },
  });
  h.claimMaterialization.mockResolvedValue({ kind: "claimed", ledgerId: "ledger-1" });
  h.createSemanticArtifact.mockImplementation(
    async (input: {
      stream: AsyncIterable<Uint8Array>;
      additionalTx2Queries: (ids: {
        artifactId: string;
        representationRevisionId: string;
      }) => Array<{ text: string; values: unknown[] }>;
    }) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of input.stream) chunks.push(chunk);
      written.push({
        input: input as unknown as Record<string, unknown>,
        bytes: Buffer.concat(chunks),
        tx2: input.additionalTx2Queries({ artifactId: "art-1", representationRevisionId: "rev-1" }),
      });
      return { artifactId: "art-1", representationRevisionId: "rev-1" };
    },
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

type RefusalCase = {
  reason: CaptureDegradeReason;
  over: Partial<CaptureRegisteredPageDeps>;
  /** The two origin refusals must send no fetch at all. */
  noFetch: boolean;
};

const fetchRefusal = (
  reason: CaptureDegradeReason,
): Partial<CaptureRegisteredPageDeps> => ({
  fetchPreview: async () => ({ ok: false, reason }),
});
const renderRefusal = (
  reason: CaptureDegradeReason,
): Partial<CaptureRegisteredPageDeps> => ({
  renderIsolated: async () => ({ ok: false, reason }),
});

const REFUSALS: RefusalCase[] = [
  { reason: "no-registered-site", over: { listRegisteredSites: async () => [] }, noFetch: true },
  {
    reason: "origin-not-registered",
    over: {
      listRegisteredSites: async () => [
        { siteId: "site-2", client: "wordpress", origin: "https://other.example.org" },
      ],
    },
    noFetch: true,
  },
  { reason: "egress-blocked", over: fetchRefusal("egress-blocked"), noFetch: false },
  { reason: "preview-unauthorized", over: fetchRefusal("preview-unauthorized"), noFetch: false },
  { reason: "preview-bad-response", over: fetchRefusal("preview-bad-response"), noFetch: false },
  { reason: "preview-too-large", over: fetchRefusal("preview-too-large"), noFetch: false },
  { reason: "preview-unreachable", over: fetchRefusal("preview-unreachable"), noFetch: false },
  {
    // The REAL sanitizer and inertness re-check, on the page the gate capture
    // suite refuses (cms-preview-capture.test.ts "REFUSES to store a page that
    // cannot be made inert").
    reason: "sanitization-failed",
    over: {
      fetchPreview: async () => ({
        ok: true,
        html: "<p>ok</p><scr" + "ipt>x</scr" + "ipt",
        pinnedAddresses: ["2001:db8::10"],
      }),
    },
    noFetch: false,
  },
  { reason: "renderer-unavailable", over: renderRefusal("renderer-unavailable"), noFetch: false },
  { reason: "render-failed", over: renderRefusal("render-failed"), noFetch: false },
];

describe("cinatra#4223 — every capture refusal reaches the caller unchanged, and nothing is filed", () => {
  it.each(REFUSALS.map((c) => [c.reason, c] as const))(
    "refuses as %s",
    async (reason, c) => {
      const events: Events = [];
      const fetchSpy = vi.fn();
      const base = captureDeps(events, c.over);
      const deps: CaptureRegisteredPageDeps = {
        ...base.deps,
        fetchPreview: async (i) => {
          fetchSpy(i);
          return base.deps.fetchPreview(i);
        },
      };

      const outcome = await captureArtifactPage(call, toolDeps(deps));

      expect(outcome).toMatchObject({ ok: false, reason });
      if (outcome.ok) throw new Error("unreachable");
      expect(outcome.error).toBe(captureDegradeCopy(reason));
      expect(h.claimMaterialization).not.toHaveBeenCalled();
      expect(h.createSemanticArtifact).not.toHaveBeenCalled();
      if (c.noFetch) expect(fetchSpy).not.toHaveBeenCalled();
      else expect(fetchSpy).toHaveBeenCalledTimes(1);
    },
  );
});

describe("cinatra#4223 — a capture files the renderer's viewport and the time it returned", () => {
  it("hands the stubbed renderer's viewport and the fixed clock to the write unchanged", async () => {
    const events: Events = [];
    const { deps, fetches, renders } = captureDeps(events);

    const outcome = await captureArtifactPage(call, toolDeps(deps));

    if (!outcome.ok) throw new Error(`refused: ${outcome.reason}: ${outcome.error}`);
    expect(outcome).toEqual({
      ok: true,
      artifactId: "art-1",
      representationRevisionId: "rev-1",
      capturedUrl: PAGE_URL,
      viewport: { width: 1280, height: 900 },
      capturedAt: "2026-10-17T16:30:00.000Z",
      deduped: false,
    });

    // The guarded fetch carries no credential header; the renderer is pinned to
    // the registered origin and the guard-validated addresses.
    expect(fetches).toEqual([{ url: PAGE_URL, headers: {} }]);
    expect(renders).toEqual([
      { documentUrl: PAGE_URL, allowedOrigin: ORIGIN, pinnedAddresses: ["2001:db8::10"] },
    ]);
    // The clock is read AFTER the renderer returns.
    expect(events).toEqual(["sites", "fetch", "render", "now"]);

    expect(h.claimMaterialization).toHaveBeenCalledTimes(1);
    expect(h.claimMaterialization.mock.calls[0]?.[0]).toMatchObject({
      outputId: "capture_page",
      nodeId: "capture_page",
      path: "materialize_tool",
      extension: SHOT,
    });
    expect(written).toHaveLength(1);
    const [w] = written;
    expect(w.input).toMatchObject({
      objectType: SCREENSHOT_OBJECT_TYPE,
      declaredMime: "image/png",
      title: "The about page",
      producerAssertionExtension: SHOT,
    });
    expect(w.input.typedData).toEqual({
      capturedUrl: PAGE_URL,
      viewport: { width: 1280, height: 900 },
      capturedAt: "2026-10-17T16:30:00.000Z",
    });
    expect(w.bytes.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(true);
    // Only the finalize query: no image provenance, so the image cap never counts it.
    expect(w.tx2).toHaveLength(1);
    expect(w.tx2.some((q) => q.text.includes("image_provider"))).toBe(false);
  });

  it("files to the single type the extension declares, whatever its id (no core type id)", async () => {
    // The tool names no type: whatever single object type the extension resolves
    // to is the one filed, as long as its accepts take image/png (the declared
    // schema is asked by the canonical writer, spied here).
    const OTHER_TYPE = "@cinatra-ai/page-capture-artifact:capture";
    h.resolveBoundArtifactTarget.mockResolvedValue({
      ok: true,
      target: { objectTypeId: OTHER_TYPE, acceptedFileMimeTypes: ["image/*"] },
    });
    const events: Events = [];
    const { deps } = captureDeps(events);

    const outcome = await captureArtifactPage(call, toolDeps(deps));

    if (!outcome.ok) throw new Error(`refused: ${outcome.reason}: ${outcome.error}`);
    expect(outcome).toMatchObject({ ok: true, artifactId: "art-1", deduped: false });
    expect(events).toEqual(["sites", "fetch", "render", "now"]);
    expect(written).toHaveLength(1);
    expect(written[0].input).toMatchObject({ objectType: OTHER_TYPE, declaredMime: "image/png" });
    expect(written[0].input.typedData).toEqual({
      capturedUrl: PAGE_URL,
      viewport: { width: 1280, height: 900 },
      capturedAt: "2026-10-17T16:30:00.000Z",
    });
  });
});

/**
 * cinatra#4223: THE PAGE CAPTURE TOOL'S DECISIONS, over supplied seams.
 *
 * Every named capture refusal reaches the caller unchanged and files nothing;
 * the two target refusals send no fetch at all. The capture runs through the
 * REAL `captureRegisteredPage` (its guarded fetch, renderer, site list and clock
 * are stubbed). A capture that succeeds files the renderer's viewport and the
 * time the renderer returned as the object's data and as the revision's facts
 * record, under a lease of the shared budget that is released afterwards.
 *
 * PURE TIER. The ledger claim and the artifact write are spies; the write itself
 * is proved against a real Postgres in
 * `artifacts/__tests__/page-capture-tool-4223.integration.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  resolveBoundArtifactTarget: vi.fn(),
  isArtifactExtensionWriteAllowed: vi.fn(async () => true),
  claimMaterialization: vi.fn(),
  readFinalizedMaterialization: vi.fn(),
  createSemanticArtifact: vi.fn(),
  enqueueArtifactMatchRun: vi.fn(async () => undefined),
}));

vi.mock("@/lib/artifacts/resolve-bound-artifact-type", () => ({
  resolveBoundArtifactTarget: h.resolveBoundArtifactTarget,
}));
vi.mock("@/lib/artifacts/artifact-extension-access", () => ({
  isArtifactExtensionWriteAllowed: h.isArtifactExtensionWriteAllowed,
}));
vi.mock("@/lib/register-all-object-types", () => ({ registerAllObjectTypes: vi.fn() }));
vi.mock("@/lib/artifacts/materialization-ledger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/artifacts/materialization-ledger")>()),
  claimMaterialization: h.claimMaterialization,
  readFinalizedMaterialization: h.readFinalizedMaterialization,
}));
vi.mock("@/lib/artifacts/artifact-creation", () => ({ createSemanticArtifact: h.createSemanticArtifact }));
vi.mock("@/lib/artifacts/matcher-enqueue", () => ({ enqueueArtifactMatchRun: h.enqueueArtifactMatchRun }));

import {
  BUDGET_REFUSAL_ERRORS,
  captureArtifactPage,
  MAX_PAGE_CAPTURE_PNG_BYTES,
  PAGE_CAPTURE_DATA_REJECTED_ERROR,
  PAGE_CAPTURE_STORED_FACTS_UNREADABLE_ERROR,
  PAGE_CAPTURE_UNEXPECTED_ERROR,
  PAGE_CAPTURE_URL_UNRECORDABLE_ERROR,
  PAGE_CAPTURE_WRITE_FAILED_ERROR,
  pageCaptureInstallStateError,
  type ArtifactPageCaptureToolDeps,
} from "@/lib/artifact-page-capture-tool";
import { captureDegradeCopy, type CaptureDegradeReason } from "@/lib/artifacts/registered-page-render";
import { MATERIALIZATION_FINALIZE_CONFLICT_MARKER } from "@/lib/artifacts/materialization-ledger";
import type { PageCaptureBudgetAnswer, PageCaptureBudgetRefusal } from "@/lib/artifacts/page-capture-budget";
import { PageCaptureFactsRecordError, type RecordedPageCaptureFacts } from "@/lib/artifacts/page-capture-facts-record";
import { captureRegisteredPage, type CaptureRegisteredPageDeps } from "@/lib/artifacts/registered-page-capture";

const EXT = "@cinatra-ai/screenshot-artifact";
/** The type the screenshot pack declares; the tool itself names no type. */
const SHOT_TYPE = "@cinatra-ai/screenshot-artifact:screenshot";
const ORIGIN = "https://blog.example.com";
const PAGE_URL = `${ORIGIN}/about/`;
const CLOCK = new Date("2026-10-17T16:30:00.000Z");
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const FACTS = { capturedUrl: PAGE_URL, viewport: { width: 1280, height: 900 }, capturedAt: CLOCK.toISOString() };

const call = {
  runId: "run-1",
  orgId: "org-1",
  templateId: "tpl-1",
  packageVersion: "1.0.0",
  createdBy: "user-1",
  nodeId: "capture_page",
  extension: EXT,
  title: "The about page",
  url: PAGE_URL,
};

/** The capture seams, stubbed in the style of `cms-preview-capture.test.ts`. */
function captureSeams(events: string[], over: Partial<CaptureRegisteredPageDeps> = {}) {
  const fetches: Array<{ url: string; headers: Record<string, string> }> = [];
  const renders: Array<{ documentUrl: string; allowedOrigin: string; pinnedAddresses: string[] }> = [];
  const deps: CaptureRegisteredPageDeps = {
    listRegisteredSites: async () => {
      events.push("sites");
      return [{ siteId: "site-1", client: "wordpress", origin: ORIGIN }];
    },
    fetchPreview: async ({ url, headers }) => {
      events.push("fetch");
      fetches.push({ url, headers });
      return { ok: true, html: "<html><body><p>about</p></body></html>", pinnedAddresses: ["2001:db8::10"] };
    },
    renderIsolated: async ({ documentUrl, allowedOrigin, pinnedAddresses }) => {
      events.push("render");
      renders.push({ documentUrl, allowedOrigin, pinnedAddresses: [...pinnedAddresses] });
      return {
        ok: true,
        screenshot: new Uint8Array(PNG),
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

type Budget = { answer: PageCaptureBudgetAnswer; acquired: Array<{ orgId: string; runId: string }>; released: number };

function budget(refusal?: PageCaptureBudgetRefusal): Budget {
  const b: Budget = { answer: { ok: false, reason: "budget_unavailable" }, acquired: [], released: 0 };
  b.answer = refusal
    ? { ok: false, reason: refusal }
    : { ok: true, lease: { leaseId: "lease-1", release: async () => void (b.released += 1) } };
  return b;
}

function toolDeps(
  capture: CaptureRegisteredPageDeps,
  b: Budget = budget(),
  recorded: () => RecordedPageCaptureFacts = () => ({ status: "recorded", facts: FACTS }),
): ArtifactPageCaptureToolDeps {
  return {
    loadProducesRefs: async () => [{ extension: EXT, objectTypeId: SHOT_TYPE }],
    resolveOwnership: async () => ({
      ownerLevel: "organization",
      ownerId: "org-1",
      visibility: "organization",
      projectId: null,
    }),
    capturePage: (i) => captureRegisteredPage({ ...i, deps: capture }),
    acquireLease: async (i) => {
      b.acquired.push(i);
      return b.answer;
    },
    readRecordedFacts: recorded,
  };
}

type Written = { input: Record<string, unknown>; bytes: Buffer; tx2: Array<{ text: string; values: unknown[] }> };
let written: Written[] = [];
let logged: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  written = [];
  logged = vi.spyOn(console, "error").mockImplementation(() => {});
  h.resolveBoundArtifactTarget.mockResolvedValue({
    ok: true,
    target: { objectTypeId: SHOT_TYPE, acceptedFileMimeTypes: ["image/png", "image/jpeg", "image/webp"] },
  });
  h.isArtifactExtensionWriteAllowed.mockResolvedValue(true);
  h.claimMaterialization.mockResolvedValue({ kind: "claimed", ledgerId: "ledger-1" });
  h.createSemanticArtifact.mockImplementation(
    async (input: {
      stream: AsyncIterable<Uint8Array>;
      additionalTx2Queries: (ids: { artifactId: string; representationRevisionId: string }) => Array<{
        text: string;
        values: unknown[];
      }>;
    }) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of input.stream) chunks.push(chunk);
      written.push({
        input: input as unknown as Record<string, unknown>,
        bytes: Buffer.concat(chunks),
        tx2: input.additionalTx2Queries({ artifactId: "art-1", representationRevisionId: "rev-1" }),
      });
      return { objectId: "art-1", artifactId: "art-1", resourceId: "res-1", representationRevisionId: "rev-1" };
    },
  );
});

afterEach(() => {
  logged.mockRestore();
  vi.clearAllMocks();
});

const fetchRefusal = (reason: CaptureDegradeReason): Partial<CaptureRegisteredPageDeps> => ({
  fetchPreview: async () => ({ ok: false, reason }),
});
const renderRefusal = (reason: CaptureDegradeReason): Partial<CaptureRegisteredPageDeps> => ({
  renderIsolated: async () => ({ ok: false, reason }),
});

const REFUSALS: Array<{ reason: CaptureDegradeReason; over: Partial<CaptureRegisteredPageDeps>; noFetch: boolean }> = [
  { reason: "no-registered-site", over: { listRegisteredSites: async () => [] }, noFetch: true },
  {
    reason: "origin-not-registered",
    over: {
      listRegisteredSites: async () => [{ siteId: "site-2", client: "wordpress", origin: "https://other.example.org" }],
    },
    noFetch: true,
  },
  { reason: "egress-blocked", over: fetchRefusal("egress-blocked"), noFetch: false },
  { reason: "preview-unauthorized", over: fetchRefusal("preview-unauthorized"), noFetch: false },
  { reason: "preview-unreachable", over: fetchRefusal("preview-unreachable"), noFetch: false },
  { reason: "preview-bad-response", over: fetchRefusal("preview-bad-response"), noFetch: false },
  { reason: "preview-too-large", over: fetchRefusal("preview-too-large"), noFetch: false },
  {
    // The REAL sanitizer and inertness re-check, on a page that cannot be made inert
    // (cms-preview-capture.test.ts "REFUSES to store a page that cannot be made inert").
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

describe("cinatra#4223 page capture: every capture refusal reaches the caller unchanged, and nothing is filed", () => {
  it.each(REFUSALS.map((c) => [c.reason, c] as const))("refuses as %s", async (reason, c) => {
    const seams = captureSeams([], c.over);
    const fetchSpy = vi.fn();
    const deps: CaptureRegisteredPageDeps = {
      ...seams.deps,
      fetchPreview: async (i) => {
        fetchSpy(i);
        return seams.deps.fetchPreview(i);
      },
    };
    const b = budget();

    const outcome = await captureArtifactPage(call, toolDeps(deps, b));

    expect(outcome).toEqual({ ok: false, reason, error: captureDegradeCopy(reason) });
    expect(h.claimMaterialization).not.toHaveBeenCalled();
    expect(h.createSemanticArtifact).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(c.noFetch ? 0 : 1);
    // The lease taken before the capture is released after its refusal.
    expect(b.acquired).toEqual([{ orgId: "org-1", runId: "run-1" }]);
    expect(b.released).toBe(1);
  });
});

describe("cinatra#4223 page capture: a capture files its three facts as object data and as the revision's record", () => {
  it("files the stubbed renderer's viewport and the fixed clock, then releases its lease", async () => {
    const events: string[] = [];
    const { deps, fetches, renders } = captureSeams(events);
    const b = budget();

    const outcome = await captureArtifactPage(call, toolDeps(deps, b));

    expect(outcome).toEqual({
      ok: true,
      artifactId: "art-1",
      representationRevisionId: "rev-1",
      ...FACTS,
      deduped: false,
    });
    // No credential header; the renderer is pinned to the site's origin and the guard's addresses.
    expect(fetches).toEqual([{ url: PAGE_URL, headers: {} }]);
    expect(renders).toEqual([{ documentUrl: PAGE_URL, allowedOrigin: ORIGIN, pinnedAddresses: ["2001:db8::10"] }]);
    // The clock is read AFTER the renderer returns.
    expect(events).toEqual(["sites", "fetch", "render", "now"]);
    expect(b.acquired).toEqual([{ orgId: "org-1", runId: "run-1" }]);
    expect(b.released).toBe(1);

    expect(h.claimMaterialization).toHaveBeenCalledTimes(1);
    expect(h.claimMaterialization.mock.calls[0]?.[0]).toMatchObject({
      orgId: "org-1",
      runId: "run-1",
      outputId: "capture_page",
      nodeId: "capture_page",
      path: "materialize_tool",
      extension: EXT,
    });
    expect(written).toHaveLength(1);
    const [w] = written;
    expect(w!.input).toMatchObject({
      orgId: "org-1",
      objectType: SHOT_TYPE,
      declaredMime: "image/png",
      title: "The about page",
      originKind: "agent_generated",
      createdByRunId: "run-1",
      producerAssertionExtension: EXT,
    });
    expect(w!.input.typedData).toEqual(FACTS);
    expect(w!.bytes.equals(PNG)).toBe(true);
    // The ledger finalize, then the facts record; no image provenance on the row.
    expect(w!.tx2).toHaveLength(2);
    expect(w!.tx2.some((q) => q.text.includes("image_provider"))).toBe(false);
    expect(w!.tx2[0]!.values).toEqual(["ledger-1", "org-1", "art-1", "rev-1"]);
    const record = w!.tx2[1]!;
    expect(record.text).toMatch(/INSERT INTO "[^"]+"\."artifact_audit"/);
    expect(record.values.slice(0, 4)).toEqual(["org-1", "art-1", "rev-1", "page_capture_facts"]);
    expect(JSON.parse(record.values[4] as string)).toEqual({ v: 1, objectType: SHOT_TYPE, ...FACTS });
    expect(h.enqueueArtifactMatchRun).toHaveBeenCalledWith({
      orgId: "org-1",
      artifactId: "art-1",
      representationRevisionId: "rev-1",
      createdByRunId: "run-1",
    });
  });

  it("files to the single type the extension resolves to, whatever its id", async () => {
    const OTHER = "@cinatra-ai/page-capture-artifact:capture";
    h.resolveBoundArtifactTarget.mockResolvedValue({
      ok: true,
      target: { objectTypeId: OTHER, acceptedFileMimeTypes: ["image/*"] },
    });
    const outcome = await captureArtifactPage(call, toolDeps(captureSeams([]).deps));
    expect(outcome).toMatchObject({ ok: true, artifactId: "art-1" });
    expect(written[0]!.input).toMatchObject({ objectType: OTHER, declaredMime: "image/png" });
  });
});

describe("cinatra#4223 page capture: the shared budget refuses before the capture", () => {
  it.each(["run_cap_exceeded", "concurrency_exceeded", "budget_unavailable"] as const)(
    "refuses %s with its fixed sentence, captures nothing and files nothing",
    async (reason) => {
      const events: string[] = [];
      const b = budget(reason);
      const outcome = await captureArtifactPage(call, toolDeps(captureSeams(events).deps, b));
      expect(outcome).toEqual({ ok: false, reason, error: BUDGET_REFUSAL_ERRORS[reason] });
      expect(events).toEqual([]);
      expect(b.acquired).toEqual([{ orgId: "org-1", runId: "run-1" }]);
      expect(h.claimMaterialization).not.toHaveBeenCalled();
    },
  );

  it("states the limits of 20 per run and 2 at once", () => {
    expect(BUDGET_REFUSAL_ERRORS.run_cap_exceeded).toContain("20 page captures");
    expect(BUDGET_REFUSAL_ERRORS.concurrency_exceeded).toContain("2 page captures in flight");
  });

  it("releases the lease when the write fails too", async () => {
    h.createSemanticArtifact.mockRejectedValueOnce(new Error("could not serialize access"));
    const b = budget();
    const outcome = await captureArtifactPage(call, toolDeps(captureSeams([]).deps, b));
    expect(outcome).toMatchObject({ ok: false, reason: "write_refused" });
    expect(b.released).toBe(1);
  });
});

describe("cinatra#4223 page capture: the write authorization refuses before a lease is taken", () => {
  it("refuses an extension the run package does not produce", async () => {
    const b = budget();
    const deps = { ...toolDeps(captureSeams([]).deps, b), loadProducesRefs: async () => [] };
    const outcome = await captureArtifactPage(call, deps);
    expect(outcome).toMatchObject({ ok: false, reason: "not_produced" });
    expect(b.acquired).toEqual([]);
  });

  it("answers an unresolved install state with the fixed sentence, through the resolver's explainer seam", async () => {
    h.resolveBoundArtifactTarget.mockImplementationOnce(
      async (i: { deps: { explainAbsentClaims: (a: unknown) => Promise<string> } }) => ({
        ok: false,
        error: await i.deps.explainAbsentClaims({ orgId: "org-1", extension: EXT }),
      }),
    );
    const b = budget();
    const outcome = await captureArtifactPage(call, toolDeps(captureSeams([]).deps, b));
    expect(outcome).toEqual({ ok: false, reason: "type_unresolved", error: pageCaptureInstallStateError(EXT) });
    expect(b.acquired).toEqual([]);
  });

  it("refuses an extension that is not write-allowed", async () => {
    h.isArtifactExtensionWriteAllowed.mockResolvedValueOnce(false);
    const b = budget();
    const outcome = await captureArtifactPage(call, toolDeps(captureSeams([]).deps, b));
    expect(outcome).toMatchObject({ ok: false, reason: "write_refused" });
    expect(b.acquired).toEqual([]);
  });

  it.each([
    // Assembled, so no credential-shaped literal sits in the source.
    ["user information", ["https://user", "pw@blog.example.com/about/"].join(":")],
    ["an empty user name", "https://@blog.example.com/about/"],
    ["a control character", "https://blog.example.com/ab\nout/"],
    ["more than 2048 characters", `${ORIGIN}/${"a".repeat(2048)}`],
  ])("refuses a url with %s that the facts record cannot hold, before a lease or a fetch", async (_l, url) => {
    const events: string[] = [];
    const b = budget();
    const outcome = await captureArtifactPage({ ...call, url }, toolDeps(captureSeams(events).deps, b));
    expect(outcome).toEqual({ ok: false, reason: "write_refused", error: PAGE_CAPTURE_URL_UNRECORDABLE_ERROR });
    expect(b.acquired).toEqual([]);
    expect(events).toEqual([]);
  });
});

describe("cinatra#4223 page capture: the size cap and the target's accepts", () => {
  const withPng = (png: Buffer): Partial<CaptureRegisteredPageDeps> => ({
    renderIsolated: async () => ({
      ok: true,
      screenshot: new Uint8Array(png),
      geometry: { regions: [], contentHeight: 900, viewport: { width: 1280, height: 900 } },
      network: { blockedRequests: 0, allowedRequests: 0 },
    }),
  });

  it("refuses a PNG over 10 MB as capture_too_large and files nothing; exactly 10 MB is filed", async () => {
    const over = await captureArtifactPage(
      call,
      toolDeps(captureSeams([], withPng(Buffer.alloc(MAX_PAGE_CAPTURE_PNG_BYTES + 1))).deps),
    );
    expect(over).toMatchObject({ ok: false, reason: "capture_too_large" });
    expect(h.claimMaterialization).not.toHaveBeenCalled();
    const edge = await captureArtifactPage(
      call,
      toolDeps(captureSeams([], withPng(Buffer.alloc(MAX_PAGE_CAPTURE_PNG_BYTES))).deps),
    );
    expect(edge.ok).toBe(true);
  });

  it("refuses a type that does not accept image/png before a lease or a request, and files nothing", async () => {
    h.resolveBoundArtifactTarget.mockResolvedValue({
      ok: true,
      target: { objectTypeId: SHOT_TYPE, acceptedFileMimeTypes: ["text/plain"] },
    });
    const events: string[] = [];
    const b = budget();
    const outcome = await captureArtifactPage(call, toolDeps(captureSeams(events).deps, b));
    expect(outcome).toMatchObject({ ok: false, reason: "write_refused" });
    expect((outcome as { error: string }).error).toContain("accepts [text/plain]");
    // A capture is always image/png, so the answer is known before the budget or the page is touched.
    expect(b.acquired).toEqual([]);
    expect(events).toEqual([]);
    expect(h.claimMaterialization).not.toHaveBeenCalled();
    expect(h.createSemanticArtifact).not.toHaveBeenCalled();
  });
});

describe("cinatra#4223 page capture: a re-drive answers the facts recorded with the revision that serves it", () => {
  const finalized = { kind: "finalized", artifactId: "art-0", representationRevisionId: "rev-0", path: "materialize_tool" };
  const OLD = { capturedUrl: PAGE_URL, viewport: { width: 1280, height: 900 }, capturedAt: "2026-10-16T08:00:00.000Z" };

  it("answers the stored facts, never this attempt's, and writes nothing", async () => {
    h.claimMaterialization.mockResolvedValueOnce(finalized);
    const read = vi.fn((): RecordedPageCaptureFacts => ({ status: "recorded", facts: OLD }));
    const outcome = await captureArtifactPage(call, toolDeps(captureSeams([]).deps, budget(), read));
    expect(outcome).toEqual({ ok: true, artifactId: "art-0", representationRevisionId: "rev-0", ...OLD, deduped: true });
    expect(read).toHaveBeenCalledWith({
      orgId: "org-1",
      artifactId: "art-0",
      representationRevisionId: "rev-0",
      objectType: SHOT_TYPE,
    });
    expect(h.createSemanticArtifact).not.toHaveBeenCalled();
  });

  it.each([
    ["absent", () => ({ status: "absent" }) as RecordedPageCaptureFacts],
    ["unreadable", () => ({ status: "unreadable" }) as RecordedPageCaptureFacts],
    [
      "a read that throws",
      (): RecordedPageCaptureFacts => {
        throw new Error("connect ECONNREFUSED facts-secret-host:5432");
      },
    ],
  ])("refuses with a fixed sentence when the stored facts are %s", async (_l, read) => {
    h.claimMaterialization.mockResolvedValueOnce(finalized);
    const outcome = await captureArtifactPage(call, toolDeps(captureSeams([]).deps, budget(), read));
    expect(outcome).toEqual({ ok: false, reason: "write_refused", error: PAGE_CAPTURE_STORED_FACTS_UNREADABLE_ERROR });
    expect(JSON.stringify(logged.mock.calls)).not.toContain("facts-secret-host");
  });

  it("serves the concurrent double-drive loser from the winner's stored facts", async () => {
    h.createSemanticArtifact.mockRejectedValueOnce(
      new Error(`${MATERIALIZATION_FINALIZE_CONFLICT_MARKER}: claim already finalized by a concurrent writer; rows=0`),
    );
    h.readFinalizedMaterialization.mockResolvedValueOnce({ artifactId: "art-w", representationRevisionId: "rev-w" });
    const outcome = await captureArtifactPage(
      call,
      toolDeps(captureSeams([]).deps, budget(), () => ({ status: "recorded", facts: OLD })),
    );
    expect(outcome).toEqual({ ok: true, artifactId: "art-w", representationRevisionId: "rev-w", ...OLD, deduped: true });
  });

  it("refuses a ledger identity that belongs to another path", async () => {
    h.claimMaterialization.mockResolvedValueOnce({ ...finalized, path: "default_road" });
    const outcome = await captureArtifactPage(call, toolDeps(captureSeams([]).deps));
    expect(outcome).toMatchObject({ ok: false, reason: "write_refused" });
    expect(h.createSemanticArtifact).not.toHaveBeenCalled();
  });
});

describe("cinatra#4223 page capture: a failed filing answers a fixed sentence, and no log line carries the error's text", () => {
  it("a write failure says what it kept", async () => {
    h.createSemanticArtifact.mockRejectedValueOnce(new Error('relation "tenant_secret_schema"."resource" does not exist'));
    const outcome = await captureArtifactPage(call, toolDeps(captureSeams([]).deps));
    expect(outcome).toEqual({ ok: false, reason: "write_refused", error: PAGE_CAPTURE_WRITE_FAILED_ERROR });
    expect(JSON.stringify(logged.mock.calls)).not.toContain("tenant_secret_schema");
  });

  it("a schema refusal answers data_rejected with a fixed sentence", async () => {
    h.createSemanticArtifact.mockRejectedValueOnce(
      new Error("object payload does not satisfy the declared schema for x: /viewport secret-field-detail"),
    );
    const outcome = await captureArtifactPage(call, toolDeps(captureSeams([]).deps));
    expect(outcome).toEqual({ ok: false, reason: "data_rejected", error: PAGE_CAPTURE_DATA_REJECTED_ERROR });
    expect(JSON.stringify(logged.mock.calls)).not.toContain("secret-field-detail");
  });

  it("an error outside the write answers the unexpected-error sentence", async () => {
    const deps = {
      ...toolDeps(captureSeams([]).deps),
      loadProducesRefs: async () => {
        throw new Error("connect ECONNREFUSED registry-secret-host:5432");
      },
    };
    const outcome = await captureArtifactPage(call, deps);
    expect(outcome).toEqual({ ok: false, reason: "write_refused", error: PAGE_CAPTURE_UNEXPECTED_ERROR });
    expect(JSON.stringify(logged.mock.calls)).not.toContain("registry-secret-host");
  });

  it("the matcher enqueue failing never fails a filed capture", async () => {
    h.enqueueArtifactMatchRun.mockRejectedValueOnce(new Error("queue down"));
    const outcome = await captureArtifactPage(call, toolDeps(captureSeams([]).deps));
    expect(outcome).toMatchObject({ ok: true, deduped: false });
  });
});

describe("cinatra#4223 captureRegisteredPage never throws", () => {
  it("answers render-failed when a seam throws", async () => {
    const { deps } = captureSeams([], {
      listRegisteredSites: async () => {
        throw new Error("site store down");
      },
    });
    await expect(captureRegisteredPage({ orgId: "org-1", url: PAGE_URL, deps })).resolves.toEqual({
      ok: false,
      reason: "render-failed",
    });
  });
});

describe("cinatra#4223 page capture: a throw after the lease is taken still releases the lease", () => {
  const SECRET = "lease-throw-secret-host";
  const thrown = () => new Error(`connect ECONNREFUSED ${SECRET}:5432`);
  const CASES: Array<{ label: string; arrange: (d: ArtifactPageCaptureToolDeps) => ArtifactPageCaptureToolDeps }> = [
    {
      label: "the ledger claim rejects",
      arrange: (d) => {
        h.claimMaterialization.mockRejectedValueOnce(thrown());
        return d;
      },
    },
    {
      label: "the ownership read rejects",
      arrange: (d) => ({
        ...d,
        resolveOwnership: async () => {
          throw thrown();
        },
      }),
    },
    {
      label: "the capture seam rejects",
      arrange: (d) => ({
        ...d,
        capturePage: async () => {
          throw thrown();
        },
      }),
    },
  ];

  it.each(CASES.map((c) => [c.label, c] as const))(
    "releases the lease when %s, and answers the unexpected-error sentence",
    async (_l, c) => {
      const b = budget();
      const outcome = await captureArtifactPage(call, c.arrange(toolDeps(captureSeams([]).deps, b)));
      expect(outcome).toEqual({ ok: false, reason: "write_refused", error: PAGE_CAPTURE_UNEXPECTED_ERROR });
      expect(b.acquired).toEqual([{ orgId: "org-1", runId: "run-1" }]);
      expect(b.released).toBe(1);
      expect(h.createSemanticArtifact).not.toHaveBeenCalled();
      expect(JSON.stringify(logged.mock.calls)).not.toContain(SECRET);
    },
  );
});

describe("cinatra#4223 page capture: the Known limit, a renderer viewport that the facts record refuses", () => {
  it("answers the write-failed sentence when the record op refuses a width-0 viewport, and releases the lease", async () => {
    // No declared schema runs here (the writer is a spy), as for a type whose schema does not bound viewport.
    const zeroWidth: Partial<CaptureRegisteredPageDeps> = {
      renderIsolated: async () => ({
        ok: true,
        screenshot: new Uint8Array(PNG),
        geometry: { regions: [], contentHeight: 900, viewport: { width: 0, height: 900 } },
        network: { blockedRequests: 0, allowedRequests: 0 },
      }),
    };
    const b = budget();

    const outcome = await captureArtifactPage(call, toolDeps(captureSeams([], zeroWidth).deps, b));

    expect(outcome).toEqual({ ok: false, reason: "write_refused", error: PAGE_CAPTURE_WRITE_FAILED_ERROR });
    // The claim was taken, and the writer was asked once with the facts as object data. Building its
    // second-transaction ops threw the facts record's own error, so no write completed and no finalize op
    // was handed back.
    expect(h.claimMaterialization).toHaveBeenCalledTimes(1);
    expect(h.createSemanticArtifact).toHaveBeenCalledTimes(1);
    expect(h.createSemanticArtifact.mock.calls[0]?.[0]?.typedData).toEqual({
      ...FACTS,
      viewport: { width: 0, height: 900 },
    });
    await expect(h.createSemanticArtifact.mock.results[0]?.value).rejects.toBeInstanceOf(PageCaptureFactsRecordError);
    expect(written).toEqual([]);
    expect(b.released).toBe(1);
    expect(JSON.stringify(logged.mock.calls)).toContain('"errorClass":"Error"');
    expect(JSON.stringify(logged.mock.calls)).not.toContain("not a valid record");
  });
});

describe("cinatra#4223 captureRegisteredPage: the url's own origin must be a registered site's origin", () => {
  const site = (origin: string): Partial<CaptureRegisteredPageDeps> => ({
    listRegisteredSites: async () => [{ siteId: "site-1", client: "wordpress", origin }],
  });

  it.each([
    ["an upper-case host", "https://BLOG.Example.COM/about/", ORIGIN],
    ["the default port written out", "https://blog.example.com:443/about/", ORIGIN],
    ["a registered origin written with upper case, the default port and a slash", PAGE_URL, "HTTPS://Blog.Example.com:443/"],
  ])("captures a url with %s", async (_l, url, registered) => {
    const { deps, fetches, renders } = captureSeams([], site(registered));
    const outcome = await captureRegisteredPage({ orgId: "org-1", url, deps });
    expect(outcome).toMatchObject({ ok: true, viewport: { width: 1280, height: 900 }, capturedAt: CLOCK.toISOString() });
    expect(fetches).toEqual([{ url, headers: {} }]);
    expect(renders).toEqual([{ documentUrl: url, allowedOrigin: ORIGIN, pinnedAddresses: ["2001:db8::10"] }]);
  });

  it.each([
    ["no scheme, so it does not parse", "blog.example.com/about/"],
    ["a scheme other than http and https", "ftp://blog.example.com/about/"],
    // Assembled, so no credential-shaped literal sits in the source.
    ["user information", ["https://user", "pw@blog.example.com/about/"].join(":")],
    ["another port on the registered host", "https://blog.example.com:8443/about/"],
    ["http where the registered site is https", "http://blog.example.com/about/"],
    ["a trailing dot on the host", "https://blog.example.com./about/"],
    ["the registered host as the start of another host", "https://blog.example.com.attacker.test/about/"],
  ])("refuses a url with %s as origin-not-registered, and sends no request", async (_l, url) => {
    const events: string[] = [];
    const { deps } = captureSeams(events);
    await expect(captureRegisteredPage({ orgId: "org-1", url, deps })).resolves.toEqual({
      ok: false,
      reason: "origin-not-registered",
    });
    expect(events).toEqual(["sites"]);
  });

  it("refuses as origin-not-registered when no registered site's origin normalises, and sends no request", async () => {
    const events: string[] = [];
    const { deps } = captureSeams(events, {
      listRegisteredSites: async () => {
        events.push("sites");
        return [
          { siteId: "site-1", client: "wordpress", origin: "not a url" },
          { siteId: "site-2", client: "wordpress", origin: "ftp://blog.example.com" },
          { siteId: "site-3", client: "wordpress", origin: "" },
        ];
      },
    });
    await expect(captureRegisteredPage({ orgId: "org-1", url: PAGE_URL, deps })).resolves.toEqual({
      ok: false,
      reason: "origin-not-registered",
    });
    expect(events).toEqual(["sites"]);
  });
});

describe("cinatra#4223 page capture: a lease release that throws does not change the answer", () => {
  const SECRET = "release-throw-secret-host";
  /** A replaced budget seam whose release throws; the production release never throws. */
  const throwingRelease = (b: Budget): ArtifactPageCaptureToolDeps["acquireLease"] => async (i) => {
    b.acquired.push(i);
    const answer: PageCaptureBudgetAnswer = {
      ok: true,
      lease: {
        leaseId: "lease-1",
        release: async () => {
          b.released += 1;
          throw new Error(`connect ECONNREFUSED ${SECRET}:5432`);
        },
      },
    };
    return answer;
  };

  it("answers the filed capture when the release throws after it, and logs no error text", async () => {
    const b = budget();
    const deps = { ...toolDeps(captureSeams([]).deps, b), acquireLease: throwingRelease(b) };
    const outcome = await captureArtifactPage(call, deps);
    expect(outcome).toEqual({ ok: true, artifactId: "art-1", representationRevisionId: "rev-1", ...FACTS, deduped: false });
    expect(written).toHaveLength(1);
    expect(b.released).toBe(1);
    expect(JSON.stringify(logged.mock.calls)).toContain('"errorClass":"Error"');
    expect(JSON.stringify(logged.mock.calls)).not.toContain(SECRET);
  });

  it("answers the capture refusal when the release throws after it, and logs no error text", async () => {
    const b = budget();
    const deps = { ...toolDeps(captureSeams([], renderRefusal("render-failed")).deps, b), acquireLease: throwingRelease(b) };
    const outcome = await captureArtifactPage(call, deps);
    expect(outcome).toEqual({ ok: false, reason: "render-failed", error: captureDegradeCopy("render-failed") });
    expect(b.released).toBe(1);
    expect(JSON.stringify(logged.mock.calls)).not.toContain(SECRET);
  });
});

describe("cinatra#4223 page capture: a refusal sentence promises no log line", () => {
  // A log line that cannot be written is dropped (failure-log.ts), so no answer may say that one was written.
  it.each([
    ["the budget that could not be read", BUDGET_REFUSAL_ERRORS.budget_unavailable],
    ["an unexpected error", PAGE_CAPTURE_UNEXPECTED_ERROR],
    ["an install state that could not be read", pageCaptureInstallStateError(EXT)],
  ])("says nothing of a log line for %s", (_l, text) => {
    expect(text).not.toMatch(/\blog/i);
  });
});

describe("cinatra#4223 page capture: a log line's fields that cannot be read do not change the answer", () => {
  const SECRET = "field-getter-secret-host";

  it("answers the unexpected-error sentence when the outer catch cannot read the org id for its log line", async () => {
    const input: typeof call = { ...call };
    Object.defineProperty(input, "orgId", {
      enumerable: true,
      get() {
        throw new Error(`connect ECONNREFUSED ${SECRET}:5432`);
      },
    });
    const deps = {
      ...toolDeps(captureSeams([]).deps),
      loadProducesRefs: async () => {
        throw new Error("connect ECONNREFUSED registry-secret-host:5432");
      },
    };
    const outcome = await captureArtifactPage(input, deps);
    expect(outcome).toEqual({ ok: false, reason: "write_refused", error: PAGE_CAPTURE_UNEXPECTED_ERROR });
    expect(JSON.stringify(logged.mock.calls)).toContain('"orgId":"unreadable"');
    expect(JSON.stringify(logged.mock.calls)).not.toContain(SECRET);
    expect(JSON.stringify(logged.mock.calls)).not.toContain("registry-secret-host");
  });

  it("answers the filed capture when a release that throws has made the org id unreadable for its log line", async () => {
    const b = budget();
    const input: typeof call = { ...call };
    const deps: ArtifactPageCaptureToolDeps = {
      ...toolDeps(captureSeams([]).deps, b),
      acquireLease: async (i) => {
        b.acquired.push(i);
        return {
          ok: true,
          lease: {
            leaseId: "lease-1",
            release: async () => {
              b.released += 1;
              Object.defineProperty(input, "orgId", {
                get() {
                  throw new Error(`connect ECONNREFUSED ${SECRET}:5432`);
                },
              });
              throw new Error("release failed");
            },
          },
        };
      },
    };
    const outcome = await captureArtifactPage(input, deps);
    expect(outcome).toEqual({ ok: true, artifactId: "art-1", representationRevisionId: "rev-1", ...FACTS, deduped: false });
    expect(b.released).toBe(1);
    expect(JSON.stringify(logged.mock.calls)).toContain('"orgId":"unreadable"');
    expect(JSON.stringify(logged.mock.calls)).not.toContain(SECRET);
  });
});

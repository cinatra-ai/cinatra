/**
 * cinatra#4223 — passthrough dispatch for the deterministic
 * `artifact_page_capture` tool: a page url on a connect-registered site
 * in, a PNG of that page filed.
 *
 * This file proves the road: the tool is on the allowlist, its shaper's
 * refusals surface as 400s, every identity the tool writes under comes from the
 * BOUND run row rather than the request body, and a tool refusal answers 400
 * with its reason.
 *
 *   npx vitest run src/__tests__/passthrough-artifact-page-capture-route.test.ts
 */
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  isAuthorizedMock,
  bindBridgeRunIdMock,
  readAgentRunByIdMock,
  buildActorContextFromRunMock,
  collectAllPrimitiveHandlersMock,
  captureArtifactPageMock,
} = vi.hoisted(() => ({
  isAuthorizedMock: vi.fn(() => true),
  bindBridgeRunIdMock: vi.fn(
    async (): Promise<{ ok: true } | { ok: false; status: number; error: string }> => ({
      ok: true,
    }),
  ),
  readAgentRunByIdMock: vi.fn(),
  buildActorContextFromRunMock: vi.fn(async () => ({
    principalType: "HumanUser",
    principalId: "user-1",
    organizationId: "org-a",
    platformRole: "member",
  })),
  collectAllPrimitiveHandlersMock: vi.fn(async () => ({})),
  captureArtifactPageMock: vi.fn(),
}));

vi.mock("@cinatra-ai/agents", () => ({
  readAgentRunById: readAgentRunByIdMock,
  publishCallAllowed: async () => true, // cinatra#4150: no publish decision holds this run
}));
vi.mock("@/lib/primitive-handlers", () => ({
  collectAllPrimitiveHandlers: collectAllPrimitiveHandlersMock,
}));
vi.mock("@/lib/wayflow-bridge-auth", () => ({
  isAuthorizedBridgeRequest: isAuthorizedMock,
}));
vi.mock("@/lib/authz/bridge-run-binding", () => ({
  bindBridgeRunId: bindBridgeRunIdMock,
}));
vi.mock("@/lib/authz/build-actor-context-from-run", () => ({
  buildActorContextFromRun: buildActorContextFromRunMock,
}));
vi.mock("@cinatra-ai/llm/actor-context", () => ({
  withActorContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/artifact-page-capture-tool", () => ({
  captureArtifactPage: captureArtifactPageMock,
}));

import { POST } from "../app/api/agents/passthrough/route";

const EXT = "@cinatra-ai/fixture-artifact";
const PAGE_URL = "https://blog.example.com/about/";

const RUN = {
  id: "run-1",
  runBy: "user-1",
  orgId: "org-a",
  templateId: "tpl-1",
  packageVersion: "1.2.3",
};

function post(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/agents/passthrough", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function captureBody(inputOverrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    tool: "artifact_page_capture",
    agent_run_id: "run-1",
    input: {
      extension: EXT,
      title: "The about page",
      url: PAGE_URL,
      node_id: "capture_page",
      ...inputOverrides,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  isAuthorizedMock.mockReturnValue(true);
  bindBridgeRunIdMock.mockResolvedValue({ ok: true });
  readAgentRunByIdMock.mockResolvedValue(RUN);
  captureArtifactPageMock.mockResolvedValue({
    ok: true,
    artifactId: "art-1",
    representationRevisionId: "rep-1",
    capturedUrl: PAGE_URL,
    viewport: { width: 1280, height: 900 },
    capturedAt: "2026-10-17T16:30:00.000Z",
    deduped: false,
  });
});

describe("cinatra#4223 POST /api/agents/passthrough — artifact_page_capture", () => {
  it("is on the allowlist and dispatches to the page capture tool with the run's facts and the shaped input", async () => {
    const res = await POST(post(captureBody({ title: "  The about page " })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      artifactId: "art-1",
      representationRevisionId: "rep-1",
      capturedUrl: PAGE_URL,
      viewport: { width: 1280, height: 900 },
      capturedAt: "2026-10-17T16:30:00.000Z",
      deduped: false,
    });
    // Server-side authority: every identity field comes from the BOUND run row
    // — never from the request body.
    expect(captureArtifactPageMock).toHaveBeenCalledTimes(1);
    expect(captureArtifactPageMock).toHaveBeenCalledWith({
      runId: "run-1",
      orgId: "org-a",
      templateId: "tpl-1",
      packageVersion: "1.2.3",
      createdBy: "user-1",
      nodeId: "capture_page",
      extension: EXT,
      title: "The about page",
      url: PAGE_URL,
    });
  });

  it("ignores identities the request body names: the shaper keeps four keys and the tool call carries the run row's", async () => {
    const extras = {
      org_id: "org-evil",
      run_id: "run-evil",
      created_by: "user-evil",
      orgId: "org-evil",
      runId: "run-evil",
      createdBy: "user-evil",
    };
    const res = await POST(post(captureBody(extras)));
    expect(res.status).toBe(200);
    expect(captureArtifactPageMock).toHaveBeenCalledTimes(1);
    expect(captureArtifactPageMock).toHaveBeenCalledWith({
      runId: "run-1",
      orgId: "org-a",
      templateId: "tpl-1",
      packageVersion: "1.2.3",
      createdBy: "user-1",
      nodeId: "capture_page",
      extension: EXT,
      title: "The about page",
      url: PAGE_URL,
    });
    // The shaper itself returns exactly its four keys, whatever else the body
    // carries. Imported here, by an absolute path made at run time, so the other
    // cases of this file still load where the shaper module does not exist.
    const shaperPath = fileURLToPath(
      new URL("../lib/artifact-page-capture-shaper.ts", import.meta.url),
    );
    const { shapeArtifactPageCaptureInput } = (await import(/* @vite-ignore */ shaperPath)) as {
      shapeArtifactPageCaptureInput: (raw: Record<string, unknown>) => Record<string, unknown>;
    };
    const shaped = shapeArtifactPageCaptureInput(captureBody(extras).input as Record<string, unknown>);
    expect(Object.keys(shaped).sort()).toEqual(["extension", "nodeId", "title", "url"]);
  });

  it("answers a tool refusal with 400 and its reason", async () => {
    captureArtifactPageMock.mockResolvedValue({
      ok: false,
      reason: "origin-not-registered",
      error: "the staged write's site is not a connect-registered site for this organization",
    });
    const res = await POST(post(captureBody()));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      reason: "origin-not-registered",
      error: "the staged write's site is not a connect-registered site for this organization",
    });
  });

  it("answers a budget refusal with 400 and its reason", async () => {
    captureArtifactPageMock.mockResolvedValue({
      ok: false,
      reason: "concurrency_exceeded",
      error: "this run already has 2 page captures in flight",
    });
    const res = await POST(post(captureBody()));
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe("concurrency_exceeded");
  });

  it.each(["extension", "title", "url", "node_id"])(
    "surfaces a missing %s as the shaper's 400 without reaching the tool",
    async (field) => {
      const res = await POST(post(captureBody({ [field]: undefined })));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain(`artifact_page_capture input.${field} must be a non-empty string`);
      expect(captureArtifactPageMock).not.toHaveBeenCalled();
    },
  );

  it("surfaces the shaper's refusal as a 400 without ever reaching the tool", async () => {
    const res = await POST(post(captureBody({ url: "/about/" })));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(
      /artifact_page_capture input\.url must be an absolute http\(s\) url/,
    );
    expect(captureArtifactPageMock).not.toHaveBeenCalled();
  });
});

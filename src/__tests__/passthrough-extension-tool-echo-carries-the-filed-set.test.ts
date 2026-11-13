/**
 * The passthrough's input echo carries the review set an extension's module
 * filed (cinatra#3035, one review per artifact), for every extension alike.
 *
 * A flow node that calls `extension_tool` with `result_input_passthrough`
 * gets its own input back beside the result's id field. When the declared
 * module filed review targets, the dispatch returns them under the reserved
 * key, and the echo carries that set at its top level as JSON TEXT — the one
 * string a marked review gate's input takes. Every other echo is unchanged.
 *
 *   npx vitest run src/__tests__/passthrough-extension-tool-echo-carries-the-filed-set.test.ts
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

const {
  isAuthorizedMock,
  bindBridgeRunIdMock,
  readAgentRunByIdMock,
  buildActorContextFromRunMock,
  collectAllPrimitiveHandlersMock,
  materializeToolArtifactMock,
  dispatchExtensionScopedToolMock,
} = vi.hoisted(() => ({
  isAuthorizedMock: vi.fn(() => true),
  bindBridgeRunIdMock: vi.fn(
    async (): Promise<
      { ok: true } | { ok: false; status: number; error: string }
    > => ({ ok: true }),
  ),
  readAgentRunByIdMock: vi.fn(),
  buildActorContextFromRunMock: vi.fn(async () => ({
    principalType: "HumanUser",
    principalId: "user-1",
    organizationId: "org-a",
    platformRole: "member",
  })),
  collectAllPrimitiveHandlersMock: vi.fn(async () => ({})),
  materializeToolArtifactMock: vi.fn(),
  dispatchExtensionScopedToolMock: vi.fn(),
}));

vi.mock("@cinatra-ai/agents", () => ({
  publishCallAllowed: async () => true, // cinatra#4150: no publish decision holds this run
  readAgentRunById: readAgentRunByIdMock,
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
vi.mock("@/lib/artifacts/run-artifact-materializer", () => ({
  materializeToolArtifact: materializeToolArtifactMock,
}));
vi.mock("@/lib/extension-scoped-tools", () => ({
  EXTENSION_SCOPED_TOOLS: new Set<string>([
    "extension_data",
    "extension_tool",
    "artifacts_list",
    "artifacts_get",
    "artifact_content_read",
  ]),
  dispatchExtensionScopedTool: dispatchExtensionScopedToolMock,
}));

import { POST } from "../app/api/agents/passthrough/route";

const RUN = {
  id: "run-1",
  runBy: "user-1",
  orgId: "org-a",
  templateId: "tpl-1",
  packageVersion: "1.2.3",
};

const POST_TARGET = { artifactId: "art-post-1", representationRevisionId: "rev-post-1" };
const IMAGE_TARGET = { artifactId: "art-image-1", representationRevisionId: "rev-image-1" };

// cinatra#4154: an `extension_tool` call comes from a proven step, so every call
// here carries the runtime's signed step pair over the run's context id.
const ATTEST_KEY = "echo-attest-key-under-test";
const CONTEXT_ID = "ctx-echo-1";
const STEP = "echo-step-1";

function stepPair(): Record<string, string> {
  const expiry = Math.floor(Date.now() / 1000) + 300;
  const sig = createHmac("sha256", ATTEST_KEY)
    .update(`s1\n${CONTEXT_ID}\n${STEP}\n${expiry}`)
    .digest("hex");
  return {
    "x-cinatra-a2a-context-id": CONTEXT_ID,
    "x-cinatra-step-node": STEP,
    "x-cinatra-step-attestation": `s1:${expiry}:${sig}`,
  };
}

function post(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/agents/passthrough", {
    method: "POST",
    headers: { "content-type": "application/json", ...stepPair() },
    body: JSON.stringify(body),
  });
}

const ATTEST_KEY_BEFORE = process.env.CINATRA_CONTEXT_ATTEST_KEY;

const TOOL_CALL = { name: "fixture_tool", input: { op: "complete" } };

function echoBody(tool: string, input: Record<string, unknown>): Record<string, unknown> {
  return {
    tool,
    agent_run_id: "run-1",
    input,
    result_input_passthrough: true,
    result_id_field: "ok",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  isAuthorizedMock.mockReturnValue(true);
  bindBridgeRunIdMock.mockResolvedValue({ ok: true });
  readAgentRunByIdMock.mockResolvedValue(RUN);
  process.env.CINATRA_CONTEXT_ATTEST_KEY = ATTEST_KEY;
});

afterAll(() => {
  if (ATTEST_KEY_BEFORE === undefined) delete process.env.CINATRA_CONTEXT_ATTEST_KEY;
  else process.env.CINATRA_CONTEXT_ATTEST_KEY = ATTEST_KEY_BEFORE;
  vi.doUnmock("@cinatra-ai/agents");
  vi.doUnmock("@/lib/primitive-handlers");
  vi.doUnmock("@/lib/wayflow-bridge-auth");
  vi.doUnmock("@/lib/authz/bridge-run-binding");
  vi.doUnmock("@/lib/authz/build-actor-context-from-run");
  vi.doUnmock("@cinatra-ai/llm/actor-context");
  vi.doUnmock("@/lib/artifacts/run-artifact-materializer");
  vi.doUnmock("@/lib/extension-scoped-tools");
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("POST /api/agents/passthrough — the extension_tool echo", () => {
  it("carries the filed review set at its top level as JSON text", async () => {
    dispatchExtensionScopedToolMock.mockResolvedValue({
      ok: true,
      result: { ok: true, reviewTargets: [POST_TARGET, IMAGE_TARGET] },
    });
    const res = await POST(post(echoBody("extension_tool", TOOL_CALL)));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.name).toBe("fixture_tool");
    expect(body.input).toEqual({ op: "complete" });
    expect(body.ok).toBe(true);
    expect(typeof body.reviewTargets).toBe("string");
    expect(JSON.parse(body.reviewTargets as string)).toEqual([POST_TARGET, IMAGE_TARGET]);
  });

  it("is the plain echo when the module filed nothing", async () => {
    dispatchExtensionScopedToolMock.mockResolvedValue({ ok: true, result: { ok: true } });
    const res = await POST(post(echoBody("extension_tool", TOOL_CALL)));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ ...TOOL_CALL, ok: true });
    expect("reviewTargets" in body).toBe(false);
  });

  it("an extension_data echo never carries a review set", async () => {
    dispatchExtensionScopedToolMock.mockResolvedValue({
      ok: true,
      result: { ok: true, reviewTargets: [POST_TARGET] },
    });
    const dataCall = { table: "fixture_rows", operation: "select" };
    const res = await POST(post(echoBody("extension_data", dataCall)));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ ...dataCall, ok: true });
    expect("reviewTargets" in body).toBe(false);
  });
});

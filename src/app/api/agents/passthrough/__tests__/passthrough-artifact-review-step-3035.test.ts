/**
 * cinatra#3035 (pre-review 2, finding 1) — the artifact roads hand the SIGNED
 * step to the write, never only the request's own node_id.
 *
 * A write reads reviewed only when the runtime's verified step is the node the
 * request names (the comparison is pinned by the materializer and image-tool
 * suites). This suite pins the route's half: `artifact_materialize` and
 * `artifact_image_generate` pass the verified step through, and pass none when
 * the step pair does not verify, whatever node_id the body claims.
 *
 * Drives the real route and the real run binding (the harness of
 * passthrough-verified-step.test.ts); the run store, the bridge-auth check, the
 * actor builder and the two artifact cores are test doubles.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

const h = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentRunByContextId: vi.fn(),
  resolveLatestWayflowGateTaskId: vi.fn(async () => null as string | null),
  materializeToolArtifact: vi.fn(),
  generateArtifactImage: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@cinatra-ai/agents", () => ({
  readAgentRunById: h.readAgentRunById,
  readAgentRunByContextId: h.readAgentRunByContextId,
}));
vi.mock("@cinatra-ai/a2a", () => ({
  resolveLatestWayflowGateTaskId: h.resolveLatestWayflowGateTaskId,
}));
vi.mock("@cinatra-ai/mcp-server", async () => {
  const actual = await vi.importActual<typeof import("@cinatra-ai/mcp-server/request-context")>(
    "@cinatra-ai/mcp-server/request-context",
  );
  return { mcpRequestContextStorage: actual.mcpRequestContextStorage };
});
vi.mock("@cinatra-ai/llm/actor-context", () => ({
  withActorContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/wayflow-bridge-auth", () => ({
  isAuthorizedBridgeRequest: () => true,
}));
vi.mock("@/lib/authz/build-actor-context-from-run", () => ({
  buildActorContextFromRun: vi.fn(async () => ({
    principalType: "HumanUser",
    principalId: "user-1",
    organizationId: "org-1",
    platformRole: "member",
  })),
}));
vi.mock("@/lib/extension-scoped-tools", () => ({ EXTENSION_SCOPED_TOOLS: new Set<string>() }));
vi.mock("@/lib/run-folder-tools", () => ({ RUN_FOLDER_TOOLS: new Set<string>() }));
vi.mock("@/lib/primitive-handlers", () => ({ collectAllPrimitiveHandlers: async () => ({}) }));
vi.mock("@/lib/artifacts/run-artifact-materializer", () => ({
  materializeToolArtifact: h.materializeToolArtifact,
}));
vi.mock("@/lib/artifact-image-tool", () => ({
  generateArtifactImage: h.generateArtifactImage,
}));

import { POST } from "@/app/api/agents/passthrough/route";

const ATTEST_KEY = "step-attest-key-under-test";
const CTX = "ctx-run-1";
const RUN = {
  id: "run-1",
  orgId: "org-1",
  runBy: "user-1",
  templateId: "tpl-1",
  packageVersion: null,
  oboCeiling: null,
};
const EXT = "@cinatra-ai/blog-post-artifact";

const ATTEST_BEFORE = process.env.CINATRA_CONTEXT_ATTEST_KEY;

function stepHeaders(node: string) {
  const expiry = Math.floor(Date.now() / 1000) + 300;
  const sig = createHmac("sha256", ATTEST_KEY)
    .update(`s1\n${CTX}\n${node}\n${expiry}`)
    .digest("hex");
  return { "x-cinatra-step-node": node, "x-cinatra-step-attestation": `s1:${expiry}:${sig}` };
}

function makeReq(tool: string, input: Record<string, unknown>, headers: Record<string, string>) {
  return new Request("http://localhost:3000/api/agents/passthrough", {
    method: "POST",
    headers: { "content-type": "application/json", "x-cinatra-a2a-context-id": CTX, ...headers },
    body: JSON.stringify({ tool, input, agent_run_id: RUN.id }),
  });
}

const MATERIALIZE_INPUT = {
  extension: EXT,
  declaredMime: "text/markdown",
  node_id: "draft_writer",
  title: "A draft",
  content: "# Draft",
};
const IMAGE_INPUT = {
  extension: EXT,
  prompt: "a lighthouse",
  node_id: "draft_writer",
  title: "A picture",
};

beforeEach(() => {
  h.readAgentRunById.mockReset().mockResolvedValue(RUN);
  h.readAgentRunByContextId.mockReset().mockImplementation(async (ctx: string) =>
    ctx === CTX ? RUN : null,
  );
  h.resolveLatestWayflowGateTaskId.mockReset().mockResolvedValue(null);
  h.materializeToolArtifact.mockReset().mockResolvedValue({
    ok: true,
    artifactId: "a-1",
    representationRevisionId: "r-1",
    deduped: false,
  });
  h.generateArtifactImage.mockReset().mockResolvedValue({
    ok: true,
    artifactId: "a-2",
    representationRevisionId: "r-2",
    revision: 1,
    provider: "p",
    model: "m",
    mime: "image/png",
    deduped: false,
  });
  process.env.CINATRA_CONTEXT_ATTEST_KEY = ATTEST_KEY;
});

afterEach(() => {
  if (ATTEST_BEFORE === undefined) delete process.env.CINATRA_CONTEXT_ATTEST_KEY;
  else process.env.CINATRA_CONTEXT_ATTEST_KEY = ATTEST_BEFORE;
});

describe("cinatra#3035 — the artifact roads pass the signed step, not only the claimed node", () => {
  it("artifact_materialize hands the write the signed step beside the claimed node_id", async () => {
    const res = await POST(
      makeReq("artifact_materialize", MATERIALIZE_INPUT, stepHeaders("picture_writer")),
    );
    expect(res.status).toBe(200);
    expect(h.materializeToolArtifact).toHaveBeenCalledTimes(1);
    expect(h.materializeToolArtifact.mock.calls[0]?.[0]).toMatchObject({
      nodeId: "draft_writer",
      verifiedStepId: "picture_writer",
    });
  });

  it("artifact_image_generate hands the write the signed step beside the claimed node_id", async () => {
    const res = await POST(
      makeReq("artifact_image_generate", IMAGE_INPUT, stepHeaders("picture_writer")),
    );
    expect(res.status).toBe(200);
    expect(h.generateArtifactImage).toHaveBeenCalledTimes(1);
    expect(h.generateArtifactImage.mock.calls[0]?.[0]).toMatchObject({
      nodeId: "draft_writer",
      verifiedStepId: "picture_writer",
    });
  });

  it("passes no step on either road when the step pair does not verify", async () => {
    await POST(makeReq("artifact_materialize", MATERIALIZE_INPUT, {}));
    await POST(makeReq("artifact_image_generate", IMAGE_INPUT, {}));
    expect(h.materializeToolArtifact.mock.calls[0]?.[0]).not.toHaveProperty("verifiedStepId");
    expect(h.generateArtifactImage.mock.calls[0]?.[0]).not.toHaveProperty("verifiedStepId");
  });
});

// Leave the module registry as this file found it.
afterAll(() => {
  vi.doUnmock("server-only");
  vi.doUnmock("@cinatra-ai/agents");
  vi.doUnmock("@cinatra-ai/a2a");
  vi.doUnmock("@cinatra-ai/mcp-server");
  vi.doUnmock("@cinatra-ai/llm/actor-context");
  vi.doUnmock("@/lib/wayflow-bridge-auth");
  vi.doUnmock("@/lib/authz/build-actor-context-from-run");
  vi.doUnmock("@/lib/extension-scoped-tools");
  vi.doUnmock("@/lib/run-folder-tools");
  vi.doUnmock("@/lib/primitive-handlers");
  vi.doUnmock("@/lib/artifacts/run-artifact-materializer");
  vi.doUnmock("@/lib/artifact-image-tool");
  vi.resetModules();
});

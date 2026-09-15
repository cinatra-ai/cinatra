/**
 * cinatra#3032 (epic #3023, lifecycle-c W8) — passthrough dispatch for the
 * deterministic `artifact_image_generate` tool (plan (C) item 0.28: "one tool on
 * the passthrough and the self-served set — a prompt in, a picture filed").
 *
 * Acceptance item 1 is reachable only through this road, so this file proves the
 * road: the tool is on the allowlist, its shaper's refusals surface as 400s, and
 * every identity the tool writes under comes from the BOUND run row rather than
 * the request body. A regeneration that lost the compare-and-set is answered 409,
 * so the caller re-reads and regenerates rather than filing a second picture.
 *
 *   npx vitest run src/__tests__/passthrough-artifact-image-route.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  isAuthorizedMock,
  bindBridgeRunIdMock,
  readAgentRunByIdMock,
  buildActorContextFromRunMock,
  collectAllPrimitiveHandlersMock,
  generateArtifactImageMock,
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
  generateArtifactImageMock: vi.fn(),
}));

vi.mock("@cinatra-ai/agents", () => ({
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
vi.mock("@/lib/artifact-image-tool", () => ({
  generateArtifactImage: generateArtifactImageMock,
}));

import { POST } from "../app/api/agents/passthrough/route";

const EXT = "@cinatra-ai/blog-image-artifact";

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

function imageBody(inputOverrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    tool: "artifact_image_generate",
    agent_run_id: "run-1",
    input: {
      extension: EXT,
      prompt: "a lighthouse at dusk",
      title: "The lighthouse",
      node_id: "make_picture",
      ...inputOverrides,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  isAuthorizedMock.mockReturnValue(true);
  bindBridgeRunIdMock.mockResolvedValue({ ok: true });
  readAgentRunByIdMock.mockResolvedValue(RUN);
  generateArtifactImageMock.mockResolvedValue({
    ok: true,
    artifactId: "art-1",
    representationRevisionId: "rep-1",
    revision: 1,
    provider: "test-image-provider",
    model: "test-image-model-1",
    mime: "image/png",
    deduped: false,
  });
});

describe("POST /api/agents/passthrough — artifact_image_generate", () => {
  it("is on the allowlist and dispatches to the image tool with the run's own authority", async () => {
    const res = await POST(post(imageBody({ data: { post: "art-9", placement: "featured" } })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      artifactId: "art-1",
      representationRevisionId: "rep-1",
      revision: 1,
      provider: "test-image-provider",
      model: "test-image-model-1",
      mime: "image/png",
      deduped: false,
    });
    // Server-side authority: every identity field comes from the BOUND run row
    // — never from the request body.
    expect(generateArtifactImageMock).toHaveBeenCalledWith({
      runId: "run-1",
      orgId: "org-a",
      templateId: "tpl-1",
      packageVersion: "1.2.3",
      createdBy: "user-1",
      nodeId: "make_picture",
      extension: EXT,
      title: "The lighthouse",
      prompt: "a lighthouse at dusk",
      data: { post: "art-9", placement: "featured" },
    });
  });

  it("routes a regeneration with the picture and the revision the caller read", async () => {
    generateArtifactImageMock.mockResolvedValue({
      ok: true,
      artifactId: "art-1",
      representationRevisionId: "rep-2",
      revision: 2,
      provider: "test-image-provider",
      model: "test-image-model-1",
      mime: "image/png",
      deduped: false,
    });
    const res = await POST(
      post(
        imageBody({
          title: undefined,
          artifactId: "art-1",
          baseRepresentationRevisionId: "rep-1",
        }),
      ),
    );
    expect(res.status).toBe(200);
    expect(generateArtifactImageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactId: "art-1",
        baseRepresentationRevisionId: "rep-1",
      }),
    );
    expect(await res.json()).toMatchObject({ artifactId: "art-1", revision: 2 });
  });

  it("answers 409 on a lost compare-and-set, and 400 on every other refusal", async () => {
    generateArtifactImageMock.mockResolvedValue({
      ok: false,
      reason: "stale_base",
      error: "another write has already built on that revision",
    });
    const stale = await POST(
      post(imageBody({ artifactId: "art-1", baseRepresentationRevisionId: "rep-1" })),
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ reason: "stale_base" });

    generateArtifactImageMock.mockResolvedValue({
      ok: false,
      reason: "no_provider",
      error: "no image provider is configured for this deployment",
    });
    const noProvider = await POST(post(imageBody()));
    expect(noProvider.status).toBe(400);
    expect(await noProvider.json()).toMatchObject({
      reason: "no_provider",
      error: expect.stringContaining("no image provider is configured"),
    });
  });

  it("surfaces the shaper's refusal as a 400 without ever reaching the tool", async () => {
    const res = await POST(post(imageBody({ prompt: "   " })));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/input\.prompt must be a non-empty string/);
    expect(generateArtifactImageMock).not.toHaveBeenCalled();
  });
});

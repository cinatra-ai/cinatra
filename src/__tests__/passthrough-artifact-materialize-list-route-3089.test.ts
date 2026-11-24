/**
 * cinatra#3089 — the LIST MODE of the deterministic `artifact_materialize`
 * passthrough tool, at the route: one materializer call per member, in order,
 * with the same node and verified step; the answer carries the artifacts and
 * the review targets as JSON text; a member that fails ends the call with a
 * typed refusal and no artifacts; a shaper refusal files nothing.
 *
 *   npx vitest run src/__tests__/passthrough-artifact-materialize-list-route-3089.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  isAuthorizedMock,
  bindBridgeRunIdMock,
  readAgentRunByIdMock,
  buildActorContextFromRunMock,
  collectAllPrimitiveHandlersMock,
  materializeToolArtifactMock,
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

import { POST } from "../app/api/agents/passthrough/route";

const EXT = "@cinatra-ai/blog-post-artifact";

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

const DRAFTS = [
  { subject: "Hello Ada", body: "Dear Ada, ..." },
  { subject: "Hello Bob", body: "Dear Bob, ..." },
  { subject: "Hello Cy", body: "Dear Cy, ..." },
];

function listBody(inputOverrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    tool: "artifact_materialize",
    agent_run_id: "run-1",
    input: {
      extension: EXT,
      content: JSON.stringify(DRAFTS),
      memberContentField: "body",
      memberTitleField: "subject",
      declaredMime: "text/markdown",
      node_id: "file_drafts",
      ...inputOverrides,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  isAuthorizedMock.mockReturnValue(true);
  bindBridgeRunIdMock.mockResolvedValue({ ok: true });
  readAgentRunByIdMock.mockResolvedValue(RUN);
  let n = 0;
  materializeToolArtifactMock.mockImplementation(async () => {
    n += 1;
    return { ok: true, artifactId: `art-${n}`, representationRevisionId: `rep-${n}`, deduped: false };
  });
});

describe("POST /api/agents/passthrough — artifact_materialize list mode (cinatra#3089)", () => {
  // red-first-expect: expected 400 to be 200
  it("files one artifact per member, in order, under the same node, and answers the review targets as JSON text", async () => {
    const res = await POST(post(listBody()));
    expect(res.status).toBe(200);
    const artifacts = [1, 2, 3].map((i) => ({ artifactId: `art-${i}`, representationRevisionId: `rep-${i}` }));
    expect(await res.json()).toEqual({ artifacts, reviewTargets: JSON.stringify(artifacts) });
    expect(materializeToolArtifactMock).toHaveBeenCalledTimes(3);
    for (const [i, draft] of DRAFTS.entries()) {
      expect(materializeToolArtifactMock.mock.calls[i]![0]).toEqual({
        runId: "run-1",
        orgId: "org-a",
        templateId: "tpl-1",
        packageVersion: "1.2.3",
        createdBy: "user-1",
        nodeId: "file_drafts",
        extension: EXT,
        title: draft.subject,
        mime: "text/markdown",
        content: draft.body,
      });
    }
    expect(collectAllPrimitiveHandlersMock).not.toHaveBeenCalled();
  });

  // red-first-expect: expected { Object (error) } to match object
  it("ends the call with a typed refusal and no artifacts when a member fails, after the members before it", async () => {
    materializeToolArtifactMock
      .mockResolvedValueOnce({ ok: true, artifactId: "art-1", representationRevisionId: "rep-1", deduped: false })
      .mockResolvedValueOnce({ ok: false, error: "materialization failed: db down" });
    const res = await POST(post(listBody()));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ code: "materialize_list_partial", failedMember: 2, filedCount: 1 });
    expect(body.error).toContain("materialization failed: db down");
    expect(body).not.toHaveProperty("artifacts");
    expect(body).not.toHaveProperty("reviewTargets");
    // The third member is never tried: the run cannot go on with a partial set.
    expect(materializeToolArtifactMock).toHaveBeenCalledTimes(2);
  });

  // red-first-expect: to contain 'same content bytes'
  it("refuses a list whose members repeat the same bytes before anything is filed", async () => {
    const res = await POST(
      post(listBody({ content: JSON.stringify([DRAFTS[0], { ...DRAFTS[1], body: DRAFTS[0]!.body }]) })),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("same content bytes");
    expect(materializeToolArtifactMock).not.toHaveBeenCalled();
  });

  it("keeps the single call as it was", async () => {
    const res = await POST(
      post({
        tool: "artifact_materialize",
        agent_run_id: "run-1",
        input: { extension: EXT, content: "# Hi", declaredMime: "text/markdown", title: "T", node_id: "n1" },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ artifactId: "art-1", representationRevisionId: "rep-1", deduped: false });
  });
});

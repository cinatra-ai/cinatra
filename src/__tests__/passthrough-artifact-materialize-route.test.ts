/**
 * Passthrough-route dispatch for the deterministic `artifact_materialize`
 * tool (cinatra#925): allowlist entry, generic-shaper 400 contract, the
 * non-MCP dispatch to `materializeToolArtifact` under the BOUND run's own
 * authority, and the error/response shapes.
 *
 *   npx vitest run src/__tests__/passthrough-artifact-materialize-route.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  isAuthorizedMock,
  bindBridgeRunIdMock,
  readAgentRunByIdMock,
  buildActorContextFromRunMock,
  collectAllPrimitiveHandlersMock,
  materializeToolArtifactMock,
  callClaim,
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
  // cinatra#4762: the decision the call check claims for the call, or null when it claims none.
  callClaim: { decisionId: null as string | null },
}));

vi.mock("@cinatra-ai/agents", () => ({
  // cinatra#4150: no publish decision holds this run, unless a test sets the claim the check takes (cinatra#4762).
  publishCallAllowed: async (_run: unknown, _step: unknown, hold: (release: () => Promise<void>, claim: { decisionId: string }) => void) => {
    if (callClaim.decisionId) hold(async () => {}, { decisionId: callClaim.decisionId });
    return true;
  },
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

function materializeBody(
  inputOverrides?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    tool: "artifact_materialize",
    agent_run_id: "run-1",
    input: {
      extension: EXT,
      content: "# Hello",
      declaredMime: "text/markdown",
      title: "My Draft",
      node_id: "persist_draft",
      ...inputOverrides,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  callClaim.decisionId = null;
  isAuthorizedMock.mockReturnValue(true);
  bindBridgeRunIdMock.mockResolvedValue({ ok: true });
  readAgentRunByIdMock.mockResolvedValue(RUN);
  materializeToolArtifactMock.mockResolvedValue({
    ok: true,
    artifactId: "art-1",
    representationRevisionId: "rep-1",
    deduped: false,
  });
});

describe("POST /api/agents/passthrough — artifact_materialize", () => {
  it("is on the allowlist and dispatches to the materializer core with the run's own authority", async () => {
    const res = await POST(post(materializeBody()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      artifactId: "art-1",
      representationRevisionId: "rep-1",
      deduped: false,
    });
    // Server-side authority: every identity field comes from the BOUND run
    // row — never from the request body.
    expect(materializeToolArtifactMock).toHaveBeenCalledWith({
      runId: "run-1",
      orgId: "org-a",
      templateId: "tpl-1",
      packageVersion: "1.2.3",
      createdBy: "user-1",
      nodeId: "persist_draft",
      extension: EXT,
      title: "My Draft",
      mime: "text/markdown",
      content: "# Hello",
    });
    // Not dispatched through the MCP primitive handlers.
    expect(collectAllPrimitiveHandlersMock).not.toHaveBeenCalled();
  });

  it("shapes via contentJsonField (parse-then-project) before dispatch", async () => {
    const res = await POST(
      post(
        materializeBody({
          content: JSON.stringify({ body: "# Projected" }),
          contentJsonField: "body",
        }),
      ),
    );
    expect(res.status).toBe(200);
    expect(materializeToolArtifactMock).toHaveBeenCalledWith(
      expect.objectContaining({ content: "# Projected" }),
    );
  });

  it("returns 400 with the shaper's message on an invalid input", async () => {
    const res = await POST(post(materializeBody({ node_id: "" })));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("input.node_id");
    expect(materializeToolArtifactMock).not.toHaveBeenCalled();
  });

  it("returns 400 with the materializer's error on a fail-closed outcome", async () => {
    materializeToolArtifactMock.mockResolvedValue({
      ok: false,
      error: `extension "${EXT}" is not declared in @test/agent's cinatra.produces ([])`,
    });
    const res = await POST(post(materializeBody()));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("cinatra.produces");
  });

  // red-first-expect: expected 400 to be 409
  it("answers 409 with its reason when the create is refused while a publishing call of the run is in flight (cinatra#4762)", async () => {
    materializeToolArtifactMock.mockResolvedValue({
      ok: false,
      reason: "publish_call_in_flight",
      error: "a publishing call of this run is in flight; try again once it has ended",
    });
    const res = await POST(post(materializeBody()));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: "publish_call_in_flight" });
  });

  it("still fails closed on a broken run binding BEFORE any materialization", async () => {
    bindBridgeRunIdMock.mockResolvedValue({
      ok: false,
      status: 403,
      error: "run binding mismatch",
    });
    const res = await POST(post(materializeBody()));
    expect(res.status).toBe(403);
    expect(materializeToolArtifactMock).not.toHaveBeenCalled();
  });

  it("supports the generic result_input_passthrough echo with result_id_field", async () => {
    const res = await POST(
      post({
        ...materializeBody(),
        result_input_passthrough: true,
        result_id_field: "artifactId",
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.artifactId).toBe("art-1");
    // Echoes the shaped input fields for OAS-declared output parity.
    expect(body.extension).toBe(EXT);
    expect(body.title).toBe("My Draft");
  });
});

describe("POST /api/agents/passthrough — a released publishing artifact_materialize (cinatra#4762)", () => {
  // What the create writes its produced event under: the claim of the frame the materializer runs in.
  const claimSeen = async () => {
    const { publishCallClaimForRun, buildProducedEventInsertOp } = await import("@/lib/lifecycle/lifecycle-emit");
    let seen: { read: string | null; bound: unknown } | null = null;
    materializeToolArtifactMock.mockImplementation(async () => {
      seen = {
        read: publishCallClaimForRun("run-1"),
        bound: buildProducedEventInsertOp("cinatra", {
          orgId: "org-a", artifactId: "art-1", representationRevisionId: "rep-1", emitter: "createSemanticArtifact",
          originKind: "agent_generated", producerRunId: "run-1", producerAttempt: null,
        }).values[13],
      };
      return { ok: true, artifactId: "art-1", representationRevisionId: "rep-1", deduped: false };
    });
    return () => seen;
  };

  // red-first-expect: hold is not a function
  it("creates under the claim its call check took, so the create's event passes that claim's fence", async () => {
    callClaim.decisionId = "decision-1";
    const seen = await claimSeen();
    const res = await POST(post(materializeBody()));
    expect(res.status).toBe(200);
    expect(seen()).toEqual({ read: "decision-1", bound: "decision-1" });
  });

  // red-first-expect: expected 500 to be 200
  it("never takes a claim from the request: a call the check claimed nothing for writes under none", async () => {
    const seen = await claimSeen();
    const res = await POST(post({ ...materializeBody({ publishCallClaim: "decision-1" }), publishCallClaim: { runId: "run-1", decisionId: "decision-1" } }));
    expect(res.status).toBe(200);
    expect(seen()).toEqual({ read: null, bound: null });
  });
});

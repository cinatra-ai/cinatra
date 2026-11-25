/**
 * cinatra#3089 — the LIST MODE of the deterministic `artifact_materialize`
 * passthrough tool, at the route: one materializer call per member, in order,
 * with the same node and verified step; the answer carries the artifacts and
 * the review targets as JSON text; a member that fails ends the call with a
 * typed refusal and no artifacts; a shaper refusal files nothing.
 *
 * Every call is a source-bound call of a running flow step, as in production:
 * the real route, the real run binding and the real argument preparation (the
 * frozen, size-checked copy of the shaped input) run; the run store with its
 * source check, the run-authority mint, the bridge-auth check, the actor
 * builder and the materializer are test doubles.
 *
 *   npx vitest run src/__tests__/passthrough-artifact-materialize-list-route-3089.test.ts
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentRunByContextId: vi.fn(),
  verifyRunExecutedSource: vi.fn(),
  assertRunStepToolAllowed: vi.fn(),
  mintRunWriteAuthorityForMcp: vi.fn(),
  collectAllPrimitiveHandlers: vi.fn(async () => ({})),
  materializeToolArtifact: vi.fn(),
  frames: [] as unknown[],
}));

vi.mock("server-only", () => ({}));
vi.mock("@cinatra-ai/agents", () => ({
  publishCallAllowed: async () => true, // cinatra#4150: no publish decision holds this run
  readAgentRunById: h.readAgentRunById,
  readAgentRunByContextId: h.readAgentRunByContextId,
}));
vi.mock("@cinatra-ai/agents/store", () => ({
  verifyRunExecutedSource: h.verifyRunExecutedSource,
  isRunExecutedSourceCurrent: async () => true,
  readRunStepToolPolicy: async () => ({ source: "bound-source-under-test" }),
  readCurrentRunStepToolPolicy: async () => ({ source: "bound-source-under-test" }),
  assertRunStepToolAllowed: h.assertRunStepToolAllowed,
}));
vi.mock("@/lib/org-write/run-authority-mint", () => ({
  mintRunWriteAuthorityForMcp: h.mintRunWriteAuthorityForMcp,
}));
vi.mock("@cinatra-ai/a2a", () => ({
  resolveLatestWayflowGateTaskId: async () => null,
}));
vi.mock("@cinatra-ai/mcp-server", async () => {
  const actual = await vi.importActual<typeof import("@cinatra-ai/mcp-server/request-context")>(
    "@cinatra-ai/mcp-server/request-context",
  );
  return { mcpRequestContextStorage: actual.mcpRequestContextStorage };
});
vi.mock("@/lib/primitive-handlers", () => ({
  collectAllPrimitiveHandlers: h.collectAllPrimitiveHandlers,
}));
vi.mock("@/lib/wayflow-bridge-auth", () => ({
  isAuthorizedBridgeRequest: () => true,
}));
vi.mock("@/lib/authz/build-actor-context-from-run", () => ({
  buildActorContextFromRun: vi.fn(async () => ({
    principalType: "HumanUser",
    principalId: "user-1",
    organizationId: "org-a",
    platformRole: "member",
  })),
}));
vi.mock("@cinatra-ai/llm/actor-context", () => ({
  withActorContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/artifacts/run-artifact-materializer", async () => {
  const { mcpRequestContextStorage } = await vi.importActual<
    typeof import("@cinatra-ai/mcp-server/request-context")
  >("@cinatra-ai/mcp-server/request-context");
  return {
    materializeToolArtifact: (...args: unknown[]) => {
      h.frames.push(mcpRequestContextStorage.getStore());
      return h.materializeToolArtifact(...args);
    },
  };
});

import { POST } from "../app/api/agents/passthrough/route";
import {
  ARTIFACT_MATERIALIZE_TOOL,
  collectArtifactMaterializeNodesFromOasDocument,
} from "../../packages/agents/src/artifact-binding";

const EXT = "@cinatra-ai/blog-post-artifact";
const ATTEST_KEY = "step-attest-key-under-test";
const CTX = "ctx-run-1";
const NODE = "file_drafts";
const ATTEMPT = "attempt-1";
const SOURCE = {
  sourceSha256: "b".repeat(64),
  executedSourceSha256: "c".repeat(64),
  declarationSourceSha256: "d".repeat(64),
};
const VERIFIED_SOURCE = Object.freeze({ contextId: CTX, stepId: NODE, executionAttemptId: ATTEMPT, ...SOURCE });
const AUTHORITY = Object.freeze({ authority: "run-authority-under-test" });
const ATTEST_BEFORE = process.env.CINATRA_CONTEXT_ATTEST_KEY;

const RUN = {
  id: "run-1",
  runBy: "user-1",
  orgId: "org-a",
  templateId: "tpl-1",
  packageVersion: "1.2.3",
  oboCeiling: null,
};

/** The source-bound pair the runtime signs over the step, its task's attempt and the executing source. */
function sourceHeaders(): Record<string, string> {
  const expiry = Math.floor(Date.now() / 1000) + 300;
  const sig = createHmac("sha256", ATTEST_KEY)
    .update(`s2\n${CTX}\n${NODE}\n${ATTEMPT}\n${SOURCE.sourceSha256}\n${SOURCE.executedSourceSha256}\n${SOURCE.declarationSourceSha256}\n${expiry}`)
    .digest("hex");
  return {
    "x-cinatra-a2a-context-id": CTX,
    "x-cinatra-step-node": NODE,
    "x-cinatra-execution-attempt": ATTEMPT,
    "x-cinatra-step-attestation": `s2:${expiry}:${sig}`,
    "x-cinatra-raw-source": SOURCE.sourceSha256,
    "x-cinatra-executed-source": SOURCE.executedSourceSha256,
    "x-cinatra-declaration-source": SOURCE.declarationSourceSha256,
  };
}

function post(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/agents/passthrough", {
    method: "POST",
    headers: { "content-type": "application/json", ...sourceHeaders() },
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
      node_id: NODE,
      ...inputOverrides,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.frames.length = 0;
  process.env.CINATRA_CONTEXT_ATTEST_KEY = ATTEST_KEY;
  h.readAgentRunById.mockResolvedValue(RUN);
  h.readAgentRunByContextId.mockImplementation(async (ctx: string) => (ctx === CTX ? RUN : null));
  h.verifyRunExecutedSource.mockResolvedValue(VERIFIED_SOURCE);
  h.assertRunStepToolAllowed.mockReturnValue({ kind: "undeclared" });
  h.mintRunWriteAuthorityForMcp.mockResolvedValue(AUTHORITY);
  let n = 0;
  h.materializeToolArtifact.mockImplementation(async () => {
    n += 1;
    return { ok: true, artifactId: `art-${n}`, representationRevisionId: `rep-${n}`, deduped: false };
  });
});

afterEach(() => {
  if (ATTEST_BEFORE === undefined) delete process.env.CINATRA_CONTEXT_ATTEST_KEY;
  else process.env.CINATRA_CONTEXT_ATTEST_KEY = ATTEST_BEFORE;
});

describe("POST /api/agents/passthrough — artifact_materialize list mode (cinatra#3089)", () => {
  // red-first-expect: expected 400 to be 200
  it("files one artifact per member, in order, under the same node and verified step, and answers the review targets as JSON text", async () => {
    const res = await POST(post(listBody()));
    expect(res.status).toBe(200);
    const artifacts = [1, 2, 3].map((i) => ({ artifactId: `art-${i}`, representationRevisionId: `rep-${i}` }));
    expect(await res.json()).toEqual({ artifacts, reviewTargets: JSON.stringify(artifacts) });
    // The call passed the real preparation: the step's declaration was asked for this tool.
    expect(h.assertRunStepToolAllowed).toHaveBeenCalledWith(
      expect.objectContaining({ stepId: NODE, toolName: "artifact_materialize" }),
    );
    expect(h.materializeToolArtifact).toHaveBeenCalledTimes(3);
    for (const [i, draft] of DRAFTS.entries()) {
      expect(h.materializeToolArtifact.mock.calls[i]![0]).toStrictEqual({
        runId: "run-1",
        orgId: "org-a",
        templateId: "tpl-1",
        packageVersion: "1.2.3",
        createdBy: "user-1",
        nodeId: NODE,
        verifiedStepId: NODE,
        extension: EXT,
        objectTypeId: undefined,
        title: draft.subject,
        mime: "text/markdown",
        content: draft.body,
      });
      // Each member is filed inside the run's verified frame.
      expect(h.frames[i]).toMatchObject({ runId: RUN.id, verifiedStepId: NODE, orgWriteAuthority: AUTHORITY });
    }
    expect(h.collectAllPrimitiveHandlers).not.toHaveBeenCalled();
  });

  // red-first-expect: expected 400 to be 200
  it("files a list whose member text is well inside the argument limit (about 140 KiB)", async () => {
    const big = Array.from({ length: 4 }, (_, i) => ({
      subject: `Long draft ${i + 1}`,
      body: `${i}`.repeat(36 * 1024),
    }));
    const res = await POST(post(listBody({ content: JSON.stringify(big) })));
    expect(res.status).toBe(200);
    expect(h.materializeToolArtifact).toHaveBeenCalledTimes(4);
    expect(h.materializeToolArtifact.mock.calls.map((c) => (c[0] as { content: string }).content)).toEqual(
      big.map((m) => m.body),
    );
  });

  // red-first-expect: expected { Object (error) } to match object
  it("ends the call with a typed refusal and no artifacts when a member fails, after the members before it", async () => {
    h.materializeToolArtifact
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
    expect(h.materializeToolArtifact).toHaveBeenCalledTimes(2);
  });

  // red-first-expect: to contain 'same content bytes'
  it.each([
    ["the same string", DRAFTS[0]!.body, DRAFTS[0]!.body],
    ["strings that encode to the same UTF-8 bytes", "a\uD800b", "a�b"],
  ])("refuses a list whose members repeat %s before anything is filed", async (_name, first, second) => {
    const res = await POST(
      post(listBody({ content: JSON.stringify([{ ...DRAFTS[0], body: first }, { ...DRAFTS[1], body: second }]) })),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("same content bytes");
    expect(h.materializeToolArtifact).not.toHaveBeenCalled();
  });

  // red-first-expect: expected 400 to be 200
  it("hands the caller's own inputs on, member fields and content text untouched, beside the artifacts and the review targets", async () => {
    // The members carry fields the filing does not use (a recipient id): the
    // step after this one reads them from the echoed content.
    const members = DRAFTS.map((d, i) => ({ ...d, recipientId: `rcp-${i + 1}` }));
    const text = JSON.stringify(members, null, 2);
    const call = listBody({ content: text }) as { input: Record<string, unknown> };
    const res = await POST(post({ ...call, result_input_passthrough: true }));
    expect(res.status).toBe(200);
    const body = await res.json();
    const artifacts = [1, 2, 3].map((i) => ({ artifactId: `art-${i}`, representationRevisionId: `rep-${i}` }));
    expect(h.materializeToolArtifact).toHaveBeenCalledTimes(3);
    // Byte for byte the text the caller sent, with every member field in it.
    expect(body.content).toBe(text);
    expect(JSON.parse(body.content)).toEqual(members);
    // The whole input as received, then the answer; the filing took the shaped members only.
    expect(body).toEqual({ ...call.input, artifacts, reviewTargets: JSON.stringify(artifacts) });
    expect(h.materializeToolArtifact.mock.calls.map((c) => (c[0] as { content: string }).content)).toEqual(
      DRAFTS.map((d) => d.body),
    );
    // A list has no single id: no id field, and never a null one.
    expect(body).not.toHaveProperty("id");
  });

  // red-first-expect: expected 400 to be 200
  it("hands a list of about 140 KiB on whole while only the shaped members are filed", async () => {
    const big = Array.from({ length: 4 }, (_, i) => ({
      subject: `Long draft ${i + 1}`,
      body: `${i}`.repeat(36 * 1024),
      recipientId: `rcp-${i + 1}`,
    }));
    const text = JSON.stringify(big);
    const res = await POST(post({ ...listBody({ content: text }), result_input_passthrough: true }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(h.materializeToolArtifact).toHaveBeenCalledTimes(4);
    expect(body.content).toBe(text);
    expect(body.artifacts).toHaveLength(4);
    expect(JSON.parse(body.reviewTargets)).toEqual(body.artifacts);
  });

  // red-first-expect: expected { Object (error) } to deeply equal
  it("refuses a list call that names one result id field before anything is filed", async () => {
    const res = await POST(
      post({ ...listBody(), result_input_passthrough: true, result_id_field: "artifactId" }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error:
        "artifact_materialize: a list call files one artifact per member and has no single id; " +
        "remove result_id_field and read artifacts (or reviewTargets) from the answer",
      code: "materialize_list_result_id_field",
    });
    expect(h.materializeToolArtifact).not.toHaveBeenCalled();
  });

  it("keeps the single call with its inputs and its id field echoed as it was", async () => {
    const res = await POST(
      post({
        tool: "artifact_materialize",
        agent_run_id: "run-1",
        input: { extension: EXT, content: "# Hi", declaredMime: "text/markdown", title: "T", node_id: NODE },
        result_input_passthrough: true,
        result_id_field: "artifactId",
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      extension: EXT,
      content: "# Hi",
      declaredMime: "text/markdown",
      title: "T",
      nodeId: NODE,
      artifactId: "art-1",
    });
    expect(h.materializeToolArtifact).toHaveBeenCalledTimes(1);
  });

  it("keeps the single call as it was", async () => {
    const res = await POST(
      post({
        tool: "artifact_materialize",
        agent_run_id: "run-1",
        input: { extension: EXT, content: "# Hi", declaredMime: "text/markdown", title: "T", node_id: NODE },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ artifactId: "art-1", representationRevisionId: "rep-1", deduped: false });
    expect(h.materializeToolArtifact.mock.calls[0]![0]).toMatchObject({ verifiedStepId: NODE, title: "T" });
  });

  describe("in a Regenerate run (cinatra#3089)", () => {
    const REPAIR_RUN = "lifecycle-repair-run:repair-1";
    const record = { artifactNode: NODE, step: NODE, noteInput: "note", startOutput: "note" };
    const segmentRun = (overrides?: Record<string, unknown>) => ({
      ...RUN,
      id: REPAIR_RUN,
      sourceType: "lifecycle_repair",
      inputParams: { note: "shorter", lifecycleRepairRequest: { findings: [], regenerateInput: record } },
      ...overrides,
    });
    const useRun = (run: Record<string, unknown>) => {
      h.readAgentRunById.mockResolvedValue(run);
      h.readAgentRunByContextId.mockImplementation(async (ctx: string) => (ctx === CTX ? run : null));
    };

    // red-first-expect: expected undefined to be 'materialize_list_in_regenerate_run'
    it("refuses a list call before anything is filed, with a typed error", async () => {
      useRun(segmentRun());
      const res = await POST(post({ ...listBody(), agent_run_id: REPAIR_RUN }));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe("materialize_list_in_regenerate_run");
      expect(body.error).toContain("a Regenerate run files exactly one artifact");
      expect(h.materializeToolArtifact).not.toHaveBeenCalled();
    });

    // red-first-expect: expected undefined to be 'materialize_list_in_regenerate_run'
    it("refuses a list call of a repair run whose inputs cannot be read (fail closed)", async () => {
      useRun(segmentRun({ inputParams: "{ not json" }));
      const res = await POST(post({ ...listBody(), agent_run_id: REPAIR_RUN }));
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("materialize_list_in_regenerate_run");
      expect(h.materializeToolArtifact).not.toHaveBeenCalled();
    });

    // red-first-expect: expected 400 to be 200
    it("files the list of an ordinary repair run (no Regenerate record) as before", async () => {
      useRun(segmentRun({ inputParams: { lifecycleRepairRequest: { findings: [{ note: "x" }] } } }));
      const res = await POST(post({ ...listBody(), agent_run_id: REPAIR_RUN }));
      expect(res.status).toBe(200);
      expect(h.materializeToolArtifact).toHaveBeenCalledTimes(3);
    });

    it("keeps the single call of a Regenerate run as it was", async () => {
      useRun(segmentRun());
      const res = await POST(
        post({
          tool: "artifact_materialize",
          agent_run_id: REPAIR_RUN,
          input: { extension: EXT, content: "# Hi", declaredMime: "text/markdown", title: "T", node_id: NODE },
        }),
      );
      expect(res.status).toBe(200);
      expect(h.materializeToolArtifact).toHaveBeenCalledTimes(1);
    });

    it("reads a Regenerate run by the same names the segment module writes", () => {
      const source = readFileSync(join(__dirname, "../../packages/agents/src/regenerate-segment.ts"), "utf8");
      expect(source).toContain('export const SEGMENT_REPAIR_RUN_PREFIX = "lifecycle-repair-run:";');
      expect(source).toContain('const LIFECYCLE_REPAIR_SOURCE_TYPE = "lifecycle_repair";');
      expect(source).toContain('const LIFECYCLE_REPAIR_REQUEST_INPUT = "lifecycleRepairRequest";');
      expect(source).toContain('export const REGENERATE_INPUT_RECORD_KEY = "regenerateInput";');
    });
  });
});

// ---------------------------------------------------------------------------
// The compile check and the route are one contract: the same call, with the
// same response fields beside its input, is refused by both or accepted by
// both, and the compile check says what the route says.
// ---------------------------------------------------------------------------
describe("the compile check and the route agree on a list call's response fields (cinatra#3089)", () => {
  const SINGLE = { title: "T" } as const;
  const cases: Array<[string, boolean, Record<string, unknown>]> = [
    ["a list call, no response fields", true, {}],
    ["a list call asking for its inputs back", true, { result_input_passthrough: true }],
    ["a list call naming an id field", true, { result_id_field: "artifactId" }],
    ["a list call asking for its inputs back and naming an id field", true, { result_input_passthrough: true, result_id_field: "artifactId" }],
    ["a list call naming a null id field", true, { result_id_field: null }],
    ["a list call naming an unused result shape", true, { result_shape: "test_delivery_send" }],
    ["a single call, no response fields", false, {}],
    ["a single call naming an id field", false, { result_id_field: "artifactId" }],
    ["a single call asking for its inputs back and naming an id field", false, { result_input_passthrough: true, result_id_field: "artifactId" }],
  ];

  async function routeRefusal(list: boolean, siblings: Record<string, unknown>): Promise<{ error: string; code: string } | null> {
    const body = list
      ? { ...listBody(), ...siblings }
      : {
          tool: "artifact_materialize",
          agent_run_id: "run-1",
          input: { extension: EXT, content: "# Hi", declaredMime: "text/markdown", ...SINGLE, node_id: NODE },
          ...siblings,
        };
    const res = await POST(post(body));
    if (res.status === 200) return null;
    expect(res.status).toBe(400);
    return (await res.json()) as { error: string; code: string };
  }

  function compileRefusals(list: boolean, siblings: Record<string, unknown>, dataAsText: boolean): string[] {
    const input = {
      extension: EXT,
      content: "{{ drafts_json }}",
      declaredMime: "text/markdown",
      node_id: NODE,
      ...(list ? { memberContentField: "body", memberTitleField: "subject" } : { title: "{{ title }}" }),
    };
    const data = { tool: ARTIFACT_MATERIALIZE_TOOL, agent_run_id: "{{ cinatra_run_id }}", input, ...siblings };
    const doc = {
      component_type: "Flow",
      id: "flow",
      $referenced_components: {
        [NODE]: {
          component_type: "ApiNode",
          id: NODE,
          url: "{{CINATRA_BASE_URL}}/api/agents/passthrough",
          data: dataAsText ? JSON.stringify(data) : data,
        },
      },
    };
    return collectArtifactMaterializeNodesFromOasDocument(doc, { produces: [EXT] }).errors;
  }

  // red-first-expect: expected undefined to be 'materialize_list_result_id_field'
  it.each(
    cases.flatMap(([name, list, siblings]) =>
      [false, true].map((dataAsText) => [
        `${name}, data as ${dataAsText ? "JSON text" : "an object"}`,
        list,
        siblings,
        dataAsText,
      ] as const),
    ),
  )(
    "%s: refused by both or accepted by both",
    async (_name, list, siblings, dataAsText) => {
      const refusal = await routeRefusal(list, siblings);
      const errors = compileRefusals(list, siblings, dataAsText);
      if (refusal === null) {
        expect(errors).toEqual([]);
        expect(h.materializeToolArtifact).toHaveBeenCalled();
      } else {
        expect(refusal.code).toBe("materialize_list_result_id_field");
        expect(errors).toEqual([expect.stringContaining(refusal.error)]);
        expect(h.materializeToolArtifact).not.toHaveBeenCalled();
      }
    },
  );
});

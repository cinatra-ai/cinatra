/**
 * The WordPress publish pack's review gate gets its target set from the
 * passthrough echo (cinatra#4150, #3650, #4313).
 *
 * The pack's `gather_review_target` node calls `artifacts_get`, which answers
 * only `{ artifact }`. The one-target set the gate `review_post` pins reaches
 * the gate only because the node sets `result_input_passthrough`, so the route
 * echoes the call's input (`reviewTargets` among it) back as the step's output.
 * This drives the real route with the node exactly as the pack ships it, its
 * templates filled the way the runtime fills them, and reads the target set
 * from the answer under the input the gate's marker names.
 *
 * The run store, the bridge auth, the run binding, the actor builder, the
 * declared-tool argument check and the scoped-tool dispatch are test doubles; the dispatch answers the shape the
 * real `artifacts_get` answers.
 *
 *   pnpm exec vitest run src/__tests__/passthrough-wordpress-review-gate-gets-its-targets.test.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  dispatchExtensionScopedTool: vi.fn(),
}));

vi.mock("@cinatra-ai/agents", () => ({
  publishCallAllowed: async () => true, // cinatra#4150: no publish decision holds this run
  readAgentRunById: h.readAgentRunById,
}));
vi.mock("@/lib/primitive-handlers", () => ({
  collectAllPrimitiveHandlers: async () => ({}),
}));
vi.mock("@/lib/wayflow-bridge-auth", () => ({ isAuthorizedBridgeRequest: () => true }));
vi.mock("@/lib/authz/bridge-run-binding", () => ({
  bindBridgeRunId: async () => ({ ok: true, runId: "run-wp" }),
}));
vi.mock("@/lib/authz/build-actor-context-from-run", () => ({
  buildActorContextFromRun: vi.fn(async () => ({
    principalType: "HumanUser",
    principalId: "user-1",
    organizationId: "org-1",
    platformRole: "member",
  })),
  resolveRunOwnerMembershipOrgRole: vi.fn(async () => undefined),
}));
vi.mock("@cinatra-ai/llm/actor-context", () => ({
  withActorContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/extension-scoped-tools", () => ({
  EXTENSION_SCOPED_TOOLS: new Set<string>([
    "extension_data",
    "extension_tool",
    "artifacts_list",
    "artifacts_get",
    "artifact_content_read",
  ]),
  dispatchExtensionScopedTool: h.dispatchExtensionScopedTool,
}));
// cinatra#3745: every passthrough call first prepares its arguments against the
// run's verified executing source and the step's declared tools (pinned in
// src/app/api/agents/passthrough/__tests__/passthrough-verified-step.test.ts).
// Here that check admits the call and hands the tool its input unchanged.
vi.mock("@/lib/extension-host-context", () => ({
  prepareDeclaredRunToolArguments: async (_tool: string, input: unknown) => input,
  OutwardActionRefusal: class OutwardActionRefusal extends Error {
    constructor(readonly code: string) { super(code); this.name = "OutwardActionRefusal"; }
  },
}));

import { POST } from "../app/api/agents/passthrough/route";

type Ref = { $component_ref: string };
type Node = Record<string, unknown> & {
  data?: Record<string, unknown>;
  metadata?: { cinatra?: Record<string, unknown> };
};

const oas = JSON.parse(
  fs.readFileSync(
    path.resolve(
      __dirname,
      "../../extensions/cinatra-ai/blog-wordpress-publish-agent/cinatra/oas.json",
    ),
    "utf8",
  ),
) as {
  $referenced_components: Record<string, Node>;
  data_flow_connections: Array<{
    source_node: Ref;
    source_output: string;
    destination_node: Ref;
    destination_input: string;
  }>;
};

const START = {
  postArtifactId: "art-post-1",
  postRepresentationRevisionId: "rev-post-7",
  cinatra_run_id: "run-wp",
};

// The runtime fills each `{{ name }}` from the node's inputs before the call.
function fill(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, name: string) => {
      const v = (START as Record<string, string>)[name];
      if (v === undefined) throw new Error(`no start value for ${name}`);
      return v;
    });
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v)]));
  }
  return value;
}

function nodeRequest(data: Record<string, unknown>): Request {
  return new Request("http://localhost/api/agents/passthrough", {
    method: "POST",
    headers: { "content-type": "application/json", "x-cinatra-a2a-context-id": "ctx-wp" },
    body: JSON.stringify(fill(data)),
  });
}

// Read inside each case, so a flow without these nodes fails the case itself.
function packNodes() {
  const gather = oas.$referenced_components.gather_review_target;
  const gate = oas.$referenced_components.review_post;
  const targetsInput = (gate.metadata?.cinatra?.artifactReview as { targetsInput: string })
    .targetsInput;
  // The gather output that feeds the gate's marked input.
  const feedingOutput = oas.data_flow_connections.find(
    (e) =>
      e.source_node.$component_ref === "gather_review_target" &&
      e.destination_node.$component_ref === "review_post" &&
      e.destination_input === targetsInput,
  )?.source_output;
  return { gather, targetsInput, feedingOutput };
}

beforeEach(() => {
  h.readAgentRunById.mockReset().mockResolvedValue({
    id: "run-wp",
    orgId: "org-1",
    runBy: "user-1",
    templateId: "tpl-wp",
    packageVersion: "0.6.0",
    oboCeiling: null,
  });
  h.dispatchExtensionScopedTool.mockReset().mockResolvedValue({
    ok: true,
    // What the real artifacts_get answers: the artifact, nothing else.
    result: { artifact: { id: START.postArtifactId, type: "@cinatra-ai/blog-post-artifact:post" } },
  });
});

afterAll(() => {
  for (const m of [
    "@cinatra-ai/agents",
    "@/lib/primitive-handlers",
    "@/lib/wayflow-bridge-auth",
    "@/lib/authz/bridge-run-binding",
    "@/lib/authz/build-actor-context-from-run",
    "@cinatra-ai/llm/actor-context",
    "@/lib/extension-scoped-tools",
    "@/lib/extension-host-context",
  ]) {
    vi.doUnmock(m);
  }
  vi.resetModules();
});

describe("the WordPress publish pack's review gate gets its targets", () => {
  it("the gather step's echoed answer carries the one-target set under the gate's marked input", async () => {
    // red-first-expect: Cannot read properties of undefined (reading 'metadata')
    const { gather, targetsInput, feedingOutput } = packNodes();
    expect(feedingOutput, "a gather output feeds the gate's marked input").toBe(targetsInput);
    const res = await POST(nodeRequest(gather.data!));
    expect(res.status).toBe(200);
    expect(h.dispatchExtensionScopedTool).toHaveBeenCalledTimes(1);
    expect(h.dispatchExtensionScopedTool.mock.calls[0][0].tool).toBe("artifacts_get");
    const body = (await res.json()) as Record<string, unknown>;
    const echoed = body[feedingOutput!];
    expect(typeof echoed).toBe("string");
    expect(JSON.parse(echoed as string)).toEqual([
      {
        artifactId: START.postArtifactId,
        representationRevisionId: START.postRepresentationRevisionId,
      },
    ]);
  });

  it("without the echo flag the answer carries no target set: the flag is what feeds the gate", async () => {
    // red-first-expect: Cannot read properties of undefined (reading 'metadata')
    const { gather, targetsInput } = packNodes();
    const { result_input_passthrough: _flag, ...withoutEcho } = gather.data!;
    const res = await POST(nodeRequest(withoutEcho));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body[targetsInput]).toBeUndefined();
  });
});

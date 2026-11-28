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
 * Two more cases follow the run past the review: the read step hands the
 * review's answer to the pack's own declared tool through the host's real
 * extension-tool dispatch (only the content read is a double), so a Regenerate's
 * approved successor is the revision read; and the write-back of a run that
 * published nothing reaches the REAL objects_update handler (only the object
 * store is a double) and writes nothing.
 *
 *   pnpm exec vitest run src/__tests__/passthrough-wordpress-review-gate-gets-its-targets.test.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  dispatchExtensionScopedTool: vi.fn(),
  collectAllPrimitiveHandlers: vi.fn(async (): Promise<Record<string, unknown>> => ({})),
  getObjectById: vi.fn(),
  upsertObjectAndEnqueue: vi.fn(),
}));

vi.mock("@cinatra-ai/agents", () => ({
  publishCallAllowed: async () => true, // cinatra#4150: no publish decision holds this run
  readAgentRunById: h.readAgentRunById,
}));
vi.mock("@/lib/primitive-handlers", () => ({
  collectAllPrimitiveHandlers: h.collectAllPrimitiveHandlers,
}));
// The object store under the REAL objects_update handler (the failing-publish
// case below): the store upsert is what records a new revision, its history
// and its outbox row.
vi.mock("@/lib/objects-store", () => ({
  getObjectById: h.getObjectById,
  upsertObjectAndEnqueue: h.upsertObjectAndEnqueue,
  listObjectsByFilter: vi.fn(),
  softDeleteObject: vi.fn(),
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
import { buildReviewResumeText } from "@/lib/artifacts/artifact-review-rejection";
import { dispatchExtensionTool } from "@/lib/extension-tool-dispatch";
import { createObjectsPrimitiveHandlers } from "../../packages/objects/src/mcp/handlers";

const PACK_ROOT = path.resolve(__dirname, "../../extensions/cinatra-ai/blog-wordpress-publish-agent");
const PACK_JSON = JSON.parse(fs.readFileSync(path.join(PACK_ROOT, "package.json"), "utf8")) as {
  name: string;
  version: string;
  cinatra: Record<string, unknown>;
};

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
  h.collectAllPrimitiveHandlers.mockReset().mockResolvedValue({});
  h.getObjectById.mockReset();
  h.upsertObjectAndEnqueue.mockReset();
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
    "@/lib/objects-store",
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
    const { gather, targetsInput } = packNodes();
    const { result_input_passthrough: _flag, ...withoutEcho } = gather.data!;
    const res = await POST(nodeRequest(withoutEcho));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body[targetsInput]).toBeUndefined();
  });
});

// A person can choose Regenerate on the review and approve the successor
// revision. The host resumes the review step with its own approval envelope,
// which names the approved target. The pack's read step, as it ships, hands
// that answer to the pack's declared tool through the host's real dispatch, so
// the words read (and then shown on the publish card and sent) are the
// successor's, never the revision the run started with.
describe("the WordPress publish pack reads the revision the review approved", () => {
  it("a Regenerate's successor, approved on the review, is the revision whose words are read", async () => {
    const read = oas.$referenced_components.read_post_text;
    const readData = read.data as { tool?: string; input?: Record<string, unknown> };
    expect(readData.tool).toBe("extension_tool");
    const successor = { artifactId: START.postArtifactId, representationRevisionId: "rev-post-8" };
    const resume = buildReviewResumeText({
      disposition: "approve",
      reviewTaskId: "review-task-1",
      comment: null,
      targets: [successor],
    });
    if (resume.kind !== "approve") throw new Error("an approval resumes with approve text");
    const values: Record<string, string> = {
      reviewDecision: resume.userResponse,
      postArtifactId: START.postArtifactId,
    };
    // The record the flow's record read hands on (the post's record as
    // artifacts_get answered it). The step's template renders it as JSON text
    // through `| tojson`, behind a comment that names the input.
    const records: Record<string, unknown> = {
      postRecord: { artifactId: START.postArtifactId, title: "The post" },
    };
    const fillFrom = (value: unknown): unknown => {
      if (typeof value === "string") {
        return value
          .replace(/\{#[\s\S]*?#\}/g, "")
          .replace(/\{\{\s*(\w+)\s*\|\s*tojson\s*\}\}/g, (_m, name: string) => {
            if (!(name in records)) throw new Error(`no record for ${name}`);
            return JSON.stringify(records[name]);
          })
          .replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, name: string) => {
            const v = values[name];
            if (v === undefined) throw new Error(`no value for ${name}`);
            return v;
          });
      }
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillFrom(v)]));
      }
      return value;
    };
    const contentRead = vi.fn(async (request: Record<string, unknown>) => ({
      text: "# The regenerated title\n\nThe regenerated words.",
      truncated: false,
      representationRevisionId: request.representationRevisionId,
    }));
    const result = await dispatchExtensionTool({
      packageName: PACK_JSON.name,
      packageVersion: PACK_JSON.version,
      orgId: "org-1",
      cinatra: PACK_JSON.cinatra,
      request: fillFrom(readData.input) as Record<string, unknown>,
      ports: {
        artifacts: { list: vi.fn(), contentRead },
      } as unknown as Parameters<typeof dispatchExtensionTool>[0]["ports"],
      deps: { resolvePackageRoot: async () => PACK_ROOT },
    });
    expect(contentRead).toHaveBeenCalledTimes(1);
    expect(contentRead).toHaveBeenCalledWith(successor);
    expect(result).toEqual({
      ...successor,
      text: "# The regenerated title\n\nThe regenerated words.",
      truncated: false,
      title: "The post",
    });
  });
});

// When nothing is published, the publish step answers its failure envelope: the
// three address members are empty strings. The write_address leaf renders the
// patch only when each member is present and non-empty, so for that envelope it
// renders `{}` (its else branch, pinned in
// packages/agents/src/__tests__/blog-wordpress-publish-agent-validates.test.ts).
// That text, sent through the real route to the REAL objects_update handler,
// writes nothing: no store upsert, so no new version, no history and no outbox
// row, and no change-set to undo.
describe("the WordPress publish pack's failing publish leaves the artifact unchanged", () => {
  it("the write-back of the failure envelope reaches objects_update and writes nothing", async () => {
    const write = oas.$referenced_components.write_address;
    const writeData = write.data as { tool?: string; input?: Record<string, unknown> };
    expect(writeData.tool).toBe("objects_update");
    expect(String(writeData.input?.data).endsWith("{% else %}{}{% endif %}")).toBe(true);
    h.getObjectById.mockReturnValue({
      id: START.postArtifactId,
      type: "@cinatra-ai/blog-post-artifact:post",
      parentId: null,
      parentType: null,
      data: { title: "The post" },
      createdBy: "user-1",
      orgId: "org-1",
      source: "agent",
      runId: "run-wp",
      agentId: null,
      packageVersion: null,
      agentSpecVersion: null,
      version: 3,
      deletedAt: null,
      // The run owner's own artifact, so the handler's access check admits it.
      ownerLevel: "user",
      ownerId: "user-1",
      visibility: "private",
      projectId: null,
    });
    // What a write would answer: the next version, with a change-set to undo.
    h.upsertObjectAndEnqueue.mockReturnValue({ id: START.postArtifactId, version: 4, changeSetId: "cs-1" });
    const realUpdate = createObjectsPrimitiveHandlers().objects_update;
    h.collectAllPrimitiveHandlers.mockResolvedValue({ objects_update: realUpdate });
    const res = await POST(
      nodeRequest({ ...writeData, input: { ...writeData.input, data: "{}" } }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(h.getObjectById).toHaveBeenCalledTimes(1);
    expect(h.upsertObjectAndEnqueue).not.toHaveBeenCalled();
  });
});

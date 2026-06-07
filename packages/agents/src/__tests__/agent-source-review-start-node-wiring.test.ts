/**
 * Verifies that `scanOasForStartNodeInputsWithoutRequired` is wired into
 * `runDeterministicReview`.
 *
 * The scanner's direct unit tests only prove scanner behavior; they do not
 * prove that the chat assistant's `agent_source_review` surfaces the warning
 * to the LLM.
 *
 * This test pins the wiring so a dropped scanner call is caught immediately.
 * We import via `../mcp/handlers` rather than calling the scanner directly,
 * so the assertion fails iff the array literal in `runDeterministicReview`
 * loses the scanner call. Heavy `vi.mock` setup mirrors
 * `agent-source-write-files-name-rescoping.test.ts` so we don't load the
 * full server-side dep tree (openai, @anthropic-ai/sdk, recharts, etc.,
 * which aren't installed in worktree symlinked node_modules).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/instance-identity-store", () => ({
  readInstanceIdentity: vi.fn(() => null),
  markFirstPublishedIfCurrentScope: vi.fn(),
}));
vi.mock("@cinatra-ai/skills", () => ({
  upsertSkill: vi.fn(),
  parseFrontmatter: vi.fn(),
  readLocalPackageSkillContent: vi.fn(),
}));
vi.mock("@cinatra-ai/registries", () => ({ listAgentPackages: vi.fn() }));
vi.mock("@cinatra-ai/objects", () => ({ createDeterministicObjectsClient: vi.fn(() => ({})) }));
vi.mock("@cinatra-ai/llm", () => ({
  getActorContext: () => null,
  getActorContextOrThrow: () => { throw new Error("not used"); },
  withActorContext: (_ctx: unknown, fn: () => unknown) => fn(),
  resolveProviderAdapter: () => null,
  ANTHROPIC_API_LOG_DIRECTORY: "/tmp",
  setAnthropicLoggingEnabled: () => {},
}));
vi.mock("../compiler", () => ({ compileWorkflow: vi.fn() }));
vi.mock("../wayflow-url", () => ({ resolveWayflowUrl: vi.fn() }));
vi.mock("../verdaccio/client", () => ({
  deleteAgentPackageVersion: vi.fn(),
  deprecateAgentPackageVersion: vi.fn(),
  publishAgentPackage: vi.fn(),
  publishAgentPackageFromGitDir: vi.fn(),
}));
vi.mock("../verdaccio/publish-metadata", () => ({ derivePublishMetadataFromSnapshot: vi.fn() }));
vi.mock("../install-from-package", () => ({ installAgentFromPackage: vi.fn() }));
vi.mock("../review-task-actions", () => ({ approveReviewTaskInternal: vi.fn() }));
vi.mock("../trigger-service", () => ({
  setRunTriggerForActor: vi.fn(),
  getRunTriggerForActor: vi.fn(),
  deleteRunTriggerForActor: vi.fn(),
}));
vi.mock("../agent-install-path", () => ({
  resolveAgentInstallDir: vi.fn(() => process.cwd()),
}));
vi.mock("../zip-helpers", () => ({ createZipBuffer: vi.fn() }));
vi.mock("../oas-compiler", () => ({ compileOasAgentJson: vi.fn((p: unknown) => p) }));
vi.mock("@/lib/background-jobs", () => ({
  enqueueBackgroundJob: vi.fn(async () => undefined),
  BACKGROUND_JOB_NAMES: { AGENT_BUILDER_EXECUTION: "agent_builder_execution" },
}));
vi.mock("@/lib/primitive-handlers", () => ({ collectAllPrimitiveHandlers: vi.fn(() => ({})) }));
vi.mock("@/lib/mcp-pagination", () => ({
  decodeCursor: vi.fn(() => 0),
  buildListPage: vi.fn(() => ({ items: [], nextCursor: null })),
}));
vi.mock("@/lib/better-auth-db", () => ({
  readTeamsForUser: vi.fn(async () => []),
  readProjectsForUser: vi.fn(async () => []),
  readUserById: vi.fn(async () => null),
}));
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: vi.fn(async () => null),
  isPlatformAdmin: vi.fn(() => true),
  requireAuthSession: vi.fn(),
}));
vi.mock("@/lib/authz", () => ({
  logAuditEvent: vi.fn(async () => undefined),
  POLICY_VERSION: "1.0",
  AuthzError: class extends Error { statusCode = 403; reason = "denied"; },
}));
vi.mock("../auth-policy", () => ({ enforceRunAccess: vi.fn(async () => undefined) }));
vi.mock("../store", () => ({ resolveDefaultOrgId: vi.fn(async () => "org-1") }));
vi.mock("@cinatra-ai/mcp-client", () => ({
  invokePrimitive: vi.fn(),
  createInProcessPrimitiveTransport: vi.fn(),
  PrimitiveInvocationError: class extends Error {},
}));

import { runDeterministicReview } from "../mcp/handlers";

type OasFixture = Record<string, unknown>;

function buildOasWithOrphanStartNodeInput(): OasFixture {
  return {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id: "fixture-flow",
    name: "Fixture Flow",
    description: "Fixture with orphan StartNode input",
    metadata: { cinatra: { type: "node" } },
    nodes: [{ $component_ref: "start" }, { $component_ref: "end" }],
    start_node: { $component_ref: "start" },
    control_flow_connections: [],
    $referenced_components: {
      start: {
        component_type: "StartNode",
        id: "start",
        name: "Inputs",
        // No metadata.cinatra.required and no metadata.cinatra.hidden — the
        // exact pattern the chat-built `webpage-image-count` agent hit.
        inputs: [{ title: "url", type: "string", format: "uri" }],
      },
      end: { component_type: "EndNode", id: "end" },
    },
  };
}

describe("runDeterministicReview — start_node_inputs_without_required wiring", () => {
  it("surfaces the warning when StartNode declares inputs without metadata.cinatra.required", () => {
    const { blockers, warnings, suggestions } = runDeterministicReview(buildOasWithOrphanStartNodeInput());

    expect(blockers).toEqual([]);
    expect(suggestions).toEqual([]);
    const codes = warnings.map((w) => w.code);
    expect(codes).toContain("start_node_inputs_without_required");

    const finding = warnings.find((w) => w.code === "start_node_inputs_without_required");
    expect(finding).toMatchObject({
      severity: "warning",
      source: "deterministic",
      location: "$referenced_components.start",
    });
    expect(finding?.message).toContain('"url"');
  });

  it("does NOT emit the warning when every StartNode input is covered by required", () => {
    const fixture = buildOasWithOrphanStartNodeInput();
    const refs = fixture.$referenced_components as Record<string, Record<string, unknown>>;
    refs.start.metadata = { cinatra: { required: ["url"] } };

    const { warnings } = runDeterministicReview(fixture);
    expect(warnings.find((w) => w.code === "start_node_inputs_without_required")).toBeUndefined();
  });
});

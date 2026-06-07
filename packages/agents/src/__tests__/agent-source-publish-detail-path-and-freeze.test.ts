/**
 * Pins the `detailPath` field + `markFirstPublishedIfCurrentScope` call site
 * on BOTH publish handlers (`agent_source_publish` and
 * `agent_registry_publish`).
 *
 * The chat assistant's publish instructions tell the LLM to
 * `[open](<detailPath>)`, so without the field on the response the LLM falls
 * back to constructing the broken `/agents/<packageName>` URL.
 *
 * This test pins both wires so regressions are caught. Mocks mirror the
 * source write-file rescoping setup; the only additional mocks are the
 * publish-path dependencies (license, destination resolver, dev-extensions
 * override).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";

const { mockMarkFirstPublishedIfCurrentScope, mockReadInstanceIdentity } = vi.hoisted(() => ({
  mockMarkFirstPublishedIfCurrentScope: vi.fn(),
  mockReadInstanceIdentity: vi.fn(() => null as unknown),
}));

vi.mock("@/lib/instance-identity-store", () => ({
  readInstanceIdentity: mockReadInstanceIdentity,
  markFirstPublishedIfCurrentScope: mockMarkFirstPublishedIfCurrentScope,
}));

const { mockPublishAgentPackageFromGitDir, mockPublishAgentPackage } = vi.hoisted(() => ({
  mockPublishAgentPackageFromGitDir: vi.fn(),
  mockPublishAgentPackage: vi.fn(),
}));

vi.mock("../verdaccio/client", () => ({
  deleteAgentPackageVersion: vi.fn(),
  deprecateAgentPackageVersion: vi.fn(),
  publishAgentPackage: mockPublishAgentPackage,
  publishAgentPackageFromGitDir: mockPublishAgentPackageFromGitDir,
}));

vi.mock("@cinatra-ai/extensions/license-detection", () => ({
  detectSpdxLicense: vi.fn(async () => ({ tier: "permissive", spdxId: "MIT", reason: null })),
  LicenseDetectionRejectedError: class extends Error { code = "LICENSE_DETECTION_REJECTED"; },
  LicenseAcknowledgementRequiredError: class extends Error {
    code = "LICENSE_ACKNOWLEDGEMENT_REQUIRED";
    spdxId: string;
    constructor(spdxId: string) { super(`acknowledge ${spdxId}`); this.spdxId = spdxId; }
  },
}));

vi.mock("@cinatra-ai/extensions/destination-resolver", () => ({
  resolvePublishDestination: vi.fn(async () => ({
    registryUrl: "http://127.0.0.1:4873",
    token: "ci-test-token",
    packageScope: "@cinatra",
    destinationId: "local",
  })),
  PublishDestinationNotConfiguredError: class extends Error { code = "PUBLISH_DESTINATION_NOT_CONFIGURED"; },
}));

vi.mock("@/lib/dev-extensions", () => ({
  readEffectivePublishScopeOverride: vi.fn(() => null),
}));

vi.mock("@/lib/verdaccio-config", () => ({
  loadVerdaccioConfigForServer: vi.fn(async () => ({
    registryUrl: "http://127.0.0.1:4873",
    token: "ci-test-token",
    packageScope: "@cinatra",
  })),
}));

vi.mock("../install-from-package", () => ({ installAgentFromPackage: vi.fn(async () => undefined) }));

// Mock triggerWayflowReload so publish-handler tests can assert
// reload-call-count and verify the installedPendingReload path.
const { mockTriggerWayflowReload } = vi.hoisted(() => ({
  mockTriggerWayflowReload: vi.fn(),
}));
vi.mock("../wayflow-reload-client", () => ({
  triggerWayflowReload: mockTriggerWayflowReload,
}));

// Heavyweight transitive mocks — copied from
// agent-source-write-files-name-rescoping.test.ts. Required to keep the
// import graph from pulling in openai / @anthropic-ai/sdk / recharts /
// etc., which aren't installed in worktree symlinked node_modules.
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
vi.mock("../wayflow-preflight", () => ({ preflightWayflowAgent: vi.fn(async () => ({ ok: true })) }));
vi.mock("../verdaccio/publish-metadata", () => ({
  derivePublishMetadataFromSnapshot: vi.fn(() => ({ riskLevel: "low", toolAccess: [], hasApprovalGates: false })),
}));
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
vi.mock("../oas-compiler", () => ({
  compileOasAgentJson: vi.fn((p: unknown) => p),
  injectCinatraLlmIntoApiNodes: vi.fn(),
}));
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
  can: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("../auth-policy", () => ({
  enforceRunAccess: vi.fn(async () => undefined),
  actorContextFromMcpRequest: vi.fn(() => null),
}));
const { mockReadAgentTemplateById, mockReadAgentVersionsByTemplate } = vi.hoisted(() => ({
  mockReadAgentTemplateById: vi.fn(),
  mockReadAgentVersionsByTemplate: vi.fn(),
}));

vi.mock("../store", () => ({
  resolveDefaultOrgId: vi.fn(async () => "org-1"),
  updateAgentTemplateOrigin: vi.fn(async () => undefined),
  // Mocks the registry-publish handler exercises:
  readAgentTemplateById: mockReadAgentTemplateById,
  readAgentVersionsByTemplate: mockReadAgentVersionsByTemplate,
  // Catch-all stubs for the broader store surface imported by handlers.ts.
  // Permissive to keep this test stable across sibling-handler refactors.
  createAgentTemplate: vi.fn(),
  createAgentVersion: vi.fn(),
  createAgentRun: vi.fn(),
  readAgentTemplates: vi.fn(),
  readAgentRunById: vi.fn(),
  readAgentRuns: vi.fn(),
  readAgentRunsByTemplate: vi.fn(),
  readAgentRunsByTemplateRaw: vi.fn(),
  readAgentRunMessages: vi.fn(),
  appendAgentRunMessage: vi.fn(),
  transitionRunStatus: vi.fn(),
  RunTransitionError: class extends Error {},
  updateAgentTemplate: vi.fn(),
  deleteAgentTemplate: vi.fn(),
  readAgentTemplateVersions: vi.fn(),
  readAgentTemplateVersionById: vi.fn(async () => null),
  diffSnapshots: vi.fn(),
  createAgentTemplateVersionIfChanged: vi.fn(),
  rollbackAgentTemplateToVersion: vi.fn(),
  setAgentTemplatePackageName: vi.fn(),
  readRunCoOwners: vi.fn(async () => []),
  resolveRunCoOwnerUserIds: vi.fn(async () => []),
}));
vi.mock("@cinatra-ai/mcp-client", () => ({
  invokePrimitive: vi.fn(),
  createInProcessPrimitiveTransport: vi.fn(),
  PrimitiveInvocationError: class extends Error {},
}));

import { createAgentBuilderPrimitiveHandlers } from "../mcp/handlers";

const TEST_SLUG = "source-publish-freeze-test";
let tmpRoot: string;
let originalCwd: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "source-publish-detail-freeze-"));
  originalCwd = process.cwd();
  process.chdir(tmpRoot);

  // resolveAgentRootDirForRead probes `<installDir>/cinatra-ai/<slug>/cinatra/oas.json`
  // — `installDir` is mocked above to return `process.cwd()` (== tmpRoot).
  // The vendor segment is `cinatra-ai/`. Create the minimum disk shape so the
  // handler proceeds past the directory existence check and the review gate.
  const agentDir = path.join(tmpRoot, "cinatra-ai", TEST_SLUG, "cinatra");
  await fs.mkdir(agentDir, { recursive: true });
  // Minimal valid OAS Flow so runDeterministicReview returns no blockers.
  const oasFixture = {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id: `${TEST_SLUG}-flow`,
    name: "Restore Test Agent",
    description: "Fixture for source-publish freeze publish-handler test.",
    metadata: { cinatra: { type: "node" } },
    nodes: [{ $component_ref: "start" }, { $component_ref: "end" }],
    start_node: { $component_ref: "start" },
    control_flow_connections: [],
    $referenced_components: {
      start: {
        component_type: "StartNode",
        id: "start",
        name: "Inputs",
        metadata: { cinatra: { required: ["url"] } },
        inputs: [{ title: "url", type: "string", format: "uri" }],
      },
      end: { component_type: "EndNode", id: "end" },
    },
  };
  await fs.writeFile(path.join(agentDir, "oas.json"), JSON.stringify(oasFixture));

  mockMarkFirstPublishedIfCurrentScope.mockReset();
  mockPublishAgentPackageFromGitDir.mockReset();
  mockPublishAgentPackage.mockReset();
  mockReadAgentTemplateById.mockReset();
  mockReadAgentVersionsByTemplate.mockReset();
  // Default to ok:false/no_token so reload doesn't affect existing assertions
  // on response shape. Tests that want a specific reload result override
  // per-call.
  mockTriggerWayflowReload.mockReset();
  mockTriggerWayflowReload.mockResolvedValue({ ok: false, reason: "no_token" });
});

afterEach(async () => {
  process.chdir(originalCwd);
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

function buildSourcePublishRequest() {
  return {
    primitiveName: "agent_source_publish",
    input: { packageSlug: TEST_SLUG, destination: "private" as const },
    actor: {
      actorType: "user" as const,
      source: "ui" as const,
      userId: "u-admin",
      platformRole: "platform_admin",
    },
    mode: "deterministic" as const,
  };
}

function getSourcePublishHandler(): (req: unknown) => Promise<unknown> {
  return createAgentBuilderPrimitiveHandlers()["agent_source_publish"];
}

describe("agent_source_publish — detailPath + freeze-on-publish wiring", () => {
  it("returns detailPath of shape /agents/<vendor>/<slug>/new on published: true", async () => {
    mockPublishAgentPackageFromGitDir.mockResolvedValueOnce({
      packageName: `@cinatra/${TEST_SLUG}`,
      packageVersion: "0.1.0",
      registryUrl: "http://127.0.0.1:4873",
      published: true,
      alreadyPublished: false,
    });

    const handler = getSourcePublishHandler();
    const result = (await handler(buildSourcePublishRequest())) as {
      error?: string;
      detailPath?: string;
      published?: boolean;
      packageName?: string;
    };

    expect(result.error).toBeUndefined();
    expect(result.published).toBe(true);
    expect(result.detailPath).toBe(`/agents/cinatra/${TEST_SLUG}/new`);
  });

  it("returns detailPath on alreadyPublished: true (republish path)", async () => {
    mockPublishAgentPackageFromGitDir.mockResolvedValueOnce({
      packageName: `@cinatra/${TEST_SLUG}`,
      packageVersion: "0.1.0",
      registryUrl: "http://127.0.0.1:4873",
      published: false,
      alreadyPublished: true,
    });

    const handler = getSourcePublishHandler();
    const result = (await handler(buildSourcePublishRequest())) as {
      detailPath?: string;
      alreadyPublished?: boolean;
    };

    expect(result.alreadyPublished).toBe(true);
    expect(result.detailPath).toBe(`/agents/cinatra/${TEST_SLUG}/new`);
  });

  it("calls markFirstPublishedIfCurrentScope on published: true", async () => {
    mockPublishAgentPackageFromGitDir.mockResolvedValueOnce({
      packageName: `@cinatra/${TEST_SLUG}`,
      packageVersion: "0.1.0",
      registryUrl: "http://127.0.0.1:4873",
      published: true,
      alreadyPublished: false,
    });

    const handler = getSourcePublishHandler();
    await handler(buildSourcePublishRequest());

    expect(mockMarkFirstPublishedIfCurrentScope).toHaveBeenCalledTimes(1);
    expect(mockMarkFirstPublishedIfCurrentScope).toHaveBeenCalledWith(`@cinatra/${TEST_SLUG}`);
  });

  it("calls markFirstPublishedIfCurrentScope on alreadyPublished: true (covers republish freeze gap)", async () => {
    mockPublishAgentPackageFromGitDir.mockResolvedValueOnce({
      packageName: `@cinatra/${TEST_SLUG}`,
      packageVersion: "0.1.0",
      registryUrl: "http://127.0.0.1:4873",
      published: false,
      alreadyPublished: true,
    });

    const handler = getSourcePublishHandler();
    await handler(buildSourcePublishRequest());

    expect(mockMarkFirstPublishedIfCurrentScope).toHaveBeenCalledTimes(1);
    expect(mockMarkFirstPublishedIfCurrentScope).toHaveBeenCalledWith(`@cinatra/${TEST_SLUG}`);
  });

  it("surfaces namespaceFreezeWarning when the freeze call throws (best-effort, never rejects publish)", async () => {
    mockPublishAgentPackageFromGitDir.mockResolvedValueOnce({
      packageName: `@cinatra/${TEST_SLUG}`,
      packageVersion: "0.1.0",
      registryUrl: "http://127.0.0.1:4873",
      published: true,
      alreadyPublished: false,
    });
    mockMarkFirstPublishedIfCurrentScope.mockImplementationOnce(() => {
      throw new Error("identity-store down");
    });

    const handler = getSourcePublishHandler();
    const result = (await handler(buildSourcePublishRequest())) as {
      published?: boolean;
      namespaceFreezeWarning?: string;
    };

    expect(result.published).toBe(true);
    expect(result.namespaceFreezeWarning).toBe("identity-store down");
  });

  it("does NOT call markFirstPublishedIfCurrentScope when publish fails (neither published nor alreadyPublished)", async () => {
    mockPublishAgentPackageFromGitDir.mockResolvedValueOnce({
      packageName: `@cinatra/${TEST_SLUG}`,
      packageVersion: "0.1.0",
      registryUrl: "http://127.0.0.1:4873",
      published: false,
      alreadyPublished: false,
    });

    const handler = getSourcePublishHandler();
    await handler(buildSourcePublishRequest());

    expect(mockMarkFirstPublishedIfCurrentScope).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// agent_registry_publish — symmetric coverage.
//
// Without these, a future revert that strips detailPath or the freeze call
// from the registry-publish return slips through the suite. The registry
// handler exercises a different code path (DB-saved templates, not on-disk
// source packages), but both handlers expose the same two surfaces, so the
// regression risk is symmetric.
// ---------------------------------------------------------------------------

function buildRegistryPublishRequest() {
  return {
    primitiveName: "agent_registry_publish",
    input: { templateId: "tmpl-test-1", semver: "0.1.0", changelog: "Initial release" },
    actor: {
      actorType: "user" as const,
      source: "ui" as const,
      userId: "u-admin",
      platformRole: "platform_admin",
    },
    mode: "deterministic" as const,
  };
}

function getRegistryPublishHandler(): (req: unknown) => Promise<unknown> {
  return createAgentBuilderPrimitiveHandlers()["agent_registry_publish"];
}

function setupRegistryTemplateMocks(): void {
  mockReadAgentTemplateById.mockResolvedValueOnce({
    id: "tmpl-test-1",
    name: "Registry Test Template",
    description: "Fixture for registry-publish regression test.",
    packageName: `@cinatra/${TEST_SLUG}`,
    packageVersion: null,
    executionProvider: "default",
    agentDependencies: null,
  });
  mockReadAgentVersionsByTemplate.mockResolvedValueOnce([
    {
      id: "ver-test-1",
      templateId: "tmpl-test-1",
      versionNumber: 1,
      contentHash: "fake-hash",
      snapshot: { name: "Registry Test Template", type: "node" },
    },
  ]);
}

describe("agent_registry_publish — detailPath + freeze-on-publish wiring", () => {
  it("returns detailPath of shape /agents/<vendor>/<slug>/new on published: true", async () => {
    setupRegistryTemplateMocks();
    mockPublishAgentPackage.mockResolvedValueOnce({
      packageName: `@cinatra/${TEST_SLUG}`,
      packageVersion: "0.1.0",
      registryUrl: "http://127.0.0.1:4873",
      published: true,
      alreadyPublished: false,
    });

    const result = (await getRegistryPublishHandler()(buildRegistryPublishRequest())) as {
      error?: string;
      detailPath?: string;
      published?: boolean;
    };

    expect(result.error).toBeUndefined();
    expect(result.published).toBe(true);
    expect(result.detailPath).toBe(`/agents/cinatra/${TEST_SLUG}/new`);
  });

  it("returns detailPath on alreadyPublished: true (republish path)", async () => {
    setupRegistryTemplateMocks();
    mockPublishAgentPackage.mockResolvedValueOnce({
      packageName: `@cinatra/${TEST_SLUG}`,
      packageVersion: "0.1.0",
      registryUrl: "http://127.0.0.1:4873",
      published: false,
      alreadyPublished: true,
    });

    const result = (await getRegistryPublishHandler()(buildRegistryPublishRequest())) as {
      alreadyPublished?: boolean;
      detailPath?: string;
    };

    expect(result.alreadyPublished).toBe(true);
    expect(result.detailPath).toBe(`/agents/cinatra/${TEST_SLUG}/new`);
  });

  it("calls markFirstPublishedIfCurrentScope on published: true", async () => {
    setupRegistryTemplateMocks();
    mockPublishAgentPackage.mockResolvedValueOnce({
      packageName: `@cinatra/${TEST_SLUG}`,
      packageVersion: "0.1.0",
      registryUrl: "http://127.0.0.1:4873",
      published: true,
      alreadyPublished: false,
    });

    await getRegistryPublishHandler()(buildRegistryPublishRequest());

    expect(mockMarkFirstPublishedIfCurrentScope).toHaveBeenCalledTimes(1);
    expect(mockMarkFirstPublishedIfCurrentScope).toHaveBeenCalledWith(`@cinatra/${TEST_SLUG}`);
  });

  it("calls markFirstPublishedIfCurrentScope on alreadyPublished: true", async () => {
    setupRegistryTemplateMocks();
    mockPublishAgentPackage.mockResolvedValueOnce({
      packageName: `@cinatra/${TEST_SLUG}`,
      packageVersion: "0.1.0",
      registryUrl: "http://127.0.0.1:4873",
      published: false,
      alreadyPublished: true,
    });

    await getRegistryPublishHandler()(buildRegistryPublishRequest());

    expect(mockMarkFirstPublishedIfCurrentScope).toHaveBeenCalledTimes(1);
    expect(mockMarkFirstPublishedIfCurrentScope).toHaveBeenCalledWith(`@cinatra/${TEST_SLUG}`);
  });

  it("surfaces namespaceFreezeWarning when the freeze call throws", async () => {
    setupRegistryTemplateMocks();
    mockPublishAgentPackage.mockResolvedValueOnce({
      packageName: `@cinatra/${TEST_SLUG}`,
      packageVersion: "0.1.0",
      registryUrl: "http://127.0.0.1:4873",
      published: true,
      alreadyPublished: false,
    });
    mockMarkFirstPublishedIfCurrentScope.mockImplementationOnce(() => {
      throw new Error("identity-store down");
    });

    const result = (await getRegistryPublishHandler()(buildRegistryPublishRequest())) as {
      published?: boolean;
      namespaceFreezeWarning?: string;
    };

    expect(result.published).toBe(true);
    expect(result.namespaceFreezeWarning).toBe("identity-store down");
  });
});

// ---------------------------------------------------------------------------
// agent_source_publish wires triggerWayflowReload exactly once per top-level
// publish call, and surfaces failure as installedPendingReload without rolling
// back the publish.
// ---------------------------------------------------------------------------

describe("agent_source_publish — reload wiring", () => {
  it("calls triggerWayflowReload exactly once on successful publish", async () => {
    mockPublishAgentPackageFromGitDir.mockResolvedValueOnce({
      packageName: `@cinatra/${TEST_SLUG}`,
      packageVersion: "0.1.0",
      registryUrl: "http://127.0.0.1:4873",
      published: true,
      alreadyPublished: false,
    });
    mockTriggerWayflowReload.mockResolvedValueOnce({
      ok: true,
      report: {
        added: [`cinatra/${TEST_SLUG}`],
        changed: [],
        removed: [],
        failed: [],
        agents: 5,
        last_reload_at: "2026-05-12T22:00:00+00:00",
      },
    });

    const result = (await getSourcePublishHandler()(buildSourcePublishRequest())) as {
      published?: boolean;
      installedPendingReload?: boolean;
      wayflowReload?: { ok: boolean };
    };

    expect(mockTriggerWayflowReload).toHaveBeenCalledTimes(1);
    expect(result.published).toBe(true);
    expect(result.installedPendingReload).toBeUndefined();
    expect(result.wayflowReload?.ok).toBe(true);
  });

  it("surfaces installedPendingReload:true when reload fails (publish stays durable)", async () => {
    mockPublishAgentPackageFromGitDir.mockResolvedValueOnce({
      packageName: `@cinatra/${TEST_SLUG}`,
      packageVersion: "0.1.0",
      registryUrl: "http://127.0.0.1:4873",
      published: true,
      alreadyPublished: false,
    });
    mockTriggerWayflowReload.mockResolvedValueOnce({
      ok: false,
      reason: "timeout",
      detail: "aborted after 10000ms",
    });

    const result = (await getSourcePublishHandler()(buildSourcePublishRequest())) as {
      published?: boolean;
      installedPendingReload?: boolean;
      wayflowReload?: { ok: boolean; reason?: string };
    };

    expect(mockTriggerWayflowReload).toHaveBeenCalledTimes(1);
    expect(result.published).toBe(true);
    expect(result.installedPendingReload).toBe(true);
    expect(result.wayflowReload?.ok).toBe(false);
    expect(result.wayflowReload?.reason).toBe("timeout");
  });

  it("does NOT call triggerWayflowReload when publish fails (neither published nor alreadyPublished)", async () => {
    mockPublishAgentPackageFromGitDir.mockResolvedValueOnce({
      packageName: `@cinatra/${TEST_SLUG}`,
      packageVersion: "0.1.0",
      registryUrl: "http://127.0.0.1:4873",
      published: false,
      alreadyPublished: false,
    });

    await getSourcePublishHandler()(buildSourcePublishRequest());

    expect(mockTriggerWayflowReload).not.toHaveBeenCalled();
  });

  it("does NOT call triggerWayflowReload when publishAgentPackageFromGitDir throws", async () => {
    mockPublishAgentPackageFromGitDir.mockRejectedValueOnce(
      new Error("verdaccio is down"),
    );

    const result = (await getSourcePublishHandler()(
      buildSourcePublishRequest(),
    )) as { error?: string };

    expect(result.error).toMatch(/verdaccio is down/);
    expect(mockTriggerWayflowReload).not.toHaveBeenCalled();
  });

  it("calls triggerWayflowReload on alreadyPublished republish (so a stale runtime can catch up)", async () => {
    mockPublishAgentPackageFromGitDir.mockResolvedValueOnce({
      packageName: `@cinatra/${TEST_SLUG}`,
      packageVersion: "0.1.0",
      registryUrl: "http://127.0.0.1:4873",
      published: false,
      alreadyPublished: true,
    });
    mockTriggerWayflowReload.mockResolvedValueOnce({
      ok: true,
      report: {
        added: [],
        changed: [],
        removed: [],
        failed: [],
        agents: 5,
        last_reload_at: "2026-05-12T22:01:00+00:00",
      },
    });

    await getSourcePublishHandler()(buildSourcePublishRequest());

    expect(mockTriggerWayflowReload).toHaveBeenCalledTimes(1);
  });
});

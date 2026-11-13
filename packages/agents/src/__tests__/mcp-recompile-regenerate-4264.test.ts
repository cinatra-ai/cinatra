/**
 * cinatra#4264 slice A1b: the MCP recompile (`agent_source_compile`) keeps the
 * stored `regenerate` list honest.
 *
 *   - It reads the stored row BEFORE the compile and hands the stored list to
 *     the compile as `retainedRegenerate`, so with no readable sibling manifest
 *     (`none`) the compile checks that list against the NEW flow and a stale
 *     list refuses the whole recompile before the source file is written.
 *   - It asks the compile to report its own sibling read and passes that
 *     reading to `syncCompiledTemplateToDb`, which writes the lifecycle column
 *     per the tri-state projection (write / clear / none).
 *   - A row read that fails refuses the recompile (the list cannot be checked).
 *
 * Harness: `agent-source-compile-gate.test.ts` (the same mocked chain), with
 * the compile, the row read and the DB sync observed.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/mcp-recompile-regenerate-4264.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";

const { mockCompile, mockSync, mockReadTemplate } = vi.hoisted(() => ({
  mockCompile: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ ok: false, error: "unset" })),
  mockSync: vi.fn(async (..._a: unknown[]) => undefined),
  mockReadTemplate: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
}));

vi.mock("../verdaccio/client", () => ({
  deleteAgentPackageVersion: vi.fn(),
  deprecateAgentPackageVersion: vi.fn(),
  publishAgentPackage: vi.fn(),
  publishAgentPackageFromGitDir: vi.fn(),
}));

// Mock the instance-identity store so the on-disk path resolvers'
// vendor-segment derivation (cinatra#537 — resolveAgentJsonPathForRead /
// safeVendorSegmentsForRead now call readInstanceIdentity) never reaches the
// REAL @/lib/database, which would block on a synchronous Postgres worker
// (Atomics.wait, ~30s/call) with no DB reachable. Returning null = "identity
// unset", so the resolvers fall back to the first-party "cinatra-ai" vendor
// segment — exactly the layout this test's writeOasFixture writes to.
vi.mock("@/lib/instance-identity-store", () => ({
  readInstanceIdentity: vi.fn(() => null),
  markFirstPublishedIfCurrentScope: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock the rest of the transitive chain (same surface as the handler test).
// ---------------------------------------------------------------------------
vi.mock("@cinatra-ai/skills", () => ({
  upsertSkill: vi.fn(),
  parseFrontmatter: vi.fn(),
  readLocalPackageSkillContent: vi.fn(),
}));
vi.mock("@cinatra-ai/registries", () => ({ isSafePathSegment: (s: unknown): boolean => typeof s === "string" && s !== "." && s !== ".." && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9-])?$/.test(s), assertSafePathSegment: (s: unknown, label = "path segment"): void => { const ok = typeof s === "string" && s !== "." && s !== ".." && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9-])?$/.test(s); if (!ok) throw new Error("unsafe " + label + ": " + JSON.stringify(s)); }, listAgentPackages: vi.fn() }));
vi.mock("@cinatra-ai/objects", () => ({
  createDeterministicObjectsClient: vi.fn(() => ({})),
}));
vi.mock("@cinatra-ai/llm", () => ({
  getActorContext: () => null,
  getActorContextOrThrow: () => {
    throw new Error("not used");
  },
  withActorContext: (_ctx: unknown, fn: () => unknown) => fn(),
  resolveProviderAdapter: () => null,
}));
vi.mock("../compiler", () => ({ compileWorkflow: vi.fn() }));
vi.mock("../wayflow-url", () => ({
  resolveWayflowUrl: vi.fn(),
  WAYFLOW_UNDICI_TIMEOUT_MS: 60_000,
}));
vi.mock("../verdaccio/publish-metadata", () => ({
  derivePublishMetadataFromSnapshot: vi.fn(),
}));
vi.mock("../install-from-package", () => ({
  installAgentFromPackage: vi.fn(),
  syncCompiledTemplateToDb: mockSync,
}));
vi.mock("../review-task-actions", () => ({
  approveReviewTaskInternal: vi.fn(),
}));
vi.mock("../trigger-service", () => ({
  setRunTriggerForActor: vi.fn(),
  getRunTriggerForActor: vi.fn(),
  deleteRunTriggerForActor: vi.fn(),
}));
// Make resolveDevExtensionSourceRoot return process.cwd() so the handler's
// rung-1 path is <tmpRoot>/cinatra/<slug>/cinatra/oas.json — which is where
// our test fixture writes its file (handler at handlers.ts:1911 joins with
// "cinatra" twice, matching our writeOasFixture path).
vi.mock("../agent-runtime-mount", () => ({
  resolveAgentRuntimeMountDir: vi.fn(() => process.cwd()),
  resolveDevExtensionSourceRoot: vi.fn(() => process.cwd()),
}));
vi.mock("../zip-helpers", () => ({ createZipBuffer: vi.fn() }));
vi.mock("../oas-compiler", () => ({
  compileOasAgentJson: mockCompile,
  injectCinatraLlmIntoApiNodes: vi.fn(),
  normalizeOasJsonForExport: vi.fn((x: unknown) => x),
}));
vi.mock("@/lib/background-jobs", () => ({
  enqueueBackgroundJob: vi.fn(async () => undefined),
  BACKGROUND_JOB_NAMES: { AGENT_BUILDER_EXECUTION: "agent_builder_execution" },
}));
vi.mock("@/lib/primitive-handlers", () => ({
  collectAllPrimitiveHandlers: vi.fn(() => ({})),
}));
vi.mock("@/lib/better-auth-db", () => ({
  readTeamsForUser: vi.fn(async () => []),
  readProjectsForUser: vi.fn(async () => []),
  readUserById: vi.fn(async () => null),
}));
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: vi.fn(async () => null),
  isPlatformAdmin: vi.fn(() => true), // admin so the publish gate passes
  requireAuthSession: vi.fn(),
}));
vi.mock("@/lib/authz", () => ({
  logAuditEvent: vi.fn(async () => undefined),
  POLICY_VERSION: "1.0",
  AuthzError: class extends Error {
    statusCode = 403;
    reason = "denied";
  },
}));
vi.mock("../auth-policy", () => ({
  enforceRunAccess: vi.fn(async () => undefined),
}));
vi.mock("../store", () => ({
  resolveDefaultOrgId: vi.fn(async () => "org-1"),
  readAgentTemplateByPackageName: mockReadTemplate,
}));
vi.mock("@cinatra-ai/mcp-client", () => ({
  invokePrimitive: vi.fn(),
  createInProcessPrimitiveTransport: vi.fn(),
  PrimitiveInvocationError: class extends Error {},
}));

import { createAgentBuilderPrimitiveHandlers } from "../mcp/handlers";

const SLUG = "regen-recompile-agent";
const PKG = `@cinatra/${SLUG}`;
const STALE = [{ artifactNode: "file_image", step: "image_flow", noteInput: "prompt" }];
let tmpRoot: string;
let originalCwd: string;
let oasPath: string;

const OAS = {
  agentspec_version: "26.1.0",
  component_type: "Flow",
  id: "regen-recompile-flow",
  name: "Regen Recompile",
  description: "Clean fixture",
  metadata: { cinatra: { type: "node", packageName: PKG } },
  nodes: [{ $component_ref: "start" }, { $component_ref: "api_step" }, { $component_ref: "end" }],
  start_node: { $component_ref: "start" },
  control_flow_connections: [],
  $referenced_components: {
    start: { component_type: "StartNode", id: "start" },
    end: { component_type: "EndNode", id: "end" },
    api_step: {
      component_type: "ApiNode",
      id: "api_step",
      url: "{{CINATRA_BASE_URL}}/api/echo",
      method: "POST",
      body: { hello: "world" },
    },
  },
};

async function writeFixture(): Promise<void> {
  // Same layout as agent-source-compile-gate.test.ts: the handler resolves
  // <cwd>/cinatra-ai/<slug>/cinatra/oas.json with the source root mocked to cwd.
  const dir = path.join(tmpRoot, "cinatra-ai", SLUG, "cinatra");
  await fs.mkdir(dir, { recursive: true });
  oasPath = path.join(dir, "oas.json");
  await fs.writeFile(oasPath, JSON.stringify(OAS, null, 2), "utf-8");
  await fs.writeFile(
    path.join(path.dirname(dir), "package.json"),
    JSON.stringify({ name: PKG, version: "0.1.0" }, null, 2),
    "utf-8",
  );
}

function compileRequest() {
  return {
    primitiveName: "agent_source_compile",
    input: { packageSlug: SLUG },
    actor: { actorType: "user", source: "ui", userId: "u-admin", platformRole: "platform_admin" },
    mode: "deterministic",
  };
}
const runCompile = () =>
  createAgentBuilderPrimitiveHandlers()["agent_source_compile"](compileRequest()) as Promise<{
    error?: string;
  }>;

const compiledValue = {
  approvalPolicy: { steps: [] },
  inputSchema: { type: "object", properties: {} },
  outputSchema: null,
  prompt: null,
  packageName: PKG,
  packageVersion: "0.1.0",
  agentDependencies: {},
  type: "node",
  compiledPlan: [],
  hitlScreens: [],
  llmConfig: null,
  toolboxes: [],
  agentSpecVersion: "26.1.0",
  triggerMode: "full",
  gatedSteps: [],
  hasArtifactBindings: false,
  artifactBindings: null,
  publishingSteps: [],
  cinatraConfig: null,
};

describe("cinatra#4264 A1b — agent_source_compile revalidates and projects the regenerate list", () => {
  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "regen-recompile-"));
    originalCwd = process.cwd();
    process.chdir(tmpRoot);
    mockCompile.mockReset();
    mockSync.mockReset();
    mockReadTemplate.mockReset();
    mockReadTemplate.mockResolvedValue(null);
    await writeFixture();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  });

  it("hands the stored list to the compile as retainedRegenerate and asks for the sibling reading", async () => {
    mockReadTemplate.mockResolvedValue({
      id: "tpl-1",
      lifecycleConfig: JSON.stringify({ repairCapable: true, regenerate: STALE }),
    });
    mockCompile.mockResolvedValue({ ok: false, error: "REGENERATE_DECLARATION_INVALID: step image_flow" });
    await runCompile();
    expect(mockReadTemplate).toHaveBeenCalledWith(PKG);
    expect(mockCompile).toHaveBeenCalledTimes(1);
    expect(mockCompile.mock.calls[0][0]).toMatchObject({
      packageName: PKG,
      retainedRegenerate: STALE,
      reportSiblingLifecycle: true,
    });
  });

  it("a compile that refuses the retained list writes neither the source file nor the row", async () => {
    mockReadTemplate.mockResolvedValue({
      id: "tpl-1",
      lifecycleConfig: JSON.stringify({ regenerate: STALE }),
    });
    mockCompile.mockResolvedValue({ ok: false, error: "REGENERATE_DECLARATION_INVALID: step image_flow" });
    const before = await fs.readFile(oasPath, "utf-8");
    const stat = await fs.stat(oasPath);
    const result = await runCompile();
    expect(result.error).toContain("REGENERATE_DECLARATION_INVALID");
    expect(await fs.readFile(oasPath, "utf-8")).toBe(before);
    expect((await fs.stat(oasPath)).mtimeMs).toBe(stat.mtimeMs);
    expect(mockSync).not.toHaveBeenCalled();
  });

  it("passes the compile's own sibling reading to the DB sync", async () => {
    const siblingLifecycle = { readable: true, lifecycle: { repairCapable: true } };
    mockCompile.mockResolvedValue({ ok: true, value: compiledValue, siblingLifecycle });
    const result = await runCompile();
    expect(result.error).toBeUndefined();
    expect(mockSync).toHaveBeenCalledTimes(1);
    expect(mockSync.mock.calls[0][0]).toBe(PKG);
    expect(mockSync.mock.calls[0][3]).toEqual(siblingLifecycle);
  });

  it("a failed row read refuses the recompile before the compile runs", async () => {
    mockReadTemplate.mockRejectedValue(new Error("db down"));
    const result = await runCompile();
    expect(result.error).toBeDefined();
    expect(mockCompile).not.toHaveBeenCalled();
    expect(mockSync).not.toHaveBeenCalled();
  });

  it("no stored row: the compile gets no retained list", async () => {
    mockCompile.mockResolvedValue({ ok: true, value: compiledValue, siblingLifecycle: { readable: false } });
    await runCompile();
    expect((mockCompile.mock.calls[0][0] as { retainedRegenerate?: unknown }).retainedRegenerate).toBeUndefined();
    expect(mockSync.mock.calls[0][3]).toEqual({ readable: false });
  });
});

/**
 * Regression tests for the agent_source_compile / agent_source_publish
 * review_blocked gate.
 *
 * Locks the contract:
 *   - agent_source_compile + agent_source_publish run a deterministic review
 *     against the OAS before writing files / hitting Verdaccio.
 *   - If the review reports any blocker (e.g. literal sk-* credential), the
 *     handler returns { error, code: "review_blocked", blockers: ReviewFinding[] }
 *     WITHOUT throwing, WITHOUT writing files, and WITHOUT calling
 *     publishAgentPackageFromGitDir.
 *   - When blockers are absent, compile succeeds (proves the gate uses a strict
 *     predicate, not a flaky heuristic).
 *   - The gate decision is idempotent across calls.
 *
 * Invocation surface: createAgentsPrimitiveHandlers() factory only — the
 * handleAgentBuilderGitCompileAndWrite / handleAgentBuilderGitPublish
 * functions are private to handlers.ts.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/agent-source-compile-gate.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// vi.hoisted refs — capture the Verdaccio publisher mock so we can count calls.
// ---------------------------------------------------------------------------

const { mockPublishAgentPackageFromGitDir, mockPublishAgentPackage } = vi.hoisted(() => ({
  mockPublishAgentPackageFromGitDir: vi.fn(async () => ({ published: true })),
  mockPublishAgentPackage: vi.fn(async () => ({ published: true })),
}));

vi.mock("../verdaccio/client", () => ({
  deleteAgentPackageVersion: vi.fn(),
  deprecateAgentPackageVersion: vi.fn(),
  publishAgentPackage: mockPublishAgentPackage,
  publishAgentPackageFromGitDir: mockPublishAgentPackageFromGitDir,
}));

// ---------------------------------------------------------------------------
// Mock the rest of the transitive chain (same surface as the handler test).
// ---------------------------------------------------------------------------
vi.mock("@cinatra-ai/skills", () => ({
  upsertSkill: vi.fn(),
  parseFrontmatter: vi.fn(),
  readLocalPackageSkillContent: vi.fn(),
}));
vi.mock("@cinatra-ai/registries", () => ({ listAgentPackages: vi.fn() }));
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
  ANTHROPIC_API_LOG_DIRECTORY: "/tmp",
  setAnthropicLoggingEnabled: () => {},
}));
vi.mock("../compiler", () => ({ compileWorkflow: vi.fn() }));
vi.mock("../wayflow-url", () => ({ resolveWayflowUrl: vi.fn() }));
vi.mock("../verdaccio/publish-metadata", () => ({
  derivePublishMetadataFromSnapshot: vi.fn(),
}));
vi.mock("../install-from-package", () => ({ installAgentFromPackage: vi.fn() }));
vi.mock("../review-task-actions", () => ({
  approveReviewTaskInternal: vi.fn(),
}));
vi.mock("../trigger-service", () => ({
  setRunTriggerForActor: vi.fn(),
  getRunTriggerForActor: vi.fn(),
  deleteRunTriggerForActor: vi.fn(),
}));
// Make resolveAgentInstallDir return process.cwd() so the handler's
// rung-1 path is <tmpRoot>/cinatra/<slug>/cinatra/oas.json — which is where
// our test fixture writes its file (handler at handlers.ts:1911 joins with
// "cinatra" twice, matching our writeOasFixture path).
vi.mock("../agent-install-path", () => ({
  resolveAgentInstallDir: vi.fn(() => process.cwd()),
}));
vi.mock("../zip-helpers", () => ({ createZipBuffer: vi.fn() }));
vi.mock("../oas-compiler", () => ({
  compileOasAgentJson: vi.fn((parsed: unknown) => parsed),
}));
vi.mock("@/lib/background-jobs", () => ({
  enqueueBackgroundJob: vi.fn(async () => undefined),
  BACKGROUND_JOB_NAMES: { AGENT_BUILDER_EXECUTION: "agent_builder_execution" },
}));
vi.mock("@/lib/primitive-handlers", () => ({
  collectAllPrimitiveHandlers: vi.fn(() => ({})),
}));
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
}));
vi.mock("@cinatra-ai/mcp-client", () => ({
  invokePrimitive: vi.fn(),
  createInProcessPrimitiveTransport: vi.fn(),
  PrimitiveInvocationError: class extends Error {},
}));

// ---------------------------------------------------------------------------
// Module under test
//
// Note: the plan named `createAgentsPrimitiveHandlers()` as the invocation
// surface, but the agent_source_compile / agent_source_publish dispatchers
// actually live on `createAgentBuilderPrimitiveHandlers()` (handlers.ts:2781);
// `createAgentsPrimitiveHandlers()` only exposes `agents_list`. Both are
// public exports — the contract requirement ("factory, not private import")
// is satisfied either way. We use the factory that actually contains the
// handlers being tested.
// ---------------------------------------------------------------------------
import { createAgentBuilderPrimitiveHandlers } from "../mcp/handlers";

// ---------------------------------------------------------------------------
// Fixtures: write a temp `agents/<slug>/cinatra/oas.json` to a tmp dir, then
// chdir there so the handler's resolveAgentRootDirForRead picks it up.
// ---------------------------------------------------------------------------

const TEST_SLUG = "compile-gate-test-agent";
let tmpRoot: string;
let originalCwd: string;

async function writeOasFixture(slug: string, oas: Record<string, unknown>): Promise<void> {
  // The handler's resolveAgentJsonPathForRead joins:
  //   resolveAgentInstallDir() + "cinatra" + <slug> + "cinatra" + "oas.json"
  // We mock resolveAgentInstallDir to process.cwd(), so the rung-1 path is
  // tmpRoot/cinatra/<slug>/cinatra/oas.json.
  const dir = path.join(tmpRoot, "cinatra-ai", slug, "cinatra");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "oas.json"), JSON.stringify(oas, null, 2), "utf-8");
  // Also write a minimal package.json so the publish handler can read name/version.
  await fs.writeFile(
    path.join(path.dirname(dir), "package.json"),
    JSON.stringify(
      {
        name: `@cinatra/${slug}`,
        version: "0.1.0",
        private: false,
        publishConfig: { registry: "http://127.0.0.1:4873" },
      },
      null,
      2,
    ),
    "utf-8",
  );
}

function buildOasWithLiteralSecret(): Record<string, unknown> {
  return {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id: "gate-test-flow",
    name: "Gate Test",
    description: "Has a literal credential",
    metadata: { cinatra: { type: "node", packageName: `@cinatra/${TEST_SLUG}` } },
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
        body: {
          Authorization: "Bearer sk-1234567890abcdef1234567890abcdef",
        },
      },
    },
  };
}

function buildCleanOas(): Record<string, unknown> {
  return {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id: "gate-test-flow",
    name: "Gate Test",
    description: "Clean fixture",
    metadata: { cinatra: { type: "node", packageName: `@cinatra/${TEST_SLUG}` } },
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
}

function buildRequest(primitiveName: string) {
  return {
    primitiveName,
    input: { packageSlug: TEST_SLUG },
    actor: {
      actorType: "user",
      source: "ui",
      userId: "u-admin",
      // The handler checks `platformRole === "platform_admin"` (not "admin").
      platformRole: "platform_admin",
    },
    mode: "deterministic",
  };
}

function getCompileHandler(): (req: unknown) => Promise<unknown> {
  const handlers = createAgentBuilderPrimitiveHandlers();
  return handlers["agent_source_compile"];
}

function getPublishHandler(): (req: unknown) => Promise<unknown> {
  const handlers = createAgentBuilderPrimitiveHandlers();
  return handlers["agent_source_publish"];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("agent_source_compile / agent_source_publish — review_blocked gate", () => {
  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "compile-gate-"));
    originalCwd = process.cwd();
    process.chdir(tmpRoot);
    mockPublishAgentPackageFromGitDir.mockClear();
    mockPublishAgentPackage.mockClear();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    try {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("Test 1: agent_source_compile with literal sk- → { error, code: 'review_blocked', blockers }", async () => {
    await writeOasFixture(TEST_SLUG, buildOasWithLiteralSecret());
    const handler = getCompileHandler();
    const result = (await handler(buildRequest("agent_source_compile"))) as {
      error?: string;
      code?: string;
      blockers?: unknown[];
    };
    expect(result.code).toBe("review_blocked");
    expect(result.error).toEqual(expect.any(String));
    expect(Array.isArray(result.blockers)).toBe(true);
    expect(result.blockers!.length).toBeGreaterThan(0);
  });

  it("Test 2: agent_source_publish with literal sk- → review_blocked BEFORE Verdaccio call", async () => {
    await writeOasFixture(TEST_SLUG, buildOasWithLiteralSecret());
    const handler = getPublishHandler();
    const result = (await handler(buildRequest("agent_source_publish"))) as {
      error?: string;
      code?: string;
      blockers?: unknown[];
    };
    expect(result.code).toBe("review_blocked");
    expect(Array.isArray(result.blockers)).toBe(true);
    expect(result.blockers!.length).toBeGreaterThan(0);
    expect(mockPublishAgentPackageFromGitDir).not.toHaveBeenCalled();
    expect(mockPublishAgentPackage).not.toHaveBeenCalled();
  });

  it("Test 3: agent_source_compile with clean OAS → succeeds (no review_blocked code)", async () => {
    await writeOasFixture(TEST_SLUG, buildCleanOas());
    const handler = getCompileHandler();
    const result = (await handler(buildRequest("agent_source_compile"))) as {
      error?: string;
      code?: string;
    };
    expect(result.code).not.toBe("review_blocked");
  });

  it("Test 4: gate decision is idempotent — two consecutive compile calls produce byte-identical blockers", async () => {
    await writeOasFixture(TEST_SLUG, buildOasWithLiteralSecret());
    const handler = getCompileHandler();
    const r1 = (await handler(buildRequest("agent_source_compile"))) as { blockers?: unknown[] };
    const r2 = (await handler(buildRequest("agent_source_compile"))) as { blockers?: unknown[] };
    expect(JSON.stringify(r1.blockers)).toEqual(JSON.stringify(r2.blockers));
  });

  it("Test 5 (no exception path): gate failure NEVER throws — returns structured data only", async () => {
    await writeOasFixture(TEST_SLUG, buildOasWithLiteralSecret());
    const handler = getCompileHandler();
    // If the handler threw, this expression would throw too; the contract is
    // that it returns a structured rejection without throwing.
    await expect(handler(buildRequest("agent_source_compile"))).resolves.toBeDefined();
  });

  // ─────────────────────────────────────────────────────────────────────
  // Dirty-disk integration tests.
  //
  // These exercise the compile/publish gates against credentials present in
  // SIBLING files (SKILL.md, package.json, .env) — files that bypass
  // agent_source_write's inline scan because they land on disk via fs.writeFile
  // here, not via MCP. Even with the OAS body clean, sibling-file credentials
  // must block.
  // ─────────────────────────────────────────────────────────────────────

  async function writeSiblingFile(slug: string, relPath: string, content: string): Promise<void> {
    const dir = path.join(tmpRoot, "cinatra-ai", slug, path.dirname(relPath));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(tmpRoot, "cinatra-ai", slug, relPath), content, "utf-8");
  }

  it("Test 6 (dirty-disk SKILL.md credential): compile → review_blocked (sibling-file scan)", async () => {
    await writeOasFixture(TEST_SLUG, buildCleanOas());
    await writeSiblingFile(TEST_SLUG, `skills/${TEST_SLUG}/SKILL.md`, "Use sk-test1234567890abcdef1234567890ABCDEF12 as your API key");
    const handler = getCompileHandler();
    const result = (await handler(buildRequest("agent_source_compile"))) as {
      error?: string;
      code?: string;
      blockers?: Array<{ code: string; location?: string }>;
    };
    expect(result.code).toBe("review_blocked");
    expect(result.blockers).toBeDefined();
    expect(result.blockers!.some((b) => b.code === "literal_credential_in_sibling_file")).toBe(true);
    expect(result.blockers!.some((b) => b.location?.includes("SKILL.md"))).toBe(true);
  });

  it("Test 7 (dirty-disk SKILL.md credential): publish → review_blocked BEFORE Verdaccio", async () => {
    await writeOasFixture(TEST_SLUG, buildCleanOas());
    await writeSiblingFile(TEST_SLUG, `skills/${TEST_SLUG}/SKILL.md`, "Bearer sk-test1234567890abcdef1234567890ABCDEF12");
    const handler = getPublishHandler();
    const result = (await handler(buildRequest("agent_source_publish"))) as {
      code?: string;
      blockers?: Array<{ code: string }>;
    };
    expect(result.code).toBe("review_blocked");
    expect(result.blockers!.some((b) => b.code === "literal_credential_in_sibling_file")).toBe(true);
    expect(mockPublishAgentPackageFromGitDir).not.toHaveBeenCalled();
  });

  it("Test 8 (dirty-disk .env present): publish → review_blocked (forbidden env file)", async () => {
    await writeOasFixture(TEST_SLUG, buildCleanOas());
    await writeSiblingFile(TEST_SLUG, ".env", "FOO=bar");
    const handler = getPublishHandler();
    const result = (await handler(buildRequest("agent_source_publish"))) as {
      code?: string;
      blockers?: Array<{ code: string; location?: string }>;
    };
    expect(result.code).toBe("review_blocked");
    expect(result.blockers!.some((b) => b.code === "package_env_file_forbidden")).toBe(true);
    expect(mockPublishAgentPackageFromGitDir).not.toHaveBeenCalled();
  });

  it("Test 9 (dirty-disk all clean): publish proceeds past sibling gate", async () => {
    await writeOasFixture(TEST_SLUG, buildCleanOas());
    await writeSiblingFile(TEST_SLUG, `skills/${TEST_SLUG}/SKILL.md`, "A clean skill with no credentials.");
    await writeSiblingFile(TEST_SLUG, "README.md", "# Clean package");
    const handler = getPublishHandler();
    const result = (await handler(buildRequest("agent_source_publish"))) as {
      code?: string;
    };
    // The gate doesn't fire. Downstream may still fail (license/registry/etc.),
    // but the failure mode should NOT be `review_blocked`.
    expect(result.code).not.toBe("review_blocked");
  });
});

/**
 * agent_export -> agent_import round-trip contract (issue #130).
 *
 * Locks the live MCP export/import surface:
 *   - Canonical-path export: the ZIP carries agent.json (the on-disk OAS Flow,
 *     byte-for-byte), manifest.json {version:1}, and the package's REAL
 *     on-disk sidecars (package.json + LICENSE) — exactly the files
 *     importAgentTemplateCore stages for the SPDX license gate and the
 *     upsert-by-packageName path. Without the sidecars the importer's
 *     detectSpdxLicense returns reject/"missing" and every archive is dead on
 *     arrival.
 *   - Round trip: the exported ZIP imports cleanly through the real
 *     agent_import handler (real oas-compiler, real zip-helpers, real
 *     license-detection): first import CREATES a template with
 *     compiler-derived columns (taskSpec from Agent.system_prompt,
 *     inputSchema from StartNode inputs, packageName/packageVersion from
 *     package.json); a second import UPSERTS the same template.
 *   - Fail-explicit fallback: templates without a canonical on-disk OAS
 *     source (no packageName / package missing on disk / unreadable file)
 *     get an explicit { error } — never a ZIP. The old DB-derived shell
 *     (empty nodes / $referenced_components) was silently non-importable.
 *   - Schema doc gate: the agent_export description names agent.json (the
 *     entry the importer requires), not oas.json (doc drift from #130).
 *
 * Hermetic: tmp-dir install root; store and host-app seams mocked; the
 * compile/zip/license modules under contract are real.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/agent-export-import-roundtrip.test.ts
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Hoisted state shared between vi.mock factories and the tests.
// ---------------------------------------------------------------------------

const state = vi.hoisted(() => ({
  installDir: "",
  templatesById: new Map<string, Record<string, unknown>>(),
  templatesByPackageName: new Map<string, Record<string, unknown>>(),
  createCalls: [] as Array<Record<string, unknown>>,
  updateCalls: [] as Array<{ id: string; patch: Record<string, unknown> }>,
  versionCalls: [] as Array<Record<string, unknown>>,
}));

// ---------------------------------------------------------------------------
// Controlled seams. The store is an in-memory map; the install dir points at
// a per-test tmp root. Everything the round trip actually exercises
// (oas-compiler, zip-helpers, license-detection, import-agent-core,
// import-export-actions) stays REAL.
// ---------------------------------------------------------------------------

vi.mock("../agent-install-path", () => ({
  resolveAgentInstallDir: () => state.installDir,
  readAgentInstallPath: () => state.installDir,
  writeAgentInstallPath: () => {},
}));

vi.mock("../store", () => ({
  readAgentTemplateById: vi.fn(async (id: string) => state.templatesById.get(id) ?? null),
  readAgentTemplateByPackageName: vi.fn(
    async (name: string) => state.templatesByPackageName.get(name) ?? null,
  ),
  createAgentTemplate: vi.fn(async (input: Record<string, unknown>) => {
    state.createCalls.push(input);
    const row = { ...input };
    state.templatesById.set(input.id as string, row);
    if (typeof input.packageName === "string") {
      state.templatesByPackageName.set(input.packageName, row);
    }
    return row;
  }),
  updateAgentTemplate: vi.fn(async (id: string, patch: Record<string, unknown>) => {
    state.updateCalls.push({ id, patch });
    const row = state.templatesById.get(id);
    if (row) Object.assign(row, patch);
    return row ?? null;
  }),
  createAgentVersion: vi.fn(async (version: Record<string, unknown>) => {
    state.versionCalls.push(version);
    return version;
  }),
  updateAgentTemplateOrigin: vi.fn(async () => undefined),
  resolveDefaultOrgId: vi.fn(async () => "org-1"),
}));

// Auth seams: handlers.ts (session reads) + import-export-actions
// (requireAdminSession before importAgentTemplateCore).
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: vi.fn(async () => null),
  isPlatformAdmin: vi.fn(() => false),
  requireAuthSession: vi.fn(),
  requireAdminSession: vi.fn(async () => ({ user: { id: "admin-1" } })),
}));

// Post-import permission seeding (dynamically imported, best-effort).
vi.mock("@cinatra-ai/extensions/permissions-actions", () => ({
  setExtensionInstaller: vi.fn(async () => ({ ok: true })),
  saveExtensionAccessPolicy: vi.fn(async () => ({ ok: true })),
  addExtensionCoOwner: vi.fn(async () => ({ ok: true })),
}));

// import-agent-core module-level imports that the no-destination path never
// calls but which must be loadable without a host app.
vi.mock("@cinatra-ai/extensions/destination-resolver", () => ({
  resolvePublishDestination: vi.fn(async () => ({ registryUrl: "http://unused" })),
}));
vi.mock("@/lib/instance-identity-store", () => ({
  readInstanceIdentity: () => null,
}));
vi.mock("@cinatra-ai/objects/auto-registrar", () => ({
  ensureDynamicObjectType: vi.fn(async () => undefined),
}));
vi.mock("@cinatra-ai/objects/registry", () => ({
  objectTypeRegistry: { resolve: () => null },
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Heavy transitive dependencies of mcp/handlers.ts that this test never
// exercises — they only need to be loadable. Mirrors
// agent-source-review-handler.test.ts.
// ---------------------------------------------------------------------------

vi.mock("@cinatra-ai/mcp-client", () => ({
  invokePrimitive: vi.fn(),
  createInProcessPrimitiveTransport: vi.fn(() => ({ invoke: vi.fn() })),
  PrimitiveInvocationError: class PrimitiveInvocationError extends Error {},
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
vi.mock("@cinatra-ai/skills", () => ({
  upsertSkill: vi.fn(),
  parseFrontmatter: vi.fn(),
  readLocalPackageSkillContent: vi.fn(),
}));
vi.mock("@cinatra-ai/registries", () => ({ listAgentPackages: vi.fn() }));
vi.mock("@cinatra-ai/objects", () => ({
  createDeterministicObjectsClient: vi.fn(() => ({})),
}));
vi.mock("../compiler", () => ({ compileWorkflow: vi.fn() }));
vi.mock("../wayflow-url", () => ({
  resolveWayflowUrl: vi.fn(),
  createWayflowFetch: vi.fn(),
  AGENT_RUN_TIMEOUT_MAX_SECONDS: 86_400,
  WAYFLOW_A2A_TIMEOUT_MS: 60_000,
}));
vi.mock("../verdaccio/client", () => ({
  deleteAgentPackageVersion: vi.fn(),
  deprecateAgentPackageVersion: vi.fn(),
  publishAgentPackage: vi.fn(),
  publishAgentPackageFromGitDir: vi.fn(),
}));
vi.mock("../verdaccio/publish-metadata", () => ({
  derivePublishMetadataFromSnapshot: vi.fn(),
}));
vi.mock("../install-from-package", () => ({ installAgentFromPackage: vi.fn() }));
vi.mock("../review-task-actions", () => ({ approveReviewTaskInternal: vi.fn() }));
vi.mock("../trigger-service", () => ({
  setRunTriggerForActor: vi.fn(),
  getRunTriggerForActor: vi.fn(),
  deleteRunTriggerForActor: vi.fn(),
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

// ---------------------------------------------------------------------------
// Modules under test — imported AFTER the vi.mock declarations.
// ---------------------------------------------------------------------------

import { createAgentBuilderPrimitiveHandlers } from "../mcp/handlers";
import { AGENT_BUILDER_TOOL_META } from "../mcp/schemas";
import { readZipFiles } from "../zip-helpers";
import { __resetRegistryCacheForTests } from "../oas-compiler";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PACKAGE_NAME = "@cinatra-test/roundtrip-agent";
const PACKAGE_SLUG = "roundtrip-agent";
const SYSTEM_PROMPT = "You are the round-trip test agent.";

/** Minimal VALID OAS Flow: Start -> AgentNode (Agent w/ system_prompt) -> End. */
function buildOasFlow(): Record<string, unknown> {
  return {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id: "roundtrip-flow",
    name: "Roundtrip Agent",
    metadata: { cinatra: { type: "leaf" } },
    inputs: [{ title: "topic", type: "string" }],
    outputs: [],
    start_node: { $component_ref: "startNode" },
    nodes: [
      { $component_ref: "startNode" },
      { $component_ref: "agentStep" },
      { $component_ref: "endNode" },
    ],
    control_flow_connections: [
      {
        component_type: "ControlFlowEdge",
        name: "start-to-agent",
        from_node: { $component_ref: "startNode" },
        to_node: { $component_ref: "agentStep" },
      },
      {
        component_type: "ControlFlowEdge",
        name: "agent-to-end",
        from_node: { $component_ref: "agentStep" },
        to_node: { $component_ref: "endNode" },
      },
    ],
    $referenced_components: {
      startNode: {
        component_type: "StartNode",
        id: "startNode",
        name: "Start",
        inputs: [{ title: "topic", type: "string" }],
        metadata: { cinatra: { required: ["topic"] } },
      },
      agentStep: {
        component_type: "AgentNode",
        id: "agentStep",
        name: "Agent Step",
        agent: { $component_ref: "coreAgent" },
      },
      coreAgent: {
        component_type: "Agent",
        id: "coreAgent",
        name: "Core Agent",
        system_prompt: SYSTEM_PROMPT,
      },
      endNode: {
        component_type: "EndNode",
        id: "endNode",
        name: "End",
        outputs: [{ title: "result", type: "string" }],
      },
    },
  };
}

/** Stage the canonical on-disk source package under the tmp install root. */
function stageCanonicalPackage(): void {
  const rootDir = path.join(state.installDir, "cinatra-ai", PACKAGE_SLUG);
  mkdirSync(path.join(rootDir, "cinatra"), { recursive: true });
  writeFileSync(
    path.join(rootDir, "cinatra", "oas.json"),
    JSON.stringify(buildOasFlow(), null, 2),
  );
  writeFileSync(
    path.join(rootDir, "package.json"),
    JSON.stringify(
      { name: PACKAGE_NAME, version: "1.2.3", license: "MIT" },
      null,
      2,
    ),
  );
  writeFileSync(path.join(rootDir, "LICENSE"), "MIT License\n");
}

function seedTemplate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const row = {
    id: "tpl-1",
    name: "Roundtrip Agent",
    description: "round-trip fixture",
    sourceNl: "",
    status: "published",
    type: "leaf",
    hitlScreens: [],
    compiledPlan: [],
    inputSchema: { type: "object", properties: {} },
    packageName: PACKAGE_NAME,
    ...overrides,
  };
  state.templatesById.set(row.id as string, row);
  if (typeof row.packageName === "string") {
    state.templatesByPackageName.set(row.packageName, row);
  }
  return row;
}

function buildRequest(primitiveName: string, input: Record<string, unknown>) {
  return {
    primitiveName,
    input,
    actor: { actorType: "user", source: "ui", userId: "u-test" },
    mode: "default",
  };
}

const handlers = createAgentBuilderPrimitiveHandlers();

async function runExport(templateId: string): Promise<Record<string, unknown>> {
  return (await handlers["agent_export"](
    buildRequest("agent_export", { templateId }),
  )) as Record<string, unknown>;
}

async function runImport(zipBase64: string): Promise<Record<string, unknown>> {
  return (await handlers["agent_import"](
    buildRequest("agent_import", { zipBase64 }),
  )) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  __resetRegistryCacheForTests();
  state.installDir = mkdtempSync(path.join(tmpdir(), "agent-export-roundtrip-"));
  state.templatesById.clear();
  state.templatesByPackageName.clear();
  state.createCalls.length = 0;
  state.updateCalls.length = 0;
  state.versionCalls.length = 0;
});

afterEach(() => {
  rmSync(state.installDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("agent_export canonical path", () => {
  it("ships agent.json byte-for-byte plus manifest + real on-disk sidecars", async () => {
    stageCanonicalPackage();
    seedTemplate();

    const result = await runExport("tpl-1");
    expect(result.error).toBeUndefined();
    expect(typeof result.zipBase64).toBe("string");
    expect(result.fileName).toMatch(/^roundtrip-agent-\d{8}\.zip$/);

    const files = readZipFiles(Buffer.from(result.zipBase64 as string, "base64"));
    expect([...files.keys()].sort()).toEqual([
      "LICENSE",
      "agent.json",
      "manifest.json",
      "package.json",
    ]);
    // agent.json is the canonical on-disk document, not a DB-derived shell.
    expect(JSON.parse(files.get("agent.json")!)).toEqual(buildOasFlow());
    expect(JSON.parse(files.get("manifest.json")!)).toMatchObject({ version: 1 });
    expect(JSON.parse(files.get("package.json")!)).toEqual({
      name: PACKAGE_NAME,
      version: "1.2.3",
      license: "MIT",
    });
  });
});

describe("agent_export -> agent_import round trip", () => {
  it("first import CREATES a template with compiler-derived columns", async () => {
    stageCanonicalPackage();
    seedTemplate();

    const exported = await runExport("tpl-1");
    expect(exported.error).toBeUndefined();

    // Restore on a "fresh instance": no template rows known.
    state.templatesById.clear();
    state.templatesByPackageName.clear();

    const imported = await runImport(exported.zipBase64 as string);
    expect(imported.error).toBeUndefined();
    expect(imported.upserted).toBe(false);
    expect(typeof imported.templateId).toBe("string");

    expect(state.createCalls).toHaveLength(1);
    const created = state.createCalls[0];
    expect(created.packageName).toBe(PACKAGE_NAME);
    expect(created.packageVersion).toBe("1.2.3");
    expect(created.type).toBe("leaf");
    // taskSpec is DERIVED from Agent.system_prompt by the real compiler.
    expect(created.taskSpec).toBe(SYSTEM_PROMPT);
    // inputSchema is DERIVED from the StartNode inputs.
    const inputSchema = created.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(inputSchema.properties ?? {})).toContain("topic");
    expect(state.versionCalls).toHaveLength(1);
  });

  it("second import UPSERTS the existing template by packageName", async () => {
    stageCanonicalPackage();
    seedTemplate();

    const exported = await runExport("tpl-1");
    expect(exported.error).toBeUndefined();

    state.templatesById.clear();
    state.templatesByPackageName.clear();

    const first = await runImport(exported.zipBase64 as string);
    expect(first.upserted).toBe(false);

    const second = await runImport(exported.zipBase64 as string);
    expect(second.error).toBeUndefined();
    expect(second.upserted).toBe(true);
    expect(second.templateId).toBe(first.templateId);
    // Create ran once; the second pass went through updateAgentTemplate.
    expect(state.createCalls).toHaveLength(1);
    expect(state.updateCalls).toHaveLength(1);
    expect(state.updateCalls[0].id).toBe(first.templateId);
  });
});

describe("agent_export fail-explicit fallback (no DB-derived shell)", () => {
  it("returns an explicit error for templates without a packageName", async () => {
    seedTemplate({ packageName: null });

    const result = await runExport("tpl-1");
    expect(result.zipBase64).toBeUndefined();
    expect(result.error).toMatch(/Export unavailable/);
    expect(result.error).toMatch(/has no packageName/);
    // Actionable: points at the source-authoring pipeline.
    expect(result.error).toMatch(/agent_source_write/);
  });

  it("returns an explicit error when the source package is missing on disk", async () => {
    seedTemplate(); // packageName set, but nothing staged under installDir

    const result = await runExport("tpl-1");
    expect(result.zipBase64).toBeUndefined();
    expect(result.error).toMatch(/Export unavailable/);
    expect(result.error).toMatch(/no on-disk OAS definition found/);
  });

  it("returns an explicit error when the canonical file exists but cannot be read", async () => {
    seedTemplate();
    // Stage oas.json as a DIRECTORY: path resolution succeeds, readFile fails.
    mkdirSync(
      path.join(state.installDir, "cinatra-ai", PACKAGE_SLUG, "cinatra", "oas.json"),
      { recursive: true },
    );

    const result = await runExport("tpl-1");
    expect(result.zipBase64).toBeUndefined();
    expect(result.error).toMatch(/Export unavailable/);
    expect(result.error).toMatch(/could not be read/);
    // Sanitized reason: errno code only — the raw Node fs message (which
    // embeds the absolute host path) must not leak into the MCP error.
    expect(result.error).toContain("(EISDIR)");
    expect(result.error).not.toContain(state.installDir);
  });
});

describe("schema doc drift (#130)", () => {
  it("agent_export description names agent.json (the entry agent_import requires), not oas.json", () => {
    const desc = AGENT_BUILDER_TOOL_META["agent_export"].description;
    expect(desc).toContain("agent.json");
    expect(desc).not.toContain("oas.json");
  });

  it("agent_import description documents upsert-by-packageName", () => {
    const desc = AGENT_BUILDER_TOOL_META["agent_import"].description;
    expect(desc).toMatch(/upsert/i);
  });
});

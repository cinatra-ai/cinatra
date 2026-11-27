/**
 * cinatra#4920 (direct readers): a by-slug read of an agent definition takes
 * `cinatra/oas.json` only. A directory with only `agent.json` or only
 * `cinatra/agent.json` fails with one plain error naming the directory, the
 * file found and the path the definition must be at; with both files,
 * `cinatra/oas.json` is read and the old file is ignored.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/agent-source-by-slug-oas-only-4920.test.ts
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
  ANTHROPIC_API_LOG_DIRECTORY: "/tmp",
  setAnthropicLoggingEnabled: () => {},
}));
vi.mock("../compiler", () => ({ compileWorkflow: vi.fn() }));
vi.mock("../wayflow-url", () => ({
  resolveWayflowUrl: vi.fn(),
  WAYFLOW_UNDICI_TIMEOUT_MS: 60_000,
}));
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
// Make resolveDevExtensionSourceRoot return process.cwd() so the handler's
// rung-1 path is <tmpRoot>/cinatra/<slug>/cinatra/oas.json — which is where
// our test fixture writes its file (handler at handlers.ts:1911 joins with
// "cinatra" twice, matching our writeOasFixture path).
vi.mock("../agent-runtime-mount", () => ({
  resolveAgentRuntimeMountDir: vi.fn(() => process.cwd()),
  resolveDevExtensionSourceRoot: vi.fn(() => process.cwd()),
}));
vi.mock("../zip-helpers", () => ({ createZipBuffer: vi.fn() }));
vi.mock("../oas-compiler", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../oas-compiler")>()),
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

const SLUG = "by-slug-oas-only-agent";
const OLD_VENDOR_FILE = `cinatra-ai/${SLUG}/cinatra/agent.json`;
const REQUIRED = `cinatra-ai/${SLUG}/cinatra/oas.json`;
// The two old layouts the by-slug readers used to fall back to.
const OLD_LAYOUTS: Array<{ name: string; file: string; shown: string; dir: string }> = [
  { name: "cinatra/agent.json beside the vendor directory", file: OLD_VENDOR_FILE, shown: OLD_VENDOR_FILE, dir: `cinatra-ai/${SLUG}` },
  { name: "cinatra/agent.json in the legacy directory", file: `${SLUG}/cinatra/agent.json`, shown: `${SLUG}/cinatra/agent.json`, dir: SLUG },
  { name: "a flat agent.json in the legacy directory", file: `${SLUG}/agent.json`, shown: `${SLUG}/agent.json`, dir: SLUG },
];

function oldLayoutMessage(layout: { shown: string; dir: string }): string {
  return (
    `Agent definition is in the old layout: found ${layout.shown} in ${layout.dir}, which is no longer read. ` +
    `The definition must be at ${REQUIRED}; move it there.`
  );
}

let tmpRoot: string;
let originalCwd: string;

async function put(rel: string, content: string): Promise<void> {
  const full = path.join(tmpRoot, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, "utf-8");
}

const OAS = JSON.stringify({
  agentspec_version: "26.1.0",
  component_type: "Flow",
  id: "oas-only-flow",
  name: "Oas Only",
  description: "read from cinatra/oas.json",
  metadata: { cinatra: { type: "node", packageName: `@example-org/${SLUG}` } },
  nodes: [{ $component_ref: "start" }, { $component_ref: "end" }],
  start_node: { $component_ref: "start" },
  control_flow_connections: [],
  $referenced_components: {
    start: { component_type: "StartNode", id: "start" },
    end: { component_type: "EndNode", id: "end" },
  },
});
const OLD_ONLY = JSON.stringify({ name: "OLD FILE MUST NOT BE READ" });

function run(name: string, input: Record<string, unknown> = { packageSlug: SLUG }): Promise<any> {
  const handler = createAgentBuilderPrimitiveHandlers()[name];
  return handler({
    primitiveName: name,
    input,
    actor: { actorType: "user", source: "ui", userId: "u-admin", platformRole: "platform_admin" },
    mode: "deterministic",
  }) as Promise<any>;
}

// Each handler's own way of carrying the error text.
const HANDLERS: Array<{ name: string; texts: (r: any) => string[] }> = [
  { name: "agent_source_read", texts: (r) => [r.error] },
  { name: "agent_source_validate", texts: (r) => r.errors },
  { name: "agent_source_review", texts: (r) => (r.blockers ?? []).map((b: { message: string }) => b.message) },
  { name: "agent_source_compile", texts: (r) => [r.error] },
  { name: "agent_source_publish", texts: (r) => [r.error] },
];

describe("by-slug source handlers read cinatra/oas.json only (cinatra#4920)", () => {
  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "by-slug-oas-only-"));
    originalCwd = process.cwd();
    process.chdir(tmpRoot);
  });
  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  for (const h of HANDLERS) {
    describe(h.name, () => {
      for (const layout of OLD_LAYOUTS) {
        it(`refuses ${layout.name} with the old-layout message`, async () => {
          await put(layout.file, OLD_ONLY);
          const result = await run(h.name);
          expect(h.texts(result)).toContain(oldLayoutMessage(layout));
          expect(JSON.stringify(result)).not.toContain("OLD FILE MUST NOT BE READ");
        });
      }

      it("does not call the old file when cinatra/oas.json is there too", async () => {
        await put(`cinatra-ai/${SLUG}/cinatra/oas.json`, OAS);
        await put(OLD_VENDOR_FILE, OLD_ONLY);
        await put(`${SLUG}/agent.json`, OLD_ONLY);
        const result = await run(h.name);
        for (const text of h.texts(result).filter(Boolean)) expect(text).not.toMatch(/old layout/);
        expect(JSON.stringify(result)).not.toContain("OLD FILE MUST NOT BE READ");
      });
    });
  }

  it("agent_source_read returns the content of cinatra/oas.json when both files exist", async () => {
    await put(`cinatra-ai/${SLUG}/cinatra/oas.json`, OAS);
    await put(OLD_VENDOR_FILE, OLD_ONLY);
    const result = await run("agent_source_read");
    expect(result.error).toBeUndefined();
    expect(JSON.stringify(result)).toContain("read from cinatra/oas.json");
  });

  it("agent_source_list still lists a directory that has only the old file (left out of this piece)", async () => {
    await put(`${SLUG}/agent.json`, JSON.stringify({ name: "Old Layout Agent" }));
    const result = await run("agent_source_list", {});
    expect(result.items.map((i: { name: string }) => i.name)).toContain("Old Layout Agent");
  });
});

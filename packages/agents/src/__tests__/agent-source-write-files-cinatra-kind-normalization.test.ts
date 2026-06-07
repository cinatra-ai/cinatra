/**
 * Server-side `cinatra.kind` + `apiVersion` normalization in
 * `agent_source_write_files`.
 *
 * Bug: chat-created packages omit the `cinatra` block in package.json. The
 * marketplace's `?tab=agent` filter excludes packages whose registry manifest
 * has `cinatra.kind` undefined (kind derivation returns null, filter excludes
 * null cards). Fix: server-side normalize `cinatra.kind` to "agent" and
 * `cinatra.apiVersion` to "cinatra.ai/v1" before writing.
 *
 * Coercion policy: override any explicit wrong value (e.g. LLM emits
 * `cinatra.kind: "skill"`). This pipeline is agent-only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";

// The handler calls readInstanceIdentity() at the top of
// agent_source_write_files for package.json#name rescoping. Without this mock
// the module-load path pulls in `pg` and the test setup breaks. Match the
// `agent-source-write-files-name-rescoping.test.ts` mock pattern exactly.
const { mockReadInstanceIdentity } = vi.hoisted(() => ({
  mockReadInstanceIdentity: vi.fn(() => null as unknown),
}));

vi.mock("@/lib/instance-identity-store", () => ({
  readInstanceIdentity: mockReadInstanceIdentity,
  markFirstPublishedIfCurrentScope: vi.fn(),
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
vi.mock("../agent-install-path", () => ({
  resolveAgentInstallDir: vi.fn(() => process.cwd()),
}));
vi.mock("../zip-helpers", () => ({ createZipBuffer: vi.fn() }));
vi.mock("../oas-compiler", () => ({ compileOasAgentJson: vi.fn((p: unknown) => p) }));
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
  isPlatformAdmin: vi.fn(() => true),
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
vi.mock("../auth-policy", () => ({ enforceRunAccess: vi.fn(async () => undefined) }));
vi.mock("../store", () => ({ resolveDefaultOrgId: vi.fn(async () => "org-1") }));
vi.mock("@cinatra-ai/mcp-client", () => ({
  invokePrimitive: vi.fn(),
  createInProcessPrimitiveTransport: vi.fn(),
  PrimitiveInvocationError: class extends Error {},
}));

import { createAgentBuilderPrimitiveHandlers } from "../mcp/handlers";

const TEST_SLUG = "kind-normalization-test";
let tmpRoot: string;
let originalCwd: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "kind-normalization-"));
  originalCwd = process.cwd();
  process.chdir(tmpRoot);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

function buildRequest(input: { packageSlug: string; packageJson: string; skillMd: string }) {
  return {
    primitiveName: "agent_source_write_files",
    input,
    actor: {
      actorType: "user",
      source: "ui",
      userId: "u-admin",
      platformRole: "platform_admin",
    },
    mode: "deterministic",
  };
}

function getHandler(): (req: unknown) => Promise<unknown> {
  return createAgentBuilderPrimitiveHandlers()["agent_source_write_files"];
}

async function readWrittenPackageJson(slug: string): Promise<Record<string, unknown>> {
  const p = path.join(tmpRoot, "cinatra-ai", slug, "package.json");
  const raw = await fs.readFile(p, "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

describe("agent_source_write_files — cinatra block normalization", () => {
  it("inject: missing cinatra block → adds kind=agent + apiVersion=cinatra.ai/v1", async () => {
    const handler = getHandler();
    const result = (await handler(
      buildRequest({
        packageSlug: TEST_SLUG,
        packageJson: JSON.stringify({ name: `@cinatra/${TEST_SLUG}`, version: "0.1.0" }),
        skillMd: "---\nname: x\n---\nClean skill.",
      }),
    )) as { written?: boolean };
    expect(result.written).toBe(true);

    const written = await readWrittenPackageJson(TEST_SLUG);
    expect(written.cinatra).toEqual({ kind: "agent", apiVersion: "cinatra.ai/v1" });
  });

  it("preserve: cinatra.kind=agent + apiVersion=cinatra.ai/v1 already present → unchanged", async () => {
    const handler = getHandler();
    await handler(
      buildRequest({
        packageSlug: TEST_SLUG,
        packageJson: JSON.stringify({
          name: `@cinatra/${TEST_SLUG}`,
          version: "0.1.0",
          cinatra: { kind: "agent", apiVersion: "cinatra.ai/v1" },
        }),
        skillMd: "---\nname: x\n---\nClean skill.",
      }),
    );
    const written = await readWrittenPackageJson(TEST_SLUG);
    const cinatra = written.cinatra as Record<string, unknown>;
    expect(cinatra.kind).toBe("agent");
    expect(cinatra.apiVersion).toBe("cinatra.ai/v1");
  });

  it("coerce: cinatra.kind=skill (wrong) → overridden to agent", async () => {
    const handler = getHandler();
    await handler(
      buildRequest({
        packageSlug: TEST_SLUG,
        packageJson: JSON.stringify({
          name: `@cinatra/${TEST_SLUG}`,
          version: "0.1.0",
          cinatra: { kind: "skill" },
        }),
        skillMd: "---\nname: x\n---\nClean skill.",
      }),
    );
    const written = await readWrittenPackageJson(TEST_SLUG);
    const cinatra = written.cinatra as Record<string, unknown>;
    expect(cinatra.kind).toBe("agent");
  });

  it("coerce: cinatra.apiVersion=stale → overridden to cinatra.ai/v1", async () => {
    const handler = getHandler();
    await handler(
      buildRequest({
        packageSlug: TEST_SLUG,
        packageJson: JSON.stringify({
          name: `@cinatra/${TEST_SLUG}`,
          version: "0.1.0",
          cinatra: { kind: "agent", apiVersion: "cinatra.ai/v0" },
        }),
        skillMd: "---\nname: x\n---\nClean skill.",
      }),
    );
    const written = await readWrittenPackageJson(TEST_SLUG);
    const cinatra = written.cinatra as Record<string, unknown>;
    expect(cinatra.apiVersion).toBe("cinatra.ai/v1");
  });

  it("partial: cinatra exists but missing apiVersion → adds it; preserves other cinatra fields", async () => {
    const handler = getHandler();
    await handler(
      buildRequest({
        packageSlug: TEST_SLUG,
        packageJson: JSON.stringify({
          name: `@cinatra/${TEST_SLUG}`,
          version: "0.1.0",
          cinatra: { kind: "agent", agentDependencies: { "@cinatra/foo": "^0.1.0" } },
        }),
        skillMd: "---\nname: x\n---\nClean skill.",
      }),
    );
    const written = await readWrittenPackageJson(TEST_SLUG);
    const cinatra = written.cinatra as Record<string, unknown>;
    expect(cinatra.kind).toBe("agent");
    expect(cinatra.apiVersion).toBe("cinatra.ai/v1");
    expect(cinatra.agentDependencies).toEqual({ "@cinatra/foo": "^0.1.0" });
  });

  it("non-object cinatra (e.g. array or string) → replaced with normalized object", async () => {
    const handler = getHandler();
    await handler(
      buildRequest({
        packageSlug: TEST_SLUG,
        packageJson: JSON.stringify({
          name: `@cinatra/${TEST_SLUG}`,
          version: "0.1.0",
          cinatra: "agent", // malformed: a string, not an object
        }),
        skillMd: "---\nname: x\n---\nClean skill.",
      }),
    );
    const written = await readWrittenPackageJson(TEST_SLUG);
    expect(written.cinatra).toEqual({ kind: "agent", apiVersion: "cinatra.ai/v1" });
  });

  it("rejects non-object packageJson with a clear error", async () => {
    const handler = getHandler();
    const result = (await handler(
      buildRequest({
        packageSlug: TEST_SLUG,
        packageJson: JSON.stringify(["not", "an", "object"]),
        skillMd: "---\nname: x\n---\nClean.",
      }),
    )) as { error?: string };
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/packageJson must be a JSON object/);
  });

  it("rescopes package.json#name to canonical @cinatra-ai/<slug>; preserves all other top-level package.json fields", async () => {
    const handler = getHandler();
    await handler(
      buildRequest({
        packageSlug: TEST_SLUG,
        packageJson: JSON.stringify({
          name: `@cinatra/${TEST_SLUG}`,
          version: "0.1.0",
          description: "A test agent",
          private: false,
          publishConfig: { registry: "http://127.0.0.1:4873" },
        }),
        skillMd: "---\nname: x\n---\nClean.",
      }),
    );
    const written = await readWrittenPackageJson(TEST_SLUG);
    // `name` is intentionally rescoped to the canonical @cinatra-ai/<slug>
    // by the handler's normalizedPackageName logic (default vendorName =
    // "cinatra-ai" when readInstanceIdentity() is empty). All OTHER
    // top-level fields are preserved untouched.
    expect(written.name).toBe(`@cinatra-ai/${TEST_SLUG}`);
    expect(written.version).toBe("0.1.0");
    expect(written.description).toBe("A test agent");
    expect(written.private).toBe(false);
    expect(written.publishConfig).toEqual({ registry: "http://127.0.0.1:4873" });
    // Plus the normalized cinatra block
    expect(written.cinatra).toEqual({ kind: "agent", apiVersion: "cinatra.ai/v1" });
  });
});

/**
 * Server-side `package.json#name` rescoping in `agent_source_write_files`.
 *
 * Bug: chat-LLMs often emit `name: "@cinatra/<slug>"` even when the operator's
 * vendor namespace is different (e.g. "@acme"). That creates a mismatch
 * between the package's manifest scope and the operator's published scope
 * (see actions.ts:393-398 — origin scope is derived from instanceNamespace,
 * not from package.json#name). Fix: server-side coerce `name` to
 * `@<vendorName>/<packageSlug>` before writing.
 *
 * Coercion policy: the `packageSlug` argument is authoritative; the operator's
 * `vendorName` / `instanceNamespace` is authoritative; the LLM-emitted name is
 * advisory and gets overwritten.
 * Fallback chain: `vendorName` → `instanceNamespace` → "cinatra".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";

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

import { createAgentBuilderPrimitiveHandlers } from "../mcp/handlers";

const TEST_SLUG = "name-rescope-test";
let tmpRoot: string;
let originalCwd: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "name-rescope-"));
  originalCwd = process.cwd();
  process.chdir(tmpRoot);
  mockReadInstanceIdentity.mockReset();
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

// The source tree is written under <installRoot>/<vendor>/<slug>/ (cinatra#537),
// where <vendor> is the same namespace the package.json#name is rescoped to —
// e.g. "acme" for an operator on @acme, "cinatra-ai" for the default instance.
// Every test that reads back a written package.json runs on the @acme operator,
// so the on-disk vendor segment is "acme".
async function readWrittenPackageJson(
  slug: string,
  vendor = "acme",
): Promise<Record<string, unknown>> {
  const p = path.join(tmpRoot, vendor, slug, "package.json");
  const raw = await fs.readFile(p, "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

describe("agent_source_write_files — package.json#name rescoping", () => {
  it("operator on @acme: '@cinatra/foo' coerced to '@acme/<packageSlug>'", async () => {
    mockReadInstanceIdentity.mockReturnValue({ instanceNamespace: "acme" });
    const handler = getHandler();
    const result = (await handler(
      buildRequest({
        packageSlug: TEST_SLUG,
        packageJson: JSON.stringify({ name: "@cinatra/foo", version: "0.1.0" }),
        skillMd: "---\nname: x\n---\nClean.",
      }),
    )) as { written?: boolean; nameNormalized?: { from: string; to: string } };

    expect(result.written).toBe(true);
    expect(result.nameNormalized).toEqual({ from: "@cinatra/foo", to: `@acme/${TEST_SLUG}` });
    const written = await readWrittenPackageJson(TEST_SLUG);
    expect(written.name).toBe(`@acme/${TEST_SLUG}`);
  });

  it("operator on @acme: already-correct '@acme/<packageSlug>' is preserved (no nameNormalized)", async () => {
    mockReadInstanceIdentity.mockReturnValue({ instanceNamespace: "acme" });
    const handler = getHandler();
    const result = (await handler(
      buildRequest({
        packageSlug: TEST_SLUG,
        packageJson: JSON.stringify({ name: `@acme/${TEST_SLUG}`, version: "0.1.0" }),
        skillMd: "---\nname: x\n---\nClean.",
      }),
    )) as { written?: boolean; nameNormalized?: unknown };

    expect(result.written).toBe(true);
    expect(result.nameNormalized).toBeUndefined();
    const written = await readWrittenPackageJson(TEST_SLUG);
    expect(written.name).toBe(`@acme/${TEST_SLUG}`);
  });

  it("operator on @acme: scope-correct but slug-mismatched ('@acme/wrong') coerced to '@acme/<packageSlug>'", async () => {
    mockReadInstanceIdentity.mockReturnValue({ instanceNamespace: "acme" });
    const handler = getHandler();
    const result = (await handler(
      buildRequest({
        packageSlug: TEST_SLUG,
        packageJson: JSON.stringify({ name: "@acme/wrong-slug", version: "0.1.0" }),
        skillMd: "---\nname: x\n---\nClean.",
      }),
    )) as { nameNormalized?: { from: string; to: string } };

    expect(result.nameNormalized).toEqual({ from: "@acme/wrong-slug", to: `@acme/${TEST_SLUG}` });
    const written = await readWrittenPackageJson(TEST_SLUG);
    expect(written.name).toBe(`@acme/${TEST_SLUG}`);
  });

  it("operator on @acme: unscoped name ('foo') coerced to '@acme/<packageSlug>'", async () => {
    mockReadInstanceIdentity.mockReturnValue({ instanceNamespace: "acme" });
    const handler = getHandler();
    const result = (await handler(
      buildRequest({
        packageSlug: TEST_SLUG,
        packageJson: JSON.stringify({ name: "foo", version: "0.1.0" }),
        skillMd: "---\nname: x\n---\nClean.",
      }),
    )) as { nameNormalized?: { from: string; to: string } };

    expect(result.nameNormalized).toEqual({ from: "foo", to: `@acme/${TEST_SLUG}` });
  });

  it("operator on @acme: missing name field coerced to '@acme/<packageSlug>'", async () => {
    mockReadInstanceIdentity.mockReturnValue({ instanceNamespace: "acme" });
    const handler = getHandler();
    const result = (await handler(
      buildRequest({
        packageSlug: TEST_SLUG,
        packageJson: JSON.stringify({ version: "0.1.0" }),
        skillMd: "---\nname: x\n---\nClean.",
      }),
    )) as { nameNormalized?: { from: string | null; to: string } };

    expect(result.nameNormalized).toEqual({ from: null, to: `@acme/${TEST_SLUG}` });
    const written = await readWrittenPackageJson(TEST_SLUG);
    expect(written.name).toBe(`@acme/${TEST_SLUG}`);
  });

  it("no identity in store → falls back to '@cinatra-ai/<packageSlug>' (handler-side normalization)", async () => {
    mockReadInstanceIdentity.mockReturnValue(null);
    const handler = getHandler();
    const result = (await handler(
      buildRequest({
        packageSlug: TEST_SLUG,
        packageJson: JSON.stringify({ name: "@something-else/foo", version: "0.1.0" }),
        skillMd: "---\nname: x\n---\nClean.",
      }),
    )) as { nameNormalized?: { from: string; to: string } };

    expect(result.nameNormalized?.to).toBe(`@cinatra-ai/${TEST_SLUG}`);
  });

  it("identity present but vendorName/instanceNamespace empty → falls back to 'cinatra-ai'", async () => {
    mockReadInstanceIdentity.mockReturnValue({ vendorName: undefined, instanceNamespace: undefined });
    const handler = getHandler();
    const result = (await handler(
      buildRequest({
        packageSlug: TEST_SLUG,
        packageJson: JSON.stringify({ name: "@x/foo", version: "0.1.0" }),
        skillMd: "---\nname: x\n---\nClean.",
      }),
    )) as { nameNormalized?: { from: string; to: string } };

    expect(result.nameNormalized?.to).toBe(`@cinatra-ai/${TEST_SLUG}`);
  });

  it("legacy vendorName (no instanceNamespace) is honored", async () => {
    mockReadInstanceIdentity.mockReturnValue({ vendorName: "legacy-vendor" });
    const handler = getHandler();
    const result = (await handler(
      buildRequest({
        packageSlug: TEST_SLUG,
        packageJson: JSON.stringify({ name: "@cinatra/foo", version: "0.1.0" }),
        skillMd: "---\nname: x\n---\nClean.",
      }),
    )) as { nameNormalized?: { from: string; to: string } };

    expect(result.nameNormalized?.to).toBe(`@legacy-vendor/${TEST_SLUG}`);
  });

  it("preserves other package.json fields (version, description, cinatra block)", async () => {
    mockReadInstanceIdentity.mockReturnValue({ instanceNamespace: "acme" });
    const handler = getHandler();
    await handler(
      buildRequest({
        packageSlug: TEST_SLUG,
        packageJson: JSON.stringify({
          name: "@cinatra/foo",
          version: "0.1.0",
          description: "A test agent",
          cinatra: { kind: "agent", apiVersion: "cinatra.ai/v1" },
        }),
        skillMd: "---\nname: x\n---\nClean.",
      }),
    );
    const written = await readWrittenPackageJson(TEST_SLUG);
    expect(written.name).toBe(`@acme/${TEST_SLUG}`);
    expect(written.version).toBe("0.1.0");
    expect(written.description).toBe("A test agent");
    expect(written.cinatra).toEqual({ kind: "agent", apiVersion: "cinatra.ai/v1" });
  });

  it("rejects non-object packageJson with a clear error", async () => {
    mockReadInstanceIdentity.mockReturnValue({ instanceNamespace: "acme" });
    const handler = getHandler();
    const result = (await handler(
      buildRequest({
        packageSlug: TEST_SLUG,
        packageJson: JSON.stringify(["not", "an", "object"]),
        skillMd: "---\nname: x\n---\nClean.",
      }),
    )) as { error?: string };

    expect(result.error).toMatch(/packageJson must be a JSON object/);
  });
});

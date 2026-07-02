/**
 * In-memory credential scan for agent_source_write_files.
 *
 * write_files writes package.json + SKILL.md directly to disk. If a credential
 * lands in either, the package would be on disk before any other gate fires.
 * We scan in-memory BEFORE the write so the package directory is never tainted.
 *
 * This test mirrors the structure of agent-source-compile-gate.test.ts and
 * uses the createAgentBuilderPrimitiveHandlers factory to exercise the
 * production handler dispatch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";

// The handler calls readInstanceIdentity() at the top of
// agent_source_write_files. Without this mock the module-load path pulls in
// `pg` and the test setup breaks. Mirrors the pattern in
// agent-source-write-files-name-rescoping.test.ts.
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

import { createAgentBuilderPrimitiveHandlers } from "../mcp/handlers";

const TEST_SLUG = "write-files-credential-scan-test";
let tmpRoot: string;
let originalCwd: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "write-files-credential-scan-"));
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
  const handlers = createAgentBuilderPrimitiveHandlers();
  return handlers["agent_source_write_files"];
}

describe("agent_source_write_files in-memory credential scan", () => {
  it("rejects credentialled SKILL.md BEFORE writing to disk", async () => {
    const handler = getHandler();
    const result = (await handler(
      buildRequest({
        packageSlug: TEST_SLUG,
        packageJson: JSON.stringify({ name: `@cinatra/${TEST_SLUG}`, version: "0.1.0" }),
        skillMd: "---\nname: x\n---\nUse sk-test1234567890abcdef1234567890ABCDEF12 here",
      }),
    )) as { code?: string; blockers?: Array<{ code: string; location?: string }> };

    expect(result.code).toBe("review_blocked");
    expect(result.blockers).toBeDefined();
    expect(result.blockers!.some((b) => b.code === "literal_credential_in_sibling_file")).toBe(true);
    expect(result.blockers!.some((b) => b.location?.includes("SKILL.md"))).toBe(true);

    // Critical: nothing on disk
    const expectedPath = path.join(tmpRoot, "cinatra", TEST_SLUG);
    await expect(fs.access(expectedPath)).rejects.toThrow();
  });

  it("rejects credentialled package.json BEFORE writing to disk", async () => {
    const handler = getHandler();
    const result = (await handler(
      buildRequest({
        packageSlug: TEST_SLUG,
        packageJson: JSON.stringify({
          name: `@cinatra/${TEST_SLUG}`,
          version: "0.1.0",
          scripts: { deploy: "GH_TOKEN=gho_aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890 git push" },
        }),
        skillMd: "---\nname: x\n---\nClean skill.",
      }),
    )) as { code?: string; blockers?: Array<{ code: string; location?: string }> };

    expect(result.code).toBe("review_blocked");
    expect(result.blockers!.some((b) => b.code === "literal_credential_in_sibling_file")).toBe(true);
  });

  it("allows clean inputs through to disk write", async () => {
    const handler = getHandler();
    const result = (await handler(
      buildRequest({
        packageSlug: TEST_SLUG,
        packageJson: JSON.stringify({ name: `@cinatra/${TEST_SLUG}`, version: "0.1.0" }),
        skillMd: "---\nname: x\n---\nA perfectly clean SKILL.md body.",
      }),
    )) as { written?: boolean; code?: string };

    expect(result.code).not.toBe("review_blocked");
    expect(result.written).toBe(true);
  });

  it("allows placeholders ({{TOKEN}}, ${TOKEN}) without blocking", async () => {
    const handler = getHandler();
    const result = (await handler(
      buildRequest({
        packageSlug: TEST_SLUG,
        packageJson: JSON.stringify({ name: `@cinatra/${TEST_SLUG}`, version: "0.1.0" }),
        skillMd: "Use `Bearer {{token}}` or `${TOKEN}` placeholders. Configure via /settings/connections.",
      }),
    )) as { written?: boolean; code?: string };

    expect(result.code).not.toBe("review_blocked");
    expect(result.written).toBe(true);
  });

  it("writes the source tree under the instance vendor namespace, not hardcoded cinatra-ai (cinatra#537)", async () => {
    // Operator instance with a non-default vendor namespace.
    mockReadInstanceIdentity.mockReturnValue({ vendorName: "acme-vendor" });
    try {
      const handler = getHandler();
      const result = (await handler(
        buildRequest({
          packageSlug: TEST_SLUG,
          // LLM emits a stale @cinatra scope; the writer must rescope AND
          // place the tree under the operator vendor, not cinatra-ai.
          packageJson: JSON.stringify({ name: `@cinatra/${TEST_SLUG}`, version: "0.1.0" }),
          skillMd: "---\nname: x\n---\nA perfectly clean SKILL.md body.",
        }),
      )) as { written?: boolean; code?: string };

      expect(result.code).not.toBe("review_blocked");
      expect(result.written).toBe(true);

      // Written under <vendor>/<slug>/, matching the rescoped package name…
      await expect(
        fs.access(path.join(tmpRoot, "acme-vendor", TEST_SLUG, "package.json")),
      ).resolves.toBeUndefined();
      // …and NOT under the hardcoded first-party namespace (the #537 bug).
      await expect(
        fs.access(path.join(tmpRoot, "cinatra-ai", TEST_SLUG, "package.json")),
      ).rejects.toThrow();
      // package.json#name is rescoped to the same vendor (no path/scope drift).
      const written = JSON.parse(
        await fs.readFile(
          path.join(tmpRoot, "acme-vendor", TEST_SLUG, "package.json"),
          "utf8",
        ),
      ) as { name?: string };
      expect(written.name).toBe(`@acme-vendor/${TEST_SLUG}`);
    } finally {
      mockReadInstanceIdentity.mockReturnValue(null);
    }
  });
});

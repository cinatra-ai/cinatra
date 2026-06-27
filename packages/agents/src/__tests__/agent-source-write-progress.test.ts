/**
 * `writing_files` progress emit in the `agent_source_write_files` MCP handler
 * and the shared `emitWritingFilesIfThreaded` helper, also used by
 * `agent_source_write`.
 *
 * Invariants under test:
 *  - WITH progressContext.runId + HumanUser actor -> ONE writing_files emit
 *    AND the write still proceeds (written: true).
 *  - WITHOUT progressContext -> ZERO emits, write proceeds.
 *  - WITH progressContext + non-HumanUser actor -> ZERO emits due to the
 *    fanout-escalation guard, write still proceeds.
 *  - Simulated emit rejection -> write STILL proceeds (fire-and-forget).
 *
 * Mock prelude mirrors agent-source-write-files-name-rescoping.test.ts
 * (the proven write-handler harness; preflight no-ops because the real
 * `@/lib/database#isAgentCreationPinActive` resolves to hardcoded false).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";

const { mockReadInstanceIdentity, mockSafeEmit } = vi.hoisted(() => ({
  mockReadInstanceIdentity: vi.fn(() => null as unknown),
  mockSafeEmit: vi.fn(async (_args: unknown) => undefined),
}));

vi.mock("@cinatra-ai/notifications/server", () => ({
  safeEmitAgentCreationProgress: mockSafeEmit,
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

const TEST_SLUG = "writing-files-progress-test";
let tmpRoot: string;
let originalCwd: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "write-progress-"));
  originalCwd = process.cwd();
  process.chdir(tmpRoot);
  mockReadInstanceIdentity.mockReset();
  mockReadInstanceIdentity.mockReturnValue({ instanceNamespace: "cinatra-ai" });
  mockSafeEmit.mockReset();
  mockSafeEmit.mockResolvedValue(undefined);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

function getHandler(): (req: unknown) => Promise<unknown> {
  return createAgentBuilderPrimitiveHandlers()["agent_source_write_files"];
}

const PKG_JSON = JSON.stringify({ name: `@cinatra-ai/${TEST_SLUG}`, version: "0.1.0" });
const SKILL_MD = "---\nname: x\n---\nClean.";

function buildRequest(
  input: Record<string, unknown>,
  actor: Record<string, unknown>,
) {
  return {
    primitiveName: "agent_source_write_files",
    input: { packageSlug: TEST_SLUG, packageJson: PKG_JSON, skillMd: SKILL_MD, ...input },
    actor,
    mode: "deterministic",
  };
}

// agent_source_write_files is admin-only at the handler boundary.
// Test actors stamp platformRole so resolveIsPlatformAdminFromSession returns
// true via the trusted-envelope fast path (no DB read needed in tests).
const HUMAN = { actorType: "human", source: "mcp", userId: "user-1", platformRole: "platform_admin" };
const SYSTEM = { actorType: "system", source: "worker", userId: "user-1", platformRole: "platform_admin" };

describe("agent_source_write_files writing_files progress emit", () => {
  it("WITH progressContext + HumanUser actor: ONE writing_files emit, write proceeds", async () => {
    const handler = getHandler();
    const result = (await handler(
      buildRequest({ progressContext: { runId: "run-1" } }, HUMAN),
    )) as { written?: boolean };

    expect(result.written).toBe(true);
    expect(mockSafeEmit).toHaveBeenCalledTimes(1);
    const arg = mockSafeEmit.mock.calls[0][0] as {
      milestone: string;
      runId: string;
      recipient: { kind: string; userId: string };
    };
    expect(arg.milestone).toBe("writing_files");
    expect(arg.runId).toBe("run-1");
    expect(arg.recipient).toEqual({ kind: "user", userId: "user-1" });
  });

  it("WITHOUT progressContext: zero emits, write proceeds", async () => {
    const handler = getHandler();
    const result = (await handler(buildRequest({}, HUMAN))) as { written?: boolean };
    expect(result.written).toBe(true);
    expect(mockSafeEmit).not.toHaveBeenCalled();
  });

  it("WITH progressContext + non-HumanUser actor: zero emits due to fanout guard, write proceeds", async () => {
    const handler = getHandler();
    const result = (await handler(
      buildRequest({ progressContext: { runId: "run-2" } }, SYSTEM),
    )) as { written?: boolean };
    expect(result.written).toBe(true);
    expect(mockSafeEmit).not.toHaveBeenCalled();
  });

  it("simulated emit rejection: write STILL proceeds (fire-and-forget)", async () => {
    mockSafeEmit.mockRejectedValueOnce(new Error("simulated DB down"));
    const handler = getHandler();
    const result = (await handler(
      buildRequest({ progressContext: { runId: "run-3" } }, HUMAN),
    )) as { written?: boolean };
    expect(result.written).toBe(true);
    expect(mockSafeEmit).toHaveBeenCalledTimes(1);
  });
});

/**
 * retireExtensionSkillsByExactId (cinatra#2090 S3 fold).
 *
 * The store is upsert-only for extension registration and preserves rows, so
 * the chat-namespace rows whose slugs the consolidation absorbed/renamed
 * survive forever unless explicitly retired. This pins the retirement's
 * narrow contract:
 *   - EXACT ids only — rows not in the list survive, whatever their
 *     namespace (never a namespace sweep);
 *   - personally-owned / agent-bound rows survive even when their id IS
 *     listed (extension registration never writes those shapes);
 *   - disk removal is confined exactly like deleteCustomSkill (an escaping
 *     stored sourcePath is never handed to rm);
 *   - idempotent: nothing matching ⇒ no catalog write, empty result.
 *
 * DB chain mocked like skills-store-delete-uninstall-containment.test.ts;
 * `rm` is spied (no real deletion) so we assert exactly what would be removed.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpBase = mkdtempSync(path.join(os.tmpdir(), "cinatra-retire-superseded-"));
const legacyRoot = path.join(tmpBase, "data", "skills");
const storeRoot = path.join(tmpBase, "data", "skill-store");
const outsideDir = path.join(tmpBase, "outside");
mkdirSync(legacyRoot, { recursive: true });
mkdirSync(storeRoot, { recursive: true });
mkdirSync(outsideDir, { recursive: true });

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const dbCatalog: { skillPackages: unknown[]; skills: unknown[] } = {
  skillPackages: [],
  skills: [],
};

const { replaceCatalogMock } = vi.hoisted(() => ({
  replaceCatalogMock: vi.fn(),
}));

vi.mock("@/lib/database", () => ({
  readConnectorConfigFromDatabase: vi.fn(() => ({
    dataPath: legacyRoot,
    storePath: storeRoot,
  })),
  writeConnectorConfigToDatabase: vi.fn(),
  readSkillCatalogFromDatabase: vi.fn(() => dbCatalog),
  replaceSkillCatalogInDatabase: replaceCatalogMock,
  getPostgresConnectionString: vi.fn(() => ""),
  ensurePostgresSchema: vi.fn(),
  readMetadataValueFromDatabase: vi.fn((_k: string, fallback: unknown) => fallback),
  writeMetadataValueToDatabase: vi.fn(),
  postgresSchema: "public",
  deleteCustomSkillAssignment: vi.fn(),
}));

vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: vi.fn(),
}));

vi.mock("./skill-packages", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./skill-packages")>();
  return { ...actual, installedSkillPackages: [] };
});

vi.mock("./storage/git-commit", () => ({
  commitSkillChange: vi.fn(async () => undefined),
}));

const { rmSpy } = vi.hoisted(() => ({
  rmSpy: vi.fn(async (_target: unknown, _options?: unknown) => undefined),
}));
vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return { ...actual, rm: rmSpy };
});

vi.mock("./github", () => ({
  ensureConfiguredRepositorySynced: vi.fn(async () => undefined),
}));

// The retirement function lives in the resolver module (route-graph budget:
// no extra module); stub the resolver's OTHER import edges the same way
// extension-skill-resolver.test.ts does, so this test's surface stays the
// store chain above.
vi.mock("./register-extension-skill", () => ({
  registerExtensionSkill: vi.fn(async () => ({ id: "x", sourcePath: "x" })),
  registerPackageAgentSkill: vi.fn(async () => ({ id: "x", sourcePath: "x" })),
  mirrorSkillBundleAssets: vi.fn(async () => undefined),
}));
vi.mock("@cinatra-ai/extensions", () => ({
  resolveExtensionKindStatus: vi.fn(async () => new Map()),
}));
vi.mock("@cinatra-ai/agents/agent-runtime-mount", () => ({
  resolveAgentRuntimeMountDir: vi.fn(() => "/nonexistent-install-root"),
}));
vi.mock("./lifecycle-store", () => ({}));

import { retireExtensionSkillsByExactId } from "./extension-skill-resolver";

function extensionRow(id: string, sourcePath: string, extra: Record<string, unknown> = {}) {
  const slug = id.split(":").pop() as string;
  return {
    id,
    name: slug,
    slug,
    description: "",
    content: `# ${slug}`,
    packageId: "pkg-chat",
    packageName: "@cinatra-ai/chat",
    packageSlug: "cinatra-ai-chat",
    sourcePath,
    usedBy: [],
    isCustom: true,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  };
}

beforeEach(() => {
  replaceCatalogMock.mockClear();
  rmSpy.mockClear();
  dbCatalog.skillPackages = [];
  dbCatalog.skills = [];
});

describe("retireExtensionSkillsByExactId", () => {
  it("removes ONLY the exact listed extension rows and rm's their confined dirs", async () => {
    const oldDir = path.join(legacyRoot, "workspace", "cinatra-ai", "assistant-skills", "skills", "chat-agent-dispatch");
    mkdirSync(oldDir, { recursive: true });
    dbCatalog.skills = [
      extensionRow("@cinatra-ai/chat:chat-agent-dispatch", path.join(oldDir, "SKILL.md")),
      extensionRow("@cinatra-ai/chat:chat-assistant-core", path.join(legacyRoot, "workspace", "x", "SKILL.md")),
    ];

    const retired = await retireExtensionSkillsByExactId(["@cinatra-ai/chat:chat-agent-dispatch"]);

    expect(retired).toEqual(["@cinatra-ai/chat:chat-agent-dispatch"]);
    expect(replaceCatalogMock).toHaveBeenCalledTimes(1);
    const written = replaceCatalogMock.mock.calls[0][0] as { skills: { id: string }[] };
    expect(written.skills.map((s) => s.id)).toEqual(["@cinatra-ai/chat:chat-assistant-core"]);
    // Confined disk removal of the retired row's dir only.
    expect(rmSpy).toHaveBeenCalledTimes(1);
    expect(path.resolve(String(rmSpy.mock.calls[0][0]))).toBe(path.resolve(oldDir));
  });

  it("preserves personally-owned and agent-bound rows even when their id is listed", async () => {
    dbCatalog.skills = [
      extensionRow("@cinatra-ai/chat:create-campaign", path.join(legacyRoot, "a", "SKILL.md"), {
        ownerUserId: "user-1",
        isCustomSkill: true,
      }),
      extensionRow("@cinatra-ai/chat:create-trigger", path.join(legacyRoot, "b", "SKILL.md"), {
        agentId: "@cinatra-ai/some-agent",
      }),
    ];

    const retired = await retireExtensionSkillsByExactId([
      "@cinatra-ai/chat:create-campaign",
      "@cinatra-ai/chat:create-trigger",
    ]);

    expect(retired).toEqual([]);
    expect(replaceCatalogMock).not.toHaveBeenCalled();
    expect(rmSpy).not.toHaveBeenCalled();
  });

  it("never hands an escaping stored sourcePath to rm (same confinement as deleteCustomSkill)", async () => {
    dbCatalog.skills = [
      extensionRow("@cinatra-ai/chat:chat-run-polling", path.join(outsideDir, "evil", "SKILL.md")),
    ];

    const retired = await retireExtensionSkillsByExactId(["@cinatra-ai/chat:chat-run-polling"]);

    // Catalog row goes (the row is the hazard), but the OUTSIDE dir is never rm'd.
    expect(retired).toEqual(["@cinatra-ai/chat:chat-run-polling"]);
    expect(rmSpy).not.toHaveBeenCalled();
  });

  it("is idempotent: no matching rows ⇒ no catalog write, empty result", async () => {
    dbCatalog.skills = [extensionRow("@cinatra-ai/chat:blog-content", path.join(legacyRoot, "c", "SKILL.md"))];
    const retired = await retireExtensionSkillsByExactId(["@cinatra-ai/chat:chat-workflow-authoring"]);
    expect(retired).toEqual([]);
    expect(replaceCatalogMock).not.toHaveBeenCalled();
  });
});

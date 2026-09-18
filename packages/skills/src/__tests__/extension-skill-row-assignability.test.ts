/**
 * AN INSTALLED SKILL EXTENSION IS OFFERED ON AN AGENT'S SKILLS PICKER
 * (cinatra#3204 — the fix leg for the fifth proof round's first counted defect).
 *
 * A skill package installed through the upload road finished, wrote its
 * canonical row, rebuilt the catalog — and was still never offered on an agent
 * card's own Skills offer. The reason is the SHAPE of the catalog row the
 * finalized-store-payload writer produced: `isCustom: true` with no recorded
 * extension provenance, which `normalizeStoredSkill` then derives into
 * `level: "organization"` / `scope: "org"`. The shared assignability predicate
 * reads exactly that shape as "a user wrote this, scoped to an owner" and
 * refuses it as `not-globally-visible`, so the picker could never carry it.
 *
 * The platform already states the true thing for an extension's own skills:
 * `registerExtensionSkill` passes `extensionRegistered: true` precisely so the
 * row is NOT user-authored and carries the recorded extension provenance the
 * rebuild preserves it by. A `cinatra.kind: "skill"` package installed from the
 * finalized store payload is that same thing, so it says the same thing.
 *
 * These tests drive the REAL writer against a temp skill root and grade its
 * output with the REAL predicate — never a second copy of either.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const tmpRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), "cinatra-skill-row-")));
const dataRoot = path.join(tmpRoot, "data-skills");
const storeRoot = path.join(tmpRoot, "skill-store");
mkdirSync(dataRoot, { recursive: true });
mkdirSync(storeRoot, { recursive: true });

const written: { skillPackages: unknown[]; skills: unknown[] }[] = [];
vi.mock("@/lib/database", () => ({
  readConnectorConfigFromDatabase: vi.fn(() => ({ dataPath: dataRoot, storePath: storeRoot })),
  writeConnectorConfigToDatabase: vi.fn(),
  readSkillCatalogFromDatabase: vi.fn(() => ({ skillPackages: [], skills: [] })),
  replaceSkillCatalogInDatabase: vi.fn((input: { skillPackages: unknown[]; skills: unknown[] }) => {
    written.push({ skillPackages: input.skillPackages, skills: input.skills });
  }),
  getPostgresConnectionString: vi.fn(() => ""),
  ensurePostgresSchema: vi.fn(async () => undefined),
  deleteConnectorConfig: vi.fn(),
  readOpenAIConnectionFromDatabase: vi.fn(),
  readAnthropicConnectionFromDatabase: vi.fn(),
  postgresSchema: "cinatra",
}));
vi.mock("@/lib/postgres-sync", () => ({ runPostgresQueriesSync: vi.fn() }));
vi.mock("@/lib/background-jobs", () => ({
  enqueueBackgroundJob: vi.fn(async () => undefined),
  BACKGROUND_JOB_NAMES: { SKILL_PREFILL_GENERATION: "skill-prefill-generation" },
}));
vi.mock("@/lib/skill-bundle-store", () => ({ isRedundantSkillBundleWrite: vi.fn(() => false) }));
vi.mock("../github", () => ({ ensureConfiguredRepositorySynced: vi.fn(async () => undefined) }));
vi.mock("../storage/git-commit", () => ({ commitSkillChange: vi.fn(async () => undefined) }));

import { upsertRepositoryBackedSkillPackage } from "../skills-store";
import { normalizeStoredSkill } from "../skills-store";
import { isGloballyVisibleCatalogRow } from "../agent-skill-assignability";

function makePackageDir(slug: string): string {
  const dir = path.join(storeRoot, `pkg-${slug}`);
  mkdirSync(path.join(dir, slug), { recursive: true });
  writeFileSync(
    path.join(dir, slug, "SKILL.md"),
    `---\nname: ${slug}\ndescription: A skill supplied by the upload walk.\n---\nbody\n`,
  );
  return dir;
}

/** The row the writer actually persisted, read back the way every reader reads it. */
function persistedSkillRow(skillId: string) {
  const last = written[written.length - 1];
  const raw = (last?.skills ?? []).find(
    (s) => (s as { id?: unknown }).id === skillId,
  ) as Record<string, unknown> | undefined;
  expect(raw).toBeDefined();
  return normalizeStoredSkill(raw as Record<string, unknown>);
}

beforeEach(() => {
  written.length = 0;
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("a skill EXTENSION's catalog rows are assignable", () => {
  it("an extension-registered install writes a row the assignability predicate accepts", async () => {
    const dir = makePackageDir("upload-walk-one");
    await upsertRepositoryBackedSkillPackage({
      packageId: "verdaccio:@acme/upload-walk-skill",
      catalogSkillIdPrefix: "@acme/upload-walk-skill",
      name: "@acme/upload-walk-skill",
      slug: "acme-upload-walk-skill",
      description: "@acme/upload-walk-skill@1.0.0",
      repositoryUrl: "verdaccio:@acme/upload-walk-skill@1.0.0",
      repositoryPath: dir,
      sourceUrl: "verdaccio:@acme/upload-walk-skill@1.0.0",
      extensionRegistered: true,
    });

    const row = persistedSkillRow("@acme/upload-walk-skill:upload-walk-one");
    expect(row).not.toBeNull();
    expect(isGloballyVisibleCatalogRow(row!)).toBe(true);
  });

  it("records the extension provenance the rebuild preserves the row by", async () => {
    const dir = makePackageDir("upload-walk-two");
    await upsertRepositoryBackedSkillPackage({
      packageId: "verdaccio:@acme/two-skill",
      catalogSkillIdPrefix: "@acme/two-skill",
      name: "@acme/two-skill",
      slug: "acme-two-skill",
      description: "d",
      repositoryUrl: "verdaccio:@acme/two-skill@1.0.0",
      repositoryPath: dir,
      extensionRegistered: true,
    });

    const row = persistedSkillRow("@acme/two-skill:upload-walk-two");
    expect(row?.isCustom).toBe(false);
    expect(row?.level).toBe("workspace");
    expect(row?.scope).toBeUndefined();
    expect((row as unknown as { source?: { origin?: string } })?.source?.origin).toBe("extension");
  });

  it("leaves a repository-backed install that is NOT an extension exactly as it was", async () => {
    const dir = makePackageDir("upload-walk-three");
    await upsertRepositoryBackedSkillPackage({
      packageId: "github:owner/repo",
      name: "owner/repo",
      slug: "owner-repo",
      description: "d",
      repositoryUrl: "https://github.com/owner/repo",
      repositoryPath: dir,
    });

    const row = persistedSkillRow("github:owner/repo:upload-walk-three");
    expect(row?.isCustom).toBe(true);
    expect(row?.level).toBe("organization");
    expect(isGloballyVisibleCatalogRow(row!)).toBe(false);
  });
});

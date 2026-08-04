/**
 * cinatra#2398 — the CATALOG IDENTITY / METADATA half of the fix.
 *
 * Two defects compounded on a production deployment. This file pins the second
 * one (the row SHAPE) and the rebuild behaviour that depends on it; the
 * always-on registration path is pinned separately in
 * `bundled-skill-registration.test.ts` and in the boot-phase test, exactly as
 * the issue asks ("catalog identity/metadata and resolved assignability role
 * are tested separately").
 *
 * What used to happen: every `upsertSkill` write — including an extension
 * registrar's — stamped `isCustom: true`, because that flag is what made the
 * catalog rebuild PRESERVE the row (its disk scanner never walks the canonical
 * store mirror the registration writes into). The shared assignability
 * predicate reads that same flag as "a user authored this", so an image-bundled
 * skill was refused as `not-globally-visible` even once registered.
 *
 * What happens now: the row says the true thing — not custom, with the RECORDED
 * `source.origin: "extension"` — and the rebuild preserves it by that
 * provenance instead. The predicate is untouched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@cinatra-ai/llm", () => ({
  runResolvedDeterministicLlmTask: vi.fn(),
  resolveConfiguredLlmRuntime: vi.fn(),
  parseStructuredJson: vi.fn(),
}));
vi.mock("@/lib/agents-store", () => ({
  readAgentsCatalog: vi.fn(async () => []),
  getAssignedSkillIdsForAgent: vi.fn(async () => []),
  readAgentSkillMatches: vi.fn(async () => ({ matches: [], matchedAt: "" })),
}));
vi.mock("@/lib/skill-bundle-store", () => ({
  isRedundantSkillBundleWrite: vi.fn(() => false),
}));
vi.mock("@/lib/postgres-sync", () => ({ runPostgresQueriesSync: vi.fn(() => []) }));
vi.mock("./storage/git-commit", () => ({ commitSkillChange: vi.fn(async () => undefined) }));

/** An in-memory stand-in for the persisted catalog, driven by the real store. */
const db = vi.hoisted(() => ({
  catalog: { skillPackages: [] as Record<string, unknown>[], skills: [] as Record<string, unknown>[] },
  storage: { dataPath: "", storePath: "" },
  writes: 0,
}));

vi.mock("@/lib/database", () => ({
  getPostgresConnectionString: vi.fn(() => "postgres://unused"),
  postgresSchema: "cinatra",
  ensurePostgresSchema: vi.fn(),
  readConnectorConfigFromDatabase: vi.fn((key: string) =>
    key === "skills_storage" ? db.storage : {},
  ),
  writeConnectorConfigToDatabase: vi.fn(),
  readSkillCatalogFromDatabase: vi.fn(() => ({
    skillPackages: db.catalog.skillPackages,
    skills: db.catalog.skills,
  })),
  replaceSkillCatalogInDatabase: vi.fn(
    (input: { skillPackages: unknown[]; skills: unknown[] }) => {
      db.writes += 1;
      db.catalog = {
        skillPackages: JSON.parse(JSON.stringify(input.skillPackages)),
        skills: JSON.parse(JSON.stringify(input.skills)),
      };
    },
  ),
}));

import { syncInstalledSkillsToDatabase, upsertSkill } from "./skills-store";
import { isGloballyVisibleCatalogRow } from "./agent-skill-assignability";

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "cinatra-2398-"));
  db.catalog = { skillPackages: [], skills: [] };
  db.storage = {
    dataPath: path.join(root, "data", "skills"),
    storePath: path.join(root, "data", "skill-store"),
  };
  db.writes = 0;
  mkdirSync(db.storage.dataPath, { recursive: true });
  mkdirSync(db.storage.storePath, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The exact call shape `registerExtensionSkill` makes. */
function registerBundled(skillId: string, packageName: string) {
  return upsertSkill({
    type: "workspace",
    packageName,
    name: skillId.split(":").pop() ?? skillId,
    description: "a bundled skill",
    content: "---\nname: bundled\n---\nbody",
    skillId,
    prefillText: "-",
    extensionRegistered: true,
  });
}

describe("cinatra#2398 — extension-registered catalog rows", () => {
  it("records the row as NOT custom, with the explicit extension provenance", async () => {
    const row = await registerBundled("@cinatra-ai/chat:company-research", "@cinatra-ai/chat");

    expect(row.isCustom).toBe(false);
    expect(row.source?.origin).toBe("extension");
    // The origin drives the revision TAG too: an extension bundle is an
    // immutable snapshot, not a mutable head.
    expect(row.source?.revision.kind).toBe("digest");
    // The catalog id is the bundled skill's own id — including the VIRTUAL chat
    // namespace, whose package does not exist as an installable package.
    expect(row.id).toBe("@cinatra-ai/chat:company-research");
    // The `custom:` packageId is UNCHANGED on purpose: it is what tells the
    // bundle store the database owns this row's content authority.
    expect(row.packageId).toBe("custom:cinatra-ai-chat");
  });

  it("makes the registered row PASS the (unmodified) global-visibility conjunct", async () => {
    const bundled = await registerBundled("@cinatra-ai/web-research-skill:web-research", "@cinatra-ai/web-research-skill");
    expect(isGloballyVisibleCatalogRow(bundled)).toBe(true);
  });

  it("still REFUSES the same write without the extension flag — the user-authored shape", async () => {
    const custom = await upsertSkill({
      type: "workspace",
      packageName: "@cinatra-ai/web-research-skill",
      name: "web-research",
      content: "---\nname: x\n---\nbody",
      skillId: "@cinatra-ai/web-research-skill:web-research",
    });
    expect(custom.isCustom).toBe(true);
    expect(custom.source?.origin).toBe("custom");
    expect(isGloballyVisibleCatalogRow(custom)).toBe(false);
  });

  it("does NOT change the shape of a personal skill written through the same store", async () => {
    const personal = await upsertSkill({
      type: "personal",
      packageName: "Custom Skills",
      name: "my skill",
      content: "body",
      ownerUserId: "user-1",
      agentId: "agent-1",
    });
    expect(personal.isCustom).toBe(true);
    expect(personal.isCustomSkill).toBe(true);
    expect(personal.source?.origin).toBe("custom");
    expect(isGloballyVisibleCatalogRow(personal)).toBe(false);
  });
});

describe("cinatra#2398 — the rebuild preserves extension-registered rows", () => {
  it("survives a rebuild, and a SECOND rebuild writes nothing (idempotent, no drops, no duplicates)", async () => {
    await registerBundled("@cinatra-ai/chat:company-research", "@cinatra-ai/chat");
    await registerBundled("@cinatra-ai/chat:blog-content", "@cinatra-ai/chat");

    const first = await syncInstalledSkillsToDatabase();
    const ids = first.skills.map((s) => s.id).sort();
    expect(ids).toEqual(["@cinatra-ai/chat:blog-content", "@cinatra-ai/chat:company-research"]);
    // The package row rides along with them — before this change the rebuild
    // preserved the skills and dropped the package that owned them.
    expect(first.skillPackages.map((p) => p.packageId)).toContain("custom:cinatra-ai-chat");

    const writesAfterFirst = db.writes;
    const second = await syncInstalledSkillsToDatabase();
    expect(second.skills.map((s) => s.id).sort()).toEqual(ids);
    expect(second.skills.filter((s) => s.id === "@cinatra-ai/chat:blog-content")).toHaveLength(1);
    expect(db.writes).toBe(writesAfterFirst);
  });

  it("keeps the row globally visible AFTER the rebuild round-trip (the normalizer keeps `source`)", async () => {
    await registerBundled("@cinatra-ai/chat:company-research", "@cinatra-ai/chat");
    const rebuilt = await syncInstalledSkillsToDatabase();
    const row = rebuilt.skills.find((s) => s.id === "@cinatra-ai/chat:company-research");
    expect(row).toBeDefined();
    expect(row!.source?.origin).toBe("extension");
    expect(isGloballyVisibleCatalogRow(row!)).toBe(true);
  });

  it("drops an extension package row once every extension skill it owned is gone", async () => {
    await registerBundled("@cinatra-ai/chat:company-research", "@cinatra-ai/chat");
    await syncInstalledSkillsToDatabase();
    expect(db.catalog.skillPackages.map((p) => p.packageId)).toContain("custom:cinatra-ai-chat");

    // Simulate the retirement sweep having removed the last owned skill row.
    db.catalog.skills = db.catalog.skills.filter(
      (s) => s.id !== "@cinatra-ai/chat:company-research",
    );
    const after = await syncInstalledSkillsToDatabase();
    expect(after.skillPackages.map((p) => p.packageId)).not.toContain("custom:cinatra-ai-chat");
  });

  it("still preserves ordinary custom rows, and still drops a non-custom row with no provenance", async () => {
    await upsertSkill({
      type: "workspace",
      packageName: "@acme/hand-written",
      name: "hand written",
      content: "body",
      skillId: "@acme/hand-written:x",
    });
    // A row shaped like the pre-fix workaround: non-custom, no recorded
    // provenance, produced by nothing the scanner walks.
    db.catalog.skills.push({
      id: "@acme/seeded:y",
      slug: "y",
      name: "seeded",
      description: "hand-seeded",
      content: "body",
      packageId: "@acme/seeded",
      packageName: "@acme/seeded",
      packageSlug: "acme-seeded",
      level: "workspace",
      usedBy: [],
      isCustom: false,
    });

    const rebuilt = await syncInstalledSkillsToDatabase();
    const ids = rebuilt.skills.map((s) => s.id);
    expect(ids).toContain("@acme/hand-written:x");
    expect(ids).not.toContain("@acme/seeded:y");
  });

  it("lets a DISK-SCANNED row of the same id win over the preserved DB row (merge precedence, unchanged)", async () => {
    await registerBundled("@cinatra-ai/chat:company-research", "@cinatra-ai/chat");
    // Materialize a legacy `data/skills` package whose scanner-derived id
    // collides with the preserved extension row's id.
    const pkgDir = path.join(db.storage.dataPath, "chat-pkg");
    mkdirSync(path.join(pkgDir, "company-research"), { recursive: true });
    writeFileSync(
      path.join(pkgDir, "company-research", "SKILL.md"),
      "---\nname: scanned\n---\nscanned body",
      "utf8",
    );
    writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "@cinatra-ai/chat" }),
      "utf8",
    );

    const rebuilt = await syncInstalledSkillsToDatabase();
    const rows = rebuilt.skills.filter((s) => s.id === "@cinatra-ai/chat:company-research");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toContain("scanned body");
  });
});

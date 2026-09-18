/**
 * A SUPPLIED (UPLOADED) SKILL EXTENSION IS OFFERED ON AN AGENT'S SKILLS OFFER
 * (cinatra#3204 — the fix leg for the sixth proof round's skill defect).
 *
 * The round installed a skill package through the upload road. Its catalog row
 * landed with honest extension provenance (the previous leg's fix: `isCustom:
 * false`, `level: "workspace"`, a recorded `source.origin`), the skills catalog
 * listed it — and the agent extension's own Skills offer still answered
 * "No matches." for every query naming it.
 *
 * The cause is the CANDIDATE SET, not the row. The offer's population
 * (`listAssignableSkillCandidates`) derives every candidate skill id from the
 * on-disk extension SCAN, and that scan reads two roots: the git-native
 * `<cwd>/extensions` authoring tree and the agent runtime mount. A package
 * installed at runtime — whether its bytes came from the registry or were
 * supplied on the upload road — is materialized into the unified
 * content-addressed store (`<CINATRA_EXTENSION_DATA_ROOT>/skill/<slug>/<digest>/`),
 * which neither root covers. No descriptor owned the skill's id, so the id
 * never entered the ownership map and the predicate was never even consulted:
 * an installed skill extension could not be offered by any query.
 *
 * These tests drive the REAL scan and the REAL population over a REAL store
 * layout, never a second copy of either.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import { scanSkillExtensions } from "../extension-skill-resolver";
import { listAssignableSkillCandidates } from "../assignable-skill-search";
import type { PersistedSkill } from "../skills-store";

/** A well-formed store digest segment (64 hex chars) — the store's own shape. */
const DIGEST = "a7".repeat(32);
const PACKAGE_NAME = "@acme/store-supplied-offer-skill";
const SKILL_SLUG = "one";
const SKILL_ID = `${PACKAGE_NAME}:${SKILL_SLUG}`;

let tmpRoot: string;
let priorDataRoot: string | undefined;

beforeAll(() => {
  tmpRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), "cinatra-store-skill-")));
  const slugDir = path.join(tmpRoot, "skill", "@acme", "store-supplied-offer-skill");
  const digestDir = path.join(slugDir, DIGEST);
  mkdirSync(path.join(digestDir, "skills", SKILL_SLUG), { recursive: true });
  writeFileSync(
    path.join(digestDir, "package.json"),
    JSON.stringify({
      name: PACKAGE_NAME,
      version: "1.0.0",
      cinatra: { kind: "skill", displayName: "Store Supplied Offer Skill" },
    }),
  );
  writeFileSync(
    path.join(digestDir, "skills", SKILL_SLUG, "SKILL.md"),
    `---\nname: ${SKILL_SLUG}\ndescription: A skill supplied by the upload road.\n---\nbody\n`,
  );
  // The store's own active-digest mirror.
  writeFileSync(path.join(slugDir, "current"), `${DIGEST}\n`);

  priorDataRoot = process.env.CINATRA_EXTENSION_DATA_ROOT;
  process.env.CINATRA_EXTENSION_DATA_ROOT = tmpRoot;
});

afterAll(() => {
  if (priorDataRoot === undefined) delete process.env.CINATRA_EXTENSION_DATA_ROOT;
  else process.env.CINATRA_EXTENSION_DATA_ROOT = priorDataRoot;
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

/** The catalog row the supplied road's writer actually persists for this skill. */
const catalogRow = {
  id: SKILL_ID,
  name: "One",
  slug: SKILL_SLUG,
  description: "A skill supplied by the upload road.",
  content: "body",
  level: "workspace",
  isCustom: false,
  packageId: `verdaccio:${PACKAGE_NAME}`,
  packageName: PACKAGE_NAME,
  usedBy: [],
} as unknown as PersistedSkill;

describe("a store-installed (supplied) skill extension reaches the agent Skills offer", () => {
  it("the extension scan sees the store-installed package and its skill", async () => {
    const descriptors = await scanSkillExtensions();
    const mine = descriptors.find((d) => d.pkgName === PACKAGE_NAME);
    expect(mine).toBeDefined();
    expect(mine?.kind).toBe("skill");
    expect(mine?.slugs).toContain(SKILL_SLUG);
  });

  it("the assignable population offers the supplied skill by its catalog id", async () => {
    const candidates = await listAssignableSkillCandidates({
      readCatalogSnapshot: async () => ({ skills: [catalogRow] }),
      readInstallStatus: async (names) =>
        new Map(names.map((n) => [n, "active" as const])),
    });
    const offered = candidates.find((c) => c.skillId === SKILL_ID);
    expect(offered).toBeDefined();
    expect(offered?.skillName).toBe("One");
    expect(offered?.ownerPackageName).toBe(PACKAGE_NAME);
  });
});

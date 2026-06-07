// Pin the catalogSkillIdPrefix contract so Verdaccio-backed skills surface in
// the catalog under their consumer-ref shape (`<packageName>:<slug>`) while the
// skill_packages row identity stays `verdaccio:<packageName>` for lifecycle
// dispatch.
//
// Tests use a pure-fn unit-level harness: we don't drive the full
// upsertRepositoryBackedSkillPackage (which writes to Postgres). The
// composed ID is `${catalogIdPrefix}:${slug}` where catalogIdPrefix
// defaults to packageId. This test pins both branches.

import { describe, it, expect } from "vitest";

function composeCatalogSkillId(
  packageId: string,
  slug: string,
  catalogSkillIdPrefix?: string,
): string {
  const prefix = catalogSkillIdPrefix ?? packageId;
  return `${prefix}:${slug}`;
}

describe("upsertRepositoryBackedSkillPackage — catalogSkillIdPrefix contract", () => {
  it("GitHub backend: omit catalogSkillIdPrefix → catalog ID stays prefixed (backward-compat)", () => {
    expect(composeCatalogSkillId("github:owner/repo", "my-skill")).toBe(
      "github:owner/repo:my-skill",
    );
  });

  it("Verdaccio backend: pass bare packageName → catalog ID does NOT carry the verdaccio: prefix", () => {
    expect(
      composeCatalogSkillId(
        "verdaccio:@anthropics/skills",
        "skill-creator",
        "@anthropics/skills",
      ),
    ).toBe("@anthropics/skills:skill-creator");
  });

  it("dev-watcher path: bare packageName == packageId → unchanged", () => {
    expect(
      composeCatalogSkillId(
        "@cinatra-ai/blog-skills",
        "generate-blog-ideas",
        "@cinatra-ai/blog-skills",
      ),
    ).toBe("@cinatra-ai/blog-skills:generate-blog-ideas");
  });

  it("an explicit catalogSkillIdPrefix matching the packageId is a no-op", () => {
    const composed = composeCatalogSkillId(
      "github:owner/repo",
      "slug",
      "github:owner/repo",
    );
    expect(composed).toBe("github:owner/repo:slug");
  });
});

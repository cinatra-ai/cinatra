import { describe, it, expect } from "vitest";
import {
  resolveSkillOwnerPackageCandidates,
  isSkillManifestGoverned,
  computeSkillManifestParity,
} from "../manifest-identity";

// Fixtures mirror the real shapes measured on the live catalog:
//   - agent-owned co-located skill (npm-scoped name; packageId custom:<slug>)
//   - artifact-owned co-located skill
//   - github system skill (owner/repo)
//   - verdaccio-installed system skill
//   - an unresolved/orphan package
const agentOwned = {
  packageName: "@cinatra-ai/blog-linkedin-writer-agent",
  packageId: "custom:cinatra-ai-blog-linkedin-writer-agent",
  packageSlug: "blog-linkedin-writer-agent",
};
const artifactOwned = {
  packageName: "@cinatra-ai/marketing-strategy-artifact",
  packageId: "custom:cinatra-ai-marketing-strategy-artifact",
};
const githubSystem = {
  packageName: "coreyhaines31-marketingskills",
  packageId: "github:coreyhaines31/marketingskills",
};
const verdaccioInstalled = {
  packageName: "_verdaccio-installs",
  packageId: "installed:_verdaccio-installs",
};

describe("resolveSkillOwnerPackageCandidates", () => {
  it("emits npm-scoped, slugified, and packageId-stripped candidates (normalization drift coverage)", () => {
    const c = resolveSkillOwnerPackageCandidates(agentOwned);
    expect(c).toContain("@cinatra-ai/blog-linkedin-writer-agent"); // raw
    expect(c).toContain("cinatra-ai-blog-linkedin-writer-agent"); // slug(name) AND stripPrefix(packageId)
    expect(c).toContain("blog-linkedin-writer-agent"); // packageSlug
  });

  it("strips the packageId install-source/owner prefix (incl. verdaccio:/zip:)", () => {
    expect(resolveSkillOwnerPackageCandidates({ packageId: "github:owner/repo" })).toContain("owner/repo");
    expect(resolveSkillOwnerPackageCandidates({ packageId: "installed:_verdaccio-installs" })).toContain(
      "_verdaccio-installs",
    );
    expect(resolveSkillOwnerPackageCandidates({ packageId: "verdaccio:@scope/pkg" })).toContain("@scope/pkg");
    expect(resolveSkillOwnerPackageCandidates({ packageId: "zip:my-bundle" })).toContain("my-bundle");
  });

  it("dedupes when name-slug and packageId-stripped collapse to the same key", () => {
    const c = resolveSkillOwnerPackageCandidates(agentOwned);
    expect(c.filter((x) => x === "cinatra-ai-blog-linkedin-writer-agent")).toHaveLength(1);
  });

  it("returns [] for an empty row", () => {
    expect(resolveSkillOwnerPackageCandidates({})).toEqual([]);
  });
});

describe("isSkillManifestGoverned (cross-kind: live set is the union of ALL kinds)", () => {
  it("agent-owned skill resolves via the slugified key against a kind=agent manifest", () => {
    // The owning agent's manifest package_name is the slug form.
    const live = new Set(["cinatra-ai-blog-linkedin-writer-agent"]);
    expect(isSkillManifestGoverned(agentOwned, live)).toBe(true);
  });

  it("artifact-owned skill resolves against its artifact manifest (non-skill kind)", () => {
    const live = new Set(["cinatra-ai-marketing-strategy-artifact"]);
    expect(isSkillManifestGoverned(artifactOwned, live)).toBe(true);
  });

  it("github system skill resolves via the raw packageName", () => {
    const live = new Set(["coreyhaines31-marketingskills"]);
    expect(isSkillManifestGoverned(githubSystem, live)).toBe(true);
  });

  it("is NOT governed when no candidate matches any live manifest", () => {
    expect(isSkillManifestGoverned(agentOwned, new Set(["something-else"]))).toBe(false);
  });
});

describe("computeSkillManifestParity", () => {
  it("buckets resolved vs unresolved by distinct package, de-duping multiple skills of one package", () => {
    const skills = [
      { ...agentOwned, id: "a:one" },
      { ...agentOwned, id: "a:two" }, // same package, second skill — de-duped
      artifactOwned,
      githubSystem,
      { packageName: "@orphan/never-installed-artifact", packageId: "custom:orphan-never-installed-artifact" },
    ];
    const live = new Set([
      "cinatra-ai-blog-linkedin-writer-agent",
      "cinatra-ai-marketing-strategy-artifact",
      "coreyhaines31-marketingskills",
    ]);
    const parity = computeSkillManifestParity(skills, live);
    expect(parity.total).toBe(4); // 4 distinct packages
    expect(parity.resolved).toEqual([
      "@cinatra-ai/blog-linkedin-writer-agent",
      "@cinatra-ai/marketing-strategy-artifact",
      "coreyhaines31-marketingskills",
    ]);
    expect(parity.unresolved).toEqual(["@orphan/never-installed-artifact"]);
  });

  it("empty live set => everything unresolved (the pre-reconciliation state)", () => {
    const parity = computeSkillManifestParity([agentOwned, githubSystem], new Set());
    expect(parity.resolved).toEqual([]);
    expect(parity.unresolved).toHaveLength(2);
  });

  it("no skills => empty parity", () => {
    expect(computeSkillManifestParity([], new Set(["x"]))).toEqual({ resolved: [], unresolved: [], total: 0 });
  });
});

import { resolveCanonicalNpmName, planSkillManifestNpmMigration } from "../manifest-identity";

describe("resolveCanonicalNpmName", () => {
  const catalog = [
    "@cinatra-ai/security-reviewer-agent",
    "@cinatra-agents/email-reviewer",
    "cinatra-agents-email-reviewer", // catalog-duplication: bare slug alongside the npm form
  ];
  it("returns npm input unchanged", () => {
    expect(resolveCanonicalNpmName("@cinatra-ai/security-reviewer-agent", catalog)).toBe(
      "@cinatra-ai/security-reviewer-agent",
    );
  });
  it("resolves a slug to the npm form via slugify match", () => {
    expect(resolveCanonicalNpmName("cinatra-ai-security-reviewer-agent", catalog)).toBe(
      "@cinatra-ai/security-reviewer-agent",
    );
  });
  it("PREFERS the @-form when the catalog carries both slug and npm for the same skill", () => {
    // slug 'cinatra-agents-email-reviewer' matches BOTH the bare-slug catalog entry
    // and slugify('@cinatra-agents/email-reviewer') — prefer the npm one.
    expect(resolveCanonicalNpmName("cinatra-agents-email-reviewer", catalog)).toBe(
      "@cinatra-agents/email-reviewer",
    );
  });
  it("returns null for an orphan slug (no npm candidate)", () => {
    expect(resolveCanonicalNpmName("agent-scrape", catalog)).toBeNull();
  });
  it("returns null when >1 distinct npm candidates collide (ambiguous — never guess)", () => {
    const ambiguous = ["@a/foo-bar", "@b/foo-bar"]; // both slugify to 'a-foo-bar'/'b-foo-bar'? no — craft a real collision
    // Construct a genuine collision: two npm names that slugify identically.
    const coll = ["@scope/foo", "@scope-foo/x"]; // slugify -> 'scope-foo' both? '@scope/foo'->'scope-foo'; '@scope-foo/x'->'scope-foo-x'. Not equal.
    // Use names that truly collide: '@a/b' -> 'a-b'; '@a-b/c'? -> 'a-b-c'. Hard. Force via identical slug:
    const real = ["@x/y", "@x/y"]; // dedup in Set -> size 1, not a collision
    void ambiguous; void coll; void real;
    // Genuine: '@foo/bar' and '@foo-bar' (a scoped vs unscoped) both slugify to 'foo-bar'.
    expect(resolveCanonicalNpmName("foo-bar", ["@foo/bar", "@foo-bar/x".replace("/x", "")])).toBe(
      // '@foo-bar' slugifies to 'foo-bar' AND '@foo/bar' slugifies to 'foo-bar' -> 2 distinct npm -> null
      null,
    );
  });
});

describe("planSkillManifestNpmMigration", () => {
  const catalog = [
    "@cinatra-ai/security-reviewer-agent",
    "@cinatra-agents/email-reviewer",
    "cinatra-agents-email-reviewer",
  ];
  const row = (id: string, packageName: string, over: Record<string, unknown> = {}) => ({
    id,
    packageName,
    ownerLevel: "platform",
    ownerId: null,
    organizationId: null,
    ...over,
  });

  it("renames a unique slug row to npm; reports orphans; leaves npm rows alone", () => {
    const plan = planSkillManifestNpmMigration(
      [
        row("r1", "cinatra-ai-security-reviewer-agent"),
        row("r2", "@cinatra-ai/already-canonical-agent"),
        row("r3", "agent-scrape"), // orphan
        row("r4", "cinatra-agents-email-reviewer"), // collision-in-catalog -> prefers @-form
      ],
      catalog,
    );
    expect(plan.renames).toEqual([
      { id: "r1", from: "cinatra-ai-security-reviewer-agent", to: "@cinatra-ai/security-reviewer-agent" },
      { id: "r4", from: "cinatra-agents-email-reviewer", to: "@cinatra-agents/email-reviewer" },
    ]);
    expect(plan.alreadyCanonical).toEqual(["r2"]);
    // No extension scope → an orphan can't be classified non-extension → needsReview.
    expect(plan.needsReview).toEqual([{ id: "r3", packageName: "agent-scrape" }]);
    expect(plan.deletes).toEqual([]);
    expect(plan.nonExtensionDeletes).toEqual([]);
  });

  it("DELETES a slug row that duplicates an existing npm row at the same identity", () => {
    const plan = planSkillManifestNpmMigration(
      [
        row("npm", "@cinatra-ai/security-reviewer-agent"),
        row("slug", "cinatra-ai-security-reviewer-agent"), // same identity -> dup -> delete
      ],
      catalog,
    );
    expect(plan.alreadyCanonical).toEqual(["npm"]);
    expect(plan.deletes).toEqual([
      { id: "slug", from: "cinatra-ai-security-reviewer-agent", duplicateOf: "@cinatra-ai/security-reviewer-agent" },
    ]);
    expect(plan.renames).toEqual([]);
  });

  it("two slug rows resolving to the SAME npm: first renames, second is deleted as a dup", () => {
    const plan = planSkillManifestNpmMigration(
      [
        row("a", "cinatra-ai-security-reviewer-agent"),
        row("b", "cinatra-ai-security-reviewer-agent"),
      ],
      catalog,
    );
    expect(plan.renames).toHaveLength(1);
    expect(plan.deletes).toHaveLength(1);
  });

  it("different owner identities resolving to the same npm are NOT duplicates (both rename)", () => {
    const plan = planSkillManifestNpmMigration(
      [
        row("a", "cinatra-ai-security-reviewer-agent", { ownerId: "u1" }),
        row("b", "cinatra-ai-security-reviewer-agent", { ownerId: "u2" }),
      ],
      catalog,
    );
    expect(plan.renames).toHaveLength(2);
    expect(plan.deletes).toHaveLength(0);
  });

  it("CROSS-KIND: a skill slug resolving to an identity held by a non-skill npm row is DELETED, not renamed (co-location)", () => {
    // The owning agent manifest (@cinatra-ai/security-reviewer-agent, kind=agent)
    // already governs the co-located skill. installed_extension uniqueness
    // excludes kind, so renaming would also violate the unique constraint.
    const plan = planSkillManifestNpmMigration(
      [row("skill-slug", "cinatra-ai-security-reviewer-agent")],
      catalog,
      [row("agent-mf", "@cinatra-ai/security-reviewer-agent")], // cross-kind npm row at platform identity
    );
    expect(plan.renames).toEqual([]);
    expect(plan.deletes).toEqual([
      { id: "skill-slug", from: "cinatra-ai-security-reviewer-agent", duplicateOf: "@cinatra-ai/security-reviewer-agent" },
    ]);
  });

  it("CROSS-KIND at a DIFFERENT owner identity does NOT block a rename", () => {
    const plan = planSkillManifestNpmMigration(
      [row("skill-slug", "cinatra-ai-security-reviewer-agent", { ownerId: "u1" })],
      catalog,
      [row("agent-mf", "@cinatra-ai/security-reviewer-agent", { ownerId: "other" })],
    );
    expect(plan.renames).toHaveLength(1);
    expect(plan.deletes).toEqual([]);
  });

  it("is idempotent: an already-migrated set yields all alreadyCanonical, no renames/deletes", () => {
    const plan = planSkillManifestNpmMigration(
      [row("r1", "@cinatra-ai/security-reviewer-agent"), row("r2", "@cinatra-agents/email-reviewer")],
      catalog,
    );
    expect(plan.alreadyCanonical).toEqual(["r1", "r2"]);
    expect(plan.renames).toEqual([]);
    expect(plan.deletes).toEqual([]);
    expect(plan.needsReview).toEqual([]);
    expect(plan.nonExtensionDeletes).toEqual([]);
  });
});

describe("planSkillManifestNpmMigration — extension scoping", () => {
  const catalog = ["@cinatra-ai/blog-skills", "@cinatra-agents/email-reviewer"];
  const extSet = ["@cinatra-ai/blog-skills"]; // only blog-skills is an extension; email-reviewer is a legacy code-agent
  const row = (id: string, packageName: string) => ({
    id,
    packageName,
    ownerLevel: "platform",
    ownerId: null,
    organizationId: null,
  });

  it("renames an EXTENSION skill but DELETES a non-extension resolved npm (backfill residue)", () => {
    const plan = planSkillManifestNpmMigration(
      [
        row("ext", "cinatra-ai-blog-skills"), // -> @cinatra-ai/blog-skills (extension)
        row("legacy", "cinatra-agents-email-reviewer"), // -> @cinatra-agents/email-reviewer (NOT an extension)
      ],
      catalog,
      [],
      extSet,
    );
    expect(plan.renames).toEqual([
      { id: "ext", from: "cinatra-ai-blog-skills", to: "@cinatra-ai/blog-skills" },
    ]);
    expect(plan.nonExtensionDeletes).toEqual([
      { id: "legacy", packageName: "cinatra-agents-email-reviewer", resolvedNpm: "@cinatra-agents/email-reviewer" },
    ]);
  });

  it("an ALREADY-npm row that is NOT an extension is DELETED (backfill residue), not kept", () => {
    const plan = planSkillManifestNpmMigration(
      [row("x", "@cinatra-agents/email-reviewer")],
      catalog,
      [],
      extSet,
    );
    expect(plan.alreadyCanonical).toEqual([]);
    expect(plan.nonExtensionDeletes).toEqual([
      { id: "x", packageName: "@cinatra-agents/email-reviewer", resolvedNpm: "@cinatra-agents/email-reviewer" },
    ]);
  });

  it("an orphan (no npm candidate) under an extension scope is DELETED as non-extension", () => {
    const plan = planSkillManifestNpmMigration([row("o", "agent-scrape")], catalog, [], extSet);
    expect(plan.nonExtensionDeletes).toEqual([{ id: "o", packageName: "agent-scrape", resolvedNpm: null }]);
    expect(plan.needsReview).toEqual([]);
  });

  it("EXTERNAL leave-alone rows are neither renamed nor deleted", () => {
    const plan = planSkillManifestNpmMigration(
      [
        row("anthropic", "@anthropics/skills"),
        row("gh", "coreyhaines31-marketingskills"),
        row("ext", "cinatra-ai-blog-skills"),
      ],
      catalog,
      [],
      extSet,
      ["@anthropics/skills", "coreyhaines31-marketingskills"], // externalLeaveAlone
    );
    expect(plan.external.map((e) => e.id).sort()).toEqual(["anthropic", "gh"]);
    expect(plan.renames.map((r) => r.id)).toEqual(["ext"]);
    expect(plan.nonExtensionDeletes).toEqual([]);
  });

  it("without an extension scope (undefined), nothing is deleted as non-extension (back-compat)", () => {
    const plan = planSkillManifestNpmMigration([row("ext", "cinatra-ai-blog-skills")], catalog);
    expect(plan.nonExtensionDeletes).toEqual([]);
    expect(plan.external).toEqual([]);
    expect(plan.renames).toHaveLength(1);
  });
});

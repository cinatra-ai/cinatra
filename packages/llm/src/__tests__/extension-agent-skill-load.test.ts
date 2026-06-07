/**
 * Regression test for bridge-dispatched extension agent SKILL.md loading.
 *
 * The bug this guards against: an extension-shipped SKILL.md under
 * `extensions/cinatra-ai/<slug>/skills/<slug>/SKILL.md` was outside
 * `getSkillsDataRootPath()` and therefore rejected by `readSkillFileContent`.
 *
 * An earlier fix added an `allowedRoots` parameter to widen containment.
 * That parameter was retired (catalog-bypass surface) and replaced with
 * a bridge-side `registerExtensionSkill()` preflight: the catalog mirrors
 * the SKILL.md into `data/skills/...` and the bridge reads from the mirrored
 * path inside the default root.
 *
 * This test would FAIL without the preflight: the catalog never gets the
 * sourcePath, the shell tool's virtual→real mapping falls back to the raw
 * `extensions/` path, and `readSkillFileContent` rejects it because the
 * default-root containment no longer accepts the override.
 */

import { describe, expect, it, vi } from "vitest";

// Mock `@cinatra-ai/skills` flat — without `importOriginal` — so the
// transitive dependency graph (which pulls in `@cinatra-ai/objects` via
// `@cinatra-ai/agents`) does not need to resolve in this package-local test.
vi.mock("@cinatra-ai/skills", () => ({
  registerExtensionSkill: vi.fn(async (input: {
    skillId: string;
    packageName: string;
    skillMdPath: string;
  }) => {
    // Production behavior: upsertSkill mirrors SKILL.md content into
    // `data/skills/<scope>/<package>/<skillId>/SKILL.md` and returns
    // that mirrored path as `sourcePath`. The path is INSIDE the default
    // skills data root by construction.
    const scopedPkg = input.packageName.replace(/^@/, "");
    const slug = input.skillId.split(":")[1] ?? input.skillId;
    return {
      id: input.skillId,
      sourcePath: `/tmp/cinatra-test/data/skills/${scopedPkg}/${slug}/SKILL.md`,
    };
  }),
}));

describe("extension-agent skill load — catalog path (regression)", () => {
  it("registerExtensionSkill returns a sourcePath inside data/skills (not extensions/)", async () => {
    const { registerExtensionSkill } = await import("@cinatra-ai/skills");
    const result = await registerExtensionSkill({
      skillId: "@cinatra-ai/web-scrape-agent:web-scrape-agent",
      packageName: "@cinatra-ai/web-scrape-agent",
      // Raw extension path — the bridge auto-discovers this BEFORE calling
      // the preflight. After the preflight, the returned `sourcePath` is
      // the catalog-mirrored path under data/skills.
      skillMdPath: "/tmp/extensions/cinatra-ai/web-scrape-agent/skills/web-scrape-agent/SKILL.md",
    });
    // CRITICAL: the returned sourcePath is INSIDE data/skills, NOT inside
    // `extensions/`. Without this preflight, the bridge passes the raw
    // `extensions/` path to the shell tool, and `readSkillFileContent`
    // rejects it because containment is now default-root-only.
    expect(result.sourcePath).toContain("/data/skills/");
    expect(result.sourcePath).not.toContain("/extensions/");
    expect(result.sourcePath.endsWith("SKILL.md")).toBe(true);
  });
});

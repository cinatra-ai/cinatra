// resolveSkillPackageSource dispatcher tests.
//
// Lock the deterministic skill_packages.id shape per source kind:
//
//   github    → `github:${packageName}`
//   verdaccio → `verdaccio:${packageName}@${version}`
//
// install → archive → restore → uninstall must all produce the same id so
// the same row flips state without drift. Tested for both backends.

import { describe, it, expect } from "vitest";

// skill-package-source.ts is intentionally a pure-fn leaf module — no
// server-only imports — so the unit test can import it directly without
// pulling in agents-store / mcp-server / etc.
import { resolveSkillPackageSource, verdaccioSkillPackageId } from "../skill-package-source";

const baseRef = (over: Partial<{ packageName: string; version?: string }> = {}) => ({
  registryUrl: "https://example.invalid",
  packageName: "owner/repo",
  ...over,
});

describe("resolveSkillPackageSource deterministic id shape", () => {
  it("classifies bare `owner/repo` refs as github with github:<name> id", () => {
    const r = resolveSkillPackageSource(baseRef({ packageName: "owner/repo" }));
    expect(r.kind).toBe("github");
    expect(r.packageId).toBe("github:owner/repo");
  });

  it("classifies `@scope/pkg` refs without a version as verdaccio (no version in id)", () => {
    const r = resolveSkillPackageSource(baseRef({ packageName: "@anthropics/skills" }));
    expect(r.kind).toBe("verdaccio");
    // The id does NOT include version so install/archive/restore/uninstall
    // flip the same row regardless of whether the caller supplied a pin.
    // Matches the GitHub backend's `github:owner/repo` shape.
    expect(r.packageId).toBe("verdaccio:@anthropics/skills");
    expect(r.version).toBeUndefined();
  });

  it("classifies `@scope/pkg` refs with a version as verdaccio; id still has no version", () => {
    const r = resolveSkillPackageSource(
      baseRef({ packageName: "@anthropics/skills", version: "1.0.0" }),
    );
    expect(r.kind).toBe("verdaccio");
    expect(r.packageId).toBe("verdaccio:@anthropics/skills");
    expect(r.version).toBe("1.0.0");
  });

  it("treats a bare github-style name WITH a version as verdaccio (version-pinned refs are Verdaccio)", () => {
    const r = resolveSkillPackageSource(baseRef({ packageName: "owner/repo", version: "1.0.0" }));
    expect(r.kind).toBe("verdaccio");
    expect(r.packageId).toBe("verdaccio:owner/repo");
  });

  it("verdaccioSkillPackageId returns the no-version id shape", () => {
    expect(verdaccioSkillPackageId("@anthropics/skills")).toBe("verdaccio:@anthropics/skills");
    // Second arg accepted for backward-source compat with callers that already
    // pass it; ignored.
    expect(verdaccioSkillPackageId("@anthropics/skills", "1.0.0")).toBe(
      "verdaccio:@anthropics/skills",
    );
  });
});

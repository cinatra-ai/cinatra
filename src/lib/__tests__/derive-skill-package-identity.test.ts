// Unit tests for `deriveSkillPackageIdentity`.
//
// Locks (a) the packageId-prefix coverage for scanner and CLI package IDs (scanner emits
// `installed:<slug>` + CLI emits `custom:<slug>`; both must yield non-null
// `(vendor, package)` so `skill_pkg_vendor_required_chk` doesn't abort the
// transactional batch) and (b) the per-SkillLevel mapping that mirrors
// `deriveContextFromLegacy` in packages/skills/src/skills-store.ts.
//
// Imports the function via relative path because the root vitest config
// stubs `@/lib/database` to a no-op shim.

import { describe, expect, it } from "vitest";

// Relative import bypasses the @/lib/database alias stub.
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import { deriveSkillPackageIdentity } from "../database";

describe("deriveSkillPackageIdentity — packageId prefix coverage", () => {
  it("matches github:<owner>/<repo> packageIds", () => {
    const id = deriveSkillPackageIdentity({
      id: "pkg-1",
      slug: "summarize",
      level: "system",
      packageId: "github:anthropic/claude-skills",
    });
    expect(id.vendor).toBe("anthropic");
    expect(id.package).toBe("claude-skills");
  });

  it("matches zip:<slug> packageIds (uploaded ZIP)", () => {
    const id = deriveSkillPackageIdentity({
      id: "pkg-1",
      slug: "summarize",
      level: "workspace",
      packageId: "zip:summarize-pack",
    });
    expect(id.vendor).toBe("uploaded");
    expect(id.package).toBe("summarize-pack");
  });

  it("matches installed:<slug> packageIds (scanner fallback)", () => {
    const id = deriveSkillPackageIdentity({
      id: "pkg-1",
      slug: "summarize",
      level: "system",
      packageId: "installed:summarize-pack",
    });
    expect(id.vendor).toBe("installed");
    expect(id.package).toBe("summarize-pack");
  });

  it("matches custom:<slug> packageIds (CLI fallback)", () => {
    const id = deriveSkillPackageIdentity({
      id: "pkg-1",
      slug: "summarize",
      level: "agent",
      packageId: "custom:my-agent",
    });
    expect(id.vendor).toBe("custom");
    expect(id.package).toBe("my-agent");
  });

  it("falls back to (unknown, slug) for unrecognized prefixes", () => {
    // Unknown prefixes don't match any of the four known shapes, so the
    // defensive guard anchors a synthetic (vendor=unknown, package=slug)
    // pair to keep `skill_pkg_vendor_required_chk` satisfied.
    const id = deriveSkillPackageIdentity({
      id: "pkg-1",
      slug: "summarize",
      level: "personal",
      packageId: "foo:bar",
    });
    expect(id.vendor).toBe("unknown");
    expect(id.package).toBe("summarize");
  });

  it("falls back to (unknown, slug) when packageId is missing", () => {
    const id = deriveSkillPackageIdentity({
      id: "pkg-1",
      slug: "summarize",
      level: "personal",
    });
    expect(id.vendor).toBe("unknown");
    expect(id.package).toBe("summarize");
  });
});

describe("deriveSkillPackageIdentity — SkillLevel mapping", () => {
  it("personal + installedByUserId → (personal, userId, owner, user-authored)", () => {
    const id = deriveSkillPackageIdentity({
      id: "pkg-1",
      slug: "my-skill",
      level: "personal",
      installedByUserId: "user-123",
    });
    expect(id.owner_scope).toBe("personal");
    expect(id.owner_id).toBe("user-123");
    expect(id.binding_scope).toBe("owner");
    expect(id.source_kind).toBe("user-authored");
  });

  it("personal without installedByUserId → owner_id falls back to 'local-user'", () => {
    const id = deriveSkillPackageIdentity({
      id: "pkg-1",
      slug: "my-skill",
      level: "personal",
    });
    expect(id.owner_scope).toBe("personal");
    expect(id.owner_id).toBe("local-user");
  });

  it("system / workspace → (workspace, null, owner, installed)", () => {
    for (const level of ["system", "workspace"] as const) {
      const id = deriveSkillPackageIdentity({ id: "pkg-1", slug: "s", level });
      expect(id.owner_scope).toBe("workspace");
      expect(id.owner_id).toBeNull();
      expect(id.binding_scope).toBe("owner");
      expect(id.source_kind).toBe("installed");
    }
  });

  it("team / organization / project → (workspace, null, owner, user-authored) [TEMP]", () => {
    for (const level of ["team", "organization", "project"] as const) {
      const id = deriveSkillPackageIdentity({ id: "pkg-1", slug: "s", level });
      expect(id.owner_scope).toBe("workspace");
      expect(id.owner_id).toBeNull();
      expect(id.binding_scope).toBe("owner");
      expect(id.source_kind).toBe("user-authored");
    }
  });

  it("agent → (workspace, null, owner, user-authored) — binding promoted post-publish", () => {
    const id = deriveSkillPackageIdentity({ id: "pkg-1", slug: "s", level: "agent" });
    expect(id.owner_scope).toBe("workspace");
    expect(id.binding_scope).toBe("owner");
    expect(id.source_kind).toBe("user-authored");
  });

  it("undefined / unrecognized level falls through to workspace default", () => {
    const id1 = deriveSkillPackageIdentity({ id: "pkg-1", slug: "s" });
    expect(id1.owner_scope).toBe("workspace");
    expect(id1.binding_scope).toBe("owner");
    expect(id1.source_kind).toBe("user-authored");

    // Unknown string (typo or future SkillLevel) — same fallback via the
    // isSkillLevel type-guard short-circuit.
    const id2 = deriveSkillPackageIdentity({ id: "pkg-1", slug: "s", level: "made-up-level" });
    expect(id2.owner_scope).toBe("workspace");
  });

  it("skill_slug defaults to row.id when row.slug is missing", () => {
    const id = deriveSkillPackageIdentity({ id: "pkg-abc", level: "personal" });
    expect(id.skill_slug).toBe("pkg-abc");
  });

  it("skill_slug uses row.slug when present", () => {
    const id = deriveSkillPackageIdentity({ id: "pkg-1", slug: "custom-slug", level: "personal" });
    expect(id.skill_slug).toBe("custom-slug");
  });
});

describe("deriveSkillPackageIdentity — CHECK constraint satisfaction", () => {
  it("never produces (source_kind=installed AND vendor=null AND package=null) for known prefixes", () => {
    // The Postgres CHECK constraint `skill_pkg_vendor_required_chk` is:
    //   source_kind = 'user-authored' OR (vendor IS NOT NULL AND package IS NOT NULL)
    // i.e. any (installed, _, _) row must have non-null vendor + package.
    // Verify the four prefix paths all produce non-null vendor+package.
    const cases: Array<{ packageId: string; level: "system" | "workspace" }> = [
      { packageId: "github:o/r", level: "system" },
      { packageId: "zip:slug", level: "system" },
      { packageId: "installed:slug", level: "system" },
      { packageId: "custom:slug", level: "system" },
    ];
    for (const c of cases) {
      const id = deriveSkillPackageIdentity({ id: "pkg-1", slug: "s", level: c.level, packageId: c.packageId });
      expect(id.source_kind).toBe("installed");
      expect(id.vendor).not.toBeNull();
      expect(id.package).not.toBeNull();
    }
  });
});

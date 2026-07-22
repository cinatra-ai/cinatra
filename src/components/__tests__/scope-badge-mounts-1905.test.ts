/**
 * cinatra#1905 source locks: the four owner-answering ScopeBadge mounts pass
 * a resolved `ownerName` (project detail, project settings, dashboards list,
 * dashboard detail) — and the two deliberately-excluded mounts do NOT (grant
 * principals show grant subjects, not owners; skill levels have no owning
 * entity). The dashboards mounts have no render tests, so these pins keep
 * the wiring from silently regressing.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const read = (p: string) => readFileSync(p, "utf-8");

describe("ScopeBadge owner-name wiring (#1905)", () => {
  it("project detail, project settings, dashboards list and dashboard detail pass ownerName", () => {
    for (const path of [
      "src/app/projects/[projectId]/page.tsx",
      "src/app/projects/[projectId]/settings/page.tsx",
      "src/app/dashboards/page.tsx",
      "src/app/dashboards/[id]/dashboard-detail-screen.tsx",
    ]) {
      const source = read(path);
      expect(source, path).toMatch(/<ScopeBadge[\s\S]*?ownerName=/);
      // Accessible text carries the name too (codex round: aria alignment).
      expect(source, path).toMatch(/Ownership: \$\{[^}]+\} — \$\{/);
    }
  });

  it("excluded mounts stay level-only: grant principals and skills", () => {
    expect(
      read("src/app/projects/[projectId]/permissions/permissions-tab-client.tsx"),
    ).not.toContain("ownerName");
    expect(read("packages/skills/src/plugin-pages.tsx")).not.toContain("ownerName");
  });
});

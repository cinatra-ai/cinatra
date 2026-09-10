/**
 * cinatra#2807 (per-scope surfaces S1) — the sidebar `Workspace` entry.
 *
 * The workspace is the scope ABOVE every organization, so its entry sits in the
 * Management group directly after `Organizations` and is visible to every
 * authenticated user — including a single-organization instance, where the
 * sidebar hides `Organizations` by its own local title filter. The entry is
 * therefore asserted against the REAL filter (`visibleNavGroups`, the function
 * `AppSidebar` itself uses), not against a restatement of it.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

import { buildSidebarData, visibleNavGroups } from "@/components/app-sidebar";
import type { NavItem } from "@/components/layout-types";

const management = (groups: { title: string; items: NavItem[] }[]) =>
  groups.find((g) => g.title === "Management");

const titles = (items: NavItem[] | undefined) => (items ?? []).map((i) => i.title);

describe("sidebar Workspace entry (#2807)", () => {
  it("sits in Management directly after Organizations", () => {
    expect(titles(management(buildSidebarData())?.items)).toEqual([
      "Personal",
      "Projects",
      "Teams",
      "Organizations",
      "Workspace",
    ]);
  });

  it("links to /workspace and carries the workspace domain icon", () => {
    const item = management(buildSidebarData())?.items.find(
      (i) => i.title === "Workspace",
    ) as { url?: string; icon?: unknown } | undefined;
    expect(item?.url).toBe("/workspace");
    expect(item?.icon).toBeTruthy();
  });

  it("survives the singleOrg title filter that hides Organizations", () => {
    const groups = visibleNavGroups({ singleOrg: true });
    const names = titles(management(groups)?.items);
    expect(names).toContain("Workspace");
    expect(names).not.toContain("Organizations");
  });

  it("is hidden only if the server ever names it — and the layout never does", () => {
    // The entry has no NAV_TARGET_GATE key, so it is never pushed onto
    // hiddenNavTitles; the filter is proven to be the only thing that could
    // remove it.
    expect(
      titles(management(visibleNavGroups({ hiddenNavTitles: ["Workspace"] }))?.items),
    ).not.toContain("Workspace");
    expect(readFileSync("src/app/layout.tsx", "utf-8")).not.toMatch(
      /hiddenNavTitles\.push\("Workspace"\)/,
    );
  });

  it("registers no nav gate — unknown targets default to visible", () => {
    expect(readFileSync("src/lib/authz/instance-mode.ts", "utf-8")).not.toMatch(
      /^\s*workspace:\s*\{\s*resourceType/m,
    );
  });
});

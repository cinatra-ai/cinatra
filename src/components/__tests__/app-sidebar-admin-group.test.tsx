/**
 * Sidebar model — Configuration is no longer a sidebar nav entry (cinatra#1563).
 *
 * Configuration moved out of the left sidebar into a top-bar cog
 * (ConfigurationTopbarCog), so its former "Admin" group — whose SOLE remaining
 * item was Configuration after the #1558 notifications cutover retired
 * "Approvals" — no longer exists. `buildAdminGroup` was deleted; no "Admin"
 * heading renders for any viewer.
 *
 * All sidebar variants (desktop / collapsed / mobile-drawer) render from this
 * single `buildSidebarData` model, so a model-level assertion (AC7) suffices to
 * prove the absence across variants. The rendered-absence + server-side gate are
 * covered by the RBAC e2e (rbac-authorization.spec.ts) and the close-out
 * Playwright proof.
 */
import { describe, it, expect } from "vitest";

import * as AppSidebarModule from "@/components/app-sidebar";
import { buildSidebarData } from "@/components/app-sidebar";
import type { NavItem } from "@/components/layout-types";

/** Depth-first flatten of every nav item (including nested sub-items). */
function flattenItems(items: NavItem[]): NavItem[] {
  return items.flatMap((item) => {
    const sub = (item as { items?: NavItem[] }).items;
    return [item, ...(sub ? flattenItems(sub) : [])];
  });
}

describe("app-sidebar model — no Admin group, no Configuration entry (cinatra#1563)", () => {
  it("buildAdminGroup is deleted — the module no longer exports it", () => {
    expect("buildAdminGroup" in AppSidebarModule).toBe(false);
  });

  it("no sidebar group is titled 'Admin'", () => {
    const groupTitles = buildSidebarData().map((g) => g.title);
    expect(groupTitles).not.toContain("Admin");
  });

  it("no sidebar item is titled 'Configuration' or links to /configuration", () => {
    const items = flattenItems(
      buildSidebarData().flatMap((g) => g.items as NavItem[]),
    );
    const titles = items.map((i) => i.title);
    const urls = items
      .map((i) => (i as { url?: string }).url)
      .filter((u): u is string => Boolean(u));

    expect(titles).not.toContain("Configuration");
    expect(urls).not.toContain("/configuration");
    // The #1558 cutover also removed the Approvals sidebar item — assert it
    // stays gone here so a future edit can't reintroduce either entry.
    expect(titles).not.toContain("Approvals");
    expect(urls).not.toContain("/configuration/approvals");
  });
});

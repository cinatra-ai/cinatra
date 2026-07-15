/**
 * Sidebar Admin-group construction proof.
 *
 * After the E8 cutover (cinatra#1558) the standalone "Approvals" nav item and
 * its ApprovalSource-registry-driven pill were removed from the sidebar per the
 * notifications design spec §VII — approvals live only in `/notifications` now
 * (reached via the bell + repointed config cards). The Admin group is therefore
 * admin-only: its sole item is the cog → /configuration. `buildAdminGroup`
 * takes just `{ isAdmin }` and returns that group, or null for a non-admin.
 */
import { describe, it, expect } from "vitest";

import { buildAdminGroup } from "@/components/app-sidebar";

function titles(group: { items: { title: string }[] } | null): string[] {
  return (group?.items ?? []).map((i) => i.title);
}

describe("buildAdminGroup — admin-only Configuration group (post-#1558 cutover)", () => {
  it("admin: Admin group with a single Configuration item", () => {
    const g = buildAdminGroup({ isAdmin: true });
    expect(titles(g)).toEqual(["Configuration"]);
  });

  it("non-admin: no Admin group at all", () => {
    const g = buildAdminGroup({ isAdmin: false });
    expect(g).toBeNull();
  });

  it("no Approvals item is ever emitted", () => {
    const admin = buildAdminGroup({ isAdmin: true });
    const nonAdmin = buildAdminGroup({ isAdmin: false });
    expect(titles(admin)).not.toContain("Approvals");
    expect(titles(nonAdmin)).not.toContain("Approvals");
  });
});

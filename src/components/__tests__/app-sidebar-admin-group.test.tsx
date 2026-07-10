/**
 * Sidebar Admin-group construction proof for cinatra#1047 — the availability-
 * driven Approvals split. `buildAdminGroup` decides, from server-resolved
 * flags, whether the Admin → Approvals item shows (independently of the
 * admin-only Configuration item) and whether it carries the pending-count pill.
 *
 * This is the sidebar half of the change; the registry→{total,visible}
 * derivation is proved in `configuration/approvals/__tests__/nav-summary.test.ts`.
 * Together they cover "adding a source flips badge + visibility with no sidebar
 * edits": the summary flips `approvalsNavVisible` / `pendingApprovalsTotal`, and
 * this proves the sidebar reacts to exactly those two flags.
 */
import { describe, it, expect } from "vitest";

import { buildAdminGroup } from "@/components/app-sidebar";

function titles(group: { items: { title: string }[] } | null): string[] {
  return (group?.items ?? []).map((i) => i.title);
}
function approvalsItem(group: { items: { title: string; extra?: unknown }[] } | null) {
  return (group?.items ?? []).find((i) => i.title === "Approvals");
}

describe("buildAdminGroup — availability-driven Approvals split", () => {
  it("admin with pending approvals: Approvals (with pill) + Configuration", () => {
    const g = buildAdminGroup({ isAdmin: true, approvalsNavVisible: true, pendingApprovalsTotal: 3 });
    expect(titles(g)).toEqual(["Approvals", "Configuration"]);
    // Pill present when total > 0.
    expect(approvalsItem(g)?.extra).toBeDefined();
  });

  it("admin at ZERO pending: Approvals still shown, but no pill", () => {
    const g = buildAdminGroup({ isAdmin: true, approvalsNavVisible: true, pendingApprovalsTotal: 0 });
    expect(titles(g)).toEqual(["Approvals", "Configuration"]);
    expect(approvalsItem(g)?.extra).toBeUndefined();
  });

  it("non-admin with no available source: no Admin group at all (v1 behavior, unchanged)", () => {
    const g = buildAdminGroup({ isAdmin: false, approvalsNavVisible: false, pendingApprovalsTotal: 0 });
    expect(g).toBeNull();
  });

  it("non-admin granted an actionable source: Approvals lights up WITHOUT Configuration (future #1032 path)", () => {
    const g = buildAdminGroup({ isAdmin: false, approvalsNavVisible: true, pendingApprovalsTotal: 2 });
    expect(titles(g)).toEqual(["Approvals"]);
    expect(approvalsItem(g)?.extra).toBeDefined();
  });

  it("admin whose approvals summary soft-failed to hidden: Configuration only (no Approvals)", () => {
    const g = buildAdminGroup({ isAdmin: true, approvalsNavVisible: false, pendingApprovalsTotal: 0 });
    expect(titles(g)).toEqual(["Configuration"]);
  });
});

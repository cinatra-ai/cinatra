/**
 * cinatra#1897 B4 — failure containment for the scope Dashboards section.
 *
 * When the tab's server read (`getScopeDashboardsTabData` — Home/Listed rows +
 * the entity-name labels) fails, the surface must degrade to the DESIGNED error
 * frame (§IX/§X data-state "error": "Couldn't load this scope's dashboards")
 * instead of bubbling an unhandled Next 500 up through the route. This proves the
 * async server component catches a service throw and returns
 * `ScopeDashboardsTabError`, and still returns the real tab on success.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/dashboards/scope-dashboards-service", () => ({
  getScopeDashboardsTabData: vi.fn(),
}));

// Stub the server-action module so the success path's `.bind` targets resolve
// without pulling the server-action graph (auth-session, the service, …).
vi.mock("@/app/dashboards/scope-dashboards-actions", () => ({
  scopeListCandidatesAction: vi.fn(),
  scopeAddListingAction: vi.fn(),
  scopeRemoveListingAction: vi.fn(),
  scopeRequestPromotionAction: vi.fn(),
}));

import { ScopeDashboardsSection } from "@/components/dashboards/scope-dashboards-section";
import {
  ScopeDashboardsTab,
  ScopeDashboardsTabError,
} from "@/components/dashboards/scope-dashboards-tab";
import { getScopeDashboardsTabData } from "@/lib/dashboards/scope-dashboards-service";

const scope = { kind: "team" as const, scopeId: "team-1", orgId: "org-1" };
const actor = { organizationId: "org-1", principalId: "u1" } as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ScopeDashboardsSection — failure containment (§IX/§X error frame)", () => {
  it("returns the designed error frame when the service throws (no 500 bubbles)", async () => {
    vi.mocked(getScopeDashboardsTabData).mockRejectedValueOnce(
      // The exact class the P1 produced: a DrizzleQueryError over the malformed
      // ANY(array) binding.
      new Error("DrizzleQueryError: malformed array literal"),
    );
    const el = (await ScopeDashboardsSection({
      actor,
      scope,
      scopeLabel: "Team: Growth",
    })) as { type: unknown };
    expect(el.type).toBe(ScopeDashboardsTabError);
  });

  it("returns the real tab when the service resolves", async () => {
    vi.mocked(getScopeDashboardsTabData).mockResolvedValueOnce({
      scopeLabel: "Team: Growth",
      rows: [],
      canManage: true,
    });
    const el = (await ScopeDashboardsSection({
      actor,
      scope,
      scopeLabel: "Team: Growth",
    })) as { type: unknown };
    expect(el.type).toBe(ScopeDashboardsTab);
  });
});

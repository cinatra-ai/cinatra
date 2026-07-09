/**
 * Pure proof for the direction section planner that drives the 4-state
 * marketplace connectivity model on the page:
 *  (a) nothing connected            → ONE group Empty, no per-section render;
 *  (b) a section's credential absent → hidden + surfaced in the footer;
 *  (c)/(d) connected                → the section renders (SourceSection then
 *      resolves ready/error/empty).
 * Uses fake sources — the planner imports only types, never a server/DB chain.
 */
import { describe, expect, it } from "vitest";

import { planApprovalSections, isEmptyPlan } from "../section-plan";
import type { ApprovalSource, ApprovalViewer, Direction } from "../types";

const GROUP = "marketplace";
const viewer: ApprovalViewer = { userId: "u1", orgId: "o1", isAdmin: true };

function fake(
  id: string,
  opts: { group?: string; configured?: boolean } = {},
): ApprovalSource {
  return {
    id,
    title: id,
    group: opts.group,
    availability: () => "ready",
    appliesTo: () => true,
    sectionConfigured: opts.configured === undefined ? undefined : () => opts.configured!,
    fetchInbox: async () => ({ availability: "ready", rows: [], actions: [] }),
    fetchMine: async () => ({ availability: "ready", rows: [], actions: [] }),
    counts: async () => ({ inbox: 0, mine: 0 }),
    rowRenderer: () => null,
    actions: { decide: async () => ({ ok: true }) },
  };
}

const dir: Direction = "inbox";

describe("planApprovalSections", () => {
  it("keeps ungrouped (local) sources separate from the group", () => {
    const plan = planApprovalSections([fake("local"), fake("mp", { group: GROUP })], viewer, dir, {
      tag: GROUP,
      connected: true,
    });
    expect(plan.local.map((s) => s.id)).toEqual(["local"]);
    expect(plan.groupReady.map((s) => s.id)).toEqual(["mp"]);
  });

  it("(a) collapses the WHOLE group to one Empty when nothing is connected", () => {
    const plan = planApprovalSections(
      [fake("local"), fake("mp1", { group: GROUP }), fake("mp2", { group: GROUP })],
      viewer,
      dir,
      { tag: GROUP, connected: false },
    );
    expect(plan.showGroupEmpty).toBe(true);
    expect(plan.groupReady).toHaveLength(0);
    expect(plan.groupHidden).toHaveLength(0); // not consulted when disconnected
    expect(plan.local.map((s) => s.id)).toEqual(["local"]); // local always renders
  });

  it("(b) hides a section whose credential is absent and lists it for the footer", () => {
    const plan = planApprovalSections(
      [fake("ready", { group: GROUP, configured: true }), fake("hidden", { group: GROUP, configured: false })],
      viewer,
      dir,
      { tag: GROUP, connected: true },
    );
    expect(plan.groupReady.map((s) => s.id)).toEqual(["ready"]);
    expect(plan.groupHidden.map((s) => s.id)).toEqual(["hidden"]);
    expect(plan.showGroupEmpty).toBe(false);
  });

  it("treats an absent sectionConfigured as configured (local sources)", () => {
    const plan = planApprovalSections([fake("mp", { group: GROUP })], viewer, dir, {
      tag: GROUP,
      connected: true,
    });
    expect(plan.groupReady.map((s) => s.id)).toEqual(["mp"]);
    expect(plan.groupHidden).toHaveLength(0);
  });

  it("no group sources ⇒ never shows the group Empty", () => {
    const plan = planApprovalSections([fake("local")], viewer, dir, { tag: GROUP, connected: false });
    expect(plan.showGroupEmpty).toBe(false);
    expect(plan.local.map((s) => s.id)).toEqual(["local"]);
  });

  it("isEmptyPlan is true only when there is genuinely nothing to render", () => {
    expect(isEmptyPlan({ local: [], groupReady: [], groupHidden: [], showGroupEmpty: false })).toBe(true);
    expect(isEmptyPlan({ local: [], groupReady: [], groupHidden: [], showGroupEmpty: true })).toBe(false);
    expect(
      isEmptyPlan({ local: [], groupReady: [], groupHidden: [fake("h", { group: GROUP })], showGroupEmpty: false }),
    ).toBe(false);
  });
});

// @vitest-environment jsdom
// The crumb-contributions bus (cinatra#1737): a replaceable, route-scoped
// snapshot keyed to (pathname, session/org epoch) — NOT an immortal merge map.
// Covers the ratified semantics: wholesale replacement per publish, soft-nav
// seeding of replacement entries within an epoch, insertion entries confined
// to their publishing route, epoch fencing, negative clearing, refresh
// (fresh module state), and back-nav (a re-publish from the revisited route).
// Two-tab independence holds structurally — the bus is per-tab module state.
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearCrumbContributions,
  getCrumbSnapshot,
  publishCrumbContributions,
  selectCrumbContributions,
  CRUMB_CONTRIBUTIONS_EVENT,
} from "../breadcrumb-contributions";

const EPOCH = "user-1:org-1";
const TEAM = "/teams/9c0dfce6-b2cb-4dab-8a01-661ca3288b9a";

beforeEach(() => {
  clearCrumbContributions();
});

describe("publish/select — route-scoped snapshot", () => {
  it("a publish REPLACES the snapshot wholesale (no cross-route accumulation)", () => {
    publishCrumbContributions(TEAM, EPOCH, [{ prefix: TEAM, label: "Best Team Ever" }]);
    publishCrumbContributions("/dashboards/d-1", EPOCH, [
      { prefix: "/dashboards/d-1", label: "Ops" },
    ]);
    // The old route's entry is gone — not merged.
    expect(selectCrumbContributions(TEAM, EPOCH)).toEqual([]);
    expect(selectCrumbContributions("/dashboards/d-1", EPOCH)).toEqual([
      { prefix: "/dashboards/d-1", label: "Ops" },
    ]);
  });

  it("soft-nav seeding: replacement entries apply to a DEEPER path within the same epoch (X → X/settings)", () => {
    publishCrumbContributions(TEAM, EPOCH, [{ prefix: TEAM, label: "Best Team Ever" }]);
    expect(selectCrumbContributions(`${TEAM}/settings`, EPOCH)).toEqual([
      { prefix: TEAM, label: "Best Team Ever" },
    ]);
  });

  it("replacement entries never apply to an unrelated path (stale-route guard)", () => {
    publishCrumbContributions(TEAM, EPOCH, [{ prefix: TEAM, label: "Best Team Ever" }]);
    expect(selectCrumbContributions("/teams/other-id", EPOCH)).toEqual([]);
  });

  it("insertion entries apply ONLY while the publishing route is current", () => {
    const entries = [
      { prefix: "/dashboards/d-1", label: "Ops" },
      { prefix: TEAM, label: "Best Team Ever", insertBefore: "/dashboards/d-1" },
    ];
    publishCrumbContributions("/dashboards/d-1", EPOCH, entries);
    // On the publishing route: both apply.
    expect(selectCrumbContributions("/dashboards/d-1", EPOCH)).toHaveLength(2);
    // On a deeper path: the insertion is dropped, the replacement seeds.
    expect(selectCrumbContributions("/dashboards/d-1/x", EPOCH)).toEqual([
      { prefix: "/dashboards/d-1", label: "Ops" },
    ]);
  });

  it("last-per-prefix wins within one publish (dedupe at publish)", () => {
    publishCrumbContributions(TEAM, EPOCH, [
      { prefix: TEAM, label: "Old" },
      { prefix: TEAM, label: "New" },
    ]);
    expect(selectCrumbContributions(TEAM, EPOCH)).toEqual([
      { prefix: TEAM, label: "New" },
    ]);
  });

  it("back-nav: a re-publish from the revisited route restores its entries", () => {
    publishCrumbContributions(TEAM, EPOCH, [{ prefix: TEAM, label: "Best Team Ever" }]);
    publishCrumbContributions("/dashboards/d-1", EPOCH, [
      { prefix: "/dashboards/d-1", label: "Ops" },
    ]);
    publishCrumbContributions(TEAM, EPOCH, [{ prefix: TEAM, label: "Best Team Ever" }]);
    expect(selectCrumbContributions(TEAM, EPOCH)).toEqual([
      { prefix: TEAM, label: "Best Team Ever" },
    ]);
  });
});

describe("epoch fencing + clearing", () => {
  it("a snapshot from another epoch is never applied (session/org switch)", () => {
    publishCrumbContributions(TEAM, "user-1:org-1", [
      { prefix: TEAM, label: "Best Team Ever" },
    ]);
    expect(selectCrumbContributions(TEAM, "user-1:org-2")).toEqual([]);
    expect(selectCrumbContributions(TEAM, "user-2:org-1")).toEqual([]);
  });

  it("negative clearing wipes the snapshot (404 / not-authorized visit)", () => {
    publishCrumbContributions(TEAM, EPOCH, [{ prefix: TEAM, label: "Best Team Ever" }]);
    clearCrumbContributions();
    // The previously-authorized label can never render again without a fresh
    // post-gate publish.
    expect(getCrumbSnapshot()).toBeNull();
    expect(selectCrumbContributions(TEAM, EPOCH)).toEqual([]);
  });

  it("refresh semantics: module state starts empty (placeholder until the island publishes)", () => {
    // beforeEach cleared — a fresh consult finds nothing.
    expect(selectCrumbContributions(TEAM, EPOCH)).toEqual([]);
  });
});

describe("live event (streaming arrival)", () => {
  it("publish and clear both dispatch the changed event for mounted consumers", () => {
    const seen = vi.fn();
    window.addEventListener(CRUMB_CONTRIBUTIONS_EVENT, seen);
    publishCrumbContributions(TEAM, EPOCH, [{ prefix: TEAM, label: "Best Team Ever" }]);
    clearCrumbContributions();
    window.removeEventListener(CRUMB_CONTRIBUTIONS_EVENT, seen);
    expect(seen).toHaveBeenCalledTimes(2);
  });
});

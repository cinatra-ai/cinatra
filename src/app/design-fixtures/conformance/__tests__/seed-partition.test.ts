import { describe, it, expect } from "vitest";

import {
  SEEDED_CONNECTOR_ALL_COUNT,
  SEEDED_CONNECTOR_CARDS,
  SEEDED_CONNECTOR_CONNECTED_COUNT,
  SEEDED_CONNECTOR_DISCONNECTED_COUNT,
  SEEDED_GRID_CARD_COUNT,
  SEEDED_INSTALLED_ACTIVE_COUNT,
  SEEDED_INSTALLED_ALL_COUNT,
  SEEDED_INSTALLED_ARCHIVED_COUNT,
  SEEDED_INSTALLED_EXTENSIONS,
  SEEDED_INSTALLED_LOCKED_COUNT,
} from "../seed-data";

// The status-filter partition contract (cinatra#1571): the seeded installed kit
// must back the four views the filter now offers — All / Active / Locked /
// Archived — with a CLEAN partition (Active/Locked/Archived disjoint by status,
// All their union) and counts that stay pairwise-distinct so a driver counting
// the wrong collection cannot accidentally pass (the seed-data cardinality
// invariant). Automated here at the unit level; the live render of each view is
// proven on the seeded harness.
describe("seeded installed-extension status partition (cinatra#1571)", () => {
  it("has the expected per-status counts (4 active, 1 locked, 2 archived, 7 all)", () => {
    expect(SEEDED_INSTALLED_ACTIVE_COUNT).toBe(4);
    expect(SEEDED_INSTALLED_LOCKED_COUNT).toBe(1);
    expect(SEEDED_INSTALLED_ARCHIVED_COUNT).toBe(2);
    expect(SEEDED_INSTALLED_ALL_COUNT).toBe(7);
  });

  it("is a clean partition: active + locked + archived === all (no row dropped or double-counted)", () => {
    expect(
      SEEDED_INSTALLED_ACTIVE_COUNT +
        SEEDED_INSTALLED_LOCKED_COUNT +
        SEEDED_INSTALLED_ARCHIVED_COUNT,
    ).toBe(SEEDED_INSTALLED_ALL_COUNT);
  });

  it("every seeded row carries one of the three lifecycle statuses", () => {
    for (const row of SEEDED_INSTALLED_EXTENSIONS) {
      expect(["active", "locked", "archived"]).toContain(row.status);
    }
    // Sum of the three status buckets accounts for every row exactly once.
    const byStatus = { active: 0, locked: 0, archived: 0 };
    for (const row of SEEDED_INSTALLED_EXTENSIONS) byStatus[row.status] += 1;
    expect(byStatus.active).toBe(SEEDED_INSTALLED_ACTIVE_COUNT);
    expect(byStatus.locked).toBe(SEEDED_INSTALLED_LOCKED_COUNT);
    expect(byStatus.archived).toBe(SEEDED_INSTALLED_ARCHIVED_COUNT);
  });

  it("has exactly one locked row (the anti-lookalike locked fixture)", () => {
    const locked = SEEDED_INSTALLED_EXTENSIONS.filter((r) => r.status === "locked");
    expect(locked).toHaveLength(1);
    expect(locked[0].base).toBe("sentinel-guard");
    expect(locked[0].displayName).toBe("Perimeter Watchtower");
    // Anti-lookalike: the displayName shares no token with the package base.
    const baseTokens = new Set(locked[0].base.split("-"));
    for (const token of locked[0].displayName.toLowerCase().split(/\s+/)) {
      expect(baseTokens.has(token)).toBe(false);
    }
  });

  it("keeps every cross-wireable count pairwise-distinct", () => {
    const counts = [
      SEEDED_GRID_CARD_COUNT, // 6
      SEEDED_INSTALLED_ACTIVE_COUNT, // 4
      SEEDED_INSTALLED_LOCKED_COUNT, // 1
      SEEDED_INSTALLED_ARCHIVED_COUNT, // 2
      SEEDED_INSTALLED_ALL_COUNT, // 7
      SEEDED_CONNECTOR_CONNECTED_COUNT, // 3
      SEEDED_CONNECTOR_DISCONNECTED_COUNT, // 5
      // cinatra#2355 (epic #2353): the All segment is the new DEFAULT view, so
      // 8 joins the cross-wireable set. It must stay distinct from every count
      // above or a driver asserting the All cardinality could pass while
      // counting the wrong collection.
      SEEDED_CONNECTOR_ALL_COUNT, // 8
    ];
    expect(new Set(counts).size).toBe(counts.length);
  });
});

// The connector partition contract (cinatra#2355, epic cinatra#2353): with the
// three-state filter the seeded connector kit must back all THREE views — All /
// Connected / Disconnected — as a clean partition, so the round-trip the
// functional-acceptance driver asserts (8 ⇄ 3 ⇄ 5) can only pass on a grid that
// really re-filters. The live render of each view is proven on the seeded
// harness.
describe("seeded connector connection-state partition (cinatra#2355)", () => {
  it("has the expected per-state counts (8 all, 3 connected, 5 disconnected)", () => {
    expect(SEEDED_CONNECTOR_ALL_COUNT).toBe(8);
    expect(SEEDED_CONNECTOR_CONNECTED_COUNT).toBe(3);
    expect(SEEDED_CONNECTOR_DISCONNECTED_COUNT).toBe(5);
  });

  it("is a clean partition: connected + disconnected === all (no card dropped or double-counted)", () => {
    expect(SEEDED_CONNECTOR_CONNECTED_COUNT + SEEDED_CONNECTOR_DISCONNECTED_COUNT).toBe(
      SEEDED_CONNECTOR_ALL_COUNT,
    );
  });

  it("keeps the three connector counts pairwise-distinct on their own", () => {
    // A driver that clicked the wrong segment, or a pass-all predicate that
    // silently fell through to a status arm, cannot land on a matching count.
    const counts = [
      SEEDED_CONNECTOR_ALL_COUNT,
      SEEDED_CONNECTOR_CONNECTED_COUNT,
      SEEDED_CONNECTOR_DISCONNECTED_COUNT,
    ];
    expect(new Set(counts).size).toBe(counts.length);
  });

  it("counts the forced-error card in the DISCONNECTED bucket (fail-soft containment)", () => {
    // cinatra#110: the throwing probe degrades that ONE card to "not
    // connected". It is therefore part of the 5, and part of the 8 — the All
    // view must not hide a card whose probe failed.
    const errored = SEEDED_CONNECTOR_CARDS.filter((c) => c.probeThrows);
    expect(errored).toHaveLength(1);
    expect(errored[0].connected).toBe(false);
  });
});

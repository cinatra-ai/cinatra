// freshnessCheckForChangeSet coverage.

import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ resolveExternalFreshness: vi.fn() }));
vi.mock("../resolve", () => ({
  resolveExternalFreshness: mocks.resolveExternalFreshness,
}));

import { freshnessCheckForChangeSet } from "../check-change-set";
import type { LoadedChangeSet } from "../../eligibility";

function loaded(events: Array<Partial<{ id: string; objectId: string; remoteRevisionRef: unknown }>>): LoadedChangeSet {
  return {
    changeSet: { id: "cs_1" } as never,
    events: events.map((e) => ({
      id: e.id ?? "evt",
      objectId: e.objectId ?? "obj",
      remoteRevisionRef: e.remoteRevisionRef ?? null,
    })) as never,
  };
}

describe("freshnessCheckForChangeSet", () => {
  beforeEach(() => mocks.resolveExternalFreshness.mockReset());

  it("returns a verdict ONLY for CMS-tagged (remoteRevisionRef) events", async () => {
    mocks.resolveExternalFreshness.mockResolvedValue(
      new Map([["obj_cms", { state: "fresh", baseRevision: "r1" }]]),
    );
    const results = await freshnessCheckForChangeSet(
      loaded([
        { id: "e1", objectId: "obj_cms", remoteRevisionRef: { connector: "wordpress" } },
        { id: "e2", objectId: "obj_local", remoteRevisionRef: null },
      ]),
      { orgId: "org_1" },
    );
    expect(results).toEqual([
      { eventId: "e1", objectId: "obj_cms", freshness: { state: "fresh", baseRevision: "r1" } },
    ]);
  });

  it("falls back to unknown when the freshness map has no entry for a CMS event", async () => {
    mocks.resolveExternalFreshness.mockResolvedValue(new Map());
    const results = await freshnessCheckForChangeSet(
      loaded([{ id: "e1", objectId: "obj_cms", remoteRevisionRef: { connector: "x" } }]),
      { orgId: "org_1" },
    );
    expect(results[0].freshness).toEqual({ state: "unknown", reason: "not resolved" });
  });

  it("skips redacted events (remoteRevisionRef scrubbed to null) — no remote-status leak", async () => {
    mocks.resolveExternalFreshness.mockResolvedValue(new Map());
    const results = await freshnessCheckForChangeSet(
      loaded([{ id: "e1", objectId: "obj_redacted", remoteRevisionRef: null }]),
      { orgId: "org_1" },
    );
    expect(results).toEqual([]);
  });
});

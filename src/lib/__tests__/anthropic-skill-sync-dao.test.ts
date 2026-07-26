/**
 * `anthropic_skill_sync` DAO write-clause regression tests.
 *
 * The GC stale-age grace window is anchored on `stale_at`. Two clauses must
 * hold together or the grace window can be bypassed:
 *
 *  - REACTIVATION (`upsertSyncRow` onConflict) MUST reset `stale_at` to NULL —
 *    otherwise a later stale transition (which COALESCE-preserves an existing
 *    `stale_at`) inherits the OLD pre-reactivation timestamp and can age past
 *    the grace window immediately.
 *  - MARK-STALE (`markSyncRowStale` / removed-catalog sweep) must COALESCE —
 *    stamping `now()` only on the false→true transition, never resetting an
 *    already-stale row's clock.
 *
 * These assert the emitted drizzle SET clauses (the repo's DAOs are unit-tested
 * against a mocked store; there is no real-PG harness for them). The GC engine's
 * consumption of a fresh vs aged `stale_at` is covered separately in
 * `anthropic-skill-gc-engine.test.ts`.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  const captured: {
    insertValues?: Record<string, unknown>;
    onConflictSet?: Record<string, unknown>;
    updateSets: Record<string, unknown>[];
  } = { updateSets: [] };
  const insertChain = {
    values: (v: Record<string, unknown>) => {
      captured.insertValues = v;
      return {
        onConflictDoUpdate: (arg: { set: Record<string, unknown> }) => {
          captured.onConflictSet = arg.set;
          return Promise.resolve();
        },
      };
    },
  };
  const updateChain = {
    set: (s: Record<string, unknown>) => {
      captured.updateSets.push(s);
      return { where: () => Promise.resolve() };
    },
  };
  const db = {
    insert: () => insertChain,
    update: () => updateChain,
  };
  return { captured, db };
});

vi.mock("@/lib/anthropic-skill-sync-store", () => ({
  // Column tokens the DAO references in target/where clauses — plain markers are
  // enough because drizzle-orm's and/eq/notInArray are mocked to passthrough.
  anthropicSkillSync: new Proxy(
    {},
    { get: (_t, prop) => ({ column: String(prop) }) },
  ),
  anthropicSkillSyncDb: h.db,
}));

vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => ({ and: a }),
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  notInArray: (a: unknown, b: unknown) => ({ notInArray: [a, b] }),
  sql: (strings: TemplateStringsArray, ...vals: unknown[]) => ({
    sqlText: strings.join("?"),
    vals,
  }),
}));

import {
  upsertSyncRow,
  markSyncRowStale,
  markStaleForRemovedCatalogSkills,
} from "@/lib/anthropic-skill-sync-dao";

beforeEach(() => {
  h.captured.insertValues = undefined;
  h.captured.onConflictSet = undefined;
  h.captured.updateSets = [];
});

describe("upsertSyncRow — reactivation resets stale_at", () => {
  it("clears stale AND stale_at on conflict (grace-window bypass fix)", async () => {
    await upsertSyncRow("fp", "env", {
      catalogSkillId: "cat-a",
      anthropicSkillId: "skill_1",
      anthropicVersion: "v1",
      contentHash: "h1",
    });
    const set = h.captured.onConflictSet!;
    expect(set.stale).toBe(false);
    // The regression guard: stale_at MUST be an explicit null reset, not absent
    // (absent would leave the stale row's old timestamp in place) and not a
    // COALESCE (that would preserve it).
    expect("staleAt" in set).toBe(true);
    expect(set.staleAt).toBeNull();
    // Fresh insert path also carries no stale_at (defaults to null).
    expect(h.captured.insertValues!.stale).toBe(false);
    expect(h.captured.insertValues!.staleAt).toBeUndefined();
  });
});

describe("markSyncRowStale / removed-catalog sweep — COALESCE preserve", () => {
  it("stamps stale_at only on the false→true transition (never resets an aged clock)", async () => {
    await markSyncRowStale("fp", "env", "cat-a");
    const set = h.captured.updateSets[0];
    expect(set.stale).toBe(true);
    // A COALESCE marker, NOT a bare null — an already-stale row keeps its clock.
    expect(set.staleAt).toMatchObject({ sqlText: expect.stringMatching(/coalesce/i) });
  });

  it("the removed-catalog sweep uses the same COALESCE preserve", async () => {
    await markStaleForRemovedCatalogSkills("fp", "env", ["keep-1"]);
    const set = h.captured.updateSets[0];
    expect(set.stale).toBe(true);
    expect(set.staleAt).toMatchObject({ sqlText: expect.stringMatching(/coalesce/i) });
  });
});

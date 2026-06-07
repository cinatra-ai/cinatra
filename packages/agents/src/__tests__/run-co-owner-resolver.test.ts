/**
 * TDD coverage for the resolveRunCoOwnerUserIds helper.
 *
 * The four cases cover empty results, a single owner, ordered de-duplication,
 * and propagated read errors.
 *
 * Mocking strategy: mock the Drizzle db layer (../db) to control what
 * readRunCoOwners returns. Since resolveRunCoOwnerUserIds and readRunCoOwners
 * live in the same ES module, vi.spyOn on the export binding would not
 * intercept the internal call; mocking the underlying DB avoids that
 * limitation and keeps tests fully in-process.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mutable state - vi.mock factories run before module-scope code.
// ---------------------------------------------------------------------------

const shared = vi.hoisted(() => {
  return {
    rows: [] as Array<{
      runId: string;
      userId: string;
      grantedBy: string;
      grantedAt: Date;
    }>,
    shouldThrow: false as boolean | string,
  };
});

// ---------------------------------------------------------------------------
// Drizzle-like chained query stub.
// ---------------------------------------------------------------------------

vi.mock("../db", () => {
  function makeChain() {
    const chain: Record<string, unknown> = {};
    for (const stage of ["from", "where", "orderBy", "limit", "offset", "innerJoin", "leftJoin"]) {
      (chain as Record<string, () => unknown>)[stage] = () => chain;
    }
    chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
      if (shared.shouldThrow) {
        const msg = typeof shared.shouldThrow === "string" ? shared.shouldThrow : "DB failure";
        return Promise.reject(new Error(msg)).then(resolve, reject);
      }
      return Promise.resolve(shared.rows.map((r) => ({
        runId: r.runId,
        userId: r.userId,
        grantedBy: r.grantedBy,
        grantedAt: r.grantedAt,
      }))).then(resolve, reject);
    };
    return chain;
  }

  const db = {
    select: () => makeChain(),
  };

  return {
    db,
    agentBuilderPool: { on: () => {}, listenerCount: () => 1, end: vi.fn() },
  };
});

// ---------------------------------------------------------------------------
// Imports under test (AFTER mocks are set up)
// ---------------------------------------------------------------------------

import { resolveRunCoOwnerUserIds } from "../store";

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("resolveRunCoOwnerUserIds", () => {
  beforeEach(() => {
    shared.rows = [];
    shared.shouldThrow = false;
  });

  it("Test 1: returns [] when readRunCoOwners returns []", async () => {
    shared.rows = [];
    const result = await resolveRunCoOwnerUserIds("run-empty");
    expect(result).toEqual([]);
  });

  it("Test 2: returns [userId] when readRunCoOwners returns single row", async () => {
    shared.rows = [
      { runId: "run-1", userId: "u1", grantedBy: "admin", grantedAt: new Date() },
    ];
    const result = await resolveRunCoOwnerUserIds("run-1");
    expect(result).toEqual(["u1"]);
  });

  it("Test 3: deduplicates userId preserving first-seen order", async () => {
    shared.rows = [
      { runId: "run-2", userId: "u1", grantedBy: "admin", grantedAt: new Date() },
      { runId: "run-2", userId: "u2", grantedBy: "admin", grantedAt: new Date() },
      { runId: "run-2", userId: "u1", grantedBy: "admin", grantedAt: new Date() },
    ];
    const result = await resolveRunCoOwnerUserIds("run-2");
    expect(result).toEqual(["u1", "u2"]);
  });

  it("Test 4: propagates errors thrown by readRunCoOwners", async () => {
    shared.shouldThrow = "DB failure";
    await expect(resolveRunCoOwnerUserIds("run-err")).rejects.toThrow("DB failure");
  });
});

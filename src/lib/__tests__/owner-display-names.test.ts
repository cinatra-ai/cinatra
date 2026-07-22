/**
 * readOwnerDisplayNames (cinatra#1905) — the one owner-name resolver behind
 * <ScopeBadge ownerName>:
 *   - BATCH: dedupes ids, issues AT MOST ONE query per level present
 *   - ignores invalid refs (empty/whitespace ids, non-owner levels)
 *   - user names fall back to email; blank names never enter the map
 *   - degrades PER LEVEL: one failing lookup drops only that level's names
 *   - never throws
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  execute: vi.fn(),
}));

vi.mock("@/lib/better-auth-db", () => ({
  betterAuthDb: { execute: h.execute },
}));

import {
  readOwnerDisplayNames,
  readOwnerDisplayName,
  ownerNameKey,
  type OwnerRef,
} from "../owner-display-names";

// The mock sees drizzle SQL objects; route responses by the table named in
// the query chunks.
function sqlTextOf(query: unknown): string {
  return JSON.stringify(query);
}

beforeEach(() => {
  h.execute.mockReset();
});

describe("readOwnerDisplayNames (#1905)", () => {
  it("batches: dedupes ids and issues one query per level present", async () => {
    h.execute.mockImplementation(async (q: unknown) => {
      const text = sqlTextOf(q);
      // Only the user query selects `email`; only the team query names `team`.
      if (text.includes("email")) {
        return { rows: [{ id: "u1", name: "Jane Doe", email: "j@x.com" }] };
      }
      if (text.includes("team")) {
        return { rows: [{ id: "t1", name: "Best Team Ever" }] };
      }
      return { rows: [] };
    });

    const refs: OwnerRef[] = [
      { level: "user", id: "u1" },
      { level: "user", id: "u1" }, // duplicate — must not widen the query set
      { level: "team", id: "t1" },
    ];
    const names = await readOwnerDisplayNames(refs);

    expect(h.execute).toHaveBeenCalledTimes(2); // one per level, not per ref
    expect(names.get(ownerNameKey("user", "u1"))).toBe("Jane Doe");
    expect(names.get(ownerNameKey("team", "t1"))).toBe("Best Team Ever");
  });

  it("ignores invalid refs entirely (no query for them)", async () => {
    const names = await readOwnerDisplayNames([
      { level: "user", id: "   " },
      { level: "workspace", id: "w1" } as unknown as OwnerRef,
      { level: "project", id: "p1" } as unknown as OwnerRef,
    ]);
    expect(h.execute).not.toHaveBeenCalled();
    expect(names.size).toBe(0);
  });

  it("user names fall back to email; blank names never enter the map", async () => {
    h.execute.mockResolvedValueOnce({
      rows: [
        { id: "u1", name: null, email: "fallback@x.com" },
        { id: "u2", name: "  ", email: "  " },
      ],
    });
    const names = await readOwnerDisplayNames([
      { level: "user", id: "u1" },
      { level: "user", id: "u2" },
    ]);
    expect(names.get(ownerNameKey("user", "u1"))).toBe("fallback@x.com");
    expect(names.has(ownerNameKey("user", "u2"))).toBe(false);
  });

  it("degrades PER LEVEL: a failing team lookup keeps resolved user names", async () => {
    h.execute.mockImplementation(async (q: unknown) => {
      const text = sqlTextOf(q);
      if (text.includes("team")) throw new Error("pg down");
      if (text.includes("email")) {
        return { rows: [{ id: "u1", name: "Jane Doe", email: null }] };
      }
      return { rows: [] };
    });
    const names = await readOwnerDisplayNames([
      { level: "user", id: "u1" },
      { level: "team", id: "t1" },
    ]);
    expect(names.get(ownerNameKey("user", "u1"))).toBe("Jane Doe");
    expect(names.has(ownerNameKey("team", "t1"))).toBe(false);
  });

  it("never throws — full outage yields an empty map", async () => {
    h.execute.mockRejectedValue(new Error("pg down"));
    const names = await readOwnerDisplayNames([
      { level: "user", id: "u1" },
      { level: "organization", id: "o1" },
    ]);
    expect(names.size).toBe(0);
  });
});

describe("readOwnerDisplayName (single-ref convenience)", () => {
  it("resolves through the batch read", async () => {
    h.execute.mockResolvedValueOnce({ rows: [{ id: "o1", name: "Acme Inc" }] });
    await expect(readOwnerDisplayName("organization", "o1")).resolves.toBe("Acme Inc");
  });

  it("returns null for non-owner levels without querying", async () => {
    await expect(readOwnerDisplayName("workspace", "w1")).resolves.toBeNull();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("returns null when unresolved", async () => {
    h.execute.mockResolvedValueOnce({ rows: [] });
    await expect(readOwnerDisplayName("team", "missing")).resolves.toBeNull();
  });
});

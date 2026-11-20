import { describe, expect, it } from "vitest";
import { electCurrentReviewGate } from "../run-step-rail";

// cinatra#3035: among review gates raised at one instant the election follows a
// total order (the id before `#`, the member number, the whole id; ids by code
// units), so the elected gate never depends on the order the gates are read in.
const gate = (reviewTaskId: string) => ({ reviewTaskId, status: "pending", createdAt: "2026-10-01T00:00:00.000Z" });
const elect = (ids: readonly string[]) => electCurrentReviewGate(ids.map(gate))?.reviewTaskId;

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map(rest => [item, ...rest]));
}

// Every read order elects the same gate, and that gate also wins each pair in
// both orders: no pair compares equal and the order has no cycle.
function expectTotal(ids: readonly string[]): string | undefined {
  const winner = elect(ids);
  for (const order of permutations(ids)) expect(elect(order)).toBe(winner);
  for (const other of ids) {
    if (other === winner) continue;
    expect(elect([winner!, other])).toBe(winner);
    expect(elect([other, winner!])).toBe(winner);
  }
  return winner;
}

describe("equal-time review gates elect by a total order (cinatra#3035)", () => {
  it("keeps canonically equivalent ids distinct, so the read order cannot change the election", () => {
    // "\u00e9" (precomposed) and "e\u0301" (decomposed) are one letter in two spellings.
    expect(expectTotal(["\u00e9#3", "e\u0301#2", "\u00e9#2"])).toBe("e\u0301#2");
    expect(expectTotal(["\u00e9", "e\u0301"])).toBe("e\u0301");
  });

  it("orders a family by member number, #10 after #9, and other ids by code units", () => {
    expect(expectTotal(["x#10", "x#9", "x#2", "x"])).toBe("x");
    expect(expectTotal(["x#10", "x#9"])).toBe("x#9");
    expect(expectTotal(["task_2", "task#2", "task.1", "task-1"])).toBe("task#2");
    expect(expectTotal(["task-a", "task-A", "task-Z"])).toBe("task-A");
  });

  it("is independent of the read order on seeded random id sets", () => {
    // Family ids over bases that include both spellings of one accented letter,
    // and bases that differ in case, punctuation and digits.
    const bases = ["w\u00e9", "we\u0301", "w", "wa", "wA", "w_", "w-", "w.1"];
    const members = ["", "#2", "#3", "#9", "#10", "#x"];
    let seed = 3035;
    const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
    const pick = (items: readonly string[]) => items[Math.floor(next() * items.length)];
    for (let round = 0; round < 200; round++) {
      const ids = new Set<string>();
      while (ids.size < 4) ids.add(pick(bases) + pick(members));
      expectTotal([...ids]);
    }
  });
});

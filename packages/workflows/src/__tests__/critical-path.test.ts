import { describe, it, expect } from "vitest";
import { computeCriticalPath, type CpmTaskRow, type CpmEdge } from "../schedule/critical-path";

// All tasks have whole-day windows (start/end in epoch-ms) for clarity.
const DAY = 86_400_000;
const day = (n: number) => n * DAY;

function rows(spec: Array<{ key: string; start: number; end: number; parent?: string }>): CpmTaskRow[] {
  return spec.map((s) => ({ key: s.key, parentKey: s.parent, startMs: s.start, endMs: s.end }));
}

function edges(...es: Array<[string, string]>): CpmEdge[] {
  return es.map(([taskKey, dependsOnKey]) => ({ taskKey, dependsOnKey }));
}

describe("CPM — critical path", () => {
  it("a linear chain marks every task as critical", () => {
    // A(0-2) → B(2-5) → C(5-7) — single chain, no slack anywhere.
    const r = computeCriticalPath({
      tasks: rows([
        { key: "a", start: day(0), end: day(2) },
        { key: "b", start: day(2), end: day(5) },
        { key: "c", start: day(5), end: day(7) },
      ]),
      dependencies: edges(["b", "a"], ["c", "b"]),
    });
    expect(Object.keys(r).sort()).toEqual(["a", "b", "c"]);
    expect(r.a.isCriticalPath).toBe(true);
    expect(r.b.isCriticalPath).toBe(true);
    expect(r.c.isCriticalPath).toBe(true);
  });

  it("a diamond marks BOTH parallel branches critical when their durations match", () => {
    //         B(1-3)
    //       /        \
    // A(0-1)          D(3-4)
    //       \        /
    //         C(1-3)
    const r = computeCriticalPath({
      tasks: rows([
        { key: "a", start: day(0), end: day(1) },
        { key: "b", start: day(1), end: day(3) },
        { key: "c", start: day(1), end: day(3) },
        { key: "d", start: day(3), end: day(4) },
      ]),
      dependencies: edges(["b", "a"], ["c", "a"], ["d", "b"], ["d", "c"]),
    });
    expect(r.a.isCriticalPath).toBe(true);
    expect(r.b.isCriticalPath).toBe(true);
    expect(r.c.isCriticalPath).toBe(true);
    expect(r.d.isCriticalPath).toBe(true);
  });

  it("a parallel SHORT branch is NOT critical (has slack)", () => {
    //         B(1-5)  ← length 4 days (critical)
    //       /        \
    // A(0-1)          D(5-6)
    //       \        /
    //         C(1-2)  ← length 1 day (slack = 3 days, NOT critical)
    const r = computeCriticalPath({
      tasks: rows([
        { key: "a", start: day(0), end: day(1) },
        { key: "b", start: day(1), end: day(5) },
        { key: "c", start: day(1), end: day(2) },
        { key: "d", start: day(5), end: day(6) },
      ]),
      dependencies: edges(["b", "a"], ["c", "a"], ["d", "b"], ["d", "c"]),
    });
    expect(r.a?.isCriticalPath).toBe(true);
    expect(r.b?.isCriticalPath).toBe(true);
    expect(r.d?.isCriticalPath).toBe(true);
    expect(r.c).toBeUndefined(); // C has slack > 0 → not in the result
  });

  it("zero-duration milestones can participate in the critical chain", () => {
    // A(0-2) → M(2-2) → C(2-5) — M is a milestone, total length 5 days, all critical
    const r = computeCriticalPath({
      tasks: rows([
        { key: "a", start: day(0), end: day(2) },
        { key: "m", start: day(2), end: day(2) }, // zero-duration
        { key: "c", start: day(2), end: day(5) },
      ]),
      dependencies: edges(["m", "a"], ["c", "m"]),
    });
    expect(r.a.isCriticalPath).toBe(true);
    expect(r.m.isCriticalPath).toBe(true);
    expect(r.c.isCriticalPath).toBe(true);
  });

  it("hierarchy: parents are transparent — critical path runs through LEAVES only", () => {
    // phase (parent over leaf-a, leaf-b)
    //   leaf-a(0-2) → leaf-b(2-5)
    // floater(0-1) — top-level, parallel, short → not critical
    const r = computeCriticalPath({
      tasks: rows([
        { key: "phase", start: day(0), end: day(5) }, // derived window
        { key: "leaf-a", start: day(0), end: day(2), parent: "phase" },
        { key: "leaf-b", start: day(2), end: day(5), parent: "phase" },
        { key: "floater", start: day(0), end: day(1) },
      ]),
      dependencies: edges(["leaf-b", "leaf-a"]),
    });
    expect(r["leaf-a"].isCriticalPath).toBe(true);
    expect(r["leaf-b"].isCriticalPath).toBe(true);
    expect(r.phase).toBeUndefined(); // parent never appears in CPM output
    expect(r.floater).toBeUndefined(); // shorter path, has slack
  });

  it("a dependency edge touching a parent is SKIPPED (transparent-parent rule)", () => {
    // leaf's only edge points at the parent → the edge is dropped under the
    // transparent-parent rule, leaving leaf unconstrained in the leaf-only DAG.
    // Both leaf and child become top-level leaves; their EFs (3d, 5d) make
    // child the longest path, so child sets the makespan and is critical;
    // leaf finishes 2d earlier and has slack, so it's NOT in the result.
    const r = computeCriticalPath({
      tasks: rows([
        { key: "phase", start: day(0), end: day(5), parent: undefined },
        { key: "child", start: day(0), end: day(5), parent: "phase" },
        { key: "leaf", start: day(0), end: day(3) },
      ]),
      dependencies: edges(["leaf", "phase"]), // edge touches parent → skipped
    });
    expect(r.child.isCriticalPath).toBe(true);
    expect(r.leaf).toBeUndefined(); // 2-day slack → absent from result
  });

  it("returns {} defensively on a cycle (validation rejects upstream)", () => {
    const r = computeCriticalPath({
      tasks: rows([
        { key: "a", start: day(0), end: day(2) },
        { key: "b", start: day(2), end: day(4) },
      ]),
      dependencies: edges(["a", "b"], ["b", "a"]), // cycle
    });
    expect(r).toEqual({});
  });

  it("drops edges whose source or target is unknown (defensive)", () => {
    // C depends on ghost → ghost is dropped; C is unconstrained.
    const r = computeCriticalPath({
      tasks: rows([
        { key: "a", start: day(0), end: day(3) },
        { key: "c", start: day(0), end: day(2) },
      ]),
      dependencies: edges(["c", "ghost"]),
    });
    expect(r.a.isCriticalPath).toBe(true);
    expect(r.c).toBeUndefined(); // shorter than makespan
  });

  it("returns {} for an empty input", () => {
    expect(computeCriticalPath({ tasks: [], dependencies: [] })).toEqual({});
  });
});

/**
 * cinatra#3562 — WHEN A RUN SURFACE HANDS A LIST STEP ITS TRY AGAIN.
 *
 * `listStepRefreshFor` is the one reading the run panel, the stepper and the
 * screen card use for the `onRequestRefresh` prop. It hands the prop only for
 * a `:list-picker` gate that is the step the run waits at, drawn in edit mode
 * and not disabled. A call reads through the host's read for that gate's
 * review task, never rejects, and answers the step's shape.
 */
import { describe, it, expect, vi } from "vitest";
import { listStepRefreshFor } from "../hitl-gate-submit";

const LIST_GATE = {
  xRenderer: "@cinatra-test/pack-agent:list-picker",
  reviewTaskId: "task-list-1",
  isCurrentWaitingStep: true,
  mode: "edit" as const,
};

describe("listStepRefreshFor — which steps offer a new read", () => {
  // red-first-expect: listStepRefreshFor) is not a function
  it("a waiting list step in edit mode gets the prop", () => {
    expect(typeof listStepRefreshFor(LIST_GATE, vi.fn())).toBe("function");
  });

  const without: Array<[string, Partial<typeof LIST_GATE> & { disabled?: boolean }]> = [
    ["a gate of another renderer", { xRenderer: "@cinatra-test/pack-agent:output" }],
    ["a list step the run no longer waits at", { isCurrentWaitingStep: false }],
    ["a list step drawn read-only", { mode: "view" as never }],
    ["a list step on a setup gate", { reviewTaskId: "setup-run-1" }],
  ];
  for (const [name, change] of without) {
    // red-first-expect: listStepRefreshFor) is not a function
    it(`${name} gets none`, () => {
      const readAgain = vi.fn();
      expect(listStepRefreshFor({ ...LIST_GATE, ...change }, readAgain)).toBeUndefined();
      expect(readAgain).not.toHaveBeenCalled();
    });
  }

  // red-first-expect: listStepRefreshFor) is not a function
  it("a disabled list step gets none", () => {
    expect(listStepRefreshFor({ ...LIST_GATE, disabled: true }, vi.fn())).toBeUndefined();
  });
});

describe("listStepRefreshFor — what a call does", () => {
  // red-first-expect: listStepRefreshFor) is not a function
  it("reads for the gate's own review task and answers the step's shape", async () => {
    const readAgain = vi.fn(async () => ({
      lists: [
        { id: "l-1", name: "Customers" },
        { id: "", name: "Blank" },
        { id: "l-1", name: "Again" },
      ],
      listsRead: "ok",
    }));
    const refresh = listStepRefreshFor(LIST_GATE, readAgain)!;
    expect(readAgain).not.toHaveBeenCalled();
    await expect(refresh()).resolves.toEqual({ lists: [{ id: "l-1", name: "Customers" }], listsRead: "ok" });
    expect(readAgain).toHaveBeenCalledWith("task-list-1");
  });

  // red-first-expect: listStepRefreshFor) is not a function
  it("a refused or failing read resolves with the failed shape, never a rejection", async () => {
    for (const readAgain of [
      vi.fn(async () => {
        throw new Error("list_step_not_waiting");
      }),
      vi.fn(() => {
        throw new Error("thrown at once");
      }),
      vi.fn(async () => ({ something: "else" })),
      vi.fn(async () => ({ lists: [{ id: "l-1", name: "Customers" }], listsRead: "failed" })),
    ]) {
      const refresh = listStepRefreshFor(LIST_GATE, readAgain as never)!;
      await expect(refresh()).resolves.toEqual({ lists: [], listsRead: "failed" });
    }
  });
});

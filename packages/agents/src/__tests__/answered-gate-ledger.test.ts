/**
 * The answered-gate ledger of the run panel (cinatra#3080).
 *
 * Each gate submit that suppresses its gate arms the ledger and takes a token.
 * A submit that fails releases only what its own token added. Duplicate
 * submits are expected (a double click, chat plus form: hitl-gate-submit.ts),
 * and the server answers the loser with a blocked result, so a losing submit
 * must never take back the suppression of an accepted one, and a late failure
 * of one submit must never clear the pair of a later one.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/answered-gate-ledger.test.ts
 */
import { describe, it, expect } from "vitest";

import {
  armAnsweredGate,
  clearAnsweredPair,
  createAnsweredGateLedger,
  isReviewTaskClaimed,
  releaseAnsweredGate,
  resetAnsweredGates,
} from "../answered-gate-ledger";
import { applyJustSubmittedSuppression, type HitlGateContext } from "../run-surface-status";

const R = "@cinatra-ai/x:output";
const ctx = (reviewTaskId: string, xRenderer = R, fieldName?: string): HitlGateContext => ({
  xRenderer,
  childRunId: null,
  reviewTaskId,
  inputSchema: {},
  currentValues: {},
  ...(fieldName === undefined ? {} : { fieldName }),
});
const view = (ledger: ReturnType<typeof createAnsweredGateLedger>, raw: HitlGateContext) =>
  applyJustSubmittedSuppression(raw, ledger.pair, ledger.claims);

describe("answered-gate ledger", () => {
  it("arms the pair and the answered task together", () => {
    const ledger = createAnsweredGateLedger();
    armAnsweredGate(ledger, { xRenderer: R, reviewTaskId: "rt-1" });
    expect(ledger.pair).toMatchObject({ xRenderer: R, reviewTaskId: "rt-1" });
    expect(isReviewTaskClaimed(ledger, "rt-1")).toBe(true);
    expect(view(ledger, ctx("rt-1"))).toEqual({ context: null, clearSuppression: false });
  });

  it("releases the pair and the task of a single failed submit (as before)", () => {
    const ledger = createAnsweredGateLedger();
    const a = armAnsweredGate(ledger, { xRenderer: R, reviewTaskId: "rt-1" });
    releaseAnsweredGate(ledger, a);
    expect(ledger.pair).toBeNull();
    expect(isReviewTaskClaimed(ledger, "rt-1")).toBe(false);
    expect(view(ledger, ctx("rt-1"))).toEqual({ context: ctx("rt-1"), clearSuppression: false });
  });

  it("keeps an accepted submit's task answered when a duplicate submit of it loses", () => {
    const ledger = createAnsweredGateLedger();
    armAnsweredGate(ledger, { xRenderer: R, reviewTaskId: "rt-1" }); // A: accepted
    const b = armAnsweredGate(ledger, { xRenderer: R, reviewTaskId: "rt-1" }); // B: blocked
    releaseAnsweredGate(ledger, b);
    expect(isReviewTaskClaimed(ledger, "rt-1")).toBe(true);
    expect(ledger.pair).toMatchObject({ xRenderer: R, reviewTaskId: "rt-1" });
    // A late poll still carrying the answered gate is not drawn.
    expect(view(ledger, ctx("rt-1"))).toEqual({ context: null, clearSuppression: false });
  });

  it("takes the task out only when every submit that answered it has failed", () => {
    const ledger = createAnsweredGateLedger();
    const a = armAnsweredGate(ledger, { xRenderer: R, reviewTaskId: "rt-1" });
    const b = armAnsweredGate(ledger, { xRenderer: R, reviewTaskId: "rt-1" });
    releaseAnsweredGate(ledger, b);
    expect(isReviewTaskClaimed(ledger, "rt-1")).toBe(true);
    releaseAnsweredGate(ledger, a);
    expect(isReviewTaskClaimed(ledger, "rt-1")).toBe(false);
  });

  it("never lets a late failure of an earlier submit clear a later submit's pair or task", () => {
    const ledger = createAnsweredGateLedger();
    const a = armAnsweredGate(ledger, { xRenderer: R, reviewTaskId: "rt-1" });
    armAnsweredGate(ledger, { xRenderer: R, reviewTaskId: "rt-2" });
    releaseAnsweredGate(ledger, a);
    expect(ledger.pair).toMatchObject({ xRenderer: R, reviewTaskId: "rt-2" });
    expect(isReviewTaskClaimed(ledger, "rt-1")).toBe(false);
    expect(isReviewTaskClaimed(ledger, "rt-2")).toBe(true);
    expect(view(ledger, ctx("rt-2"))).toEqual({ context: null, clearSuppression: false });
  });

  it("releases a token once: a second release changes nothing", () => {
    const ledger = createAnsweredGateLedger();
    const a = armAnsweredGate(ledger, { xRenderer: R, reviewTaskId: "rt-1" });
    const b = armAnsweredGate(ledger, { xRenderer: R, reviewTaskId: "rt-1" });
    releaseAnsweredGate(ledger, a);
    releaseAnsweredGate(ledger, a);
    expect(isReviewTaskClaimed(ledger, "rt-1")).toBe(true);
    expect(ledger.pair).toMatchObject({ reviewTaskId: "rt-1" });
    releaseAnsweredGate(ledger, b);
    expect(isReviewTaskClaimed(ledger, "rt-1")).toBe(false);
  });

  it("clears only the pair at the render-time clear; a later release of that submit leaves a newer pair alone", () => {
    const ledger = createAnsweredGateLedger();
    const a = armAnsweredGate(ledger, { xRenderer: R, reviewTaskId: "rt-1" });
    clearAnsweredPair(ledger);
    expect(ledger.pair).toBeNull();
    expect(isReviewTaskClaimed(ledger, "rt-1")).toBe(true);
    armAnsweredGate(ledger, { xRenderer: R, reviewTaskId: "rt-2" });
    releaseAnsweredGate(ledger, a);
    expect(ledger.pair).toMatchObject({ reviewTaskId: "rt-2" });
  });

  it("empties everything at Re-check; a release of an older submit after it is a no-op", () => {
    const ledger = createAnsweredGateLedger();
    const a = armAnsweredGate(ledger, { xRenderer: R, reviewTaskId: "rt-1" });
    resetAnsweredGates(ledger);
    expect(ledger.pair).toBeNull();
    expect(isReviewTaskClaimed(ledger, "rt-1")).toBe(false);
    const c = armAnsweredGate(ledger, { xRenderer: R, reviewTaskId: "rt-3" });
    releaseAnsweredGate(ledger, a);
    expect(ledger.pair).toMatchObject({ reviewTaskId: "rt-3" });
    expect(isReviewTaskClaimed(ledger, "rt-3")).toBe(true);
    expect(c).not.toBe(a);
  });

  it("holds no answered entry for an id that names no gate (shared setup id, blank id)", () => {
    const ledger = createAnsweredGateLedger();
    armAnsweredGate(ledger, { xRenderer: R, reviewTaskId: "setup-run-1" });
    armAnsweredGate(ledger, { xRenderer: R, reviewTaskId: "  " });
    expect(ledger.claims.size).toBe(0);
    // The pair is still armed, so the renderer-only reading holds.
    expect(ledger.pair).toMatchObject({ reviewTaskId: "  " });
  });

  it("draws the next WayFlow gate of the same renderer after a duplicate submit of the first lost", () => {
    const ledger = createAnsweredGateLedger();
    armAnsweredGate(ledger, { xRenderer: R, reviewTaskId: "wayflow-t1" });
    const b = armAnsweredGate(ledger, { xRenderer: R, reviewTaskId: "wayflow-t1" });
    releaseAnsweredGate(ledger, b);
    // A still holds the pair and the answered task.
    expect(view(ledger, ctx("wayflow-t1"))).toEqual({ context: null, clearSuppression: false });
    expect(view(ledger, ctx("wayflow-t2"))).toEqual({ context: ctx("wayflow-t2"), clearSuppression: true });
  });

  // "The question the person answered is spent wherever it is read" - and only
  // that question (cinatra#3739). A run's gates can share one review task, so
  // a question under the answered review task that asks another renderer or
  // another field is a new question and is drawn; the answered question
  // itself stays spent.
  it("draws another question under the answered review task once the pair is cleared, never the answered one", () => {
    const ledger = createAnsweredGateLedger();
    armAnsweredGate(ledger, { xRenderer: R, reviewTaskId: "rt-1" });
    clearAnsweredPair(ledger);
    const otherRenderer = ctx("rt-1", "@cinatra-ai/x:other", "idea");
    const otherField = ctx("rt-1", R, "idea");
    expect(view(ledger, otherRenderer)).toEqual({ context: otherRenderer, clearSuppression: false });
    expect(view(ledger, otherField)).toEqual({ context: otherField, clearSuppression: false });
    // The answered question itself, as a late poll returns it, stays spent.
    expect(view(ledger, ctx("rt-1"))).toEqual({ context: null, clearSuppression: false });
  });

  it("draws a question of another renderer under the answered review task while the pair is armed, and clears the pair", () => {
    const ledger = createAnsweredGateLedger();
    armAnsweredGate(ledger, { xRenderer: R, reviewTaskId: "rt-1" });
    const otherRenderer = ctx("rt-1", "@cinatra-ai/x:other", "idea");
    expect(view(ledger, otherRenderer)).toEqual({ context: otherRenderer, clearSuppression: true });
  });

  it("claims the answered field: the same renderer and review task with that field stays spent", () => {
    const ledger = createAnsweredGateLedger();
    armAnsweredGate(ledger, { xRenderer: R, reviewTaskId: "rt-1", fieldName: "idea" });
    clearAnsweredPair(ledger);
    expect(view(ledger, ctx("rt-1", R, "idea"))).toEqual({ context: null, clearSuppression: false });
    expect(view(ledger, ctx("rt-1", R, "other"))).toEqual({
      context: ctx("rt-1", R, "other"),
      clearSuppression: false,
    });
  });

  it("keeps a review task claimed while any submit holds a question under it", () => {
    const ledger = createAnsweredGateLedger();
    const a = armAnsweredGate(ledger, { xRenderer: R, reviewTaskId: "rt-1" });
    const b = armAnsweredGate(ledger, { xRenderer: "@cinatra-ai/x:other", reviewTaskId: "rt-1" });
    releaseAnsweredGate(ledger, a);
    expect(isReviewTaskClaimed(ledger, "rt-1")).toBe(true);
    clearAnsweredPair(ledger);
    // Only the released question is drawn again; the held one stays spent.
    expect(view(ledger, ctx("rt-1"))).toEqual({ context: ctx("rt-1"), clearSuppression: false });
    expect(view(ledger, ctx("rt-1", "@cinatra-ai/x:other"))).toEqual({
      context: null,
      clearSuppression: false,
    });
    releaseAnsweredGate(ledger, b);
    expect(isReviewTaskClaimed(ledger, "rt-1")).toBe(false);
  });

  it("keeps the pair of an accepted setup submit when a duplicate submit of it loses", () => {
    // `setup-<runId>` is never claimed, so the pair alone suppresses it.
    const ledger = createAnsweredGateLedger();
    armAnsweredGate(ledger, { xRenderer: R, reviewTaskId: "setup-run-1" }); // A: accepted
    const b = armAnsweredGate(ledger, { xRenderer: R, reviewTaskId: "setup-run-1" }); // B: blocked
    releaseAnsweredGate(ledger, b);
    expect(ledger.pair).toMatchObject({ xRenderer: R, reviewTaskId: "setup-run-1" });
    expect(view(ledger, ctx("setup-run-1"))).toEqual({ context: null, clearSuppression: false });
  });
});

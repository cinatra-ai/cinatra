import { describe, it, expect, beforeEach } from "vitest";
import {
  getActivationGeneration,
  bumpActivationGeneration,
  getActivationControlPlaneSnapshot,
  __resetActivationGenerationForTests,
} from "@/lib/extension-activation-generation";

beforeEach(() => __resetActivationGenerationForTests());

describe("extension activation (control-plane) generation", () => {
  it("starts at 0 with an empty transition history", () => {
    expect(getActivationGeneration()).toBe(0);
    expect(getActivationControlPlaneSnapshot()).toEqual({ generation: 0, lastTransitions: [] });
  });

  it("bumps monotonically and returns the new value", () => {
    expect(bumpActivationGeneration("activate")).toBe(1);
    expect(bumpActivationGeneration("hot-update")).toBe(2);
    expect(bumpActivationGeneration("teardown")).toBe(3);
    expect(getActivationGeneration()).toBe(3);
  });

  it("records each transition with its reason + packageName + a timestamp", () => {
    const before = Date.now();
    bumpActivationGeneration("activate", "@cinatra-ai/foo");
    bumpActivationGeneration("teardown", "@cinatra-ai/foo");
    const after = Date.now();

    const { generation, lastTransitions } = getActivationControlPlaneSnapshot();
    expect(generation).toBe(2);
    expect(lastTransitions).toHaveLength(2);
    expect(lastTransitions[0]).toMatchObject({
      generation: 1,
      reason: "activate",
      packageName: "@cinatra-ai/foo",
    });
    expect(lastTransitions[1]).toMatchObject({
      generation: 2,
      reason: "teardown",
      packageName: "@cinatra-ai/foo",
    });
    for (const t of lastTransitions) {
      expect(t.at).toBeGreaterThanOrEqual(before);
      expect(t.at).toBeLessThanOrEqual(after);
    }
  });

  it("omits packageName when a transition is not package-scoped (boot)", () => {
    bumpActivationGeneration("boot-static");
    bumpActivationGeneration("boot-runtime");
    const { lastTransitions } = getActivationControlPlaneSnapshot();
    expect(lastTransitions.map((t) => t.reason)).toEqual(["boot-static", "boot-runtime"]);
    expect(lastTransitions.every((t) => t.packageName === undefined)).toBe(true);
  });

  it("bounds the transition history ring to the last 100 transitions (generation keeps climbing)", () => {
    for (let i = 0; i < 150; i++) bumpActivationGeneration("activate", `@cinatra-ai/p${i}`);
    const { generation, lastTransitions } = getActivationControlPlaneSnapshot();
    expect(generation).toBe(150);
    expect(lastTransitions).toHaveLength(100);
    // The ring keeps the NEWEST 100 (generations 51..150), oldest first.
    expect(lastTransitions[0].generation).toBe(51);
    expect(lastTransitions[lastTransitions.length - 1].generation).toBe(150);
  });

  it("snapshot is a copy — a caller cannot mutate the internal ring", () => {
    bumpActivationGeneration("activate", "@cinatra-ai/foo");
    const snap = getActivationControlPlaneSnapshot();
    (snap.lastTransitions as unknown as { reason: string }[])[0].reason = "TAMPERED";
    // A fresh snapshot is unaffected.
    expect(getActivationControlPlaneSnapshot().lastTransitions[0].reason).toBe("activate");
  });
});

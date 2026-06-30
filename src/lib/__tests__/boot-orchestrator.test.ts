import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Boot orchestrator sequence (engineering #302). Pins the EXACT phase order,
// dev-only gating, and the detached-vs-awaited dev-block interleave preserved
// from the original instrumentation.node.ts inline body:
//   - dev block 1 (agents/skills scan) is DETACHED and fires EARLY (after the
//     extension-activation phases, before assistant-bootstrap/otel);
//   - a2a-dev-auto-connect is AWAITED, between otel and usage-event-subscriber;
//   - dev block 2 (dev-auto-setup) is DETACHED and fires LAST.
// All dev-only steps are skipped entirely in production.
// ---------------------------------------------------------------------------

// Mock the phase modules so the test asserts the orchestration order without
// running any real boot side effect.
vi.mock("@/lib/boot/boot-state", () => ({
  beginBoot: vi.fn(),
  markBootReady: vi.fn(),
}));

vi.mock("@/lib/boot/phases/core-boot", () => ({
  coreBootPhases: () => [{ name: "core-x", policy: "retryable", run: async () => {} }],
}));
vi.mock("@/lib/boot/phases/extension-activation", () => ({
  extensionActivationPhases: () => [{ name: "ext-x", policy: "retryable", run: async () => {} }],
}));
vi.mock("@/lib/boot/phases/required-extension-materialize", () => ({
  requiredExtensionMaterializePhases: () => [
    { name: "required-extension-materialize", policy: "fatal", run: async () => {} },
  ],
}));
vi.mock("@/lib/boot/phases/agent-marker-backfill", () => ({
  agentMarkerBackfillPhases: () => [
    { name: "agent-marker-backfill", policy: "degraded", run: async () => {} },
  ],
}));
vi.mock("@/lib/boot/phases/system-services", () => ({
  systemServicesPhases: () => [
    { name: "assistant-bootstrap", policy: "retryable", run: async () => {} },
    { name: "otel-tracing", policy: "degraded", run: async () => {} },
    { name: "usage-event-subscriber", policy: "degraded", run: async () => {} },
    { name: "anthropic-skill-sync-map", policy: "retryable", run: async () => {} },
  ],
}));
vi.mock("@/lib/boot/phases/system-loops", () => ({
  systemLoopPhases: () => [{ name: "loops-x", policy: "retryable", run: async () => {} }],
}));
vi.mock("@/lib/boot/phases/dev-boot", () => ({
  devAwaitedPhases: () => [{ name: "a2a-dev-auto-connect", policy: "dev-only", run: async () => {} }],
  startDetachedDevAgentsScanPhase: vi.fn(),
  startDetachedDevAutoSetupPhase: vi.fn(),
}));

import { runBoot } from "@/lib/boot/boot-orchestrator";
import { beginBoot, markBootReady } from "@/lib/boot/boot-state";
import {
  startDetachedDevAgentsScanPhase,
  startDetachedDevAutoSetupPhase,
} from "@/lib/boot/phases/dev-boot";

describe("runBoot orchestration", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.clearAllMocks());

  it("runs every phase in the exact preserved order (dev mode)", async () => {
    const order: string[] = [];
    const runPhase = vi.fn(async (phase: { name: string }) => {
      order.push(phase.name);
      return undefined as never;
    });
    (startDetachedDevAgentsScanPhase as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => order.push("[detached] dev-agents-skills-scan"),
    );
    (startDetachedDevAutoSetupPhase as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => order.push("[detached] dev-auto-setup"),
    );

    await runBoot({ isDevMode: () => true, runPhase });

    expect(beginBoot).toHaveBeenCalledTimes(1);
    expect(markBootReady).toHaveBeenCalledTimes(1);
    expect(order).toEqual([
      "core-x",
      "ext-x",
      "required-extension-materialize", // cinatra-ai/ops#436 — after ext-activation, before marker backfill
      "agent-marker-backfill", // engineering #418 — always-on, AWAITED, before the dev scan
      "[detached] dev-agents-skills-scan", // dev block 1 — EARLY + detached
      "assistant-bootstrap",
      "otel-tracing",
      "a2a-dev-auto-connect", // AWAITED dev phase, between otel + usage
      "usage-event-subscriber",
      "anthropic-skill-sync-map",
      "loops-x",
      "[detached] dev-auto-setup", // dev block 2 — LAST + detached
    ]);
  });

  it("skips ALL dev-only steps in production", async () => {
    const order: string[] = [];
    const runPhase = vi.fn(async (phase: { name: string }) => {
      order.push(phase.name);
      return undefined as never;
    });

    await runBoot({ isDevMode: () => false, runPhase });

    expect(startDetachedDevAgentsScanPhase).not.toHaveBeenCalled();
    expect(startDetachedDevAutoSetupPhase).not.toHaveBeenCalled();
    expect(order).toEqual([
      "core-x",
      "ext-x",
      "required-extension-materialize", // cinatra-ai/ops#436 — runs in PROD (fail-closed)
      "agent-marker-backfill", // engineering #418 — runs in PROD too (self-heal)
      "assistant-bootstrap",
      "otel-tracing",
      // no a2a-dev-auto-connect in prod
      "usage-event-subscriber",
      "anthropic-skill-sync-map",
      "loops-x",
    ]);
    expect(markBootReady).toHaveBeenCalledTimes(1);
  });

  it("runs agent-marker-backfill (engineering #418) in BOTH dev and prod, AWAITED before markBootReady", async () => {
    for (const dev of [true, false]) {
      vi.clearAllMocks();
      const order: string[] = [];
      const runPhase = vi.fn(async (phase: { name: string }) => {
        order.push(phase.name);
        return undefined as never;
      });
      await runBoot({ isDevMode: () => dev, runPhase });
      // Present regardless of dev/prod.
      expect(order).toContain("agent-marker-backfill");
      // AWAITED through the same runner as the always-on phases (so markers are
      // written before wayflow scans) and reached before readiness is marked.
      expect(order.indexOf("agent-marker-backfill")).toBeGreaterThan(
        order.indexOf("ext-x"),
      );
      expect(order.indexOf("agent-marker-backfill")).toBeLessThan(
        order.indexOf("loops-x"),
      );
      expect(markBootReady).toHaveBeenCalledTimes(1);
    }
  });

  it("runs required-extension-materialize (cinatra-ai/ops#436) after ext-activation and BEFORE marker backfill, in BOTH dev and prod", async () => {
    for (const dev of [true, false]) {
      vi.clearAllMocks();
      const order: string[] = [];
      const runPhase = vi.fn(async (phase: { name: string }) => {
        order.push(phase.name);
        return undefined as never;
      });
      await runBoot({ isDevMode: () => dev, runPhase });
      expect(order).toContain("required-extension-materialize");
      // After extension-activation (the in-process registry load) so the
      // required-activation assert is independent of the disk reconcile.
      expect(order.indexOf("required-extension-materialize")).toBeGreaterThan(
        order.indexOf("ext-x"),
      );
      // BEFORE marker backfill so markers backfill against the freshly
      // materialized on-disk tree.
      expect(order.indexOf("required-extension-materialize")).toBeLessThan(
        order.indexOf("agent-marker-backfill"),
      );
    }
  });

  it("propagates a fatal phase throw out of runBoot (aborts boot)", async () => {
    const runPhase = vi.fn(async (phase: { name: string }) => {
      if (phase.name === "ext-x") throw new Error("required activation missing");
      return undefined as never;
    });

    await expect(runBoot({ isDevMode: () => false, runPhase })).rejects.toThrow(
      "required activation missing",
    );
    // markBootReady not reached when a fatal phase aborts boot.
    expect(markBootReady).not.toHaveBeenCalled();
  });
});

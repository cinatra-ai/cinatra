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
vi.mock("@/lib/boot/phases/schema-version-precondition", () => ({
  schemaVersionPreconditionPhases: () => [
    { name: "schema-version-precondition", policy: "fatal", run: async () => {} },
  ],
}));
vi.mock("@/lib/boot/phases/extension-activation", () => ({
  extensionActivationPhases: () => [{ name: "ext-x", policy: "retryable", run: async () => {} }],
}));
vi.mock("@/lib/boot/phases/required-extension-materialize", () => ({
  requiredExtensionMaterializePhases: () => [
    { name: "required-extension-materialize", policy: "fatal", run: async () => {} },
  ],
}));
vi.mock("@/lib/boot/phases/agent-mount-projection", () => ({
  agentMountProjectionPhases: () => [
    { name: "agent-mount-projection", policy: "degraded", run: async () => {} },
  ],
}));
vi.mock("@/lib/boot/phases/agent-marker-backfill", () => ({
  agentMarkerBackfillPhases: () => [
    { name: "agent-marker-backfill", policy: "degraded", run: async () => {} },
  ],
}));
vi.mock("@/lib/boot/phases/agent-runtime-dep-backfill", () => ({
  agentRuntimeDepBackfillPhases: () => [
    { name: "agent-runtime-dep-backfill", policy: "retryable", run: async () => {} },
  ],
}));
vi.mock("@/lib/boot/phases/agent-template-org-reconcile", () => ({
  agentTemplateOrgReconcilePhases: () => [
    { name: "agent-template-org-reconcile", policy: "degraded", run: async () => {} },
  ],
}));
vi.mock("@/lib/boot/phases/bundled-skill-registration", () => ({
  bundledSkillRegistrationPhases: () => [
    { name: "bundled-skill-registration", policy: "degraded", run: async () => {} },
  ],
}));
vi.mock("@/lib/boot/phases/skills-catalog-rebuild", () => ({
  skillsCatalogRebuildPhases: () => [
    { name: "skills-catalog-rebuild", policy: "degraded", run: async () => {} },
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
vi.mock("@/lib/boot/phases/required-env-note", () => ({
  requiredEnvNotePhases: () => [
    { name: "required-env-soft-check", policy: "retryable", run: async () => {} },
  ],
}));
vi.mock("@/lib/boot/phases/user-store-mount-check", () => ({
  userStoreMountCheckPhases: () => [
    { name: "user-store-mount-check", policy: "retryable", run: async () => {} },
  ],
}));
vi.mock("@/lib/boot/phases/artifact-data-root-guard", () => ({
  artifactDataRootGuardPhases: () => [
    { name: "artifact-data-root-guard", policy: "retryable", run: async () => {} },
  ],
}));
vi.mock("@/lib/boot/phases/boot-degrade-probe", () => ({
  bootDegradeProbePhases: () => [
    { name: "boot-degrade-probe", policy: "degraded", run: async () => {} },
  ],
}));
vi.mock("@/lib/boot/phases/dev-boot", () => ({
  devAwaitedPhases: () => [{ name: "a2a-dev-auto-connect", policy: "dev-only", run: async () => {} }],
  startDetachedDevAgentsScanPhase: vi.fn(),
  startDetachedDevAutoSetupPhase: vi.fn(),
}));

import { runBoot } from "@/lib/boot/boot-orchestrator";
import { beginBoot, markBootReady } from "@/lib/boot/boot-state";
import {
  armBootStallWatchdog,
  BOOT_STALL_DEADLINE_MS,
  BOOT_STALL_REPEAT_MS,
  type BootStallWatchdog,
} from "@/lib/boot/boot-stall-watchdog";
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
      "schema-version-precondition", // cinatra#789 item 4 — after core (migrations), before ext-activation
      "ext-x",
      "user-store-mount-check", // cinatra#789 item 5 — BEFORE the reconcile/projection create the mount (cinatra#793)
      "artifact-data-root-guard", // cinatra#926 — stranded-bytes warn, alongside the mount checks
      "required-extension-materialize", // cinatra-ai/ops#436 — after ext-activation, before marker backfill
      "agent-mount-projection", // cinatra#793 — store→mount self-heal, before marker backfill
      "agent-marker-backfill", // engineering #418 — always-on, AWAITED, before the dev scan
      "agent-runtime-dep-backfill", // cinatra#1056 — always-on, AWAITED, after marker backfill
      "agent-template-org-reconcile", // cinatra#2619 — always-on owning-org heal, AFTER the agent phases above
      "bundled-skill-registration", // cinatra#2398 — always-on colocated scan, BEFORE the rebuild
      "skills-catalog-rebuild", // cinatra#1364 — explicit rebuild AFTER activation/materialization
      "dashboard-contribution-reconcile", // cinatra#1628 (S11c) — dormant adoption reconcile, AWAITED
      "dashboard-template-materialize", // cinatra#1896 (Scope 2) — dormant install→materialize trigger, AWAITED (dev + prod)
      "[detached] dev-agents-skills-scan", // dev block 1 — EARLY + detached
      "assistant-bootstrap",
      "otel-tracing",
      "a2a-dev-auto-connect", // AWAITED dev phase, between otel + usage
      "usage-event-subscriber",
      "anthropic-skill-sync-map",
      "loops-x",
      "required-env-soft-check", // cinatra#789 item 3 — deploy-robustness readiness signals
      "boot-degrade-probe", // cinatra#789 item 1 — inert unless double-armed
      "execution-plane-health", // cinatra#1705 — exec-plane readiness, deploy-robustness signal (dev + prod)
      "environment-execution-service", // cinatra#1708 S3 A2 — durable env-layer store + cache + builder + DI slot
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
      "schema-version-precondition", // cinatra#789 item 4 — runs in PROD (fatal on too-old)
      "ext-x",
      "user-store-mount-check", // cinatra#789 item 5 — BEFORE the reconcile/projection create the mount (cinatra#793)
      "artifact-data-root-guard", // cinatra#926 — stranded-bytes warn, alongside the mount checks
      "required-extension-materialize", // cinatra-ai/ops#436 — runs in PROD (fail-closed)
      "agent-mount-projection", // cinatra#793 — store→mount self-heal (runs in PROD too)
      "agent-marker-backfill", // engineering #418 — runs in PROD too (self-heal)
      "agent-runtime-dep-backfill", // cinatra#1056 — runs in PROD too
      "agent-template-org-reconcile", // cinatra#2619 — runs in PROD too (that is what heals a damaged deployment)
      "bundled-skill-registration", // cinatra#2398 — runs in PROD too (that is the whole fix)
      "skills-catalog-rebuild", // cinatra#1364 — runs in PROD too (explicit boot rebuild)
      "dashboard-contribution-reconcile", // cinatra#1628 (S11c) — dormant adoption reconcile, runs in PROD too
      "dashboard-template-materialize", // cinatra#1896 (Scope 2) — dormant install→materialize trigger, runs in PROD too
      "assistant-bootstrap",
      "otel-tracing",
      // no a2a-dev-auto-connect in prod
      "usage-event-subscriber",
      "anthropic-skill-sync-map",
      "loops-x",
      "required-env-soft-check", // cinatra#789 item 3
      "boot-degrade-probe", // cinatra#789 item 1
      "execution-plane-health", // cinatra#1705 — exec-plane readiness, deploy-robustness signal (runs in PROD)
      "environment-execution-service", // cinatra#1708 S3 A2 — durable env-layer store + cache + builder + DI slot
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

// ---------------------------------------------------------------------------
// #2554 — the startup deadline, wired through the REAL orchestrator.
//
// boot-stall-watchdog.test.ts pins the watchdog's own dev-exit / prod-repeat
// behavior. These pin the wiring: that the orchestrator actually marks each
// phase at its await boundary (so the diagnostic can name a REAL phase name),
// and that the deadline is disarmed on both the ready and the abort path.
// ---------------------------------------------------------------------------
describe("runBoot startup deadline wiring (#2554)", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  function fakeWatchdog() {
    const marks: string[] = [];
    const watchdog: BootStallWatchdog = {
      phaseStarted: (name) => marks.push(`start:${name}`),
      phaseFinished: (name) => marks.push(`finish:${name}`),
      disarm: vi.fn(),
    };
    return { watchdog, marks };
  }

  it("marks every awaited phase started/finished and disarms once boot is ready", async () => {
    const { watchdog, marks } = fakeWatchdog();
    const runPhase = vi.fn(async () => undefined as never);

    await runBoot({
      isDevMode: () => false,
      runPhase,
      armStallWatchdog: () => watchdog,
    });

    // Every awaited phase is bracketed by a marker pair, in order.
    expect(marks.slice(0, 4)).toEqual([
      "start:core-x",
      "finish:core-x",
      "start:schema-version-precondition",
      "finish:schema-version-precondition",
    ]);
    expect(marks).toContain("start:agent-marker-backfill");
    expect(marks.length).toBe(runPhase.mock.calls.length * 2);
    expect(watchdog.disarm).toHaveBeenCalledTimes(1);
  });

  it("disarms the deadline even when a fatal phase aborts boot", async () => {
    const { watchdog, marks } = fakeWatchdog();
    const runPhase = vi.fn(async (phase: { name: string }) => {
      if (phase.name === "ext-x") throw new Error("required activation missing");
      return undefined as never;
    });

    await expect(
      runBoot({ isDevMode: () => false, runPhase, armStallWatchdog: () => watchdog }),
    ).rejects.toThrow("required activation missing");

    // The failing phase is still closed out, and the deadline is stopped.
    expect(marks).toContain("start:ext-x");
    expect(marks).toContain("finish:ext-x");
    expect(watchdog.disarm).toHaveBeenCalledTimes(1);
  });

  it("hands the watchdog the STRICT boot-mode predicate: an unset CINATRA_RUNTIME_MODE is NOT dev", async () => {
    // Load-bearing: the dev arm EXITS the process. The repo-wide
    // isAppDevelopmentMode() helper treats an UNSET var as development, so if the
    // deadline ever adopted it, a production process with the var unset would
    // exit itself on a transient stall. runBoot must keep passing its own strict
    // `CINATRA_RUNTIME_MODE === "development"` predicate.
    const prior = process.env.CINATRA_RUNTIME_MODE;
    try {
      const { watchdog } = fakeWatchdog();
      const seen: boolean[] = [];
      const armStallWatchdog = (deps: { isDevMode: () => boolean }) => {
        seen.push(deps.isDevMode());
        return watchdog;
      };
      const runPhase = vi.fn(async () => undefined as never);

      delete process.env.CINATRA_RUNTIME_MODE;
      await runBoot({ runPhase, armStallWatchdog });

      process.env.CINATRA_RUNTIME_MODE = "production";
      await runBoot({ runPhase, armStallWatchdog });

      process.env.CINATRA_RUNTIME_MODE = "development";
      await runBoot({ runPhase, armStallWatchdog });

      expect(seen).toEqual([false, false, true]);
    } finally {
      if (prior === undefined) delete process.env.CINATRA_RUNTIME_MODE;
      else process.env.CINATRA_RUNTIME_MODE = prior;
    }
  });

  it("names the REAL in-flight phase when a boot phase hangs past the deadline", async () => {
    vi.useFakeTimers();
    const logged: string[] = [];
    const exit = vi.fn();

    // "ext-x" never resolves — the exact shape of the #2554 stall.
    const runPhase = vi.fn(async (phase: { name: string }) => {
      if (phase.name === "ext-x") return new Promise<never>(() => {});
      return undefined as never;
    });

    const booting = runBoot({
      isDevMode: () => false,
      runPhase,
      armStallWatchdog: (deps) =>
        armBootStallWatchdog({
          ...deps,
          logError: (message) => logged.push(message),
          exit,
        }),
    });
    // Surface the hang as a pending promise rather than an unhandled rejection.
    void booting.catch(() => {});

    await vi.advanceTimersByTimeAsync(BOOT_STALL_DEADLINE_MS);

    expect(logged.length).toBeGreaterThan(0);
    expect(logged[0]).toContain("ext-x");
    expect(exit).not.toHaveBeenCalled(); // prod: keep waiting
    expect(markBootReady).not.toHaveBeenCalled();

    const afterDeadline = logged.length;
    await vi.advanceTimersByTimeAsync(BOOT_STALL_REPEAT_MS);
    expect(logged.length).toBe(afterDeadline + 1);
  });
});

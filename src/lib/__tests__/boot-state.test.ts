import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __resetBootStateForTests,
  beginBoot,
  getBootStateSnapshot,
  markBootReady,
  recordBootPhaseResult,
} from "@/lib/boot/boot-state";
import type { BootPhaseResult } from "@/lib/boot/boot-phase";

// ---------------------------------------------------------------------------
// Process-local boot/readiness state (engineering #302). A phase failure must be
// VISIBLE to health checks/operators. These tests pin the readiness derivation:
// begin -> booting; markReady -> ready/degraded; a fatal failure -> failed.
// ---------------------------------------------------------------------------

function result(over: Partial<BootPhaseResult> & { name: string }): BootPhaseResult {
  return {
    policy: "retryable",
    status: "ok",
    at: 1,
    durationMs: 0,
    ...over,
  };
}

describe("boot-state readiness", () => {
  beforeEach(() => __resetBootStateForTests());
  afterEach(() => __resetBootStateForTests());

  it("starts 'booting' after beginBoot and becomes 'ready' on markBootReady with all OK", () => {
    beginBoot(() => 100);
    expect(getBootStateSnapshot().readiness).toBe("booting");
    expect(getBootStateSnapshot().startedAt).toBe(100);

    recordBootPhaseResult(result({ name: "core-migrations", policy: "fatal", status: "ok" }));
    markBootReady(() => 200);

    const snap = getBootStateSnapshot();
    expect(snap.readiness).toBe("ready");
    expect(snap.readyAt).toBe(200);
    expect(snap.degradedPhases).toEqual([]);
    expect(snap.fatalPhase).toBeUndefined();
  });

  it("becomes 'degraded' (still serving) when a degraded/retryable phase failed", () => {
    beginBoot();
    recordBootPhaseResult(result({ name: "otel-tracing", policy: "degraded", status: "failed", reason: "no exporter" }));
    recordBootPhaseResult(result({ name: "cache-warmup", policy: "retryable", status: "failed", reason: "db down" }));
    markBootReady();

    const snap = getBootStateSnapshot();
    expect(snap.readiness).toBe("degraded");
    expect(snap.degradedPhases).toEqual(["otel-tracing", "cache-warmup"]);
    // blockingPhases = the DURABLE `degraded`-policy failures ONLY (cinatra#789 item 1):
    // the retryable cache-warmup is NOT deploy-blocking; the degraded otel-tracing IS.
    expect(snap.blockingPhases).toEqual(["otel-tracing"]);
  });

  it("blockingPhases excludes retryable-only failures (deploy not blocked)", () => {
    beginBoot();
    recordBootPhaseResult(result({ name: "cache-warmup", policy: "retryable", status: "failed", reason: "db blip" }));
    recordBootPhaseResult(result({ name: "marketplace-attach", policy: "retryable", status: "failed" }));
    markBootReady();

    const snap = getBootStateSnapshot();
    expect(snap.readiness).toBe("degraded");
    expect(snap.degradedPhases).toEqual(["cache-warmup", "marketplace-attach"]);
    // No durable degraded-policy failure -> nothing deploy-blocking (self-healing).
    expect(snap.blockingPhases).toEqual([]);
  });

  it("becomes 'failed' when a fatal phase failed (and markReady cannot revive it)", () => {
    beginBoot();
    recordBootPhaseResult(result({ name: "core-migrations", policy: "fatal", status: "failed", reason: "half-migrated" }));
    expect(getBootStateSnapshot().readiness).toBe("failed");

    markBootReady();
    const snap = getBootStateSnapshot();
    expect(snap.readiness).toBe("failed");
    expect(snap.fatalPhase).toBe("core-migrations");
    expect(snap.readyAt).toBeNull();
  });

  it("records every phase outcome in completion order", () => {
    beginBoot();
    recordBootPhaseResult(result({ name: "a" }));
    recordBootPhaseResult(result({ name: "b", status: "skipped", reason: "kill switch" }));
    recordBootPhaseResult(result({ name: "c" }));
    expect(getBootStateSnapshot().phases.map((p) => p.name)).toEqual(["a", "b", "c"]);
  });

  it("re-begin resets the phase log (dev hot-reload re-invokes register)", () => {
    beginBoot();
    recordBootPhaseResult(result({ name: "a", policy: "degraded", status: "failed" }));
    expect(getBootStateSnapshot().readiness).toBe("degraded");

    beginBoot();
    const snap = getBootStateSnapshot();
    expect(snap.readiness).toBe("booting");
    expect(snap.phases).toEqual([]);
  });

  it("is a process-local singleton anchored on the versioned Symbol", () => {
    expect(getBootStateSnapshot().scope).toBe("process-local");
  });
});

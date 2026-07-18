// Unit tests for the execution-plane health boot phase (ops#517 / epic #1705).
// Proves the per-instance-class health semantics: a class that REQUIRES the plane
// makes a not-configured/misconfigured plane DEPLOY-BLOCKING (lands in
// blockingPhases → /api/health 503); any other class surfaces it as non-blocking
// degraded (degradedPhases only). Inert (skipped) when the plane is neither
// configured nor required.
import { describe, expect, it, vi } from "vitest";

import { runBootPhase } from "@/lib/boot/boot-phase";
import {
  __resetBootStateForTests,
  getBootStateSnapshot,
} from "@/lib/boot/boot-state";
import {
  EXECUTION_PLANE_HEALTH_PHASE,
  evaluateExecutionPlaneReadiness,
  executionPlaneHealthPhases,
  executionPlaneRequired,
} from "@/lib/boot/phases/execution-plane-health";

const READY = { EXECUTION_BROKER_URL: "https://broker.internal:4000", EXECUTION_BROKER_SECRET: "s3cr3t" };

describe("evaluateExecutionPlaneReadiness", () => {
  it("not-configured when neither URL nor secret is set", () => {
    expect(evaluateExecutionPlaneReadiness({})).toEqual({ state: "not-configured" });
  });
  it("ready when URL (http/https) + secret are both present", () => {
    expect(evaluateExecutionPlaneReadiness(READY)).toEqual({ state: "ready" });
    expect(evaluateExecutionPlaneReadiness({ ...READY, EXECUTION_BROKER_URL: "http://b:4000" })).toEqual({
      state: "ready",
    });
  });
  it("misconfigured when the secret is missing but a URL is set", () => {
    const r = evaluateExecutionPlaneReadiness({ EXECUTION_BROKER_URL: "https://b" });
    expect(r.state).toBe("misconfigured");
    expect(r).toMatchObject({ reason: expect.stringContaining("EXECUTION_BROKER_SECRET") });
  });
  it("misconfigured when the URL is missing but a secret is set", () => {
    const r = evaluateExecutionPlaneReadiness({ EXECUTION_BROKER_SECRET: "x" });
    expect(r).toMatchObject({ state: "misconfigured", reason: expect.stringContaining("EXECUTION_BROKER_URL") });
  });
  it("misconfigured when the URL is unparseable", () => {
    expect(evaluateExecutionPlaneReadiness({ ...READY, EXECUTION_BROKER_URL: "not a url" }).state).toBe(
      "misconfigured",
    );
  });
  it("misconfigured when the URL scheme is not http(s)", () => {
    const r = evaluateExecutionPlaneReadiness({ ...READY, EXECUTION_BROKER_URL: "ftp://b/x" });
    expect(r).toMatchObject({ state: "misconfigured", reason: expect.stringContaining("http") });
  });
});

describe("executionPlaneRequired", () => {
  it("is true only when EXECUTION_PLANE_REQUIRED === '1'", () => {
    expect(executionPlaneRequired({ EXECUTION_PLANE_REQUIRED: "1" })).toBe(true);
    expect(executionPlaneRequired({ EXECUTION_PLANE_REQUIRED: "true" })).toBe(false);
    expect(executionPlaneRequired({})).toBe(false);
  });
});

describe("executionPlaneHealthPhases — policy by class", () => {
  it("uses `degraded` (deploy-blocking) policy when the class requires the plane", () => {
    const [p] = executionPlaneHealthPhases({ EXECUTION_PLANE_REQUIRED: "1" });
    expect(p.name).toBe(EXECUTION_PLANE_HEALTH_PHASE);
    expect(p.policy).toBe("degraded");
  });
  it("uses `retryable` (non-blocking) policy otherwise", () => {
    const [p] = executionPlaneHealthPhases({});
    expect(p.policy).toBe("retryable");
  });
});

const logDeps = () => ({ logError: vi.fn() });

describe("executionPlaneHealthPhases — run outcomes", () => {
  it("SKIPS when not configured and not required (inert on today's instances)", async () => {
    const [p] = executionPlaneHealthPhases({});
    const r = await runBootPhase(p, { record: () => {}, ...logDeps() });
    expect(r.status).toBe("skipped");
  });
  it("FAILS when required but not configured", async () => {
    const [p] = executionPlaneHealthPhases({ EXECUTION_PLANE_REQUIRED: "1" });
    const r = await runBootPhase(p, { record: () => {}, ...logDeps() });
    expect(r.status).toBe("failed");
    expect(r.policy).toBe("degraded");
  });
  it("is OK when configured and valid", async () => {
    const [p] = executionPlaneHealthPhases(READY);
    const r = await runBootPhase(p, { record: () => {}, ...logDeps() });
    expect(r.status).toBe("ok");
  });
});

describe("boot-state integration — deploy-blocking semantics", () => {
  it("required + not-configured lands in blockingPhases (deploy-blocking 503)", async () => {
    __resetBootStateForTests();
    const [p] = executionPlaneHealthPhases({ EXECUTION_PLANE_REQUIRED: "1" });
    await runBootPhase(p, logDeps()); // default record → the process boot-state
    const snap = getBootStateSnapshot();
    expect(snap.blockingPhases).toContain(EXECUTION_PLANE_HEALTH_PHASE);
  });
  it("not-required + misconfigured lands in degradedPhases only (non-blocking)", async () => {
    __resetBootStateForTests();
    const [p] = executionPlaneHealthPhases({ EXECUTION_BROKER_URL: "https://b" }); // secret missing, not required
    await runBootPhase(p, logDeps());
    const snap = getBootStateSnapshot();
    expect(snap.degradedPhases).toContain(EXECUTION_PLANE_HEALTH_PHASE);
    expect(snap.blockingPhases).not.toContain(EXECUTION_PLANE_HEALTH_PHASE);
  });
});

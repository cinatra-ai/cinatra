// Unit tests for the execution-plane health boot phase (ops#517 / epic #1705).
// Proves the per-instance-class health semantics: a class that REQUIRES the plane
// makes a not-configured/misconfigured plane DEPLOY-BLOCKING (lands in
// blockingPhases → /api/health 503); any other class surfaces it as non-blocking
// degraded (degradedPhases only). Inert (skipped) when the plane is neither
// configured nor required.
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  isExecutionBrokerLiveProbeEnabled,
  probeExecutionBrokerLive,
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

// ---------------------------------------------------------------------------
// The LIVE probe (exec-plane L4) — its own default-off flag.
// ---------------------------------------------------------------------------

vi.mock("@/lib/execution/execution-broker-remote-config", () => ({
  resolveRemoteBrokerConfig: () => remoteConfig,
  // PER-REPLICA (cinatra#2266 G3): the gate is applied to each client, so the
  // double has to be able to answer differently for each — otherwise a probe
  // that dialled only the first replica would be indistinguishable from one
  // that dialled them all.
  checkRemoteComposite: async (client: { baseUrl?: string }) => {
    if (compositeHangs) return new Promise(() => {});
    return compositeByUrl.get(client?.baseUrl ?? "") ?? compositeResult;
  },
  describeComposite: () => "worker ok; gateway ok; lease not-applicable",
  sanitizeOperatorDetail: (text: string): string =>
    text.replace(/([a-z][a-z0-9+.-]{0,31}:\/\/)[^/\s@]{0,256}@/gi, "$1"),
}));

vi.mock("@cinatra-ai/execution-plane", () => ({
  BrokerServiceClient: class {
    readonly baseUrl: string;
    constructor(config: { baseUrl?: string }) {
      this.baseUrl = config?.baseUrl ?? "";
      clientsConstructed += 1;
      constructedUrls.push(this.baseUrl);
    }
    close(): void {
      clientsClosed += 1;
    }
  },
}));

const REPLICA_A = "https://broker-a.invalid";
const REPLICA_B = "https://broker-b.invalid";

let remoteConfig: { ok: boolean; reason?: string; value?: unknown } = {
  ok: true,
  value: { baseUrls: [REPLICA_A] },
};
let compositeResult: { ok: boolean; reason?: string; composite?: unknown } = {
  ok: true,
  composite: {},
};
/** Per-replica overrides; anything absent falls back to `compositeResult`. */
let compositeByUrl = new Map<string, { ok: boolean; reason?: string; composite?: unknown }>();
let clientsConstructed = 0;
let clientsClosed = 0;
let constructedUrls: string[] = [];
let compositeHangs = false;

const LIVE = { ...READY, EXECUTION_BROKER_LIVE_PROBE: "on" };

describe("the LIVE probe flag", () => {
  beforeEach(() => {
    remoteConfig = { ok: true, value: { baseUrls: [REPLICA_A] } };
    compositeResult = { ok: true, composite: {} };
    compositeByUrl = new Map();
    clientsConstructed = 0;
    clientsClosed = 0;
    constructedUrls = [];
    compositeHangs = false;
  });

  it("is off unless the flag is EXACTLY `on`", () => {
    for (const value of [undefined, "", "off", "true", "1", "ON", "on "]) {
      expect(
        isExecutionBrokerLiveProbeEnabled(
          value === undefined ? {} : { EXECUTION_BROKER_LIVE_PROBE: value },
        ),
      ).toBe(false);
    }
    expect(isExecutionBrokerLiveProbeEnabled({ EXECUTION_BROKER_LIVE_PROBE: "on" })).toBe(true);
  });

  it("FLAG OFF: the phase body is SYNCHRONOUS and reaches no network at all", async () => {
    const [p] = executionPlaneHealthPhases(READY);
    // Not "an async body that returns early" — the same synchronous phase the
    // config-only version shipped, so nothing about boot timing can differ.
    const outcome = p.run();
    expect(outcome).toBeUndefined();
    expect(clientsConstructed).toBe(0);
    const r = await runBootPhase(p, { record: () => {}, ...logDeps() });
    expect(r.status).toBe("ok");
  });

  it("FLAG OFF: every config-only outcome is unchanged", async () => {
    expect(
      (await runBootPhase(executionPlaneHealthPhases({})[0], { record: () => {}, ...logDeps() }))
        .status,
    ).toBe("skipped");
    expect(
      (
        await runBootPhase(
          executionPlaneHealthPhases({ EXECUTION_PLANE_REQUIRED: "1" })[0],
          { record: () => {}, ...logDeps() },
        )
      ).status,
    ).toBe("failed");
    expect(clientsConstructed).toBe(0);
  });

  it("FLAG ON + a reachable, healthy broker: ok", async () => {
    const [p] = executionPlaneHealthPhases(LIVE);
    const r = await runBootPhase(p, { record: () => {}, ...logDeps() });
    expect(r.status).toBe("ok");
    expect(clientsConstructed).toBe(1);
    // The keep-alive agent is always released, success or failure.
    expect(clientsClosed).toBe(1);
  });

  it("FLAG ON + an unreachable broker: the phase FAILS with the verbatim reason", async () => {
    compositeResult = { ok: false, reason: "the broker did not answer a health call: ECONNREFUSED" };
    const [p] = executionPlaneHealthPhases(LIVE);
    const r = await runBootPhase(p, { record: () => {}, ...logDeps() });
    expect(r.status).toBe("failed");
    expect(r.reason).toContain("ECONNREFUSED");
    expect(clientsClosed).toBe(1);
  });

  it("FLAG ON + an unhealthy WORKER: degraded on a normal class, blocking on a required one", async () => {
    compositeResult = {
      ok: false,
      reason: "the broker's dependencies are not healthy — worker unhealthy (connect refused)",
    };
    const normal = await runBootPhase(executionPlaneHealthPhases(LIVE)[0], {
      record: () => {},
      ...logDeps(),
    });
    expect(normal.policy).toBe("retryable");
    expect(normal.status).toBe("failed");

    const required = await runBootPhase(
      executionPlaneHealthPhases({ ...LIVE, EXECUTION_PLANE_REQUIRED: "1" })[0],
      { record: () => {}, ...logDeps() },
    );
    // Same policy vocabulary as a misconfiguration — the probe adds a FACT, not
    // a new severity.
    expect(required.policy).toBe("degraded");
    expect(required.status).toBe("failed");
    expect(required.reason).toContain("deploy-blocking");
  });

  it("FLAG ON but NOT CONFIGURED on a normal class: still skipped, still no network", async () => {
    const [p] = executionPlaneHealthPhases({ EXECUTION_BROKER_LIVE_PROBE: "on" });
    const r = await runBootPhase(p, { record: () => {}, ...logDeps() });
    expect(r.status).toBe("skipped");
    expect(clientsConstructed).toBe(0);
  });

  it("FLAG ON with unusable remote config fails BEFORE dialing anything", async () => {
    remoteConfig = { ok: false, reason: "missing EXECUTION_BROKER_CLIENT_CERT_FILE" };
    const [p] = executionPlaneHealthPhases(LIVE);
    const r = await runBootPhase(p, { record: () => {}, ...logDeps() });
    expect(r.status).toBe("failed");
    expect(r.reason).toContain("EXECUTION_BROKER_CLIENT_CERT_FILE");
    expect(clientsConstructed).toBe(0);
  });

  // Codex convergence, adopted: the ceiling must bound the WHOLE probe, not
  // just the HTTP request — an operator-set request timeout may exceed it and
  // nothing else bounds a stalled import. A boot phase must not be able to hang.
  it("FLAG ON + a HANGING broker fails on the whole-probe deadline", async () => {
    compositeHangs = true;
    const [p] = executionPlaneHealthPhases(LIVE);
    const r = await runBootPhase(p, { record: () => {}, ...logDeps() });
    expect(r.status).toBe("failed");
    expect(r.reason).toMatch(/did not answer within \d+ ms/);
  }, 20_000);

  // -------------------------------------------------------------------------
  // THE FLEET (cinatra#2266 G3, Codex convergence, adopted).
  //
  // This probe dialled the FIRST declared origin and reported the whole plane
  // healthy on its answer alone. The cost is the one `broker-fleet.ts` names in
  // its own header: a replica the app cannot reach is a replica whose audit
  // spool nobody is draining, and an undrained spool fills and goes fail-closed
  // — so an operator would read a green boot phase right up until commands
  // started being refused.
  // -------------------------------------------------------------------------

  it("FLEET: probes EVERY replica, not just the first", async () => {
    remoteConfig = { ok: true, value: { baseUrls: [REPLICA_A, REPLICA_B] } };
    const [p] = executionPlaneHealthPhases(LIVE);
    const r = await runBootPhase(p, { record: () => {}, ...logDeps() });
    expect(r.status).toBe("ok");
    // Asserted on the ORIGINS dialled, not merely on a count: two clients built
    // against the same URL would satisfy a count and prove nothing.
    expect(constructedUrls).toEqual([REPLICA_A, REPLICA_B]);
    // Every keep-alive agent released, not just the last one.
    expect(clientsClosed).toBe(2);
  });

  it("FLEET: the success DETAIL says the verdict stands for every replica", async () => {
    remoteConfig = { ok: true, value: { baseUrls: [REPLICA_A, REPLICA_B] } };
    // Read off the probe itself: the boot phase records a reason only on
    // failure, so this is the surface that carries the successful verdict.
    const probe = await probeExecutionBrokerLive(LIVE);
    expect(probe.ok).toBe(true);
    if (!probe.ok) throw new Error("unreachable");
    expect(probe.detail).toContain("2 replicas ready");

    // And a ONE-replica deployment keeps its original single-composite line.
    remoteConfig = { ok: true, value: { baseUrls: [REPLICA_A] } };
    const single = await probeExecutionBrokerLive(LIVE);
    expect(single.ok).toBe(true);
    if (!single.ok) throw new Error("unreachable");
    expect(single.detail).not.toContain("replicas ready");
  });

  it("FLEET: an unhealthy SECOND replica fails the phase and names it", async () => {
    remoteConfig = { ok: true, value: { baseUrls: [REPLICA_A, REPLICA_B] } };
    // A is fine; only B is broken — the exact case the single-endpoint probe
    // reported as healthy.
    compositeByUrl.set(REPLICA_B, {
      ok: false,
      reason: "the broker did not answer a health call: ECONNREFUSED",
    });
    const [p] = executionPlaneHealthPhases(LIVE);
    const r = await runBootPhase(p, { record: () => {}, ...logDeps() });
    expect(r.status).toBe("failed");
    expect(r.reason).toContain(REPLICA_B);
    expect(r.reason).toContain("ECONNREFUSED");
    // The failure does not leak the other replica's socket.
    expect(clientsClosed).toBe(2);
  });

  it("FLEET: a THROWING probe still names the replica and closes every client", async () => {
    // `Promise.all` decided the verdict by which failure landed FIRST IN TIME
    // and tore the clients down while siblings were still in flight. Settling
    // every probe keeps the verdict a function of DECLARATION order, which is
    // the only order an operator can act on.
    remoteConfig = { ok: true, value: { baseUrls: [REPLICA_A, REPLICA_B] } };
    compositeByUrl.set(REPLICA_A, { ok: false, reason: "A is merely unready" });
    const probe = await probeExecutionBrokerLive(LIVE);
    expect(probe.ok).toBe(false);
    if (probe.ok) throw new Error("unreachable");
    // A is declared first, so A is the replica reported — even though B
    // answered fine.
    expect(probe.reason).toContain(REPLICA_A);
    expect(clientsClosed).toBe(2);
  });

  it("FLEET: a SINGLE-replica deployment's message is unchanged — no origin prefix", async () => {
    compositeResult = { ok: false, reason: "the broker did not answer a health call: ECONNREFUSED" };
    const [p] = executionPlaneHealthPhases(LIVE);
    const r = await runBootPhase(p, { record: () => {}, ...logDeps() });
    expect(r.status).toBe("failed");
    expect(r.reason).toContain("ECONNREFUSED");
    // The one-replica deployment has exactly one place to look, so its reason
    // keeps the shape every existing reader already understands.
    expect(r.reason).not.toContain(REPLICA_A);
  });

  it("REDACTS a userinfo component out of a reason before it reaches boot state", async () => {
    compositeResult = {
      ok: false,
      reason:
        "the broker did not answer a health call: connect " +
        `${["https://svc", "not-a-real-credential"].join(":")}@broker.invalid/`,
    };
    const [p] = executionPlaneHealthPhases(LIVE);
    const r = await runBootPhase(p, { record: () => {}, ...logDeps() });
    expect(r.status).toBe("failed");
    expect(r.reason).not.toContain("not-a-real-credential");
    expect(r.reason).toContain("broker.invalid");
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

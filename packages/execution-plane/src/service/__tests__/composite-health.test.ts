// COMPOSITE health (exec-plane L4, epic cinatra#1705).
//
// The properties under test are the ones an activation gate is built on:
//  - `not-applicable` is NOT a pass and NOT a failure;
//  - a hanging dependency degrades on a timer instead of hanging the endpoint;
//  - a probe that throws becomes `unhealthy` WITH its message, never a throw
//    out of the provider;
//  - the broker's `health` op carries the composite, still answers 200 when the
//    composite is not ok, and omits the field entirely when no provider was
//    configured (so an app-side gate can tell "unproven" from "healthy").

import { describe, expect, it, vi } from "vitest";

import {
  createCompositeHealthProvider,
  createGatewayHealthProbe,
  redactCompositeDetail,
  DEFAULT_COMPOSITE_PROBE_TIMEOUT_MS,
  MAX_COMPOSITE_PROBE_TIMEOUT_MS,
} from "../composite-health";
import { createBrokerDispatch, type BrokerServiceBroker } from "../broker-server";
import { createInMemoryCommandLedger } from "../command-ledger";
import {
  EXEC_PROTOCOL_VERSION,
  execRequestEnvelope,
  type ExecCompositeHealth,
  type ExecResponseEnvelope,
  type HealthResultPayload,
} from "../protocol";
import type { ExecTlsMaterial } from "../mtls";

/**
 * Credentialed-origin fixtures are ASSEMBLED, never written as a literal.
 *
 * The redaction under test only matters for an origin carrying a userinfo
 * component, 
 * but a contiguous one in source is exactly the shape the repo's secret-scan
 * gate flags — and a fixture that has to be allow-listed teaches the scanner to
 * ignore the very pattern it exists to catch. Building it at runtime keeps the
 * assertion honest and the file clean.
 */
const USERINFO = ["svc", "not-a-real-credential"].join(":");
const credentialed = (host: string, scheme = "https"): string =>
  `${scheme}://${USERINFO}@${host}`;
/** The token half, for `not.toContain` assertions. */
const CREDENTIAL = USERINFO.split(":")[1] as string;

const ok = async (): Promise<void> => undefined;
const boom = async (): Promise<void> => {
  throw new Error("connect refused");
};
const NA_GATEWAY = { notApplicable: "egress is disabled" } as const;
const NA_LEASE = { notApplicable: "workers are not host-exclusive" } as const;

describe("composite health provider", () => {
  it("is ok when every applicable subsystem answers", async () => {
    const composite = await createCompositeHealthProvider({
      worker: ok,
      gateway: { probe: ok },
      lease: { probe: ok },
    })();
    expect(composite.ok).toBe(true);
    expect(composite.worker.state).toBe("ok");
    expect(composite.gateway.state).toBe("ok");
    expect(composite.lease.state).toBe("ok");
  });

  it("treats an absent dependency as `not-applicable` — neither a pass nor a failure", async () => {
    const composite = await createCompositeHealthProvider({
      worker: ok,
      gateway: NA_GATEWAY,
      lease: NA_LEASE,
    })();
    expect(composite.ok).toBe(true);
    expect(composite.gateway).toEqual({
      state: "not-applicable",
      detail: "egress is disabled",
    });
    expect(composite.lease).toEqual({
      state: "not-applicable",
      detail: "workers are not host-exclusive",
    });
    // The distinction the state exists for: `not-applicable` never reads as ok.
    expect(composite.gateway.state).not.toBe("ok");
  });

  it("a failing subsystem makes the composite NOT ok and carries its message", async () => {
    const composite = await createCompositeHealthProvider({
      worker: boom,
      gateway: { probe: ok },
      lease: { probe: ok },
    })();
    expect(composite.ok).toBe(false);
    expect(composite.worker).toEqual({ state: "unhealthy", detail: "connect refused" });
    // The healthy ones still report honestly — a composite is a diagnosis, not
    // a single bit.
    expect(composite.gateway.state).toBe("ok");
  });

  it("a HANGING dependency degrades on the timeout instead of hanging the caller", async () => {
    vi.useFakeTimers();
    try {
      const provider = createCompositeHealthProvider({
        worker: () => new Promise<void>(() => {}),
        gateway: NA_GATEWAY,
        lease: NA_LEASE,
        timeoutMs: 50,
      });
      const pending = provider();
      await vi.advanceTimersByTimeAsync(60);
      const composite = await pending;
      expect(composite.ok).toBe(false);
      expect(composite.worker.state).toBe("unhealthy");
      expect(composite.worker.detail).toContain("did not answer within 50 ms");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a non-Error throw still becomes a string, never a second throw", async () => {
    const composite = await createCompositeHealthProvider({
      worker: async () => {
        throw null;
      },
      gateway: NA_GATEWAY,
      lease: NA_LEASE,
    })();
    expect(composite.worker.state).toBe("unhealthy");
    expect(typeof composite.worker.detail).toBe("string");
  });

  // Codex convergence, adopted: an operator-influenced timeout must not be able
  // to hold a health request open for an arbitrary duration.
  it("CLAMPS a configured timeout into a bounded range", async () => {
    vi.useFakeTimers();
    try {
      const provider = createCompositeHealthProvider({
        worker: () => new Promise<void>(() => {}),
        gateway: NA_GATEWAY,
        lease: NA_LEASE,
        timeoutMs: 10 * 60_000,
      });
      const pending = provider();
      await vi.advanceTimersByTimeAsync(MAX_COMPOSITE_PROBE_TIMEOUT_MS + 10);
      const composite = await pending;
      expect(composite.worker.state).toBe("unhealthy");
      expect(composite.worker.detail).toContain(`${MAX_COMPOSITE_PROBE_TIMEOUT_MS} ms`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to the default for a non-positive or non-finite timeout", async () => {
    vi.useFakeTimers();
    try {
      const provider = createCompositeHealthProvider({
        worker: () => new Promise<void>(() => {}),
        gateway: NA_GATEWAY,
        lease: NA_LEASE,
        timeoutMs: Number.NaN,
      });
      const pending = provider();
      await vi.advanceTimersByTimeAsync(DEFAULT_COMPOSITE_PROBE_TIMEOUT_MS + 10);
      expect((await pending).worker.detail).toContain(
        `${DEFAULT_COMPOSITE_PROBE_TIMEOUT_MS} ms`,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("REDACTS a userinfo component out of a probe's failure detail", async () => {
    const composite = await createCompositeHealthProvider({
      worker: async () => {
        throw new Error(`connect failed for ${credentialed("worker.invalid:4200")}/`);
      },
      gateway: NA_GATEWAY,
      lease: NA_LEASE,
    })();
    expect(composite.worker.detail).not.toContain(CREDENTIAL);
    expect(composite.worker.detail).toContain("worker.invalid");
    expect(redactCompositeDetail(`${credentialed("h")}/`)).toBe("https://h/");
  });

  it("the redaction is `g`-safe across calls — a shared lastIndex must not skip a match", () => {
    const input = `${credentialed("a")}/ and ${credentialed("b")}/`;
    for (let i = 0; i < 3; i += 1) {
      expect(redactCompositeDetail(input)).toBe("https://a/ and https://b/");
    }
  });

  // CodeQL: "Polynomial regular expression used on uncontrolled data". Both
  // repetitions are bounded now; this pins that a long adversarial run cannot
  // make the redaction pathological.
  it("is LINEAR on a long run of scheme-shaped characters that never reaches `://`", () => {
    const hostile = "a".repeat(200_000);
    const started = Date.now();
    expect(redactCompositeDetail(hostile)).toBe(hostile);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("gateway health probe", () => {
  it("passes on a 2xx from the OPEN /__health endpoint and sends no credential", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await createGatewayHealthProbe("http://gateway.invalid:9", 100)();
      const [target, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
      expect(target.pathname).toBe("/__health");
      // No control secret, no token — the endpoint is open on purpose.
      expect(init.headers).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("fails on a non-2xx and names the STATUS, never the URL", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 503 }));
    try {
      await expect(createGatewayHealthProbe(credentialed("gateway.invalid:9", "http"), 100)()).rejects.toThrow(
        /status 503/,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a transport failure produces a FIXED message — a userinfo-bearing URL cannot ride out", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error(`connect ECONNREFUSED ${credentialed("gateway.invalid:9", "http")}`);
    });
    try {
      const probe = createGatewayHealthProbe(credentialed("gateway.invalid:9", "http"), 100);
      await expect(probe()).rejects.toThrow("the attributing egress gateway did not answer /__health");
      await probe().catch((err: Error) => {
        expect(err.message).not.toContain(CREDENTIAL);
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

const TLS: ExecTlsMaterial = { certPem: "cert", keyPem: "key", caPem: "ca" };

function brokerDouble(): BrokerServiceBroker {
  return {
    openJob: async () => ({ ok: false, reason: "carrier_malformed", message: "n/a" }),
    exec: async () => ({ ok: false, reason: "worker_error", message: "n/a" }),
    closeJob: async () => {},
    terminateJobsForRun: async () => 0,
    closeIdleJobs: async () => 0,
    executingCount: 0,
  };
}

async function callHealth(
  composite?: () => Promise<ExecCompositeHealth>,
): Promise<HealthResultPayload & { status: number }> {
  const dispatch = createBrokerDispatch({
    broker: brokerDouble(),
    instance: "test",
    serviceToken: "token",
    tls: TLS,
    ledger: createInMemoryCommandLedger(),
    nowMs: () => 1_000,
    ...(composite ? { composite } : {}),
  });
  const reply = await dispatch(execRequestEnvelope("health", {}), {
    peerUri: "spiffe://cinatra-exec/test/app-client",
  });
  const body = reply.body as ExecResponseEnvelope<HealthResultPayload>;
  if (!("result" in body)) throw new Error("expected an ok envelope");
  return { ...body.result, status: reply.status };
}

describe("the broker's health op", () => {
  it("OMITS the composite when no provider was configured — absent, not empty", async () => {
    const result = await callHealth();
    expect(result.status).toBe(200);
    expect(result.protocolVersion).toBe(EXEC_PROTOCOL_VERSION);
    expect("composite" in result).toBe(false);
  });

  it("carries the composite when one is configured", async () => {
    const result = await callHealth(
      createCompositeHealthProvider({ worker: ok, gateway: { probe: ok }, lease: { probe: ok } }),
    );
    expect(result.composite?.ok).toBe(true);
    expect(result.composite?.worker.state).toBe("ok");
  });

  it("answers 200 WITH an unhealthy composite — the diagnosis must survive the transport", async () => {
    const result = await callHealth(createCompositeHealthProvider({ worker: boom, gateway: NA_GATEWAY, lease: NA_LEASE }));
    expect(result.status).toBe(200);
    expect(result.composite?.ok).toBe(false);
    expect(result.composite?.worker.detail).toBe("connect refused");
  });

  it("a THROWING provider degrades to an unhealthy composite, not to a 500", async () => {
    const result = await callHealth(async () => {
      throw new Error("provider exploded");
    });
    expect(result.status).toBe(200);
    expect(result.composite?.ok).toBe(false);
    expect(result.composite?.worker.detail).toBe("provider exploded");
  });
});

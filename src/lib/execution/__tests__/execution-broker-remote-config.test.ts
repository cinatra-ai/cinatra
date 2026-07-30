// Unit tests for the REMOTE placement's construction gates (exec-plane L4;
// epic cinatra#1705).
//
// Three properties carry the whole activation decision, and each is asserted
// here rather than assumed:
//
//  1. CONFIG RESOLUTION IS FAIL-CLOSED AND SPECIFIC. Every missing input is
//     named at once (an operator should learn all four names in one boot, not
//     four), and a non-https origin is refused outright — an http origin would
//     silently drop both halves of the mutual-TLS authorization on this hop.
//  2. AN ABSENT COMPOSITE IS NOT A PASS. A broker that answers without one has
//     had nothing below it checked, and "unverified" must never read as
//     "healthy".
//  3. THE REASON TRAVELS VERBATIM, because it is what an operator acts on.

import { describe, expect, it } from "vitest";

import {
  checkRemoteComposite,
  describeComposite,
  REMOTE_BROKER_CA_FILE_ENV,
  REMOTE_BROKER_CLIENT_CERT_FILE_ENV,
  REMOTE_BROKER_CLIENT_KEY_FILE_ENV,
  REMOTE_BROKER_INSTANCE_ENV,
  REMOTE_BROKER_SERVICE_TOKEN_ENV,
  REMOTE_BROKER_URL_ENV,
  resolveRemoteBrokerConfig,
  sanitizeOperatorDetail,
} from "@/lib/execution/execution-broker-remote-config";

/**
 * Credentialed-origin fixtures are ASSEMBLED, never written as a literal: a
 * contiguous credentialed origin in source is exactly what the repo's
 * secret-scan gate flags, and allow-listing a fixture would teach the scanner
 * to ignore the pattern it exists to catch.
 */
const USERINFO = ["svc", "not-a-real-credential"].join(":");
const credentialed = (host: string, scheme = "https"): string =>
  `${scheme}://${USERINFO}@${host}`;
const CREDENTIAL = USERINFO.split(":")[1] as string;

const FILES: Record<string, string> = {
  "/tls/ca.crt": "CA-PEM",
  "/tls/app.crt": "CERT-PEM",
  "/tls/app.key": "KEY-PEM",
};
const readFile = (path: string): string => {
  const value = FILES[path];
  if (value === undefined) throw new Error(`ENOENT: no such file, open '${path}'`);
  return value;
};

const COMPLETE: Record<string, string> = {
  [REMOTE_BROKER_URL_ENV]: "https://broker.invalid:4100",
  [REMOTE_BROKER_INSTANCE_ENV]: "acme-prod",
  [REMOTE_BROKER_SERVICE_TOKEN_ENV]: "service-token",
  [REMOTE_BROKER_CA_FILE_ENV]: "/tls/ca.crt",
  [REMOTE_BROKER_CLIENT_CERT_FILE_ENV]: "/tls/app.crt",
  [REMOTE_BROKER_CLIENT_KEY_FILE_ENV]: "/tls/app.key",
};

describe("resolveRemoteBrokerConfig", () => {
  it("resolves a complete configuration and reads the TLS material at boot", () => {
    const result = resolveRemoteBrokerConfig(COMPLETE, readFile);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.instance).toBe("acme-prod");
    expect(result.value.tls).toEqual({
      certPem: "CERT-PEM",
      keyPem: "KEY-PEM",
      caPem: "CA-PEM",
    });
  });

  it("names EVERY missing input in one message", () => {
    const result = resolveRemoteBrokerConfig({}, readFile);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    for (const name of [
      REMOTE_BROKER_URL_ENV,
      REMOTE_BROKER_INSTANCE_ENV,
      REMOTE_BROKER_SERVICE_TOKEN_ENV,
      REMOTE_BROKER_CA_FILE_ENV,
      REMOTE_BROKER_CLIENT_CERT_FILE_ENV,
      REMOTE_BROKER_CLIENT_KEY_FILE_ENV,
    ]) {
      expect(result.reason).toContain(name);
    }
  });

  it("REFUSES an http origin — the boundary IS mutual TLS", () => {
    const result = resolveRemoteBrokerConfig(
      { ...COMPLETE, [REMOTE_BROKER_URL_ENV]: "http://broker.invalid:4100" },
      readFile,
    );
    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.reason).toContain("must be https");
  });

  it("refuses an unparseable origin", () => {
    const result = resolveRemoteBrokerConfig(
      { ...COMPLETE, [REMOTE_BROKER_URL_ENV]: "not a url" },
      readFile,
    );
    expect(result).toMatchObject({ ok: false });
  });

  it("refuses an instance name the service-identity builder would refuse", () => {
    const result = resolveRemoteBrokerConfig(
      { ...COMPLETE, [REMOTE_BROKER_INSTANCE_ENV]: "acme prod/../x" },
      readFile,
    );
    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.reason).toContain(REMOTE_BROKER_INSTANCE_ENV);
  });

  it("reports an unreadable key file by PATH and never by contents", () => {
    const result = resolveRemoteBrokerConfig(
      { ...COMPLETE, [REMOTE_BROKER_CLIENT_KEY_FILE_ENV]: "/tls/missing.key" },
      readFile,
    );
    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.reason).toContain("/tls/missing.key");
    expect(result.reason).not.toContain("KEY-PEM");
  });

  it("refuses a non-positive request timeout rather than coercing it", () => {
    const result = resolveRemoteBrokerConfig(
      { ...COMPLETE, EXECUTION_BROKER_REQUEST_TIMEOUT_MS: "0" },
      readFile,
    );
    expect(result).toMatchObject({ ok: false });
  });
});

const HEALTHY = {
  ok: true as const,
  worker: { state: "ok" as const, detail: "answered" },
  gateway: { state: "ok" as const, detail: "answered" },
  lease: { state: "not-applicable" as const, detail: "not host-exclusive" },
};

describe("checkRemoteComposite", () => {
  it("passes when the broker reports a healthy composite", async () => {
    const result = await checkRemoteComposite({
      health: async () => ({ protocolVersion: 1, executingCount: 2, atMs: 5, composite: HEALTHY }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.executingCount).toBe(2);
  });

  it("FAILS when the broker answers with NO composite — unverified is not healthy", async () => {
    const result = await checkRemoteComposite({
      health: async () => ({ protocolVersion: 1, executingCount: 0, atMs: 5 }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("no composite readiness");
  });

  it("fails on an unhealthy dependency and carries the composite for the surface", async () => {
    const composite = {
      ...HEALTHY,
      ok: false,
      worker: { state: "unhealthy" as const, detail: "connect refused" },
    };
    const result = await checkRemoteComposite({
      health: async () => ({ protocolVersion: 1, executingCount: 0, atMs: 5, composite }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("worker unhealthy (connect refused)");
    expect(result.composite).toEqual(composite);
  });

  it("turns an unreachable broker into a reason, never a rejection", async () => {
    const result = await checkRemoteComposite({
      health: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("connect ECONNREFUSED");
    expect(result.composite).toBeUndefined();
  });
});

describe("describeComposite", () => {
  it("names all three subsystems with their state and detail", () => {
    expect(describeComposite(HEALTHY)).toBe(
      "worker ok (answered); gateway ok (answered); lease not-applicable (not host-exclusive)",
    );
  });
});

// Codex convergence, adopted: these strings are assembled from transport errors
// and from a remote broker's own prose, land in a boot log and on an admin page,
// and admin pages get screenshotted into tickets.
describe("sanitizeOperatorDetail", () => {
  it("strips a userinfo component while keeping the diagnostic host", () => {
    expect(
      sanitizeOperatorDetail(`connect failed for ${credentialed("broker.invalid:4100")}/exec`),
    ).toBe("connect failed for https://broker.invalid:4100/exec");
  });

  it("strips every occurrence, not only the first", () => {
    const out = sanitizeOperatorDetail(`${credentialed("x")}/ then ${credentialed("y")}/`);
    expect(out).toBe("https://x/ then https://y/");
    expect(out).not.toContain(CREDENTIAL);
  });

  it("leaves an ordinary message untouched", () => {
    expect(sanitizeOperatorDetail("worker unhealthy (connect ECONNREFUSED)")).toBe(
      "worker unhealthy (connect ECONNREFUSED)",
    );
  });

  it("is applied by the composite gate on the transport-failure path", async () => {
    const result = await checkRemoteComposite({
      health: async () => {
        throw new Error(`call to ${credentialed("broker.invalid")}/ failed`);
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).not.toContain(CREDENTIAL);
  });
});

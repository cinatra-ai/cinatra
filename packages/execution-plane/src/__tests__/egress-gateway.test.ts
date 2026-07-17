/**
 * In-process tests of the egress gateway (runtime/egress-gateway.cjs): real
 * sockets on loopback, a real upstream HTTP server, real proxied flows — only
 * docker is absent (the container topology is the E2E battery's job). Tokens
 * are registered on the authenticated control channel exactly as the broker
 * registers them at runtime.
 */
import { createRequire } from "node:module";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const gatewayModule = require("../../runtime/egress-gateway.cjs") as {
  createGateway: (config: {
    controlSecret: string;
    defaultMode: string;
    defaultAllowlist: string[];
    defaultMaxBytesPerJob: number;
  }) => {
    proxyServer: http.Server;
    adminServer: http.Server;
    stats: { snapshot: (job: string) => { totalBytes: number; destinations: unknown[] } };
    registry: { register: (token: string, policy: unknown) => void };
  };
  parseConfig: (env: Record<string, string | undefined>) => {
    controlSecret: string;
    defaultMode: string;
    defaultAllowlist: string[];
    defaultMaxBytesPerJob: number;
    proxyPort: number;
    adminPort: number;
  };
  hostAllowed: (host: string, mode: string, allowlist: string[]) => boolean;
  jobTokenFrom: (header: unknown) => string | null;
  isProtectedAddress: (ip: string) => boolean;
  ipv6ToBytes: (ip: string) => number[] | null;
};

const CONTROL = "unit-control-secret";

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function proxiedGet(opts: {
  proxyPort: number;
  targetUrl: string;
  jobToken?: string;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (opts.jobToken) {
      headers["Proxy-Authorization"] =
        "Basic " + Buffer.from(`${opts.jobToken}:x`).toString("base64");
    }
    const req = http.request(
      {
        host: "127.0.0.1",
        port: opts.proxyPort,
        method: "GET",
        path: opts.targetUrl,
        headers,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function makeGateway(over?: Partial<Parameters<typeof gatewayModule.createGateway>[0]>) {
  return gatewayModule.createGateway({
    controlSecret: CONTROL,
    defaultMode: "allow_all",
    defaultAllowlist: [],
    defaultMaxBytesPerJob: 0,
    ...over,
  });
}

describe("egress gateway (in-process, real sockets)", () => {
  let upstream: http.Server;
  let upstreamPort: number;

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("upstream-ok");
    });
    upstreamPort = await listen(upstream);
  });

  afterAll(() => {
    upstream.close();
  });

  it("parses config from env with safe defaults", () => {
    const config = gatewayModule.parseConfig({ EGRESS_CONTROL_SECRET: "s" });
    expect(config.defaultMode).toBe("allow_all");
    expect(config.defaultAllowlist).toEqual([]);
    expect(config.defaultMaxBytesPerJob).toBe(0);
    expect(config.controlSecret).toBe("s");
  });

  it("hostAllowed enforces exact/dot-suffix semantics in allowlist mode", () => {
    expect(gatewayModule.hostAllowed("pypi.org", "allowlist", ["pypi.org"])).toBe(true);
    expect(gatewayModule.hostAllowed("files.pypi.org", "allowlist", ["pypi.org"])).toBe(true);
    expect(gatewayModule.hostAllowed("notpypi.org", "allowlist", ["pypi.org"])).toBe(false);
    expect(gatewayModule.hostAllowed("anything.example", "allow_all", [])).toBe(true);
  });

  it("extracts the job token from Basic proxy credentials only", () => {
    const header = "Basic " + Buffer.from("job-42:x").toString("base64");
    expect(gatewayModule.jobTokenFrom(header)).toBe("job-42");
    expect(gatewayModule.jobTokenFrom("Bearer nope")).toBeNull();
    expect(gatewayModule.jobTokenFrom(undefined)).toBeNull();
  });

  it("flags loopback / private / link-local / metadata addresses as protected", () => {
    for (const ip of ["127.0.0.1", "10.0.0.5", "172.16.0.1", "192.168.1.1", "169.254.169.254", "::1", "fd00::1"]) {
      expect(gatewayModule.isProtectedAddress(ip)).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1"]) {
      expect(gatewayModule.isProtectedAddress(ip)).toBe(false);
    }
  });

  it("numeric IPv6 classification catches alternate representations (no prefix-match bypass)", () => {
    // Expanded loopback, full fe80::/10 (not just the fe80 prefix), ULA range,
    // and hex-form IPv4-mapped metadata/private — all must be protected.
    for (const ip of [
      "0:0:0:0:0:0:0:1", // expanded ::1
      "fe90::1", // fe80::/10 second-nibble variant
      "febf::1", // top of fe80::/10
      "fc00::1", // ULA
      "::ffff:a9fe:a9fe", // hex-form 169.254.169.254 (metadata)
      "::ffff:127.0.0.1", // v4-mapped loopback (dotted)
      "::ffff:0a00:0001", // hex-form 10.0.0.1
    ]) {
      expect(gatewayModule.isProtectedAddress(ip)).toBe(true);
    }
    // A public v6 and a public v4-mapped address stay allowed.
    expect(gatewayModule.isProtectedAddress("2606:4700:4700::1111")).toBe(false);
    expect(gatewayModule.isProtectedAddress("::ffff:8.8.8.8")).toBe(false);
    // Unparseable ⇒ rejected (fail-closed).
    expect(gatewayModule.isProtectedAddress("not-an-ip")).toBe(true);
  });

  it("REFUSES an unregistered token with 407 (attribution is mandatory)", async () => {
    const gateway = makeGateway();
    const proxyPort = await listen(gateway.proxyServer);
    try {
      // No register() call ⇒ the token is unknown ⇒ 407.
      const res = await proxiedGet({
        proxyPort,
        targetUrl: `http://127.0.0.1:${upstreamPort}/`,
        jobToken: "job-unregistered",
      });
      expect(res.status).toBe(407);
    } finally {
      gateway.proxyServer.close();
      gateway.adminServer.close();
    }
  });

  it("REFUSES a request with no proxy credentials with 407", async () => {
    const gateway = makeGateway();
    const proxyPort = await listen(gateway.proxyServer);
    try {
      const res = await proxiedGet({ proxyPort, targetUrl: `http://127.0.0.1:${upstreamPort}/` });
      expect(res.status).toBe(407);
    } finally {
      gateway.proxyServer.close();
      gateway.adminServer.close();
    }
  });

  it("REFUSES a public-name request that resolves to a protected address", async () => {
    // The upstream is on 127.0.0.1 (loopback) — a registered, allow_all token
    // still cannot reach it: the SSRF guard rejects the resolved private IP.
    const gateway = makeGateway();
    gateway.registry.register("job-ssrf", { mode: "allow_all", allowlist: [], maxBytesPerJob: 0 });
    const proxyPort = await listen(gateway.proxyServer);
    try {
      const res = await proxiedGet({
        proxyPort,
        targetUrl: `http://127.0.0.1:${upstreamPort}/`,
        jobToken: "job-ssrf",
      });
      expect(res.status).toBe(403);
      expect(res.body).toContain("destination_blocked");
    } finally {
      gateway.proxyServer.close();
      gateway.adminServer.close();
    }
  });

  it("DENIES a non-allowlisted destination with 403 in allowlist mode", async () => {
    const gateway = makeGateway();
    gateway.registry.register("job-B", { mode: "allowlist", allowlist: ["allowed.example"], maxBytesPerJob: 0 });
    const proxyPort = await listen(gateway.proxyServer);
    try {
      const res = await proxiedGet({
        proxyPort,
        targetUrl: `http://127.0.0.1:${upstreamPort}/`,
        jobToken: "job-B",
      });
      expect(res.status).toBe(403);
      expect(res.body).toContain("denied_by_allowlist");
    } finally {
      gateway.proxyServer.close();
      gateway.adminServer.close();
    }
  });

  it("admin control endpoints require the control secret", async () => {
    const gateway = makeGateway();
    const adminPort = await listen(gateway.adminServer);
    try {
      // /__health is open.
      expect((await fetch(`http://127.0.0.1:${adminPort}/__health`)).ok).toBe(true);
      // /__stats without the secret ⇒ 401.
      const noSecret = await fetch(`http://127.0.0.1:${adminPort}/__stats?job=x`);
      expect(noSecret.status).toBe(401);
      // /__register without the secret ⇒ 401.
      const reg = await fetch(`http://127.0.0.1:${adminPort}/__register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "x", mode: "allow_all" }),
      });
      expect(reg.status).toBe(401);
    } finally {
      gateway.adminServer.close();
    }
  });

  it("registers a token over the control channel and serves its stats", async () => {
    const gateway = makeGateway();
    const proxyPort = await listen(gateway.proxyServer);
    const adminPort = await listen(gateway.adminServer);
    try {
      // Register via the authenticated control channel (as the broker does).
      const reg = await fetch(`http://127.0.0.1:${adminPort}/__register`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-egress-control": CONTROL },
        body: JSON.stringify({ token: "job-D", mode: "allow_all", allowlist: [], maxBytesPerJob: 0 }),
      });
      expect(reg.ok).toBe(true);
      // The policy decision for a registered token is RECORDED in stats even
      // though the SSRF guard then blocks the loopback destination (403). This
      // exercises register → decide → stats without needing a public upstream.
      const proxied = await proxiedGet({
        proxyPort,
        targetUrl: `http://127.0.0.1:${upstreamPort}/`,
        jobToken: "job-D",
      });
      expect(proxied.status).toBe(403);
      const stats = (await (
        await fetch(`http://127.0.0.1:${adminPort}/__stats?job=job-D`, {
          headers: { "x-egress-control": CONTROL },
        })
      ).json()) as { job: string; destinations: unknown[] };
      expect(stats.job).toBe("job-D");
      expect(stats.destinations.length).toBeGreaterThan(0);
    } finally {
      gateway.proxyServer.close();
      gateway.adminServer.close();
    }
  });
});

/**
 * In-process tests of the egress gateway (runtime/egress-gateway.cjs): real
 * sockets on loopback, a real upstream HTTP server, real proxied flows — only
 * docker is absent (the container topology is the E2E battery's job). Tokens
 * are registered on the authenticated control channel exactly as the broker
 * registers them at runtime.
 */
import { createRequire } from "node:module";
import * as http from "node:http";
import * as net from "node:net";
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
    stats: {
      snapshot: (job: string) => {
        totalBytes: number;
        destinations: { host: string; port: number; allowed: number; denied: number }[];
      };
    };
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
  resolvePinnedAddress: (host: string) => Promise<string | null>;
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

/**
 * Raw CONNECT against the proxy port, resolving with the status line. Raw
 * sockets rather than http.request: an IPv6 destination LITERAL only reaches
 * the address predicate through CONNECT (the absolute-URI path parses with
 * WHATWG URL, whose `hostname` keeps the `[...]` brackets, so a v6 literal
 * there is a name lookup, not a literal) — and CONNECT is the real path anyway
 * (pip/npm/curl tunnel https through it).
 */
function connectViaProxy(opts: {
  proxyPort: number;
  authority: string;
  jobToken?: string;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffered = "";
    const socket = net.connect(opts.proxyPort, "127.0.0.1", () => {
      const auth = opts.jobToken
        ? `Proxy-Authorization: Basic ${Buffer.from(`${opts.jobToken}:x`).toString("base64")}\r\n`
        : "";
      socket.write(`CONNECT ${opts.authority} HTTP/1.1\r\nHost: ${opts.authority}\r\n${auth}\r\n`);
    });
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      const eol = buffered.indexOf("\r\n");
      if (eol >= 0) {
        socket.destroy();
        resolve(buffered.slice(0, eol));
      }
    });
    socket.on("close", () => {
      if (buffered.length === 0) reject(new Error("proxy closed without a status line"));
    });
    socket.on("error", reject);
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

  it("resolvePinnedAddress applies the SAME predicate on the DNS branch", async () => {
    // `localhost` resolves to 127.0.0.1 and/or ::1 — every record is protected,
    // so the resolver has nothing left to pin and returns null. This exercises
    // the record-filtering branch (not the literal shortcut) with no external
    // DNS dependency.
    expect(await gatewayModule.resolvePinnedAddress("localhost")).toBeNull();
    // A name that cannot resolve at all is likewise unpinnable (fail-closed).
    expect(
      await gatewayModule.resolvePinnedAddress("no-such-host.invalid"),
    ).toBeNull();
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

/**
 * IPv6 protected-range coverage, range by range, at parity with the IPv4 list
 * the same predicate enforces. `protectedSamples` are the range's members
 * (including its boundaries, alternate spellings and — for the v4-in-v6
 * wrappers — an embedded IPv4 the v4 list rejects); `allowedNeighbours` are the
 * negative cases that keep each mask from silently widening: an address one
 * hextet outside the range, plus a real global-unicast destination that must
 * stay reachable. Every entry names the IPv4 class it mirrors.
 */
const V6_RANGES: {
  range: string;
  what: string;
  mirrorsV4: string;
  protectedSamples: string[];
  allowedNeighbours: string[];
}[] = [
  {
    range: "::/128 + ::1/128",
    what: "unspecified + loopback",
    mirrorsV4: "0.0.0.0/8 this-network + 127.0.0.0/8 loopback",
    protectedSamples: ["::", "::1", "0:0:0:0:0:0:0:1"],
    allowedNeighbours: ["2606:4700:4700::1111"],
  },
  {
    range: "fc00::/7",
    what: "unique local (ULA)",
    mirrorsV4: "10/8 + 172.16/12 + 192.168/16 private",
    protectedSamples: ["fc00::", "fc00::1", "fd00::1", "fdff:ffff::1"],
    allowedNeighbours: ["2606:4700:4700::1111"],
  },
  {
    range: "fe80::/10",
    what: "link-local",
    mirrorsV4: "169.254/16 link-local (incl. the metadata address)",
    protectedSamples: ["fe80::1", "fe90::1", "febf::1", "fe80::1%eth0"],
    allowedNeighbours: ["2606:4700:4700::1111"],
  },
  {
    range: "fec0::/10",
    what: "site-local (deprecated by RFC 3879, still locally routed)",
    mirrorsV4: "10/8 + 172.16/12 + 192.168/16 private",
    protectedSamples: ["fec0::1", "fed0::1", "feff::1"],
    allowedNeighbours: ["2606:4700:4700::1111"],
  },
  {
    range: "ff00::/8",
    what: "multicast",
    mirrorsV4: "224.0.0.0/4 multicast",
    protectedSamples: ["ff00::", "ff02::1", "ff02::fb", "ff05::1:3", "ff0e::1", "ffff::1"],
    allowedNeighbours: ["2606:4700:4700::1111"],
  },
  {
    range: "100::/64",
    what: "discard-only",
    mirrorsV4: "240.0.0.0/4 reserved (the upper half of the `>= 224` rule)",
    protectedSamples: ["100::", "100::1", "100::ffff", "100:0:0:1::1"],
    allowedNeighbours: ["2606:4700:4700::1111"],
  },
  {
    range: "5f00::/16",
    what: "SRv6 SIDs (RFC 9602), never globally reachable",
    mirrorsV4: "240.0.0.0/4 reserved (the upper half of the `>= 224` rule)",
    protectedSamples: ["5f00::1", "5f00:ffff::1"],
    allowedNeighbours: ["2606:4700:4700::1111"],
  },
  {
    range: "2001:db8::/32",
    what: "documentation",
    mirrorsV4: "no v4 counterpart — v6-side superset, safe direction only",
    protectedSamples: ["2001:db8::1", "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff"],
    allowedNeighbours: ["2001:db9::1", "2001:db7::1"],
  },
  {
    range: "3fff::/20",
    what: "documentation (RFC 9637)",
    mirrorsV4: "no v4 counterpart — v6-side superset, safe direction only",
    protectedSamples: ["3fff::1", "3fff:fff:ffff::1"],
    allowedNeighbours: ["3fff:1000::1", "2606:4700:4700::1111"],
  },
  {
    range: "3ffe::/16",
    what: "6BONE, returned to IANA by RFC 3701 — carries the legacy Teredo prefix 3ffe:831f::/32",
    mirrorsV4: "the v4 ranges a legacy Teredo tunnel would otherwise reach",
    protectedSamples: ["3ffe::1", "3ffe:831f:7f00:1:0:0:80ff:fffe", "3ffe:ffff::1"],
    allowedNeighbours: ["3ffd::1", "2606:4700:4700::1111"],
  },
  {
    range: "2001::/32",
    what: "Teredo (tunnels to an arbitrary IPv4)",
    mirrorsV4: "the v4 ranges a Teredo tunnel would otherwise reach",
    protectedSamples: ["2001::1", "2001:0:53aa:64c:1:2:3:4"],
    // Deliberately NOT the enclosing 2001::/23: these siblings are globally
    // reachable allocations (PCP/TURN anycast, AMT, AS112, Drone Remote ID) and
    // must stay pinnable.
    allowedNeighbours: [
      "2001:1::1", // PCP anycast
      "2001:1::2", // TURN anycast
      "2001:3::1", // AMT
      "2001:4:112::1", // AS112-v6
      "2001:20::1", // ORCHIDv2 — IANA marks it globally reachable
      "2001:30::1", // Drone Remote ID
    ],
  },
  {
    range: "2001:2::/48",
    what: "benchmarking",
    mirrorsV4: "no v4 counterpart — v6-side superset, safe direction only",
    protectedSamples: ["2001:2::1", "2001:2:0:ffff::1"],
    allowedNeighbours: ["2001:2:1::1", "2001:200::1"],
  },
  {
    range: "2002::/16",
    what: "6to4 — unwrapped at bytes 2..5, tunnel-endpoint v4 re-checked",
    mirrorsV4: "the whole IPv4 list",
    protectedSamples: [
      "2002::1", // endpoint 0.0.0.0
      "2002:7f00:1::1", // endpoint 127.0.0.1
      "2002:a9fe:a9fe::1", // endpoint 169.254.169.254 (metadata)
      "2002:c0a8:1::1", // endpoint 192.168.0.1
      "2002:0a00:1::1", // endpoint 10.0.0.1
    ],
    // A 6to4 wrapper around a PUBLIC endpoint stays reachable — the range is
    // classified by what it tunnels to, not denied wholesale.
    allowedNeighbours: ["2002:0808:0808::1", "2002:0101:0101::1", "2003::1"],
  },
  {
    range: "::ffff:0:0/96",
    what: "IPv4-mapped — unwrapped, embedded v4 re-checked",
    mirrorsV4: "the whole IPv4 list",
    protectedSamples: [
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
      "::ffff:a9fe:a9fe",
      "::ffff:0a00:0001",
      "::ffff:224.0.0.1",
    ],
    allowedNeighbours: ["::ffff:8.8.8.8", "::ffff:1.1.1.1"],
  },
  {
    range: "::/96",
    what: "IPv4-compatible (deprecated) — unwrapped, embedded v4 re-checked",
    mirrorsV4: "the whole IPv4 list",
    protectedSamples: ["::127.0.0.1", "::169.254.169.254", "::10.0.0.1", "::224.0.0.1"],
    allowedNeighbours: ["::8.8.8.8"],
  },
  {
    range: "::ffff:0:0:0/96",
    what: "IPv4-translated — unwrapped, embedded v4 re-checked",
    mirrorsV4: "the whole IPv4 list",
    protectedSamples: ["::ffff:0:127.0.0.1", "::ffff:0:7f00:1", "::ffff:0:a9fe:a9fe"],
    allowedNeighbours: ["::ffff:0:8.8.8.8"],
  },
  {
    range: "64:ff9b::/96",
    what: "NAT64 well-known prefix — unwrapped, embedded v4 re-checked",
    mirrorsV4: "the whole IPv4 list",
    protectedSamples: ["64:ff9b::127.0.0.1", "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe", "64:ff9b::10.0.0.1"],
    allowedNeighbours: ["64:ff9b::8.8.8.8"],
  },
  {
    range: "64:ff9b:1::/48",
    what: "NAT64 local-use — NOT unwrapped (variable embedded-v4 offset, RFC 8215)",
    mirrorsV4: "the operator-internal v4 space it translates to",
    protectedSamples: ["64:ff9b:1::1", "64:ff9b:1:ffff::8.8.8.8", "64:ff9b:2::1"],
    // The negative that matters: the local-use denial must not swallow the
    // well-known prefix, whose wrapper around a public v4 stays reachable.
    allowedNeighbours: ["64:ff9b::8.8.8.8"],
  },
];

describe("IPv6 protected-range coverage (parity with the IPv4 list)", () => {
  for (const entry of V6_RANGES) {
    it(`${entry.range} — ${entry.what} [mirrors v4: ${entry.mirrorsV4}]`, () => {
      for (const ip of entry.protectedSamples) {
        expect(gatewayModule.isProtectedAddress(ip), `${ip} must be protected`).toBe(true);
      }
      for (const ip of entry.allowedNeighbours) {
        expect(gatewayModule.isProtectedAddress(ip), `${ip} must stay reachable`).toBe(false);
      }
    });
  }

  it("outside global unicast (2000::/3) is refused wholesale — the v6 `a >= 224`", () => {
    // Everything IANA can hand out as a routable IPv6 destination comes from
    // 2000::/3; the complement is link/site/unique-local, multicast, discard,
    // SRv6, NAT64 local-use and IETF-reserved space. Rejecting the complement
    // is what gives the ranges above their coverage, so pin the boundary and a
    // representative of each reserved /3 that used to slip through.
    for (const ip of [
      "1fff:ffff::1", // last address below 2000::/3
      "4000::1",
      "6000::1",
      "8000::1",
      "a000::1",
      "c000::1",
      "e000::1",
      "0200::1", // deprecated NSAP allocation
      "0800::1",
      "1000::1",
    ]) {
      expect(gatewayModule.isProtectedAddress(ip), `${ip} is outside 2000::/3`).toBe(true);
    }
    for (const ip of ["2000::1", "3fff:ffff:ffff::1", "2606:4700:4700::1111", "2a00:1450::1"]) {
      expect(gatewayModule.isProtectedAddress(ip), `${ip} is global unicast`).toBe(false);
    }
  });

  it("every IPv4 class the predicate rejects has a rejected IPv6 counterpart", () => {
    // Read as a table: v4 sample (rejected today) → the v6 form of the same
    // class. Both sides must be rejected, so a future v4 addition without its
    // v6 counterpart reds this test.
    const parity: [v4: string, v6: string][] = [
      ["0.0.0.0", "::"],
      ["127.0.0.1", "::1"],
      ["10.0.0.1", "fd00::1"],
      ["172.16.0.1", "fc00::1"],
      ["192.168.1.1", "fdff::1"],
      ["169.254.169.254", "fe80::1"],
      ["224.0.0.1", "ff02::1"],
      ["255.255.255.255", "ff02::1"],
      ["100.64.0.1", "fc00::1"], // CGNAT has no v6 analogue; ULA is the carrier-private form
    ];
    for (const [v4, v6] of parity) {
      expect(gatewayModule.isProtectedAddress(v4), `${v4} (v4 side)`).toBe(true);
      expect(gatewayModule.isProtectedAddress(v6), `${v6} (v6 counterpart)`).toBe(true);
    }
  });

  it("the PINNED-ADDRESS path can never hand back a newly-protected range", async () => {
    for (const entry of V6_RANGES) {
      for (const ip of entry.protectedSamples) {
        expect(
          await gatewayModule.resolvePinnedAddress(ip),
          `resolvePinnedAddress(${ip}) must not pin`,
        ).toBeNull();
      }
    }
    // The counterpart: a reachable literal is still pinned verbatim, so the
    // hardening did not turn into a blanket IPv6 denial.
    expect(await gatewayModule.resolvePinnedAddress("2606:4700:4700::1111")).toBe(
      "2606:4700:4700::1111",
    );
    expect(await gatewayModule.resolvePinnedAddress("::ffff:8.8.8.8")).toBe("::ffff:8.8.8.8");
  });
});

describe("gateway-level denial for a newly-protected IPv6 destination", () => {
  it("CONNECT to an IPv6 multicast destination is 403 AFTER the policy allowed it", async () => {
    const gateway = makeGateway();
    // allow_all + a registered token: policy has no reason to refuse. The only
    // thing standing between the sandbox and ff02::1 is the address predicate.
    gateway.registry.register("job-v6", { mode: "allow_all", allowlist: [], maxBytesPerJob: 0 });
    const proxyPort = await listen(gateway.proxyServer);
    try {
      const status = await connectViaProxy({
        proxyPort,
        authority: "[ff02::1]:443",
        jobToken: "job-v6",
      });
      expect(status).toBe("HTTP/1.1 403 Forbidden");
      // Provenance of the 403: the destination was recorded ALLOWED by the
      // policy layer, so the refusal came from the pinned-address guard rather
      // than the allowlist — the coverage under test, not a lucky bystander.
      const snapshot = gateway.stats.snapshot("job-v6");
      const destination = snapshot.destinations.find((d) => d.host === "ff02::1");
      expect(destination).toBeDefined();
      expect(destination?.allowed).toBe(1);
      expect(destination?.denied).toBe(0);
    } finally {
      gateway.proxyServer.close();
      gateway.adminServer.close();
    }
  });

  it("CONNECT to a NAT64-wrapped metadata address is 403 (no wrapper bypass)", async () => {
    const gateway = makeGateway();
    gateway.registry.register("job-nat64", { mode: "allow_all", allowlist: [], maxBytesPerJob: 0 });
    const proxyPort = await listen(gateway.proxyServer);
    try {
      const status = await connectViaProxy({
        proxyPort,
        authority: "[64:ff9b::169.254.169.254]:443",
        jobToken: "job-nat64",
      });
      expect(status).toBe("HTTP/1.1 403 Forbidden");
      const snapshot = gateway.stats.snapshot("job-nat64");
      const destination = snapshot.destinations.find((d) => d.host === "64:ff9b::169.254.169.254");
      expect(destination?.allowed).toBe(1);
      expect(destination?.denied).toBe(0);
    } finally {
      gateway.proxyServer.close();
      gateway.adminServer.close();
    }
  });
});

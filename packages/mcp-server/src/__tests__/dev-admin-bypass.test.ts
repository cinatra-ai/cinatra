/**
 * Hermetic test for the dev-admin-bypass policy.
 *
 * The policy is intentionally a pure function — testing the boundaries
 * matters more than testing the call site. Every guard (NODE_ENV, the opt-in
 * env flag, forwarded-header absence, a loopback SOCKET PEER, and the per-boot
 * local credential) must hold; missing any one must keep the bypass off.
 *
 * The trust decision reads NO hostname. The host helpers below
 * (`normalizeHost` / `urlRequestHost` / `forwardedRequestHost` /
 * `effectiveRequestHost` / `parseTrustedHosts`) survive for request shaping and
 * diagnostics, and their behaviour is pinned here so a later change cannot
 * quietly re-introduce a host-derived trust path.
 */
import { describe, it, expect } from "vitest";
import {
  DEV_LOCAL_TOKEN_HEADER,
  FORWARDED_HEADER_NAMES,
  effectiveRequestHost,
  forwardedRequestHost,
  hasForwardedHeader,
  isLoopbackPeerAddress,
  isTrustedDevPeer,
  localTokensMatch,
  normalizeHost,
  parseTrustedHosts,
  shouldGrantDevAdminBypass,
  urlRequestHost,
} from "../dev-admin-bypass";

const TOKEN = "a".repeat(64);

/** Header bag with the read-only shape the policy consumes. */
function headers(map: Record<string, string>): { get(name: string): string | null } {
  const lower = new Map(
    Object.entries(map).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return { get: (name: string) => lower.get(name.toLowerCase()) ?? null };
}

describe("shouldGrantDevAdminBypass — dev admin bypass policy", () => {
  it("grants when all guards pass (NODE_ENV != production, flag=true, trusted dev peer)", () => {
    expect(
      shouldGrantDevAdminBypass({
        nodeEnv: "development",
        envBypassFlag: "true",
        isTrustedDevPeer: true,
      }),
    ).toBe(true);
  });

  it("grants in test env (NODE_ENV=test is not production)", () => {
    expect(
      shouldGrantDevAdminBypass({
        nodeEnv: "test",
        envBypassFlag: "true",
        isTrustedDevPeer: true,
      }),
    ).toBe(true);
  });

  it("refuses in production even with flag and trusted peer", () => {
    expect(
      shouldGrantDevAdminBypass({
        nodeEnv: "production",
        envBypassFlag: "true",
        isTrustedDevPeer: true,
      }),
    ).toBe(false);
  });

  it("refuses when the peer is not trusted", () => {
    expect(
      shouldGrantDevAdminBypass({
        nodeEnv: "development",
        envBypassFlag: "false",
        isTrustedDevPeer: false,
      }),
    ).toBe(false);
  });

  it("refuses when the opt-in flag is absent or not exactly 'true'", () => {
    expect(
      shouldGrantDevAdminBypass({
        nodeEnv: "development",
        envBypassFlag: undefined,
        isTrustedDevPeer: true,
      }),
    ).toBe(false);
    expect(
      shouldGrantDevAdminBypass({
        nodeEnv: "development",
        envBypassFlag: "TRUE",
        isTrustedDevPeer: true,
      }),
    ).toBe(false);
    expect(
      shouldGrantDevAdminBypass({
        nodeEnv: "development",
        envBypassFlag: "1",
        isTrustedDevPeer: true,
      }),
    ).toBe(false);
  });
});

describe("isTrustedDevPeer — socket peer + per-boot credential", () => {
  function call(
    over: Partial<Parameters<typeof isTrustedDevPeer>[0]> = {},
  ): boolean {
    return isTrustedDevPeer({
      nodeEnv: "development",
      envBypassFlag: "true",
      peerAddress: "127.0.0.1",
      forwardedHeaderPresent: false,
      presentedToken: TOKEN,
      expectedToken: TOKEN,
      ...over,
    });
  }

  it("grants a loopback socket peer presenting the per-boot credential", () => {
    expect(call()).toBe(true);
    expect(call({ peerAddress: "::1" })).toBe(true);
    expect(call({ peerAddress: "::ffff:127.0.0.1" })).toBe(true);
  });

  // THE DEFECT THIS SUITE EXISTS FOR. A caller anywhere on the network can
  // write `Host: localhost`, and the development server then synthesises the
  // forwarded chain from that very header — so a request whose HEADERS all say
  // "local" proves nothing at all. None of these inputs is a hostname any more,
  // and the presence of a forwarded header refuses on its own.
  it("REFUSES a request carrying any forwarded header, at any value", () => {
    for (const name of FORWARDED_HEADER_NAMES) {
      expect(name).toBeTypeOf("string");
    }
    expect(call({ forwardedHeaderPresent: true })).toBe(false);
    // Even with a loopback peer AND the real credential.
    expect(
      call({
        forwardedHeaderPresent: true,
        peerAddress: "127.0.0.1",
        presentedToken: TOKEN,
        expectedToken: TOKEN,
      }),
    ).toBe(false);
  });

  it("REFUSES a remote socket peer however local the request claims to be", () => {
    expect(call({ peerAddress: "203.0.113.7" })).toBe(false);
    expect(call({ peerAddress: "10.1.2.3" })).toBe(false);
    expect(call({ peerAddress: "172.17.0.4" })).toBe(false);
    expect(call({ peerAddress: "::ffff:203.0.113.7" })).toBe(false);
  });

  it("REFUSES when the socket peer is unknown (fail closed, no header fallback)", () => {
    expect(call({ peerAddress: null })).toBe(false);
    expect(call({ peerAddress: "" })).toBe(false);
  });

  it("REFUSES when no credential was minted (unset means off)", () => {
    expect(call({ expectedToken: null })).toBe(false);
    expect(call({ expectedToken: "" })).toBe(false);
  });

  it("REFUSES when the presented credential is absent or wrong", () => {
    expect(call({ presentedToken: null })).toBe(false);
    expect(call({ presentedToken: "" })).toBe(false);
    expect(call({ presentedToken: "b".repeat(64) })).toBe(false);
    // A prefix of the real credential is not the credential.
    expect(call({ presentedToken: TOKEN.slice(0, 32) })).toBe(false);
    // Nor is the credential plus anything.
    expect(call({ presentedToken: `${TOKEN}x` })).toBe(false);
  });

  it("REFUSES in production and without the opt-in flag", () => {
    expect(call({ nodeEnv: "production" })).toBe(false);
    expect(call({ envBypassFlag: undefined })).toBe(false);
    expect(call({ envBypassFlag: "TRUE" })).toBe(false);
  });
});

describe("hasForwardedHeader — presence, never value", () => {
  it("names exactly the four forwarded headers", () => {
    expect([...FORWARDED_HEADER_NAMES]).toEqual([
      "x-forwarded-for",
      "x-forwarded-host",
      "x-forwarded-proto",
      "forwarded",
    ]);
  });

  it("is false only when none of them is present", () => {
    expect(hasForwardedHeader(headers({}))).toBe(false);
    expect(hasForwardedHeader(headers({ host: "localhost:3000" }))).toBe(false);
  });

  it("is true for each of them, including a chain that names only loopback", () => {
    expect(hasForwardedHeader(headers({ "x-forwarded-for": "127.0.0.1" }))).toBe(true);
    expect(hasForwardedHeader(headers({ "x-forwarded-host": "localhost" }))).toBe(true);
    expect(hasForwardedHeader(headers({ "x-forwarded-proto": "http" }))).toBe(true);
    expect(hasForwardedHeader(headers({ forwarded: "for=127.0.0.1" }))).toBe(true);
    // Empty string is still PRESENT.
    expect(hasForwardedHeader(headers({ "x-forwarded-for": "" }))).toBe(true);
  });

  it("reads the credential header by its published name", () => {
    expect(DEV_LOCAL_TOKEN_HEADER).toBe("x-cinatra-dev-local-token");
  });
});

describe("isLoopbackPeerAddress — socket peer classification", () => {
  it("accepts the loopback forms a runtime actually reports", () => {
    expect(isLoopbackPeerAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackPeerAddress("127.1.2.3")).toBe(true);
    expect(isLoopbackPeerAddress("::1")).toBe(true);
    expect(isLoopbackPeerAddress("[::1]")).toBe(true);
    expect(isLoopbackPeerAddress("0:0:0:0:0:0:0:1")).toBe(true);
    expect(isLoopbackPeerAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackPeerAddress("::FFFF:127.0.0.1")).toBe(true);
  });

  it("refuses everything else, including absent and hostname-shaped input", () => {
    expect(isLoopbackPeerAddress(null)).toBe(false);
    expect(isLoopbackPeerAddress(undefined)).toBe(false);
    expect(isLoopbackPeerAddress("")).toBe(false);
    expect(isLoopbackPeerAddress("   ")).toBe(false);
    // A NAME is not a socket peer address — the peer is always numeric.
    expect(isLoopbackPeerAddress("localhost")).toBe(false);
    expect(isLoopbackPeerAddress("host.docker.internal")).toBe(false);
    expect(isLoopbackPeerAddress("192.0.2.10")).toBe(false);
    expect(isLoopbackPeerAddress("10.0.0.1")).toBe(false);
    expect(isLoopbackPeerAddress("172.18.0.2")).toBe(false);
    expect(isLoopbackPeerAddress("203.0.113.7")).toBe(false);
    expect(isLoopbackPeerAddress("fe80::1%en0")).toBe(false);
    expect(isLoopbackPeerAddress("::ffff:10.0.0.1")).toBe(false);
    // Not a 127-block address, merely prefixed by one.
    expect(isLoopbackPeerAddress("127.0.0.1.evil.example")).toBe(false);
  });
});

describe("localTokensMatch — constant-time credential compare", () => {
  it("matches only an exact credential", () => {
    expect(localTokensMatch(TOKEN, TOKEN)).toBe(true);
    expect(localTokensMatch(TOKEN, `${TOKEN}x`)).toBe(false);
    expect(localTokensMatch(`${TOKEN}x`, TOKEN)).toBe(false);
    expect(localTokensMatch(TOKEN.slice(0, 63), TOKEN)).toBe(false);
  });

  it("refuses when either side is absent or empty", () => {
    expect(localTokensMatch(null, TOKEN)).toBe(false);
    expect(localTokensMatch(TOKEN, null)).toBe(false);
    expect(localTokensMatch(undefined, undefined)).toBe(false);
    expect(localTokensMatch("", "")).toBe(false);
  });
});

describe("normalizeHost — host normalization", () => {
  it("returns null for empty / whitespace / undefined", () => {
    expect(normalizeHost(undefined)).toBeNull();
    expect(normalizeHost(null)).toBeNull();
    expect(normalizeHost("")).toBeNull();
    expect(normalizeHost("   ")).toBeNull();
  });

  it("lowercases", () => {
    expect(normalizeHost("FOO.TS.NET")).toBe("foo.ts.net");
  });

  it("strips :port for plain hostnames", () => {
    expect(normalizeHost("localhost:3000")).toBe("localhost");
    expect(normalizeHost("foo.ts.net:443")).toBe("foo.ts.net");
  });

  it("strips IPv6 brackets and port", () => {
    expect(normalizeHost("[::1]")).toBe("::1");
    expect(normalizeHost("[::1]:3000")).toBe("::1");
    expect(normalizeHost("[2001:db8::1]:8080")).toBe("2001:db8::1");
  });

  it("preserves raw IPv6 without brackets (no port stripping)", () => {
    // No brackets, multiple colons → assume raw IPv6, do not strip
    expect(normalizeHost("::1")).toBe("::1");
    expect(normalizeHost("2001:db8::1")).toBe("2001:db8::1");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeHost("  foo.ts.net  ")).toBe("foo.ts.net");
  });

  it("rejects URL-shaped inputs (scheme prefix)", () => {
    // A buggy port-strip would turn `https://foo.ts.net` into `https`,
    // and an attacker probing with `Host: https` could have matched.
    expect(normalizeHost("https://foo.ts.net")).toBeNull();
    expect(normalizeHost("http://localhost")).toBeNull();
    expect(normalizeHost("https://[::1]:3000")).toBeNull();
    // Bare `host:port` with a numeric port is still accepted
    expect(normalizeHost("foo.ts.net:443")).toBe("foo.ts.net");
  });

  it("rejects malformed IPv6 bracket suffixes", () => {
    // `[::1]evil.com` must not normalize to `::1` by silently ignoring
    // the trailing junk. The normalizer must reject
    // anything after `]` that isn't an empty string or `:<port>`.
    expect(normalizeHost("[::1]evil.com")).toBeNull();
    expect(normalizeHost("[::1]bar")).toBeNull();
    expect(normalizeHost("[::1]:port")).toBeNull();
    // Still accept the legitimate forms
    expect(normalizeHost("[::1]")).toBe("::1");
    expect(normalizeHost("[::1]:3000")).toBe("::1");
  });

  it("rejects plain `host:non-numeric-port`", () => {
    // A single-colon suffix must be all digits.
    // Otherwise we mangle a malformed input into a valid-looking host.
    expect(normalizeHost("localhost:notaport")).toBeNull();
    expect(normalizeHost("foo.com:abc")).toBeNull();
    expect(normalizeHost("foo.com:")).toBeNull();
    // Numeric port is fine
    expect(normalizeHost("foo.com:8080")).toBe("foo.com");
  });
});

describe("forwardedRequestHost — forwarded host parsing", () => {
  function headers(map: Record<string, string>) {
    const normalized = new Map(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
    return { get: (name: string) => normalized.get(name.toLowerCase()) ?? null };
  }

  it("null when header absent", () => {
    expect(forwardedRequestHost(headers({}))).toBeNull();
  });

  it("extracts first comma-separated value, normalized", () => {
    expect(forwardedRequestHost(headers({ "x-forwarded-host": "Foo.Ts.Net" }))).toBe("foo.ts.net");
    expect(forwardedRequestHost(headers({ "x-forwarded-host": "a.com, b.com" }))).toBe("a.com");
    expect(forwardedRequestHost(headers({ "x-forwarded-host": "[::1]:3000" }))).toBe("::1");
  });

  it("returns null on whitespace-only or malformed value", () => {
    expect(forwardedRequestHost(headers({ "x-forwarded-host": "" }))).toBeNull();
    expect(forwardedRequestHost(headers({ "x-forwarded-host": "   " }))).toBeNull();
    expect(forwardedRequestHost(headers({ "x-forwarded-host": "https://foo.ts.net" }))).toBeNull();
  });
});

describe("urlRequestHost — URL host parsing", () => {
  it("returns normalized URL hostname", () => {
    expect(urlRequestHost("https://Foo.Ts.Net:443/api/mcp")).toBe("foo.ts.net");
  });

  it("returns null on malformed URL", () => {
    expect(urlRequestHost("not a url")).toBeNull();
  });

  it("ignores any forwarded-host header semantics", () => {
    // urlRequestHost doesn't see headers — that's the whole point.
    expect(urlRequestHost("http://localhost:3000/api/mcp")).toBe("localhost");
  });
});

describe("parseTrustedHosts — trusted host allowlist parsing", () => {
  it("empty / null / undefined produce empty set", () => {
    expect(parseTrustedHosts(undefined).size).toBe(0);
    expect(parseTrustedHosts(null).size).toBe(0);
    expect(parseTrustedHosts("").size).toBe(0);
    expect(parseTrustedHosts("   ").size).toBe(0);
  });

  it("single host", () => {
    const set = parseTrustedHosts("foo.ts.net");
    expect(set.size).toBe(1);
    expect(set.has("foo.ts.net")).toBe(true);
  });

  it("multi-host with whitespace", () => {
    const set = parseTrustedHosts("a.com,  b.com , c.com");
    expect(set.has("a.com")).toBe(true);
    expect(set.has("b.com")).toBe(true);
    expect(set.has("c.com")).toBe(true);
    expect(set.size).toBe(3);
  });

  it("skips empty entries and dedupes", () => {
    const set = parseTrustedHosts("a.com,,b.com,a.com,");
    expect(set.size).toBe(2);
    expect(set.has("a.com")).toBe(true);
    expect(set.has("b.com")).toBe(true);
  });

  it("normalizes case + strips port", () => {
    const set = parseTrustedHosts("FOO.ts.NET:443");
    expect(set.has("foo.ts.net")).toBe(true);
  });
});

describe("effectiveRequestHost — effective request host resolution", () => {
  function makeHeaders(map: Record<string, string>): { get(name: string): string | null } {
    const normalized = new Map<string, string>(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      get(name: string): string | null {
        return normalized.get(name.toLowerCase()) ?? null;
      },
    };
  }

  it("x-forwarded-host `localhost:3000` → `localhost`", () => {
    const h = makeHeaders({ "x-forwarded-host": "localhost:3000" });
    expect(effectiveRequestHost(h, "http://localhost:3000/api/mcp")).toBe("localhost");
  });

  it("x-forwarded-host `[::1]:3000` → `::1`", () => {
    const h = makeHeaders({ "x-forwarded-host": "[::1]:3000" });
    expect(effectiveRequestHost(h, "http://[::1]:3000/api/mcp")).toBe("::1");
  });

  it("x-forwarded-host `Foo.Ts.Net` is lowercased", () => {
    const h = makeHeaders({ "x-forwarded-host": "Foo.Ts.Net" });
    expect(effectiveRequestHost(h, "https://Foo.Ts.Net/api/mcp")).toBe("foo.ts.net");
  });

  it("x-forwarded-host with comma-separated values picks the first", () => {
    const h = makeHeaders({ "x-forwarded-host": "a.com, b.com" });
    expect(effectiveRequestHost(h, "http://a.com/api/mcp")).toBe("a.com");
  });

  it("no x-forwarded-host → URL hostname", () => {
    const h = makeHeaders({});
    expect(effectiveRequestHost(h, "http://foo.ts.net/api/mcp")).toBe("foo.ts.net");
  });

  it("malformed URL with no forwarded header → null", () => {
    const h = makeHeaders({});
    expect(effectiveRequestHost(h, "this is not a url")).toBeNull();
  });

  it("x-forwarded-host takes precedence over URL hostname", () => {
    const h = makeHeaders({ "x-forwarded-host": "foo.ts.net" });
    expect(effectiveRequestHost(h, "http://localhost:3000/api/mcp")).toBe("foo.ts.net");
  });

  it("whitespace-only forwarded header falls through to URL hostname", () => {
    const h = makeHeaders({ "x-forwarded-host": "   " });
    expect(effectiveRequestHost(h, "http://foo.ts.net/api/mcp")).toBe("foo.ts.net");
  });
});

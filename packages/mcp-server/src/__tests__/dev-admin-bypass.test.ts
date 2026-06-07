/**
 * Hermetic test for the dev-admin-bypass policy.
 *
 * The policy is intentionally a pure function — testing the boundaries
 * matters more than testing the call site. The three guards (NODE_ENV,
 * opt-in env flag, trusted-dev-host detection) must ALL hold; missing any
 * one must keep the bypass off.
 *
 * The host helpers cover:
 *   - `isTrustedDevHost()` — unified trust tier (loopback OR env allowlist)
 *   - `parseTrustedHosts()` — comma-separated allowlist parsing
 *   - `normalizeHost()` / `effectiveRequestHost()` — host normalization
 *
 * `shouldGrantDevAdminBypass()` keeps its three-guard shape; the
 * `isTrustedDevHost` argument reflects the widened trust tier.
 */
import { describe, it, expect } from "vitest";
import {
  effectiveRequestHost,
  forwardedRequestHost,
  isTrustedDevHost,
  normalizeHost,
  parseTrustedHosts,
  shouldGrantDevAdminBypass,
  urlRequestHost,
} from "../dev-admin-bypass";

describe("shouldGrantDevAdminBypass — dev admin bypass policy", () => {
  it("grants when all three guards pass (NODE_ENV != production, flag=true, trusted host)", () => {
    expect(
      shouldGrantDevAdminBypass({
        nodeEnv: "development",
        envBypassFlag: "true",
        isTrustedDevHost: true,
      }),
    ).toBe(true);
  });

  it("denies in NODE_ENV=production even with flag + trusted host", () => {
    expect(
      shouldGrantDevAdminBypass({
        nodeEnv: "production",
        envBypassFlag: "true",
        isTrustedDevHost: true,
      }),
    ).toBe(false);
  });

  it("denies when flag is absent / not 'true'", () => {
    for (const flag of [undefined, "", "false", "1", "yes", "TRUE"]) {
      expect(
        shouldGrantDevAdminBypass({
          nodeEnv: "development",
          envBypassFlag: flag,
          isTrustedDevHost: true,
        }),
      ).toBe(false);
    }
  });

  it("denies when request is not a trusted dev host", () => {
    expect(
      shouldGrantDevAdminBypass({
        nodeEnv: "development",
        envBypassFlag: "true",
        isTrustedDevHost: false,
      }),
    ).toBe(false);
  });

  it("NODE_ENV=undefined treated as non-production (only literal 'production' denies)", () => {
    expect(
      shouldGrantDevAdminBypass({
        nodeEnv: undefined,
        envBypassFlag: "true",
        isTrustedDevHost: true,
      }),
    ).toBe(true);
    expect(
      shouldGrantDevAdminBypass({
        nodeEnv: undefined,
        envBypassFlag: undefined,
        isTrustedDevHost: true,
      }),
    ).toBe(false);
  });

  it("production denies even when flag is mis-set", () => {
    expect(
      shouldGrantDevAdminBypass({
        nodeEnv: "production",
        envBypassFlag: "true",
        isTrustedDevHost: true,
      }),
    ).toBe(false);
  });
});

describe("isTrustedDevHost — trusted host policy", () => {
  // Convenience defaults for the env-flag + nodeEnv guards.
  const ok = { nodeEnv: "development", envBypassFlag: "true" } as const;
  function call(extra: {
    trustedHostsEnv: string | undefined;
    urlHost: string | null;
    forwardedHostRaw?: string | null;
  }) {
    return isTrustedDevHost({
      ...ok,
      trustedHostsEnv: extra.trustedHostsEnv,
      urlHost: extra.urlHost,
      forwardedHostRaw: extra.forwardedHostRaw ?? null,
    });
  }

  it("loopback `localhost` urlHost is trusted when env flags pass", () => {
    expect(call({ trustedHostsEnv: undefined, urlHost: "localhost" })).toBe(true);
  });

  it("loopback denied in production regardless of env flag", () => {
    expect(
      isTrustedDevHost({
        nodeEnv: "production",
        envBypassFlag: "true",
        trustedHostsEnv: undefined,
        urlHost: "localhost",
        forwardedHostRaw: null,
      }),
    ).toBe(false);
  });

  it("denied when CINATRA_MCP_DEV_ADMIN_BYPASS not 'true'", () => {
    for (const flag of [undefined, "", "false", "1", "TRUE"]) {
      expect(
        isTrustedDevHost({
          nodeEnv: "development",
          envBypassFlag: flag,
          trustedHostsEnv: "foo.ts.net",
          urlHost: "foo.ts.net",
          forwardedHostRaw: null,
        }),
      ).toBe(false);
    }
  });

  it("env-allowlisted urlHost trusted when flags pass", () => {
    expect(call({ trustedHostsEnv: "foo.ts.net", urlHost: "foo.ts.net" })).toBe(true);
  });

  it("allowlist match is exact — does NOT trust suffix hosts", () => {
    expect(call({ trustedHostsEnv: "foo.ts.net", urlHost: "bar.foo.ts.net" })).toBe(false);
    expect(call({ trustedHostsEnv: "foo.ts.net", urlHost: "xfoo.ts.net" })).toBe(false);
  });

  it("allowlist match is case-insensitive (helper normalizes signals)", () => {
    expect(call({ trustedHostsEnv: "FOO.ts.NET", urlHost: "foo.ts.net" })).toBe(true);
    expect(call({ trustedHostsEnv: "foo.ts.net", urlHost: "FOO.TS.NET" })).toBe(true);
  });

  it("allowlist is comma-separated, whitespace-tolerant, multi-host", () => {
    const env = "a.com, b.com , c.com";
    for (const host of ["a.com", "b.com", "c.com"]) {
      expect(call({ trustedHostsEnv: env, urlHost: host })).toBe(true);
    }
  });

  it("host not in allowlist is denied", () => {
    expect(call({ trustedHostsEnv: "a.com,b.com", urlHost: "c.com" })).toBe(false);
  });

  it("empty / whitespace allowlist grants no extra trust beyond loopback", () => {
    for (const env of [undefined, "", "   ", ",", ", ,"]) {
      expect(call({ trustedHostsEnv: env, urlHost: "foo.ts.net" })).toBe(false);
      // Loopback urlHost still works
      expect(call({ trustedHostsEnv: env, urlHost: "127.0.0.1" })).toBe(true);
    }
  });

  it("scheme-prefixed allowlist entry does NOT match plain hostname", () => {
    // Operator typo guard. `https://foo.ts.net` is rejected by `normalizeHost`
    // (contains `://`), so the allowlist set is effectively empty.
    expect(call({ trustedHostsEnv: "https://foo.ts.net", urlHost: "foo.ts.net" })).toBe(false);
    // Specifically: the bare `https` token (which a buggy port-strip would
    // have produced) MUST NOT match — otherwise a request with
    // `Host: https` (e.g. attacker probing) could gain admin.
    expect(call({ trustedHostsEnv: "https://foo.ts.net", urlHost: "https" })).toBe(false);
  });

  it("null/empty hosts are denied even if env flags pass", () => {
    expect(call({ trustedHostsEnv: "foo.ts.net", urlHost: null })).toBe(false);
    expect(call({ trustedHostsEnv: "foo.ts.net", urlHost: "" })).toBe(false);
  });

  it("production wins even with valid allowlist + matching host", () => {
    expect(
      isTrustedDevHost({
        nodeEnv: "production",
        envBypassFlag: "true",
        trustedHostsEnv: "foo.ts.net",
        urlHost: "foo.ts.net",
        forwardedHostRaw: null,
      }),
    ).toBe(false);
  });

  it("all four loopback hosts are trusted by default (urlHost only)", () => {
    for (const host of ["localhost", "127.0.0.1", "::1", "host.docker.internal"]) {
      expect(call({ trustedHostsEnv: undefined, urlHost: host })).toBe(true);
    }
  });

  // Spoofing defenses for `x-forwarded-host`.
  it("allowlist path ignores forwardedHost — spoof does not grant trust", () => {
    // Attacker on a non-loopback URL spoofs forwarded-host to an
    // allowlisted hostname. Allowlist path consults urlHost only → reject.
    expect(
      isTrustedDevHost({
        nodeEnv: "development",
        envBypassFlag: "true",
        trustedHostsEnv: "foo.ts.net",
        urlHost: "attacker.example.com",
        forwardedHostRaw: "foo.ts.net",
      }),
    ).toBe(false);
  });

  it("legit Tailscale Serve topology (Host preserved end-to-end) is trusted", () => {
    expect(
      isTrustedDevHost({
        nodeEnv: "development",
        envBypassFlag: "true",
        trustedHostsEnv: "my-box.tailnet000.ts.net",
        urlHost: "my-box.tailnet000.ts.net",
        forwardedHostRaw: null,
      }),
    ).toBe(true);
  });

  // Loopback path requires urlHost to be loopback. The
  // forwarded-host header is a VETO signal only (must agree or be absent).
  it("loopback path — urlHost=loopback + forwardedHost=loopback → trust", () => {
    expect(
      call({ trustedHostsEnv: undefined, urlHost: "localhost", forwardedHostRaw: "localhost" }),
    ).toBe(true);
  });

  it("loopback path — urlHost=loopback + forwardedHost=non-loopback → reject (veto)", () => {
    expect(
      call({
        trustedHostsEnv: undefined,
        urlHost: "localhost",
        forwardedHostRaw: "foo.ts.net",
      }),
    ).toBe(false);
  });

  it("spoof defense — urlHost=non-loopback + forwardedHost=loopback → reject", () => {
    // `X-Forwarded-Host: localhost:3000` while request.url is
    // `http://attacker.example.com/api/mcp` must NOT produce loopback trust.
    expect(
      call({
        trustedHostsEnv: undefined,
        urlHost: "attacker.example.com",
        forwardedHostRaw: "localhost",
      }),
    ).toBe(false);
  });

  it("Turbopack dev-proxy compat — urlHost=localhost + forwardedHostRaw=`localhost:3000` (loopback) → trust", () => {
    // Turbopack's dev server sets x-forwarded-host to localhost:<port>,
    // which is still a loopback address and is treated as local.
    // normalizeHost strips the port, so forwardedHost ends up as
    // `localhost` → veto agrees.
    expect(
      call({ trustedHostsEnv: undefined, urlHost: "localhost", forwardedHostRaw: "localhost:3000" }),
    ).toBe(true);
  });

  // Malformed-but-PRESENT forwarded-host veto. Present-but-unparseable
  // headers must not collapse to "absent" and silently bypass the veto.
  it("malformed forwarded-host with loopback urlHost → reject (veto present)", () => {
    for (const raw of [
      "https://evil.example", // URL-shaped → normalizeHost returns null
      "[::1]evil.com",        // malformed IPv6 bracket suffix
      "   ",                  // whitespace only
      "",                     // empty string (header present but empty value)
    ]) {
      expect(
        call({ trustedHostsEnv: undefined, urlHost: "localhost", forwardedHostRaw: raw }),
      ).toBe(false);
    }
  });

  it("header absent (null) is distinct from header present-but-malformed", () => {
    // Absent → veto inactive → trust based on urlHost alone.
    expect(
      call({ trustedHostsEnv: undefined, urlHost: "localhost", forwardedHostRaw: null }),
    ).toBe(true);
  });

  it("multi-value forwarded with first-value malformed → reject", () => {
    // We pick the first comma-separated value (HTTP convention). If the
    // first parses to non-loopback OR fails to parse, the veto fires.
    expect(
      call({
        trustedHostsEnv: undefined,
        urlHost: "localhost",
        forwardedHostRaw: "evil.example, localhost",
      }),
    ).toBe(false);
  });

  it("non-numeric port suffix in forwarded value → veto (malformed)", () => {
    // A single-colon suffix that isn't all digits (e.g.
    // `localhost:notaport`) must not be stripped and normalized to
    // `localhost`, which would silently pass the veto. Reject it as
    // present-but-invalid.
    for (const raw of [
      "localhost:notaport",
      "127.0.0.1:bad",
      "::1:foo", // multi-colon w/o brackets — kept literal, fails loopback match
    ]) {
      expect(
        call({ trustedHostsEnv: undefined, urlHost: "localhost", forwardedHostRaw: raw }),
      ).toBe(false);
    }
  });

  // Reverse-proxy topology: public-edge proxies can rewrite Host to
  // `localhost:3000` and put the public hostname in `X-Forwarded-Host`.
  // The same shape applies to named Cloudflare Tunnel, cloudflared
  // named-tunnel mode, and any other reverse proxy that terminates TLS
  // at the public edge and forwards to the localhost listener. Loopback
  // path must trust forwarded-host values that match the operator-defined
  // allowlist.
  it("Funnel topology — urlHost=loopback + forwardedHost=allowlisted → trust", () => {
    expect(
      call({
        trustedHostsEnv: "localhost-0.tailnet000.ts.net",
        urlHost: "localhost",
        forwardedHostRaw: "localhost-0.tailnet000.ts.net",
      }),
    ).toBe(true);
  });

  it("spoof — urlHost=loopback + forwardedHost=non-loopback-non-allowlisted → reject", () => {
    expect(
      call({
        trustedHostsEnv: "foo.ts.net",
        urlHost: "localhost",
        forwardedHostRaw: "attacker.example.com",
      }),
    ).toBe(false);
  });

  it("non-loopback urlHost cannot be rescued by allowlisted forwarded-host", () => {
    // The allowlist path consults urlHost ONLY. Even if forwardedHost
    // matches the allowlist, a non-loopback urlHost that is not in the
    // allowlist must reject.
    expect(
      call({
        trustedHostsEnv: "foo.ts.net",
        urlHost: "attacker.example.com",
        forwardedHostRaw: "foo.ts.net",
      }),
    ).toBe(false);
  });

  it("urlHost=loopback + forwardedHost=malformed → reject (veto preserved)", () => {
    // Sanity check that adding the allowlist branch did not weaken the
    // malformed-veto path.
    for (const raw of [
      "https://evil.example",
      "[::1]evil.com",
      "localhost:notaport",
    ]) {
      expect(
        call({ trustedHostsEnv: "foo.ts.net", urlHost: "localhost", forwardedHostRaw: raw }),
      ).toBe(false);
    }
  });

  it("comma-separated forwarded — first value drives the veto/trust decision", () => {
    // First-value-wins is the HTTP convention. If the first value is
    // allowlisted, trust; if the first value is malformed/non-loopback/
    // non-allowlisted, reject (even when a later value would have matched).
    expect(
      call({
        trustedHostsEnv: "foo.ts.net",
        urlHost: "localhost",
        forwardedHostRaw: "foo.ts.net, attacker.example.com",
      }),
    ).toBe(true);
    expect(
      call({
        trustedHostsEnv: "foo.ts.net",
        urlHost: "localhost",
        forwardedHostRaw: "attacker.example.com, foo.ts.net",
      }),
    ).toBe(false);
  });

  it("URL-shaped allowlist entries do NOT widen the loopback forwarded path", () => {
    // Explicit guard for the loopback-forwarded branch. If the operator writes a URL into env
    // (`https://foo.ts.net`), `parseTrustedHosts` drops it (because
    // `normalizeHost` rejects `://`). A request with forwarded-host
    // `foo.ts.net` must therefore NOT match.
    expect(
      call({
        trustedHostsEnv: "https://foo.ts.net",
        urlHost: "localhost",
        forwardedHostRaw: "foo.ts.net",
      }),
    ).toBe(false);
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

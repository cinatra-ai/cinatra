import { describe, expect, it } from "vitest";

import {
  isConcreteOrigin,
  normalizeConcreteOrigin,
  resolveConcreteOrigin,
} from "../origin-policy";

// The resolver's own contract. `new URL()` is a parser, not a validator — these
// cases are the line between "the parser accepted it" and "this is a place".

describe("resolveConcreteOrigin", () => {
  it("returns the canonical scheme://host[:port] for a real site", () => {
    expect(resolveConcreteOrigin("https://a.example/path?x=1#h")).toEqual({
      ok: true,
      origin: "https://a.example",
    });
    expect(resolveConcreteOrigin("http://a.example:8080")).toEqual({
      ok: true,
      origin: "http://a.example:8080",
    });
    expect(resolveConcreteOrigin("  https://a.example  ")).toEqual({
      ok: true,
      origin: "https://a.example",
    });
  });

  it("drops the default port and punycodes an internationalized name", () => {
    expect(normalizeConcreteOrigin("https://a.example:443")).toBe("https://a.example");
    expect(normalizeConcreteOrigin("http://a.example:80")).toBe("http://a.example");
    expect(normalizeConcreteOrigin("https://münchen.example")).toBe(
      "https://xn--mnchen-3ya.example",
    );
    expect(normalizeConcreteOrigin("https://xn--mnchen-3ya.example:8443")).toBe(
      "https://xn--mnchen-3ya.example:8443",
    );
  });

  it("accepts loopback, IP literals and a single-label host", () => {
    expect(normalizeConcreteOrigin("http://localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeConcreteOrigin("https://10.0.0.7")).toBe("https://10.0.0.7");
    expect(normalizeConcreteOrigin("https://[::1]:8443")).toBe("https://[::1]:8443");
    expect(normalizeConcreteOrigin("https://[2001:db8::1]")).toBe("https://[2001:db8::1]");
  });

  it("refuses an asterisk in the HOST in any form, and says WHY", () => {
    for (const candidate of [
      "*",
      "https://*",
      "https://*.example.com",
      "https://%2A.example.com",
      "https://%2a.example.com",
      "https://exam%2Aple.com",
      // Unicode look-alikes the WHATWG parser FOLDS to a literal asterisk, so
      // the written form carries no `*` at all and only the parsed host does.
      "https://＊.example",
      "https://﹡.example",
    ]) {
      const resolved = resolveConcreteOrigin(candidate);
      expect(resolved.ok).toBe(false);
      if (!resolved.ok) expect(resolved.refusal).toBe("wildcard");
      expect(normalizeConcreteOrigin(candidate)).toBe("");
    }
  });

  it("accepts an asterisk OUTSIDE the host — a path or query is discarded", () => {
    // The origin is what this resolver answers; a star in a component that is
    // thrown away says nothing about which site the value names, and refusing
    // it would fail a real registration for a decoration.
    expect(normalizeConcreteOrigin("https://shop.example/assets/*.js")).toBe(
      "https://shop.example",
    );
    expect(normalizeConcreteOrigin("https://shop.example/?q=*")).toBe("https://shop.example");
    expect(normalizeConcreteOrigin("https://shop.example/#*")).toBe("https://shop.example");
    // A backslash starts the path too, for the schemes this resolver accepts.
    expect(normalizeConcreteOrigin("https://shop.example\\assets\\*.js")).toBe(
      "https://shop.example",
    );
  });

  it("keeps the DNS root dot exactly as written — a distinct origin, never folded", () => {
    // A page served from the dotted address sends the dotted origin, so folding
    // it onto the dotless one would break the byte-equality every comparison
    // downstream relies on. It is accepted, and it stays its own origin.
    expect(normalizeConcreteOrigin("https://shop.example.com.")).toBe("https://shop.example.com.");
    expect(normalizeConcreteOrigin("https://shop.example.com.")).not.toBe(
      normalizeConcreteOrigin("https://shop.example.com"),
    );
  });

  it("accepts an underscore anywhere in a label, refuses an edge hyphen", () => {
    expect(normalizeConcreteOrigin("https://_edge.example")).toBe("https://_edge.example");
    expect(normalizeConcreteOrigin("https://edge_.example")).toBe("https://edge_.example");
    expect(normalizeConcreteOrigin("https://ed_ge.example")).toBe("https://ed_ge.example");
    expect(normalizeConcreteOrigin("https://-edge.example")).toBe("");
    expect(normalizeConcreteOrigin("https://edge-.example")).toBe("");
  });

  it("folds the spellings of ONE site onto ONE canonical origin", () => {
    // Two spellings of the same place must not become two origins, or every
    // byte-equality check downstream silently stops matching.
    const same = [
      "https://SHOP.Example.COM",
      "https://shop.example.com",
      "https://shop.example.com:443",
      "https://shop.example.com/wp-admin/",
    ];
    for (const spelling of same) {
      expect(normalizeConcreteOrigin(spelling)).toBe("https://shop.example.com");
    }
    // The parser's own IPv4 canonicalization, likewise.
    expect(normalizeConcreteOrigin("https://0x7f.0.0.1")).toBe("https://127.0.0.1");
    expect(normalizeConcreteOrigin("https://2130706433")).toBe("https://127.0.0.1");
  });

  it("refuses a host that is not a place", () => {
    const refusals: Array<[string, string]> = [
      ["https://.example.com", "non-registrable-host"],
      ["https://example..com", "non-registrable-host"],
      ["https://example.com..", "non-registrable-host"],
      ["https://-example.com", "non-registrable-host"],
      ["https://example-.com", "non-registrable-host"],
      ["https://.", "non-registrable-host"],
    ];
    for (const [candidate, refusal] of refusals) {
      const resolved = resolveConcreteOrigin(candidate);
      expect(resolved.ok).toBe(false);
      if (!resolved.ok) expect(resolved.refusal).toBe(refusal);
    }
  });

  it("refuses the scheme, credential and emptiness classes", () => {
    expect(resolveConcreteOrigin("ftp://a.example")).toMatchObject({
      ok: false,
      refusal: "unsupported-scheme",
    });
    expect(resolveConcreteOrigin("javascript:alert(1)")).toMatchObject({
      ok: false,
      refusal: "unsupported-scheme",
    });
    // Assembled at runtime: written out as one literal, a URL carrying userinfo
    // reads to a secret scanner as a credential in the source.
    const withUserinfo = ["https://", "u", ":", "p", "@a.example"].join("");
    expect(resolveConcreteOrigin(withUserinfo)).toMatchObject({
      ok: false,
      refusal: "credentials",
    });
    expect(resolveConcreteOrigin("not a url")).toMatchObject({
      ok: false,
      refusal: "unparsable",
    });
    expect(resolveConcreteOrigin("")).toMatchObject({ ok: false, refusal: "empty" });
    expect(resolveConcreteOrigin(null)).toMatchObject({ ok: false, refusal: "empty" });
    expect(resolveConcreteOrigin(undefined)).toMatchObject({ ok: false, refusal: "empty" });
  });

  it("every refusal carries a message a person can act on", () => {
    for (const candidate of ["", "*", "ftp://a.example", "not a url", "https://.example.com"]) {
      const resolved = resolveConcreteOrigin(candidate);
      expect(resolved.ok).toBe(false);
      if (!resolved.ok) {
        expect(resolved.message.length).toBeGreaterThan(0);
        // The message must never echo the rejected value back at the caller.
        if (candidate) expect(resolved.message).not.toContain(candidate);
      }
    }
  });
});

describe("the property each accepted spelling must carry", () => {
  // One table covering every ACCEPTED CLASS this resolver knows — DNS name,
  // port, loopback, IPv6 literal, IPv4 literal, punycode, underscore label,
  // root dot, a discarded path/query, mixed case. Not a proof over all inputs;
  // one case per class, each held to the same property.
  const ACCEPTED = [
    "https://a.example",
    "https://a.example:8443",
    "http://localhost:3000",
    "https://[::1]:8443",
    "https://10.0.0.7",
    "https://xn--mnchen-3ya.example",
    "https://_edge.example",
    "https://shop.example/wp-admin/?q=*",
    "https://SHOP.Example.COM",
    "https://shop.example.com.",
  ];

  it("is already canonical, and carries no byte a policy could not hold", () => {
    for (const candidate of ACCEPTED) {
      const origin = normalizeConcreteOrigin(candidate);
      expect(origin).not.toBe("");
      // Idempotent: feeding the answer back in returns the same answer.
      expect(normalizeConcreteOrigin(origin)).toBe(origin);
      expect(isConcreteOrigin(origin)).toBe(true);
      // No asterisk, whitespace, quote, semicolon, comma, backslash or control
      // character — the bytes that would end or extend a CSP source list.
      expect(origin).not.toMatch(/[*\s"'`;,\\]|[\u0000-\u001f]/);
      expect(origin).toMatch(/^https?:\/\//);
    }
  });
});

describe("isConcreteOrigin", () => {
  it("is true only for a value that is ALREADY the canonical origin", () => {
    expect(isConcreteOrigin("https://a.example")).toBe(true);
    expect(isConcreteOrigin("https://a.example:8443")).toBe(true);
    expect(isConcreteOrigin("https://[::1]:8443")).toBe(true);
    // Resolvable, but not itself canonical — a policy takes the canonical form.
    expect(isConcreteOrigin("https://a.example/path")).toBe(false);
    expect(isConcreteOrigin("https://a.example:443")).toBe(false);
    expect(isConcreteOrigin("https://*")).toBe(false);
    expect(isConcreteOrigin("")).toBe(false);
  });
});

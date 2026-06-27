import { describe, it, expect } from "vitest";

import { replaceOriginInString, replaceOriginInValue } from "../origin-rewrite";

// ---------------------------------------------------------------------------
// origin-rewrite helpers (extracted from index.tsx to keep the entry module a
// thin facade under the file-size ratchet). Pure string transforms that rewrite
// the internal request origin (and the well-known localhost dev origins) to the
// public origin inside JSON metadata responses.
// ---------------------------------------------------------------------------

describe("replaceOriginInString", () => {
  it("rewrites the source origin to the target origin", () => {
    expect(
      replaceOriginInString("https://internal.example/auth", "https://internal.example", "https://public.example"),
    ).toBe("https://public.example/auth");
  });

  it("rewrites every occurrence of the source origin", () => {
    expect(
      replaceOriginInString("https://a.test/x https://a.test/y", "https://a.test", "https://public.example"),
    ).toBe("https://public.example/x https://public.example/y");
  });

  it("rewrites the well-known localhost dev origins to the target", () => {
    expect(replaceOriginInString("http://localhost:3000/jwks", "https://x", "https://public.example")).toBe(
      "https://public.example/jwks",
    );
    expect(replaceOriginInString("http://127.0.0.1:3000/jwks", "https://x", "https://public.example")).toBe(
      "https://public.example/jwks",
    );
  });

  it("leaves a string with no matching origin untouched", () => {
    expect(replaceOriginInString("just a label", "https://internal.example", "https://public.example")).toBe(
      "just a label",
    );
  });

  it("does not double-rewrite when source equals target", () => {
    expect(replaceOriginInString("https://same.test/a", "https://same.test", "https://same.test")).toBe(
      "https://same.test/a",
    );
  });
});

describe("replaceOriginInValue", () => {
  it("recurses through nested objects and arrays, rewriting only string leaves", () => {
    const input = {
      issuer: "https://internal.example",
      authorization_servers: ["https://internal.example/auth"],
      nested: { jwks_uri: "https://internal.example/jwks", ttl: 3600, enabled: true, missing: null },
    };
    expect(replaceOriginInValue(input, "https://internal.example", "https://public.example")).toEqual({
      issuer: "https://public.example",
      authorization_servers: ["https://public.example/auth"],
      nested: { jwks_uri: "https://public.example/jwks", ttl: 3600, enabled: true, missing: null },
    });
  });

  it("returns non-string, non-collection leaves unchanged", () => {
    expect(replaceOriginInValue(42, "https://internal.example", "https://public.example")).toBe(42);
    expect(replaceOriginInValue(null, "https://internal.example", "https://public.example")).toBeNull();
  });
});

// `allowNamedRateLimit` — the single-bucket limiter added by cinatra#2674
// (codex confirming round).
//
// WHY IT EXISTS AND WHAT THESE CASES PROTECT. `allowConnectTokenRequest` charges
// TWO buckets on every call: one per IP, one per "code". That is right for a
// code redeem and wrong for a caller that wants a second, independent dimension
// — passing a CONSTANT in the code slot turns the 5/min code bucket into a
// GLOBAL cap that any one caller can exhaust for everybody, which is a
// denial-of-sign-in wearing a rate limiter's clothes. The widget frame's per-site
// limit therefore charges exactly one bucket, and these cases pin that.

import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetConnectRateLimitForTests,
  allowConnectTokenRequest,
  allowNamedRateLimit,
} from "@/lib/connect-rate-limit";

beforeEach(() => {
  __resetConnectRateLimitForTests();
});

describe("allowNamedRateLimit", () => {
  it("allows up to the cap in a window, then refuses", () => {
    const now = 1_000_000;
    for (let i = 0; i < 5; i += 1) {
      expect(allowNamedRateLimit({ key: "k", now })).toBe(true);
    }
    expect(allowNamedRateLimit({ key: "k", now })).toBe(false);
  });

  it("keys are INDEPENDENT — exhausting one leaves the others untouched", () => {
    const now = 1_000_000;
    for (let i = 0; i < 5; i += 1) allowNamedRateLimit({ key: "site-a", now });
    expect(allowNamedRateLimit({ key: "site-a", now })).toBe(false);
    expect(allowNamedRateLimit({ key: "site-b", now })).toBe(true);
  });

  it("the window rolls", () => {
    const now = 1_000_000;
    for (let i = 0; i < 5; i += 1) allowNamedRateLimit({ key: "k", now });
    expect(allowNamedRateLimit({ key: "k", now })).toBe(false);
    expect(allowNamedRateLimit({ key: "k", now: now + 60_001 })).toBe(true);
  });

  it("honours a caller-raised cap", () => {
    const now = 1_000_000;
    for (let i = 0; i < 30; i += 1) {
      expect(allowNamedRateLimit({ key: "k", now, max: 30 })).toBe(true);
    }
    expect(allowNamedRateLimit({ key: "k", now, max: 30 })).toBe(false);
  });

  it("does NOT touch the pair limiter's buckets — one call, one bucket", () => {
    const now = 1_000_000;
    // Exhaust a named key completely…
    for (let i = 0; i < 5; i += 1) allowNamedRateLimit({ key: `ip:1.2.3.4`, now });
    expect(allowNamedRateLimit({ key: `ip:1.2.3.4`, now })).toBe(false);
    // …and the pair limiter for the SAME apparent ip is unaffected, because the
    // two live in separate namespaces. This is what stops one dimension's
    // exhaustion from silently spending another's budget.
    expect(allowConnectTokenRequest({ ip: "1.2.3.4", codeKey: "hash", now })).toBe(true);
  });
});

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

import { beforeEach, describe, expect, it, vi } from "vitest";

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

// cinatra#4217 — the limiter must not keep an entry whose window has ended.
// Every frame renewal presents a NEW token, so its `code:<hash>` key is used
// once and never again; before this change such keys stayed in the map for the
// life of the process. RED BEFORE: hit() only reset an entry when its own key
// came back, so the 100 one-off entries below were still there (106, not 6).
describe("expired entries are deleted (cinatra#4217)", () => {
  it("deletes expired entries, so a key that is never hit again does not stay", () => {
    const entries = () => globalThis.__cinatraConnectRateBuckets?.size ?? 0;
    const t0 = 1_000_000;
    // A burst of one-off keys: 50 addresses, 50 tokens, each used once.
    for (let i = 0; i < 50; i += 1) {
      allowConnectTokenRequest({ ip: `burst-${i}`, codeKey: `once-${i}`, now: t0 });
    }
    expect(entries()).toBe(100);
    // Half a window later, one token is presented four times: its bucket is live.
    for (let i = 0; i < 4; i += 1) {
      allowConnectTokenRequest({ ip: `late-${i}`, codeKey: "live", now: t0 + 30_000 });
    }
    // One window after the burst, the next request finds the burst expired.
    expect(allowConnectTokenRequest({ ip: "late-4", codeKey: "live", now: t0 + 60_000 })).toBe(true);
    // The 100 burst entries are gone; the five late addresses and the live token stay.
    expect(entries()).toBe(6);
    // The kept bucket still counts: its sixth request in its window is refused.
    expect(allowConnectTokenRequest({ ip: "late-5", codeKey: "live", now: t0 + 60_000 })).toBe(false);
  });

  // cinatra#4217 r6 — the sweep clock is the process's, like the map. RED ON
  // r5: the next sweep time was a module variable, so a second evaluation of
  // the module (a dev recompile) started its own sweep clock and swept the
  // shared map again within the same minute.
  it("a second evaluation of the module shares the sweep clock: one sweep per minute", async () => {
    const t0 = 2_000_000;
    // The first sweep runs at t0; a one-second entry is written right after it.
    allowNamedRateLimit({ key: "short", now: t0, windowMs: 1_000, max: 5 });
    expect(globalThis.__cinatraConnectRateBuckets?.has("named:short")).toBe(true);

    vi.resetModules();
    const again = await import("@/lib/connect-rate-limit");
    // Ten seconds later the entry has expired, but the minute since the last
    // sweep has not passed: the second evaluation does not sweep the map.
    expect(again.allowNamedRateLimit({ key: "other", now: t0 + 10_000 })).toBe(true);
    expect(
      globalThis.__cinatraConnectRateBuckets?.has("named:short"),
      "no second sweep inside the minute",
    ).toBe(true);
    // A minute after the first sweep, the next one runs and deletes it.
    expect(again.allowNamedRateLimit({ key: "other", now: t0 + 60_000 })).toBe(true);
    expect(globalThis.__cinatraConnectRateBuckets?.has("named:short")).toBe(false);
  });
});

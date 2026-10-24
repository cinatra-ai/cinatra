// The address the shared sign-in buckets are keyed on (cinatra#4217).
//
// The caller writes the FIRST X-Forwarded-For hops; the platform's proxy appends
// the LAST one (the socket address it saw), and with no proxy the framework
// fills the header with the socket address. These cases pin that the key is the
// last hop, and they drive the REAL limiter so the property is the one that
// matters: a forged hop neither escapes the caller's own bucket nor fills
// another client's.
//
// RED BEFORE: the module did not exist, and every route keyed the shared bucket
// on the first hop, which the caller writes.

import { beforeEach, describe, expect, it } from "vitest";

import { __resetConnectRateLimitForTests, allowConnectTokenRequest } from "@/lib/connect-rate-limit";
import { rateLimitClientAddress } from "@/lib/rate-limit-client-address";

const CLIENT = "2001:db8::9"; // the address the platform's proxy saw
const VICTIM = "2001:db8::5";

function req(headers: Record<string, string>) {
  return new Request("https://app.cinatra.test/x", { method: "POST", headers });
}

beforeEach(() => {
  __resetConnectRateLimitForTests();
});

describe("rateLimitClientAddress", () => {
  it("reads the last hop, the one the platform appended", () => {
    expect(rateLimitClientAddress(req({ "x-forwarded-for": CLIENT }))).toBe(CLIENT);
    expect(rateLimitClientAddress(req({ "x-forwarded-for": `${VICTIM}, ${CLIENT}` }))).toBe(CLIENT);
    expect(rateLimitClientAddress(req({ "x-forwarded-for": `a, b,c ,  ${CLIENT}  ` }))).toBe(CLIENT);
    expect(rateLimitClientAddress(req({ "x-forwarded-for": `${VICTIM}, 2001:db8::7` }))).toBe("2001:db8::7");
  });

  it("an empty last hop keys the shared unknown bucket, never an earlier hop", () => {
    expect(rateLimitClientAddress(req({ "x-forwarded-for": `${VICTIM}, ` }))).toBe("unknown");
    expect(rateLimitClientAddress(req({ "x-forwarded-for": " , " }))).toBe("unknown");
  });

  it("falls back to X-Real-IP only when there is no X-Forwarded-For, then to unknown", () => {
    expect(rateLimitClientAddress(req({ "x-real-ip": ` ${CLIENT} ` }))).toBe(CLIENT);
    expect(
      rateLimitClientAddress(req({ "x-forwarded-for": CLIENT, "x-real-ip": VICTIM })),
      "the forwarded chain wins",
    ).toBe(CLIENT);
    expect(rateLimitClientAddress(req({}))).toBe("unknown");
  });
});

describe("a forged hop and the shared bucket (cinatra#4217)", () => {
  const now = 1_000_000;
  const charge = (xff: string, codeKey: string) =>
    allowConnectTokenRequest({ ip: rateLimitClientAddress(req({ "x-forwarded-for": xff })), codeKey, now });

  it("requests from one client with different forged first hops share one bucket", () => {
    // 30 a minute per address; a fresh code key each time so only the IP bucket counts.
    for (let i = 0; i < 30; i += 1) {
      expect(charge(`2001:db8::f${i}, ${CLIENT}`, `k${i}`), `request ${i + 1}`).toBe(true);
    }
    expect(charge(`2001:db8::b1, ${CLIENT}`, "k-last"), "the 31st is refused whatever it forges").toBe(false);
  });

  it("a forged hop naming another client cannot fill that client's bucket", () => {
    for (let i = 0; i < 40; i += 1) charge(`${VICTIM}, ${CLIENT}`, `f${i}`);
    expect(charge(`${VICTIM}, ${CLIENT}`, "f-more"), "the forger exhausted its own bucket").toBe(false);
    expect(charge(VICTIM, "victim-own"), "the named client still gets through").toBe(true);
  });
});

/**
 * THE FENCE around the design-conformance seed route, tested the way a security
 * surface is tested: with NEGATIVE CONTROLS. Every refusal case below is paired
 * with the SAME input one variable away from passing, so a fence that refuses
 * everything cannot "pass" this file.
 *
 * The headline property is the one that separates this fence from its sibling
 * (`lifecycle-seed-fence`): EVERY refusal answers 404, never 403. This route is
 * deliberately reachable on a production-SHAPED CI build, so a 403 would tell an
 * unauthenticated caller that the seed endpoint exists on this host. The
 * refusals must be indistinguishable from "no such route".
 */
import { describe, expect, it } from "vitest";

import {
  CONFORMANCE_SEED_CAPABILITY_ENV,
  CONFORMANCE_SEED_CAPABILITY_MIN_LENGTH,
  conformanceSeedVerdict,
} from "../conformance-seed-fence";

/** 57 chars — comfortably over the minimum, and not a prefix of anything below. */
const CAPABILITY = "conformance-seed-capability-with-enough-entropy-0123456789";

const ARMED = { [CONFORMANCE_SEED_CAPABILITY_ENV]: CAPABILITY };

function headersOf(entries: Record<string, string>) {
  const lower = new Map(
    Object.entries(entries).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return { get: (name: string) => lower.get(name.toLowerCase()) ?? null };
}

/** A request presenting the correct capability. Overrides add/replace headers. */
function req(overrides: Record<string, string> = {}) {
  return { headers: headersOf({ authorization: `Bearer ${CAPABILITY}`, ...overrides }) };
}

describe("the armed capability (fence 1)", () => {
  it("POSITIVE CONTROL: armed + presented + no forwarded chain passes", () => {
    expect(conformanceSeedVerdict(req(), ARMED)).toEqual({ ok: true });
  });

  it("refuses 404 when the capability env is UNSET — the default of every stack", () => {
    expect(conformanceSeedVerdict(req(), {})).toMatchObject({ ok: false, status: 404 });
  });

  it("refuses 404 when the capability is shorter than the minimum", () => {
    const short = "x".repeat(CONFORMANCE_SEED_CAPABILITY_MIN_LENGTH - 1);
    const verdict = conformanceSeedVerdict(
      { headers: headersOf({ authorization: `Bearer ${short}` }) },
      { [CONFORMANCE_SEED_CAPABILITY_ENV]: short },
    );
    expect(verdict).toMatchObject({ ok: false, status: 404 });
  });

  it("PAIRED CONTROL: the same value at exactly the minimum length passes", () => {
    const exact = "x".repeat(CONFORMANCE_SEED_CAPABILITY_MIN_LENGTH);
    expect(
      conformanceSeedVerdict(
        { headers: headersOf({ authorization: `Bearer ${exact}` }) },
        { [CONFORMANCE_SEED_CAPABILITY_ENV]: exact },
      ),
    ).toEqual({ ok: true });
  });

  it("the minimum is 32 characters", () => {
    expect(CONFORMANCE_SEED_CAPABILITY_MIN_LENGTH).toBe(32);
  });

  it("reads the documented env var name", () => {
    expect(CONFORMANCE_SEED_CAPABILITY_ENV).toBe("CINATRA_CONFORMANCE_SEED_TOKEN");
  });
});

describe("the presented capability (fence 2)", () => {
  it("refuses 404 when NO authorization header is sent", () => {
    expect(conformanceSeedVerdict({ headers: headersOf({}) }, ARMED)).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  it("refuses 404 on an empty bearer", () => {
    expect(conformanceSeedVerdict(req({ authorization: "Bearer " }), ARMED)).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  it("refuses 404 on a WRONG capability of the SAME length", () => {
    const wrong = "conformance-seed-capability-with-enough-entropy-9876543210";
    expect(wrong.length).toBe(CAPABILITY.length);
    expect(conformanceSeedVerdict(req({ authorization: `Bearer ${wrong}` }), ARMED)).toMatchObject(
      { ok: false, status: 404 },
    );
  });

  it("refuses 404 on a PREFIX of the capability (the length fold)", () => {
    expect(
      conformanceSeedVerdict(req({ authorization: `Bearer ${CAPABILITY.slice(0, -1)}` }), ARMED),
    ).toMatchObject({ ok: false, status: 404 });
  });

  it("refuses 404 on the capability with a suffix appended", () => {
    expect(
      conformanceSeedVerdict(req({ authorization: `Bearer ${CAPABILITY}x` }), ARMED),
    ).toMatchObject({ ok: false, status: 404 });
  });

  it("refuses 404 when the capability is sent WITHOUT the Bearer scheme", () => {
    expect(conformanceSeedVerdict(req({ authorization: CAPABILITY }), ARMED)).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  it("accepts a case-insensitive scheme (bearer), as RFC 7235 requires", () => {
    expect(conformanceSeedVerdict(req({ authorization: `bearer ${CAPABILITY}` }), ARMED)).toEqual({
      ok: true,
    });
  });
});

describe("the forwarded chain (fence 3)", () => {
  it("refuses 404 on a REMOTE x-forwarded-for hop even with the right capability", () => {
    expect(
      conformanceSeedVerdict(req({ "x-forwarded-for": "203.0.113.7" }), ARMED),
    ).toMatchObject({ ok: false, status: 404 });
  });

  it("refuses 404 when ANY hop in the chain is remote", () => {
    expect(
      conformanceSeedVerdict(req({ "x-forwarded-for": "127.0.0.1, 203.0.113.7" }), ARMED),
    ).toMatchObject({ ok: false, status: 404 });
  });

  it("PAIRED CONTROL: a purely loopback chain passes (Next synthesises one)", () => {
    expect(conformanceSeedVerdict(req({ "x-forwarded-for": "127.0.0.1" }), ARMED)).toEqual({
      ok: true,
    });
    expect(conformanceSeedVerdict(req({ "x-forwarded-for": "::1" }), ARMED)).toEqual({ ok: true });
  });

  it("refuses 404 on a remote x-forwarded-host", () => {
    expect(
      conformanceSeedVerdict(req({ "x-forwarded-host": "conformance.example.com" }), ARMED),
    ).toMatchObject({ ok: false, status: 404 });
  });

  it("refuses 404 on a remote RFC 7239 Forwarded for=", () => {
    expect(
      conformanceSeedVerdict(req({ forwarded: "for=203.0.113.7;proto=https" }), ARMED),
    ).toMatchObject({ ok: false, status: 404 });
  });

  it("PAIRED CONTROL: a loopback RFC 7239 Forwarded passes", () => {
    expect(conformanceSeedVerdict(req({ forwarded: 'for="[::1]"' }), ARMED)).toEqual({ ok: true });
  });
});

describe("every refusal is a 404 — never a 403", () => {
  it("no refusal reveals that the route exists", () => {
    const refusals = [
      conformanceSeedVerdict(req(), {}),
      conformanceSeedVerdict({ headers: headersOf({}) }, ARMED),
      conformanceSeedVerdict(req({ authorization: "Bearer nope" }), ARMED),
      conformanceSeedVerdict(req({ "x-forwarded-for": "203.0.113.7" }), ARMED),
    ];
    for (const verdict of refusals) {
      expect(verdict.ok).toBe(false);
      expect(verdict).toHaveProperty("status", 404);
    }
  });
});

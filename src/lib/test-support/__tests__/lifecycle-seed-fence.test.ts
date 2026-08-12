/**
 * cinatra#2683 (epic #2564 S8f) — THE FENCE around the in-process lifecycle seed
 * path.
 *
 * A test-only route on an app is a security surface, so the fence is tested the
 * way a security surface is: with NEGATIVE CONTROLS. Every refusal case below is
 * paired with the SAME input one variable away from passing, so a test that
 * "passes" because the fence refuses everything cannot hide here.
 *
 * The production-shaped environment is the headline case: the exact env a real
 * deployment carries (`NODE_ENV=production`, no dev runtime mode) must refuse —
 * and it must still refuse when the scripted flag, an armed capability, a
 * presented bearer and a loopback caller are ALL present, which is the only
 * combination that could otherwise look like a legitimate seed.
 */
import { describe, expect, it } from "vitest";

import {
  SEED_CAPABILITY_ENV,
  lifecycleSeedEnvVerdict,
  lifecycleSeedRequestVerdict,
  lifecycleSeedVerdict,
} from "../lifecycle-seed-fence";

const CAPABILITY = "s8f-seed-capability-with-enough-entropy-0123456789";

/** The env a scripted UAT stack that has ARMED the seed actually carries — the
 *  ONE passing shape. */
const DEV_SCRIPTED_ENV = {
  NODE_ENV: "development",
  CINATRA_RUNTIME_MODE: "development",
  CINATRA_TEST_LLM_PROVIDER: "scripted",
  [SEED_CAPABILITY_ENV]: CAPABILITY,
} as const;

/** The env a real deployment carries. */
const PRODUCTION_ENV = {
  NODE_ENV: "production",
  CINATRA_RUNTIME_MODE: "production",
} as const;

function req(
  url: string,
  headers: Record<string, string> = {},
): { url: string; headers: { get(name: string): string | null } } {
  const merged = {
    authorization: `Bearer ${CAPABILITY}`,
    "content-type": "application/json",
    ...headers,
  };
  const lower = new Map(
    Object.entries(merged).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return { url, headers: { get: (n: string) => lower.get(n.toLowerCase()) ?? null } };
}

const LOOPBACK = req("http://localhost:3000/api/development/lifecycle-seed");

describe("fences 1 + 2 + 3a — the environment", () => {
  it("POSITIVE CONTROL: an armed scripted development stack passes", () => {
    expect(lifecycleSeedEnvVerdict({ ...DEV_SCRIPTED_ENV })).toEqual({ ok: true });
  });

  it("refuses a PRODUCTION-shaped environment", () => {
    const verdict = lifecycleSeedEnvVerdict({ ...PRODUCTION_ENV });
    expect(verdict).toMatchObject({ ok: false, status: 404, reason: "production-build" });
  });

  it("refuses a production BUILD even when every other signal says development", () => {
    // The single most dangerous shape: someone sets the dev runtime mode, the
    // scripted flag AND the capability on a production build. The build check is
    // independent, so it still refuses.
    expect(
      lifecycleSeedEnvVerdict({ ...DEV_SCRIPTED_ENV, NODE_ENV: "production" }),
    ).toMatchObject({ ok: false, reason: "production-build" });
  });

  it("refuses an UNSET runtime mode (allow-list, not deny-list)", () => {
    const env: Record<string, string | undefined> = { ...DEV_SCRIPTED_ENV };
    delete env.CINATRA_RUNTIME_MODE;
    expect(lifecycleSeedEnvVerdict(env)).toMatchObject({
      ok: false,
      reason: "not-development-runtime",
    });
  });

  it("refuses a MISSPELLED runtime mode", () => {
    expect(
      lifecycleSeedEnvVerdict({ ...DEV_SCRIPTED_ENV, CINATRA_RUNTIME_MODE: "Development" }),
    ).toMatchObject({ ok: false, reason: "not-development-runtime" });
  });

  it("refuses a development stack that is NOT running the scripted provider", () => {
    const env: Record<string, string | undefined> = { ...DEV_SCRIPTED_ENV };
    delete env.CINATRA_TEST_LLM_PROVIDER;
    const verdict = lifecycleSeedEnvVerdict(env);
    expect(verdict.ok).toBe(false);
    expect((verdict as { reason: string }).reason).toContain("CINATRA_TEST_LLM_PROVIDER");
  });

  it("refuses an UNARMED stack — the default everywhere", () => {
    const env: Record<string, string | undefined> = { ...DEV_SCRIPTED_ENV };
    delete env[SEED_CAPABILITY_ENV];
    expect(lifecycleSeedEnvVerdict(env)).toMatchObject({
      ok: false,
      status: 404,
      reason: `${SEED_CAPABILITY_ENV} is not armed`,
    });
  });

  it("refuses a SHORT capability rather than accepting it weakly", () => {
    expect(
      lifecycleSeedEnvVerdict({ ...DEV_SCRIPTED_ENV, [SEED_CAPABILITY_ENV]: "short" }),
    ).toMatchObject({ ok: false, reason: `${SEED_CAPABILITY_ENV} is not armed` });
  });
});

describe("fences 3b + 4 — the caller", () => {
  it("POSITIVE CONTROL: a bearer-carrying loopback JSON caller passes", () => {
    expect(lifecycleSeedRequestVerdict(LOOPBACK, DEV_SCRIPTED_ENV)).toEqual({ ok: true });
    expect(
      lifecycleSeedRequestVerdict(
        req("http://127.0.0.1:3000/api/development/lifecycle-seed"),
        DEV_SCRIPTED_ENV,
      ),
    ).toEqual({ ok: true });
  });

  it("refuses a caller that presents NO capability", () => {
    expect(
      lifecycleSeedRequestVerdict(
        req("http://localhost:3000/api/development/lifecycle-seed", { authorization: "" }),
        DEV_SCRIPTED_ENV,
      ),
    ).toMatchObject({ ok: false, status: 403, reason: "capability-not-presented" });
  });

  it("refuses a WRONG capability, and one that is merely a prefix of the right one", () => {
    for (const wrong of ["Bearer nope", `Bearer ${CAPABILITY.slice(0, -1)}`, `Bearer ${CAPABILITY}x`]) {
      expect(
        lifecycleSeedRequestVerdict(
          req("http://localhost:3000/api/development/lifecycle-seed", { authorization: wrong }),
          DEV_SCRIPTED_ENV,
        ),
        wrong,
      ).toMatchObject({ ok: false, status: 403, reason: "capability-not-presented" });
    }
  });

  it("refuses a NON-JSON content type — the shape a CORS-simple POST is limited to", () => {
    for (const ct of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
      expect(
        lifecycleSeedRequestVerdict(
          req("http://localhost:3000/api/development/lifecycle-seed", { "content-type": ct }),
          DEV_SCRIPTED_ENV,
        ),
        ct,
      ).toMatchObject({ ok: false, status: 403, reason: "non-json-content-type" });
    }
  });

  it("refuses a CROSS-SITE browser caller", () => {
    expect(
      lifecycleSeedRequestVerdict(
        req("http://localhost:3000/api/development/lifecycle-seed", {
          "sec-fetch-site": "cross-site",
        }),
        DEV_SCRIPTED_ENV,
      ),
    ).toMatchObject({ ok: false, status: 403, reason: "cross-site-request" });
  });

  it("refuses a cross-ORIGIN caller, and accepts a loopback one", () => {
    expect(
      lifecycleSeedRequestVerdict(
        req("http://localhost:3000/api/development/lifecycle-seed", {
          origin: "https://evil.example.com",
        }),
        DEV_SCRIPTED_ENV,
      ),
    ).toMatchObject({ ok: false, status: 403, reason: "cross-origin-request" });
    expect(
      lifecycleSeedRequestVerdict(
        req("http://localhost:3000/api/development/lifecycle-seed", {
          origin: "http://localhost:3000",
          "sec-fetch-site": "same-origin",
        }),
        DEV_SCRIPTED_ENV,
      ),
    ).toEqual({ ok: true });
  });

  it("refuses a NON-loopback authority", () => {
    expect(
      lifecycleSeedRequestVerdict(
        req("https://app.example.com/api/development/lifecycle-seed"),
        DEV_SCRIPTED_ENV,
      ),
    ).toMatchObject({ ok: false, status: 403, reason: "non-loopback-authority" });
  });

  it("refuses a chain that names a hop OFF this machine", () => {
    for (const [header, value] of [
      ["x-forwarded-for", "203.0.113.7"],
      ["x-forwarded-for", "127.0.0.1, 203.0.113.7"],
      ["x-forwarded-host", "app.example.com"],
      ["forwarded", 'for=203.0.113.7;proto=https'],
    ] as const) {
      const verdict = lifecycleSeedRequestVerdict(
        req("http://localhost:3000/api/development/lifecycle-seed", { [header]: value }),
        DEV_SCRIPTED_ENV,
      );
      expect(verdict.ok, `${header}: ${value} must disqualify`).toBe(false);
      expect((verdict as { reason: string }).reason).toBe("forwarded-from-off-host");
    }
  });

  it("ACCEPTS the chain Next's own dev server synthesises", () => {
    // MEASURED, not assumed: an earlier draft disqualified on PRESENCE and
    // refused every request on the live stack, because Next injects these on the
    // way into a route handler. The check that was meant is "no hop from off this
    // machine", and these are the shapes that arrive.
    for (const value of ["127.0.0.1", "::1", "[::1]:54321", "::ffff:127.0.0.1", "127.0.0.1, ::1"]) {
      expect(
        lifecycleSeedRequestVerdict(
          req("http://localhost:3000/api/development/lifecycle-seed", {
            "x-forwarded-for": value,
            "x-forwarded-host": "localhost:3000",
            "x-forwarded-proto": "http",
          }),
          DEV_SCRIPTED_ENV,
        ),
        value,
      ).toEqual({ ok: true });
    }
  });

  it("refuses an EMPTY or unparseable forwarded entry — fail closed", () => {
    for (const value of ["", "   ", "unknown", "_hidden"]) {
      expect(
        lifecycleSeedRequestVerdict(
          req("http://localhost:3000/api/development/lifecycle-seed", { "x-forwarded-for": value }),
          DEV_SCRIPTED_ENV,
        ),
        value,
      ).toMatchObject({ ok: false, reason: "forwarded-from-off-host" });
    }
  });
});

describe("all four fences, in order", () => {
  it("POSITIVE CONTROL: the one passing combination passes", () => {
    expect(lifecycleSeedVerdict(LOOPBACK, { ...DEV_SCRIPTED_ENV })).toEqual({ ok: true });
  });

  it("a PRODUCTION environment refuses an otherwise-perfect caller", () => {
    // Everything the caller could do right, done right — and it still refuses,
    // which is the property the whole fence exists for.
    expect(lifecycleSeedVerdict(LOOPBACK, { ...PRODUCTION_ENV })).toMatchObject({
      ok: false,
      status: 404,
      reason: "production-build",
    });
    expect(
      lifecycleSeedVerdict(LOOPBACK, {
        ...DEV_SCRIPTED_ENV,
        NODE_ENV: "production",
      }),
    ).toMatchObject({ ok: false, status: 404, reason: "production-build" });
  });

  it("the environment answers BEFORE the caller is inspected", () => {
    // A production host must not disclose which caller shapes it would accept,
    // so a remote caller on a production host gets the ENVIRONMENT's 404, never
    // the caller's 403.
    expect(
      lifecycleSeedVerdict(req("https://app.example.com/api/development/lifecycle-seed"), {
        ...PRODUCTION_ENV,
      }),
    ).toMatchObject({ ok: false, status: 404, reason: "production-build" });
  });

  it("a development environment still refuses a remote caller", () => {
    expect(
      lifecycleSeedVerdict(req("https://app.example.com/api/development/lifecycle-seed"), {
        ...DEV_SCRIPTED_ENV,
      }),
    ).toMatchObject({ ok: false, status: 403, reason: "non-loopback-authority" });
  });

  it("a development environment refuses a HOST-SPOOFING remote caller without the capability", () => {
    // The exact bypass codex round 0 named: `Host: localhost` from a LAN address
    // passes every host-shaped check, because `request.url` is built from the
    // header. The capability is what actually stops it.
    expect(
      lifecycleSeedVerdict(
        req("http://localhost:3000/api/development/lifecycle-seed", {
          authorization: "Bearer guessed-nonsense-that-is-long-enough-to-look-real",
        }),
        { ...DEV_SCRIPTED_ENV },
      ),
    ).toMatchObject({ ok: false, status: 403, reason: "capability-not-presented" });
  });
});

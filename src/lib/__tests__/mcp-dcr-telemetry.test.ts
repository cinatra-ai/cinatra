import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Unit contract for the Dynamic Client Registration (DCR) usage telemetry
// (cinatra#2218 scope item 7).
//
// DCR is deprecated by MCP revision `2026-07-28` with a twelve-month minimum
// removal window; the recorded maintainer decision is RETAIN + instrument, so
// any later removal is evidence-gated. These tests pin the two properties that
// make the evidence usable:
//
//   1. the classification distinguishes "the plugin served it" from "our scope
//      shim was needed", because the two imply different amounts of migration
//      work; and
//   2. the emitted payload is dimensions and counts ONLY — no client id, no
//      client secret, no token, no redirect URI, no client-authored string.
//
// Property (2) is asserted as an EXACT key set, not a spot check: a future field
// addition has to come back through this test and re-argue the payload
// contract rather than slipping a client-supplied value into a log line.
// ---------------------------------------------------------------------------

import {
  classifyDcrRegistration,
  dcrOutcomeForStatus,
  DCR_REGISTRATION_EVENT,
  recordDcrRegistrationUsage,
  REQUIRED_MCP_SCOPE,
} from "@/lib/mcp-dcr-telemetry";

function emittedEvents(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls
    .map((call) => {
      if (typeof call[0] !== "string") return null;
      try {
        return JSON.parse(call[0]) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter(
      (parsed): parsed is Record<string, unknown> =>
        parsed !== null && parsed.event === DCR_REGISTRATION_EVENT,
    );
}

describe("classifyDcrRegistration", () => {
  it("reports an omitted scope as the plugin-default path (the provider fills its own defaults)", () => {
    expect(classifyDcrRegistration({ redirect_uris: ["https://example.test/cb"] })).toEqual({
      path: "plugin-default",
      scopeDisposition: "omitted",
      clientRequestedScopeCount: 0,
      rewrittenScope: null,
    });
  });

  it("reports an EMPTY-STRING scope as omitted, because the provider's own rule is falsiness", () => {
    // `if (!body.scope) body.scope = clientRegistrationDefaultScopes` — "" is
    // falsy, so this client DOES get the defaults, exactly like an absent key.
    expect(classifyDcrRegistration({ scope: "" })).toEqual({
      path: "plugin-default",
      scopeDisposition: "omitted",
      clientRequestedScopeCount: 0,
      rewrittenScope: null,
    });
  });

  it("reports a whitespace-only scope as unusable-scope, NOT omitted", () => {
    // "   " is TRUTHY, so the provider does not substitute its defaults — this
    // client is not in the same state as one that omitted `scope`, and recording
    // them alike would corrupt the deprecation-window reading. Behaviour is
    // unchanged: the body is still forwarded untouched.
    expect(classifyDcrRegistration({ scope: "   " })).toEqual({
      path: "plugin-default",
      scopeDisposition: "unusable-scope",
      clientRequestedScopeCount: 0,
      rewrittenScope: null,
    });
  });

  it("reports a non-string scope as unusable-scope and forwards it untouched", () => {
    // The endpoint's body schema is `scope: z.string().optional()`, so each of
    // these is refused there. It is still an observed registration attempt.
    for (const scope of [null, 42, true, ["openid"], { openid: true }]) {
      const result = classifyDcrRegistration({ scope });
      expect(result.scopeDisposition).toBe("unusable-scope");
      expect(result.path).toBe("plugin-default");
      expect(result.rewrittenScope).toBeNull();
    }
  });

  it("reports a client that already asked for the required scope as plugin-default", () => {
    const result = classifyDcrRegistration({ scope: `openid ${REQUIRED_MCP_SCOPE}` });
    expect(result.path).toBe("plugin-default");
    expect(result.scopeDisposition).toBe("already-required");
    expect(result.clientRequestedScopeCount).toBe(2);
    expect(result.rewrittenScope).toBeNull();
  });

  it("reports the shim path, and unions the required scope in, for an explicit narrow scope", () => {
    // The MCP CLI proxy's shape: registers with OIDC scopes only, requests
    // mcp:connect later from the protected-resource metadata.
    const result = classifyDcrRegistration({ scope: "openid email profile" });
    expect(result.path).toBe("cinatra-scope-shim");
    expect(result.scopeDisposition).toBe("widened");
    expect(result.clientRequestedScopeCount).toBe(3);
    expect(result.rewrittenScope?.split(" ")).toEqual([
      "openid",
      "email",
      "profile",
      REQUIRED_MCP_SCOPE,
    ]);
  });

  it("counts distinct scopes, so a duplicated scope does not inflate the reading", () => {
    expect(classifyDcrRegistration({ scope: "openid openid email" }).clientRequestedScopeCount).toBe(2);
  });

  it("reports an unparsed body distinctly from a scope-less one", () => {
    // A malformed client and a well-behaved scope-less client are different
    // evidence; collapsing them would distort the removal decision.
    for (const body of [undefined, null, "not-an-object", 42, ["scope"]]) {
      const result = classifyDcrRegistration(body);
      expect(result.scopeDisposition).toBe("unreadable-body");
      expect(result.path).toBe("plugin-default");
      expect(result.rewrittenScope).toBeNull();
    }
  });
});

describe("dcrOutcomeForStatus", () => {
  it("treats 2xx as accepted and everything else as rejected", () => {
    expect(dcrOutcomeForStatus(200)).toBe("accepted");
    expect(dcrOutcomeForStatus(201)).toBe("accepted");
    expect(dcrOutcomeForStatus(299)).toBe("accepted");
    expect(dcrOutcomeForStatus(400)).toBe("rejected");
    expect(dcrOutcomeForStatus(401)).toBe("rejected");
    expect(dcrOutcomeForStatus(403)).toBe("rejected");
    expect(dcrOutcomeForStatus(429)).toBe("rejected");
    expect(dcrOutcomeForStatus(500)).toBe("rejected");
  });
});

describe("recordDcrRegistrationUsage", () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits exactly one machine-readable event carrying the recorded dimensions", () => {
    recordDcrRegistrationUsage({
      path: "cinatra-scope-shim",
      scopeDisposition: "widened",
      clientRequestedScopeCount: 3,
      outcome: "accepted",
      status: 201,
    });

    const events = emittedEvents(infoSpy);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: DCR_REGISTRATION_EVENT,
      path: "cinatra-scope-shim",
      scopeDisposition: "widened",
      clientRequestedScopeCount: 3,
      outcome: "accepted",
      status: 201,
    });
    expect(typeof events[0].occurredAt).toBe("string");
    expect(Number.isNaN(Date.parse(String(events[0].occurredAt)))).toBe(false);
  });

  it("records a thrown handler as handler-error with a null status", () => {
    recordDcrRegistrationUsage({
      path: "plugin-default",
      scopeDisposition: "omitted",
      clientRequestedScopeCount: 0,
      outcome: "handler-error",
      status: null,
    });

    expect(emittedEvents(infoSpy)[0]).toMatchObject({
      outcome: "handler-error",
      status: null,
    });
  });

  it("emits the EXACT payload key set — no client id, secret, token, redirect URI or scope string", () => {
    recordDcrRegistrationUsage({
      path: "plugin-default",
      scopeDisposition: "already-required",
      clientRequestedScopeCount: 2,
      outcome: "accepted",
      status: 200,
    });

    const [event] = emittedEvents(infoSpy);
    expect(Object.keys(event).sort()).toEqual([
      "clientRequestedScopeCount",
      "event",
      "occurredAt",
      "outcome",
      "path",
      "scopeDisposition",
      "status",
    ]);

    // Belt and braces: the serialized line must not carry any of the
    // registration vocabulary that would constitute a credential/PII leak.
    const line = String(infoSpy.mock.calls[0][0]);
    for (const banned of [
      "client_id",
      "client_secret",
      "clientSecret",
      "redirect_uri",
      "authorization",
      "Bearer",
      "software_id",
      "client_name",
    ]) {
      expect(line).not.toContain(banned);
    }
  });

  it("never throws when the log sink itself fails — telemetry cannot break a registration", () => {
    // The deliberate consequence, recorded in the contract doc: a broken sink is
    // swallowed, so ZERO OBSERVED EVENTS is necessary but not sufficient evidence
    // of non-use. The removal decision must separately establish that the
    // instrumented build ran and its stdout was collected. This test pins the
    // swallow so that trade-off stays a decision, not an accident.
    infoSpy.mockImplementation(() => {
      throw new Error("log sink unavailable");
    });

    expect(() =>
      recordDcrRegistrationUsage({
        path: "plugin-default",
        scopeDisposition: "omitted",
        clientRequestedScopeCount: 0,
        outcome: "accepted",
        status: 201,
      }),
    ).not.toThrow();
  });
});

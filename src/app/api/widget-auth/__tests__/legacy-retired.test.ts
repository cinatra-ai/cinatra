import { describe, expect, it, vi } from "vitest";

// cinatra#2674 (epic #2564 S8e) — THE SITE-MEDIATED CEREMONY IS RETIRED.
//
// The AC: "A CMS-backend test double records all widget-auth responses and
// proves that neither user bearer nor widget bearer pair is returned to
// WordPress/Drupal after the new flow begins. The retired legacy redemption
// contract fails closed."
//
// The double below is a stand-in for a CMS backend: it drives the two retired
// endpoints exactly as the shipped WordPress/Drupal plugins do — with a valid
// `cnx_`-shaped credential, a well-formed body, the paired Origin — and RECORDS
// every response. The assertion is over the whole recording: no response body,
// and no response header, contains anything shaped like a bearer.
//
// This is the migration rule of #2674 in test form: a legacy widget's sign-in
// FAILS, and the person signs in again inside the frame. There is no
// compatibility mode, because every compatibility mode here is a way for a site
// to keep receiving a credential.

const emitWidgetAuthAudit = vi.fn();
vi.mock("@/lib/widget-auth-audit", () => ({
  emitWidgetAuthAudit: (...a: unknown[]) => emitWidgetAuthAudit(...a),
}));

import { POST as legacyInit } from "../init/route";
import { POST as legacyToken } from "../token/route";

const CNX = "cnx_11111111-1111-1111-1111-111111111111_secretpart";
const SITE_ORIGIN = "https://wp.example.test";

/** A CMS backend, as the shipped plugins behave, recording what it receives. */
class CmsBackendDouble {
  readonly recorded: Array<{ status: number; body: string; headers: string }> = [];

  async call(
    handler: (r: Request) => Promise<Response>,
    path: string,
    body: unknown,
  ): Promise<void> {
    const response = await handler(
      new Request(`https://app.cinatra.test${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${CNX}`,
          Origin: SITE_ORIGIN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }),
    );
    this.recorded.push({
      status: response.status,
      body: await response.text(),
      headers: JSON.stringify([...response.headers.entries()]),
    });
  }

  /** Everything this backend ever received, as one string. */
  everything(): string {
    return JSON.stringify(this.recorded);
  }
}

describe("cinatra#2674 — a CMS backend can no longer obtain a credential", () => {
  it("both retired endpoints fail closed, and NOTHING bearer-shaped reaches the backend", async () => {
    const cms = new CmsBackendDouble();

    await cms.call(legacyInit, "/api/widget-auth/init", {
      client: "wordpress",
      agentSlug: "wordpress-content-editor",
      codeChallenge: "a".repeat(43),
      codeChallengeMethod: "S256",
      state: "state-value-1234",
      instanceId: "inst-1",
    });
    await cms.call(legacyToken, "/api/widget-auth/token", {
      grantType: "authorization_code",
      client: "wordpress",
      agentSlug: "wordpress-content-editor",
      code: "an-authorization-code",
      codeVerifier: "b".repeat(64),
    });

    // Both refused, and refused as GONE — the honest answer for a withdrawn
    // contract, and the one an integrator debugging an old plugin can act on.
    expect(cms.recorded.map((r) => r.status)).toEqual([410, 410]);

    // THE LOAD-BEARING ASSERTION: nothing the backend recorded is a credential.
    const everything = cms.everything();
    for (const prefix of ["cwu_", "cit_"]) {
      expect(everything).not.toContain(prefix);
    }
    // …and no field that used to carry one is present at all.
    for (const field of ["token", "userToken", "transportToken", "authorizeUrl", "txnId"]) {
      expect(JSON.parse(cms.recorded[0].body)).not.toHaveProperty(field);
      expect(JSON.parse(cms.recorded[1].body)).not.toHaveProperty(field);
    }
  });

  it("the refusal is not an oracle — the same answer for a nonsense request", async () => {
    const cms = new CmsBackendDouble();
    await cms.call(legacyToken, "/api/widget-auth/token", { nonsense: true });
    await cms.call(legacyToken, "/api/widget-auth/token", {
      grantType: "authorization_code",
      code: "a-code-that-might-be-real",
      codeVerifier: "c".repeat(64),
    });
    const [a, b] = cms.recorded;
    expect(a.status).toBe(b.status);
    expect(a.body).toBe(b.body);
  });

  it("the retirement is AUDITED so a site still calling it is visible in the trail", async () => {
    emitWidgetAuthAudit.mockClear();
    const cms = new CmsBackendDouble();
    await cms.call(legacyToken, "/api/widget-auth/token", { grantType: "authorization_code" });
    expect(emitWidgetAuthAudit).toHaveBeenCalledWith(
      "redeem_failure",
      expect.objectContaining({ reason: "legacy_site_redemption_retired" }),
    );
  });

  it("no migration path negotiates BACK to a credential-bearing parent bootstrap", async () => {
    // The bridge's own version literal is the other half of this: a protocol-1
    // parent cannot negotiate with a protocol-2 frame at all. Here we pin the
    // server half — there is no request shape, header or flag that turns the
    // retired endpoints back on.
    const cms = new CmsBackendDouble();
    for (const body of [
      { grantType: "authorization_code", compat: true },
      { grantType: "authorization_code", protocolVersion: 1 },
      { grantType: "authorization_code", legacy: "please" },
    ]) {
      await cms.call(legacyToken, "/api/widget-auth/token", body);
    }
    expect(cms.recorded.every((r) => r.status === 410)).toBe(true);
    expect(cms.everything()).not.toContain("cwu_");
  });
});

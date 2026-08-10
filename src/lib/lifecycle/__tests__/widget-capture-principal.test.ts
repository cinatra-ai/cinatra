import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// The jti-keyed LIVE PRINCIPAL probe (cinatra#2576, S8c).
//
// It exists because an `<img>` request carries no bearer, so the capability can
// only seal the token's `jti`. Its whole job is to be the REVOCATION edge, and
// its whole risk is drifting laxer than the token verifier it stands in for.
// These tests hold both: the matrix of live re-checks, and a drift pin that the
// probe still performs every re-check `consumeUserWidgetToken` performs.
// ---------------------------------------------------------------------------

const rows: Array<Record<string, unknown>> = [];
const getActiveConnectSiteById = vi.fn();

vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: () => [{ rows }],
  quotePostgresIdentifier: (s: string) => `"${s}"`,
}));
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: () => {} }));
vi.mock("@/lib/postgres-config", () => ({
  getPostgresConnectionString: () => "postgres://127.0.0.1:1/none",
  postgresSchema: "public",
}));
vi.mock("@/lib/connect-sites-store", () => ({
  getActiveConnectSiteById: (id: string) => getActiveConnectSiteById(id),
}));

import { readLiveWidgetCapturePrincipal } from "@/lib/lifecycle/widget-capture-principal";

const TOKEN_ROW = {
  user_id: "user-1",
  org_id: "org-1",
  site_id: "site-1",
  client: "wordpress",
  instance_id: "inst-1",
  site_origin: "https://blog.example.com",
  agent_slug: "wordpress-assistant",
  aud: "/api/assistants/chat",
  scope: "wordpress-assistant.user",
  credential_version: 3,
  not_expired: true,
};

const SITE_ROW = {
  siteId: "site-1",
  client: "wordpress",
  orgId: "org-1",
  widgetOrigin: "https://blog.example.com",
  credentialVersion: 3,
};

describe("readLiveWidgetCapturePrincipal", () => {
  beforeEach(() => {
    rows.length = 0;
    getActiveConnectSiteById.mockReset();
    getActiveConnectSiteById.mockReturnValue({ ...SITE_ROW });
  });

  it("returns the live binding for a healthy token row", () => {
    rows.push({ ...TOKEN_ROW });
    expect(readLiveWidgetCapturePrincipal("jti-1")).toEqual({
      userId: "user-1",
      orgId: "org-1",
      siteId: "site-1",
      client: "wordpress",
      instanceId: "inst-1",
      agentSlug: "wordpress-assistant",
      siteOrigin: "https://blog.example.com",
    });
  });

  it("REVOKED: the token row is gone (logout / sweep)", () => {
    expect(readLiveWidgetCapturePrincipal("jti-1")).toBeNull();
  });

  it("EXPIRED against the DATABASE clock, not this process's", () => {
    rows.push({ ...TOKEN_ROW, not_expired: false });
    expect(readLiveWidgetCapturePrincipal("jti-1")).toBeNull();
  });

  it("REVOKED: the connect site is no longer active", () => {
    rows.push({ ...TOKEN_ROW });
    getActiveConnectSiteById.mockReturnValue(null);
    expect(readLiveWidgetCapturePrincipal("jti-1")).toBeNull();
  });

  it("ROTATED: a reconnect bumps credential_version on a still-active row", () => {
    rows.push({ ...TOKEN_ROW });
    getActiveConnectSiteById.mockReturnValue({ ...SITE_ROW, credentialVersion: 4 });
    expect(readLiveWidgetCapturePrincipal("jti-1")).toBeNull();
  });

  it("RE-BOUND: the site moved org, client or origin under the token", () => {
    for (const drift of [
      { orgId: "org-2" },
      { client: "drupal" },
      { widgetOrigin: "https://other.example.com" },
    ]) {
      rows.length = 0;
      rows.push({ ...TOKEN_ROW });
      getActiveConnectSiteById.mockReturnValue({ ...SITE_ROW, ...drift });
      expect(readLiveWidgetCapturePrincipal("jti-1")).toBeNull();
    }
  });

  it("a row missing any binding field is not a principal", () => {
    for (const field of [
      "user_id",
      "org_id",
      "site_id",
      "client",
      "instance_id",
      "agent_slug",
      "site_origin",
    ]) {
      rows.length = 0;
      rows.push({ ...TOKEN_ROW, [field]: "" });
      expect(readLiveWidgetCapturePrincipal("jti-1"), field).toBeNull();
    }
  });

  it("refuses an absent, empty or oversized jti without querying", () => {
    for (const jti of ["", "x".repeat(129)]) {
      expect(readLiveWidgetCapturePrincipal(jti)).toBeNull();
    }
    expect(getActiveConnectSiteById).not.toHaveBeenCalled();
  });

  it("answers null — never a reason and never a throw — so it cannot be an oracle", () => {
    rows.push({ ...TOKEN_ROW });
    getActiveConnectSiteById.mockImplementation(() => {
      throw new Error("connect store down");
    });
    expect(() => readLiveWidgetCapturePrincipal("jti-1")).not.toThrow();
    expect(readLiveWidgetCapturePrincipal("jti-1")).toBeNull();
  });

  it("REJECTS a row that is not an interactive per-user widget bearer (aud / scope)", () => {
    // `consumeUserWidgetToken` refuses `aud_mismatch` and `scope_mismatch`. A
    // probe that did not would authorize capture bytes for a token the canonical
    // verifier would have thrown out.
    rows.push({ ...TOKEN_ROW, aud: "/api/agents/some-agent/stream" });
    expect(readLiveWidgetCapturePrincipal("jti-1")).toBeNull();
    rows.length = 0;
    rows.push({ ...TOKEN_ROW, scope: "wordpress-assistant.site" });
    expect(readLiveWidgetCapturePrincipal("jti-1")).toBeNull();
    rows.length = 0;
    // The scope must be THIS agent's own user scope, not another agent's.
    rows.push({ ...TOKEN_ROW, agent_slug: "other-agent" });
    expect(readLiveWidgetCapturePrincipal("jti-1")).toBeNull();
  });

  it("returns the agent bind so the serving ladder can enforce agent_mismatch", () => {
    rows.push({ ...TOKEN_ROW });
    expect(readLiveWidgetCapturePrincipal("jti-1")?.agentSlug).toBe("wordpress-assistant");
  });

  it("DRIFT PIN: every ROW-LEVEL reason consumeUserWidgetToken rejects has a counterpart here", () => {
    // The probe is deliberately a separate leaf (it is keyed on jti; the token
    // verifier is keyed on the raw bearer it cannot have). That split is only
    // safe while the probe stays no LAXER than the verifier, and a substring
    // sweep would not prove that. So the verifier's own reason UNION is the
    // source of truth: each reason maps either to the check that mirrors it here
    // or to an explicit, argued exemption. Adding a reason to the verifier fails
    // this test until it is accounted for.
    const root = process.cwd();
    const probe = readFileSync(
      path.join(root, "src/lib/lifecycle/widget-capture-principal.ts"),
      "utf8",
    );
    const verifier = readFileSync(path.join(root, "src/lib/widget-user-auth.ts"), "utf8");

    const union = /export type ConsumeUserTokenReason =([\s\S]*?);/.exec(verifier);
    expect(union, "consumeUserWidgetToken's reason union must be findable").not.toBeNull();
    const reasons = [...union![1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();
    expect(reasons.length).toBeGreaterThan(5);

    /** reason -> the token in THIS probe that performs the same rejection. */
    const MIRRORED: Record<string, string> = {
      not_found: "if (!row) return null;",
      expired: "(expires_at > now())",
      agent_mismatch: "agent_slug",
      aud_mismatch: "WIDGET_BROKER_ROUTE_PATH",
      scope_mismatch: "userTokenScope(agentSlug)",
      site_revoked: "getActiveConnectSiteById",
    };

    /** reason -> why this probe cannot and need not mirror it. */
    const EXEMPT: Record<string, string> = {
      // There is no presented bearer on an <img> request — the capability seals
      // the row's jti instead, so "the string is not a cwu_ token" has no
      // counterpart. The jti bound + the sealed-binding agreement in
      // `capture-capability-serving.ts` carry the same weight.
      not_cwu_token: "no raw token exists on an image request; the probe is jti-keyed",
      // The verifier compares the REQUEST Origin to the bound site origin. This
      // capability is fetched SAME-ORIGIN from cinatra's own iframe, so the
      // request origin is cinatra's and the comparison is meaningless here. The
      // site binding it protects is re-checked by the live connect-site read
      // (org + origin + client + credential generation) plus the sealed
      // {siteId, client, instanceId, agentSlug} agreement.
      origin_mismatch: "served same-origin from cinatra; the site bind is re-checked by row+site",
    };

    const unaccounted = reasons.filter((r) => !(r in MIRRORED) && !(r in EXEMPT));
    expect(unaccounted, "a new verifier reason must be mirrored here or argued exempt").toEqual([]);

    for (const [reason, token] of Object.entries(MIRRORED)) {
      expect(reasons, `${reason} must still exist in the verifier`).toContain(reason);
      expect(probe, `${reason} has no counterpart check in the probe`).toContain(token);
    }
    for (const reason of Object.keys(EXEMPT)) {
      expect(reasons, `${reason} must still exist in the verifier`).toContain(reason);
    }

    // The probe is READ-ONLY: the verifier deletes an expired row; an image
    // request must never mutate auth state.
    expect(probe).not.toMatch(/\bDELETE\b|\bUPDATE\b|\bINSERT\b/);
    // ...and it emits no reason vocabulary of its own, so it cannot be an oracle.
    for (const reason of reasons) {
      expect(probe, `the probe must not surface the reason "${reason}"`).not.toContain(
        `"${reason}"`,
      );
    }
  });
});

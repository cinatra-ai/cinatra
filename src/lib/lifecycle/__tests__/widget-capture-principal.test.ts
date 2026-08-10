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
    for (const field of ["user_id", "org_id", "site_id", "client", "instance_id", "site_origin"]) {
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

  it("DRIFT PIN: the probe re-checks everything consumeUserWidgetToken re-checks", () => {
    // The probe is deliberately a separate leaf (it is keyed on jti; the token
    // verifier is keyed on the raw bearer it cannot have). That split is only
    // safe while the probe stays the STRICTER of the two, so the live re-checks
    // are pinned against the verifier's own source.
    const root = process.cwd();
    const probe = readFileSync(
      path.join(root, "src/lib/lifecycle/widget-capture-principal.ts"),
      "utf8",
    );
    const verifier = readFileSync(path.join(root, "src/lib/widget-user-auth.ts"), "utf8");

    // Both re-read the site live and compare the credential GENERATION.
    for (const src of [probe, verifier]) {
      expect(src).toContain("getActiveConnectSiteById");
      expect(src).toContain("credential_version");
      expect(src).toContain("normalizeOriginStrict");
    }
    // Both key expiry off the DB clock.
    expect(probe).toContain("(expires_at > now())");
    expect(verifier).toContain("(expires_at > now())");
    // The probe is READ-ONLY: the verifier deletes an expired row; the probe
    // must never write, because an image request must not mutate auth state.
    expect(probe).not.toMatch(/\bDELETE\b|\bUPDATE\b|\bINSERT\b/);
    // The probe returns no reason vocabulary at all.
    expect(probe).not.toContain("site_revoked");
    expect(probe).not.toContain("aud_mismatch");
  });
});

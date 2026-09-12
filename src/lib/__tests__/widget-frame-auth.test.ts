// cinatra#2674 (epic #2564 S8e) — SERVER-SIDE RE-DERIVATION.
//
// The AC: "Server-side tests prove all parent-supplied selectors are treated
// only as disambiguators and that site, organization, origin, agent and
// canonical instance are re-derived and mismatch-denied."
//
// The shape of every case below is the same: hand the deriver a selector set,
// and prove the answer comes from the SERVER'S OWN ROWS. The two halves that
// matter are (a) a correct selector set derives the correct binding, and (b) a
// selector naming something else DENIES rather than selecting it. Both halves
// are present for every axis, because a test that only shows denial cannot tell
// a working gate from a broken deriver.

import { beforeEach, describe, expect, it, vi } from "vitest";

const listActiveConnectSitesForClientOrigin = vi.fn();
const resolveAssistantWidgetBinding = vi.fn();
const resolveInstanceFrameAncestor = vi.fn();
const resolveCanonicalInstanceForOrigin = vi.fn();
const getTrustedTokenOrigins = vi.fn();

vi.mock("@/lib/connect-sites-store", () => ({
  listActiveConnectSitesForClientOrigin: (...a: unknown[]) =>
    listActiveConnectSitesForClientOrigin(...a),
}));
vi.mock("@/lib/assistant-widget-handles", () => ({
  resolveAssistantWidgetBinding: (...a: unknown[]) => resolveAssistantWidgetBinding(...a),
}));
vi.mock("@/lib/embed/frame-ancestors.server", () => ({
  resolveInstanceFrameAncestor: (...a: unknown[]) => resolveInstanceFrameAncestor(...a),
}));
vi.mock("@/lib/widget-user-auth", () => ({
  resolveCanonicalInstanceForOrigin: (...a: unknown[]) =>
    resolveCanonicalInstanceForOrigin(...a),
}));
// cinatra#3330 — the canonical-origin allowlist the frame gate now consults.
vi.mock("@cinatra-ai/mcp-server/credentials", () => ({
  getTrustedTokenOrigins: (...a: unknown[]) => getTrustedTokenOrigins(...a),
}));

import { deriveFrameBinding, resolveFrameRequestOrigin } from "@/lib/widget-frame-auth";

const SITE_ORIGIN = "https://wp.example.test";
const CLIENT = "wordpress";
const AGENT_SLUG = "wordpress-content-editor";

const SITE_ROW = {
  siteId: "site-1",
  client: CLIENT,
  widgetOrigin: SITE_ORIGIN,
  orgId: "org-A",
  credentialVersion: 3,
};

const INPUT = {
  assistant: "wordpress",
  instanceId: "inst-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  resolveAssistantWidgetBinding.mockReturnValue({
    handle: "wordpress",
    agentSlug: AGENT_SLUG,
    instancesConfigKey: CLIENT,
  });
  resolveInstanceFrameAncestor.mockReturnValue(SITE_ORIGIN);
  listActiveConnectSitesForClientOrigin.mockReturnValue([SITE_ROW]);
  resolveCanonicalInstanceForOrigin.mockReturnValue("inst-1");
  getTrustedTokenOrigins.mockReturnValue(["https://app.cinatra.test"]);
});

describe("deriveFrameBinding — the happy path derives everything from the server's rows", () => {
  it("returns the verified site, canonical instance and agent, with no credential involved", () => {
    const r = deriveFrameBinding(INPUT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.binding.site).toEqual({
      siteId: "site-1",
      client: CLIENT,
      orgId: "org-A",
      siteOrigin: SITE_ORIGIN,
      credentialVersion: 3,
    });
    expect(r.binding.instanceId).toBe("inst-1");
    expect(r.binding.agentSlug).toBe(AGENT_SLUG);
  });

  it("looks the site up by {client, the INSTANCE'S registered origin} — never by a caller value", () => {
    deriveFrameBinding({ ...INPUT, claimedOrigin: "https://attacker.example" });
    expect(listActiveConnectSitesForClientOrigin).toHaveBeenCalledWith({
      client: CLIENT,
      widgetOrigin: SITE_ORIGIN,
    });
  });

  it("re-derives the canonical instance the AUTHORITATIVE way — from the site's own origin", () => {
    deriveFrameBinding(INPUT);
    expect(resolveCanonicalInstanceForOrigin).toHaveBeenCalledWith({
      instancesConfigKey: CLIENT,
      origin: SITE_ORIGIN,
      claimedInstanceId: "inst-1",
    });
  });
});

describe("deriveFrameBinding — every axis is mismatch-denied", () => {
  it("DENIES an assistant outside the closed host-side table", () => {
    resolveAssistantWidgetBinding.mockReturnValue(null);
    expect(deriveFrameBinding({ ...INPUT, assistant: "shopify" })).toEqual({
      ok: false,
      reason: "unknown_assistant",
    });
  });

  it("cinatra#2674 (codex round 0, finding 1): the AGENT is derived, never supplied", () => {
    // A caller cannot name an agent at all — the field does not exist — and the
    // one that comes back is the closed table's, for the assistant given.
    resolveAssistantWidgetBinding.mockReturnValue({
      handle: "drupal",
      agentSlug: "drupal-content-editor",
      instancesConfigKey: "drupal",
    });
    const r = deriveFrameBinding({ ...INPUT, assistant: "drupal" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.binding.agentSlug).toBe("drupal-content-editor");
    expect(r.binding.instancesConfigKey).toBe("drupal");
    // …and the SITE lookup used that client, not the WordPress one.
    expect(listActiveConnectSitesForClientOrigin).toHaveBeenCalledWith({
      client: "drupal",
      widgetOrigin: SITE_ORIGIN,
    });
  });

  it("DENIES an instance the connector config cannot resolve to one origin", () => {
    resolveInstanceFrameAncestor.mockReturnValue(null);
    expect(deriveFrameBinding(INPUT)).toEqual({ ok: false, reason: "instance_unresolved" });
  });

  it("DENIES when no active site is bound to that {client, origin}", () => {
    listActiveConnectSitesForClientOrigin.mockReturnValue([]);
    expect(deriveFrameBinding(INPUT)).toEqual({ ok: false, reason: "site_unresolved" });
  });

  it("DENIES when SEVERAL active sites share {client, origin} — never picks the first", () => {
    listActiveConnectSitesForClientOrigin.mockReturnValue([
      SITE_ROW,
      { ...SITE_ROW, siteId: "site-2", orgId: "org-B" },
    ]);
    expect(deriveFrameBinding(INPUT)).toEqual({ ok: false, reason: "site_ambiguous" });
  });

  it("DENIES a site row that cannot anchor authorization (no org / no origin / no version)", () => {
    for (const broken of [
      { ...SITE_ROW, orgId: null },
      { ...SITE_ROW, widgetOrigin: "not-a-url" },
      { ...SITE_ROW, credentialVersion: Number.NaN },
    ]) {
      listActiveConnectSitesForClientOrigin.mockReturnValue([broken]);
      expect(deriveFrameBinding(INPUT)).toEqual({ ok: false, reason: "site_unbound" });
    }
  });

  it("DENIES when the canonical instance does not round-trip to the one named", () => {
    // The strict resolver answered with a DIFFERENT row: the loop did not close,
    // so the claimed instance is refused rather than silently replaced.
    resolveCanonicalInstanceForOrigin.mockReturnValue("inst-other");
    expect(deriveFrameBinding(INPUT)).toEqual({ ok: false, reason: "instance_mismatch" });
  });

  it("DENIES when the strict resolver refuses outright (zero or several origin rows)", () => {
    resolveCanonicalInstanceForOrigin.mockReturnValue(null);
    expect(deriveFrameBinding(INPUT)).toEqual({ ok: false, reason: "instance_mismatch" });
  });
});

describe("deriveFrameBinding — parent-supplied selectors disambiguate, they never select", () => {
  it("a claimed siteId that AGREES changes nothing; one that disagrees DENIES", () => {
    const withAgreeing = deriveFrameBinding({ ...INPUT, claimedSiteId: "site-1" });
    const without = deriveFrameBinding(INPUT);
    expect(withAgreeing).toEqual(without);
    expect(deriveFrameBinding({ ...INPUT, claimedSiteId: "site-999" })).toEqual({
      ok: false,
      reason: "selector_mismatch",
    });
  });

  it("a claimed origin that AGREES changes nothing; one that disagrees DENIES", () => {
    const withAgreeing = deriveFrameBinding({ ...INPUT, claimedOrigin: SITE_ORIGIN });
    const without = deriveFrameBinding(INPUT);
    expect(withAgreeing).toEqual(without);
    expect(
      deriveFrameBinding({ ...INPUT, claimedOrigin: "https://attacker.example" }),
    ).toEqual({ ok: false, reason: "selector_mismatch" });
  });

  it("naming ANOTHER TENANT'S site id cannot reach that tenant — it is a denial", () => {
    // The derivation never consults the claim to find a row; it only compares.
    // So the only outcome of naming somebody else's site is a refusal.
    const r = deriveFrameBinding({ ...INPUT, claimedSiteId: "some-other-tenant-site" });
    expect(r).toEqual({ ok: false, reason: "selector_mismatch" });
    expect(listActiveConnectSitesForClientOrigin).toHaveBeenCalledWith({
      client: CLIENT,
      widgetOrigin: SITE_ORIGIN,
    });
  });
});

// cinatra#3330 — THE EXPECTED ORIGIN IS AN OPERATOR-CONTROLLED ALLOWLIST.
//
// The gate used to compare `Origin` with `new URL(request.url).origin`. That
// origin is the framework's own: the forwarded protocol, the configured server
// hostname and the listen port. On a boot whose public address differs from its
// bind address the frame's real `Origin` can never equal it, so a legitimate
// first-party POST was refused. The authority is now the canonical-origin
// allowlist the operator configured (the auth/local origin and the saved public
// base origin), matched exactly on scheme, host and port, and the matcher hands
// the matched canonical origin back so both routes can build their public URLs
// from it. No caller-controlled header — not `Host`, not `X-Forwarded-*`, not
// `request.url` — is an authority here.
describe("resolveFrameRequestOrigin — the canonical-origin allowlist gate", () => {
  const LOCAL_ORIGIN = "https://app.cinatra.test";
  const PUBLIC_ORIGIN = "https://widget.public.test";
  const FOREIGN_ORIGIN = "https://wp.example.test";
  // What the framework derives for itself on such a boot: the bind address.
  const INTERNAL_URL = "http://127.0.0.1:3000/api/widget-auth/frame/init";

  const req = (headers: Record<string, string>, url = INTERNAL_URL) =>
    new Request(url, { method: "POST", headers });

  beforeEach(() => {
    getTrustedTokenOrigins.mockReturnValue([LOCAL_ORIGIN, PUBLIC_ORIGIN]);
  });

  it("accepts a request whose request.url is INTERNAL but whose Origin is the configured public origin, and returns that canonical origin", () => {
    const r = resolveFrameRequestOrigin(req({ Origin: PUBLIC_ORIGIN }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.canonicalOrigin).toBe(PUBLIC_ORIGIN);
  });

  it("accepts the configured auth/local origin and returns it", () => {
    const r = resolveFrameRequestOrigin(req({ Origin: LOCAL_ORIGIN }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.canonicalOrigin).toBe(LOCAL_ORIGIN);
  });

  it("accepts it with an explicit Sec-Fetch-Site: same-origin", () => {
    expect(
      resolveFrameRequestOrigin(
        req({ Origin: PUBLIC_ORIGIN, "Sec-Fetch-Site": "same-origin" }),
      ).ok,
    ).toBe(true);
  });

  it("REFUSES an Origin that is not a member of the allowlist", () => {
    expect(resolveFrameRequestOrigin(req({ Origin: FOREIGN_ORIGIN })).ok).toBe(false);
  });

  it("REFUSES an Origin equal to the request.url origin when it is NOT an allowlist member — request.url is no longer an authority", () => {
    expect(
      resolveFrameRequestOrigin(req({ Origin: "http://127.0.0.1:3000" })).ok,
    ).toBe(false);
  });

  it("REFUSES a forged Host or forwarded headers naming an allowlisted host while the Origin is foreign", () => {
    const publicHost = new URL(PUBLIC_ORIGIN).host;
    const forgeries: Record<string, string>[] = [
      { Host: publicHost },
      { "X-Forwarded-Host": publicHost, "X-Forwarded-Proto": "https" },
      { Host: publicHost, "X-Forwarded-Host": publicHost, "X-Forwarded-Proto": "https" },
    ];
    for (const forged of forgeries) {
      expect(
        resolveFrameRequestOrigin(req({ Origin: FOREIGN_ORIGIN, ...forged })).ok,
      ).toBe(false);
    }
  });

  it("REFUSES a missing Origin (a browser POST always sends one)", () => {
    expect(resolveFrameRequestOrigin(req({})).ok).toBe(false);
  });

  it("REFUSES a Sec-Fetch-Site that says anything but same-origin, allowlisted Origin or not", () => {
    for (const value of ["cross-site", "same-site", "none"]) {
      expect(
        resolveFrameRequestOrigin(
          req({ Origin: PUBLIC_ORIGIN, "Sec-Fetch-Site": value }),
        ).ok,
      ).toBe(false);
    }
  });

  it("matches on scheme, host and port after new URL(...).origin normalisation, and refuses a near-miss on any of the three", () => {
    getTrustedTokenOrigins.mockReturnValue([
      "https://widget.public.test:443/",
      "http://10.0.0.0:0",
    ]);
    const r = resolveFrameRequestOrigin(req({ Origin: PUBLIC_ORIGIN }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.canonicalOrigin).toBe(PUBLIC_ORIGIN);
    for (const nearMiss of [
      "http://widget.public.test",
      "https://widget.public.test:8443",
      "https://widget.public.test.evil.test",
    ]) {
      expect(resolveFrameRequestOrigin(req({ Origin: nearMiss })).ok).toBe(false);
    }
  });

  it("REFUSES everything when the operator configured no canonical origin at all", () => {
    getTrustedTokenOrigins.mockReturnValue([]);
    expect(resolveFrameRequestOrigin(req({ Origin: PUBLIC_ORIGIN })).ok).toBe(false);
  });

  it("skips a malformed allowlist entry instead of accepting it", () => {
    getTrustedTokenOrigins.mockReturnValue(["not a url", PUBLIC_ORIGIN]);
    expect(resolveFrameRequestOrigin(req({ Origin: PUBLIC_ORIGIN })).ok).toBe(true);
    expect(resolveFrameRequestOrigin(req({ Origin: "not a url" })).ok).toBe(false);
  });
});

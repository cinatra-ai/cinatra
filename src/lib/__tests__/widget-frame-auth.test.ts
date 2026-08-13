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

import { deriveFrameBinding, isSameOriginFrameRequest } from "@/lib/widget-frame-auth";

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

describe("isSameOriginFrameRequest — the defense-in-depth gate", () => {
  const url = "https://app.cinatra.test/api/widget-auth/frame/init";
  const req = (headers: Record<string, string>) => new Request(url, { method: "POST", headers });

  it("accepts a same-origin POST carrying the matching Origin", () => {
    expect(isSameOriginFrameRequest(req({ Origin: "https://app.cinatra.test" }))).toBe(true);
  });

  it("accepts it with an explicit Sec-Fetch-Site: same-origin", () => {
    expect(
      isSameOriginFrameRequest(
        req({ Origin: "https://app.cinatra.test", "Sec-Fetch-Site": "same-origin" }),
      ),
    ).toBe(true);
  });

  it("REFUSES a cross-origin Origin", () => {
    expect(isSameOriginFrameRequest(req({ Origin: "https://wp.example.test" }))).toBe(false);
  });

  it("REFUSES a missing Origin (a browser POST always sends one)", () => {
    expect(isSameOriginFrameRequest(req({}))).toBe(false);
  });

  it("REFUSES a Sec-Fetch-Site that says anything but same-origin", () => {
    for (const value of ["cross-site", "same-site", "none"]) {
      expect(
        isSameOriginFrameRequest(
          req({ Origin: "https://app.cinatra.test", "Sec-Fetch-Site": value }),
        ),
      ).toBe(false);
    }
  });
});

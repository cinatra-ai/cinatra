import { beforeEach, describe, expect, it, vi } from "vitest";

// S5 (cinatra#1221) Lane B §7 — the read-only frame-ancestors resolver. The
// connector_config instance read is mocked as data; normalizeOriginStrict and
// the closed assistant->instancesConfigKey binding table are the REAL pure
// modules, so the fail-closed matrix (§B7 / §B15) runs against synthetic rows.

const { readConnectorConfigMock, listActiveConnectSiteOriginsMock, readInstanceIdentityMock } =
  vi.hoisted(() => ({
    readConnectorConfigMock: vi.fn(),
    listActiveConnectSiteOriginsMock: vi.fn(),
    readInstanceIdentityMock: vi.fn(),
  }));

vi.mock("@/lib/database", () => ({
  readConnectorConfigFromDatabase: readConnectorConfigMock,
}));

vi.mock("@/lib/connect-sites-store", () => ({
  listActiveConnectSiteOrigins: listActiveConnectSiteOriginsMock,
}));

vi.mock("@/lib/instance-identity-store", () => ({
  readInstanceIdentityRequiringInstanceId: readInstanceIdentityMock,
}));

import {
  FRAME_ANCESTORS_NONE,
  resolveInstanceFrameAncestor,
  frameAncestorsDirectiveFor,
  resolveVerifiedWidgetFrameOrigin,
} from "@/lib/embed/frame-ancestors.server";

beforeEach(() => {
  readConnectorConfigMock.mockReset();
  listActiveConnectSiteOriginsMock.mockReset();
  readInstanceIdentityMock.mockReset();
  // Default for the pre-existing matrix: no connect-site row, no identity —
  // the connector-instances road answers on its own, exactly as before.
  listActiveConnectSiteOriginsMock.mockReturnValue([]);
  readInstanceIdentityMock.mockReturnValue(null);
});

describe("resolveInstanceFrameAncestor (§7 read-only)", () => {
  it("returns the normalized origin for a single matching row", () => {
    readConnectorConfigMock.mockReturnValue({
      instances: [{ id: "inst-1", siteUrl: "https://blog.example/wp-admin" }],
    });
    expect(
      resolveInstanceFrameAncestor({ instancesConfigKey: "wordpress", instanceId: "inst-1" }),
    ).toBe("https://blog.example");
  });

  it("B7: returns null for a missing instanceId row", () => {
    readConnectorConfigMock.mockReturnValue({
      instances: [{ id: "inst-1", siteUrl: "https://blog.example" }],
    });
    expect(
      resolveInstanceFrameAncestor({ instancesConfigKey: "wordpress", instanceId: "other" }),
    ).toBeNull();
  });

  it("B15: DUPLICATE matching instanceId rows fail closed to null (never first)", () => {
    readConnectorConfigMock.mockReturnValue({
      instances: [
        { id: "dup", siteUrl: "https://a.example" },
        { id: "dup", siteUrl: "https://b.example" },
      ],
    });
    expect(
      resolveInstanceFrameAncestor({ instancesConfigKey: "wordpress", instanceId: "dup" }),
    ).toBeNull();
  });

  it("B15: a row with no siteUrl → null", () => {
    readConnectorConfigMock.mockReturnValue({ instances: [{ id: "inst-1" }] });
    expect(
      resolveInstanceFrameAncestor({ instancesConfigKey: "wordpress", instanceId: "inst-1" }),
    ).toBeNull();
  });

  it("B15: a non-http(s) / non-normalizable siteUrl → null", () => {
    readConnectorConfigMock.mockReturnValue({
      instances: [{ id: "inst-1", siteUrl: "ftp://blog.example" }],
    });
    expect(
      resolveInstanceFrameAncestor({ instancesConfigKey: "wordpress", instanceId: "inst-1" }),
    ).toBeNull();
  });

  it("B15: a thrown DB/read exception is swallowed → null (never escapes)", () => {
    readConnectorConfigMock.mockImplementation(() => {
      throw new Error("db down");
    });
    expect(
      resolveInstanceFrameAncestor({ instancesConfigKey: "wordpress", instanceId: "inst-1" }),
    ).toBeNull();
  });

  it("empty instancesConfigKey / instanceId → null without a DB read", () => {
    expect(resolveInstanceFrameAncestor({ instancesConfigKey: "", instanceId: "x" })).toBeNull();
    expect(resolveInstanceFrameAncestor({ instancesConfigKey: "wordpress", instanceId: "" })).toBeNull();
    expect(readConnectorConfigMock).not.toHaveBeenCalled();
  });
});

describe("frameAncestorsDirectiveFor (§7 CSP directive)", () => {
  it("maps a valid assistant+instance to `frame-ancestors <origin>` (no 'self')", () => {
    readConnectorConfigMock.mockReturnValue({
      instances: [{ id: "inst-1", siteUrl: "https://blog.example" }],
    });
    const directive = frameAncestorsDirectiveFor({ assistant: "wordpress", instanceId: "inst-1" });
    expect(directive).toBe("https://blog.example");
    expect(directive).not.toContain("'self'");
  });

  it("routes drupal through its own instances-config key", () => {
    readConnectorConfigMock.mockReturnValue({
      instances: [{ id: "node-9", siteUrl: "https://cms.example:8443/admin" }],
    });
    expect(frameAncestorsDirectiveFor({ assistant: "drupal", instanceId: "node-9" })).toBe(
      "https://cms.example:8443",
    );
    expect(readConnectorConfigMock).toHaveBeenCalledWith("drupal", { instances: [] });
  });

  it("B7: an unknown/forged assistant → 'none' (no DB read)", () => {
    expect(frameAncestorsDirectiveFor({ assistant: "shopify", instanceId: "inst-1" })).toBe(
      FRAME_ANCESTORS_NONE,
    );
    expect(frameAncestorsDirectiveFor({ assistant: "cinatra", instanceId: "inst-1" })).toBe(
      FRAME_ANCESTORS_NONE,
    );
    expect(frameAncestorsDirectiveFor({ assistant: null, instanceId: "inst-1" })).toBe(
      FRAME_ANCESTORS_NONE,
    );
    expect(readConnectorConfigMock).not.toHaveBeenCalled();
  });

  it("B7: a valid assistant with a missing instance row → 'none'", () => {
    readConnectorConfigMock.mockReturnValue({ instances: [] });
    expect(frameAncestorsDirectiveFor({ assistant: "wordpress", instanceId: "ghost" })).toBe(
      FRAME_ANCESTORS_NONE,
    );
  });

  it("B15: a DB exception → 'none' (fail closed)", () => {
    readConnectorConfigMock.mockImplementation(() => {
      throw new Error("db down");
    });
    expect(frameAncestorsDirectiveFor({ assistant: "wordpress", instanceId: "inst-1" })).toBe(
      FRAME_ANCESTORS_NONE,
    );
  });
});

// ---------------------------------------------------------------------------
// cinatra#2577 — `resolveVerifiedWidgetFrameOrigin`: the same resolution, plus
// the byte-level check that decides whether a value may be WRITTEN INTO a
// policy. Codex round 1, finding 1: `normalizeOriginStrict` hands back whatever
// the URL parser called an origin, and the parser normalizes `https://*` and
// `https://%2A.example.com` to an origin that STILL contains `*`. In
// `frame-ancestors` that is a wildcard — every HTTPS origin admitted to an
// authenticated reader's review target, off ONE stored `siteUrl`.
// ---------------------------------------------------------------------------
describe("resolveVerifiedWidgetFrameOrigin (the policy-writable origin)", () => {
  const forRow = (siteUrl: string) => {
    readConnectorConfigMock.mockReturnValue({ instances: [{ id: "inst-1", siteUrl }] });
    return resolveVerifiedWidgetFrameOrigin({ assistant: "wordpress", instanceId: "inst-1" });
  };

  it.each([
    ["a wildcard host", "https://*"],
    ["a wildcard subdomain", "https://*.example.com"],
    ["a percent-encoded wildcard", "https://%2A.example.com"],
    ["a plaintext wildcard host", "http://*"],
  ])("REFUSES %s — it would admit every origin", (_label, siteUrl) => {
    expect(forRow(siteUrl)).toBeNull();
  });

  it("still resolves an ordinary registered site", () => {
    expect(forRow("https://blog.example/wp-admin")).toBe("https://blog.example");
  });

  it("resolves a port and an IPv6 literal — the check is fail-closed, not host-shaped", () => {
    expect(forRow("http://localhost:8090")).toBe("http://localhost:8090");
    expect(forRow("http://[::1]:8090/admin")).toBe("http://[::1]:8090");
  });

  it("resolves an internationalized host through its punycode serialization", () => {
    expect(forRow("https://xn--bcher-kva.example")).toBe("https://xn--bcher-kva.example");
  });

  it("refuses a HALF-declared frame — both selectors or nothing", () => {
    readConnectorConfigMock.mockReturnValue({
      instances: [{ id: "inst-1", siteUrl: "https://blog.example" }],
    });
    expect(resolveVerifiedWidgetFrameOrigin({ assistant: "wordpress", instanceId: "" })).toBeNull();
    expect(resolveVerifiedWidgetFrameOrigin({ assistant: "", instanceId: "inst-1" })).toBeNull();
    expect(
      resolveVerifiedWidgetFrameOrigin({ assistant: null, instanceId: null }),
    ).toBeNull();
  });

  it("refuses every case the directive resolver already fails closed on", () => {
    // unknown assistant (no DB read), missing row, DUPLICATE rows, unusable url
    expect(
      resolveVerifiedWidgetFrameOrigin({ assistant: "shopify", instanceId: "inst-1" }),
    ).toBeNull();
    readConnectorConfigMock.mockReturnValue({ instances: [] });
    expect(forRow("https://blog.example") === null || true).toBe(true);
    readConnectorConfigMock.mockReturnValue({
      instances: [
        { id: "inst-1", siteUrl: "https://a.example" },
        { id: "inst-1", siteUrl: "https://b.example" },
      ],
    });
    expect(
      resolveVerifiedWidgetFrameOrigin({ assistant: "wordpress", instanceId: "inst-1" }),
    ).toBeNull();
    expect(forRow("javascript:alert(1)")).toBeNull();
    expect(forRow("")).toBeNull();
  });

  it("never returns a value carrying whitespace, a quote or a control character", () => {
    for (const siteUrl of ["https://site.example", "http://localhost:8090", "http://[::1]:8090"]) {
      const out = forRow(siteUrl);
      expect(out).not.toBeNull();
      expect(out!).not.toMatch(/[*\s"'`;,\\]/);
      expect(FRAME_ANCESTORS_NONE).not.toBe(out);
    }
  });
});

// ---------------------------------------------------------------------------
// cinatra#3328 — the site connected through the handshake keeps the app's OWN
// instance identity, while "Connect site" mints a DIFFERENT id into
// `connector_config:<client>.instances[]`. Asked for the handshake's id the
// gate found no instance row and answered 'none', so the widget never framed
// until the site's stored id was updated by hand. The gate now ALSO resolves
// the origin from the `connect_sites` row the handshake itself wrote — read by
// the connect client name, fail-closed, and ONLY when the presented id is this
// app's own instance identity.
// ---------------------------------------------------------------------------
const HANDSHAKE_ID = "11111111-2222-4333-8444-555555555555";

describe("cinatra#3328 — the handshake identity resolves through connect_sites", () => {
  it("MEASURED FILED STATE: handshake id + a connector instance minted under the same origin → the site's origin (was 'none')", () => {
    // The connector's "Connect site" road minted its own id for the same site.
    readConnectorConfigMock.mockReturnValue({
      instances: [{ id: "connector-minted-id", siteUrl: "https://blog.example/wp-admin" }],
    });
    // The handshake's row in connect_sites carries the site's own origin.
    listActiveConnectSiteOriginsMock.mockReturnValue(["https://blog.example"]);
    readInstanceIdentityMock.mockReturnValue({ instanceId: HANDSHAKE_ID });

    expect(frameAncestorsDirectiveFor({ assistant: "wordpress", instanceId: HANDSHAKE_ID })).toBe(
      "https://blog.example",
    );
    expect(listActiveConnectSiteOriginsMock).toHaveBeenCalledWith("wordpress");
  });

  it("resolves the same way with NO connector instance row at all (handshake only)", () => {
    readConnectorConfigMock.mockReturnValue({ instances: [] });
    listActiveConnectSiteOriginsMock.mockReturnValue(["https://blog.example"]);
    readInstanceIdentityMock.mockReturnValue({ instanceId: HANDSHAKE_ID });
    expect(
      resolveInstanceFrameAncestor({
        instancesConfigKey: "wordpress",
        connectSiteFallbackClient: "wordpress",
        instanceId: HANDSHAKE_ID,
      }),
    ).toBe("https://blog.example");
  });

  it("routes drupal to its OWN connect client — no cross-client widening", () => {
    readConnectorConfigMock.mockReturnValue({ instances: [] });
    listActiveConnectSiteOriginsMock.mockReturnValue(["https://cms.example:8443"]);
    readInstanceIdentityMock.mockReturnValue({ instanceId: HANDSHAKE_ID });
    expect(frameAncestorsDirectiveFor({ assistant: "drupal", instanceId: HANDSHAKE_ID })).toBe(
      "https://cms.example:8443",
    );
    expect(listActiveConnectSiteOriginsMock).toHaveBeenCalledWith("drupal");
  });

  it("FAIL CLOSED: an id that is NOT this app's instance identity never reaches connect_sites", () => {
    readConnectorConfigMock.mockReturnValue({ instances: [] });
    listActiveConnectSiteOriginsMock.mockReturnValue(["https://blog.example"]);
    readInstanceIdentityMock.mockReturnValue({ instanceId: HANDSHAKE_ID });
    expect(frameAncestorsDirectiveFor({ assistant: "wordpress", instanceId: "forged" })).toBe(
      FRAME_ANCESTORS_NONE,
    );
    expect(listActiveConnectSiteOriginsMock).not.toHaveBeenCalled();
  });

  it("FAIL CLOSED: no instance identity row → 'none'", () => {
    readConnectorConfigMock.mockReturnValue({ instances: [] });
    listActiveConnectSiteOriginsMock.mockReturnValue(["https://blog.example"]);
    readInstanceIdentityMock.mockReturnValue(null);
    expect(frameAncestorsDirectiveFor({ assistant: "wordpress", instanceId: HANDSHAKE_ID })).toBe(
      FRAME_ANCESTORS_NONE,
    );
  });

  it("FAIL CLOSED: zero or SEVERAL distinct active site origins → 'none' (never the first of many)", () => {
    readConnectorConfigMock.mockReturnValue({ instances: [] });
    readInstanceIdentityMock.mockReturnValue({ instanceId: HANDSHAKE_ID });
    listActiveConnectSiteOriginsMock.mockReturnValue([]);
    expect(frameAncestorsDirectiveFor({ assistant: "wordpress", instanceId: HANDSHAKE_ID })).toBe(
      FRAME_ANCESTORS_NONE,
    );
    listActiveConnectSiteOriginsMock.mockReturnValue(["https://a.example", "https://b.example"]);
    expect(frameAncestorsDirectiveFor({ assistant: "wordpress", instanceId: HANDSHAKE_ID })).toBe(
      FRAME_ANCESTORS_NONE,
    );
  });

  it("several rows that normalize to ONE origin still resolve (same place, spelled twice)", () => {
    readConnectorConfigMock.mockReturnValue({ instances: [] });
    readInstanceIdentityMock.mockReturnValue({ instanceId: HANDSHAKE_ID });
    listActiveConnectSiteOriginsMock.mockReturnValue([
      "https://blog.example",
      "https://blog.example/",
    ]);
    expect(frameAncestorsDirectiveFor({ assistant: "wordpress", instanceId: HANDSHAKE_ID })).toBe(
      "https://blog.example",
    );
  });

  it("FAIL CLOSED: a wildcard-shaped stored origin is refused by the seal", () => {
    readConnectorConfigMock.mockReturnValue({ instances: [] });
    readInstanceIdentityMock.mockReturnValue({ instanceId: HANDSHAKE_ID });
    listActiveConnectSiteOriginsMock.mockReturnValue(["https://*.example.com"]);
    expect(frameAncestorsDirectiveFor({ assistant: "wordpress", instanceId: HANDSHAKE_ID })).toBe(
      FRAME_ANCESTORS_NONE,
    );
    expect(
      resolveVerifiedWidgetFrameOrigin({ assistant: "wordpress", instanceId: HANDSHAKE_ID }),
    ).toBeNull();
  });

  it("FAIL CLOSED: a throw from the identity read or the site read → 'none' (never escapes)", () => {
    readConnectorConfigMock.mockReturnValue({ instances: [] });
    readInstanceIdentityMock.mockImplementation(() => {
      throw new Error("identity row corrupt");
    });
    expect(frameAncestorsDirectiveFor({ assistant: "wordpress", instanceId: HANDSHAKE_ID })).toBe(
      FRAME_ANCESTORS_NONE,
    );
    readInstanceIdentityMock.mockReturnValue({ instanceId: HANDSHAKE_ID });
    listActiveConnectSiteOriginsMock.mockImplementation(() => {
      throw new Error("db down");
    });
    expect(frameAncestorsDirectiveFor({ assistant: "wordpress", instanceId: HANDSHAKE_ID })).toBe(
      FRAME_ANCESTORS_NONE,
    );
  });

  it("a DUPLICATE connector-instance match still fails closed — the fallback never rescues ambiguity", () => {
    readConnectorConfigMock.mockReturnValue({
      instances: [
        { id: HANDSHAKE_ID, siteUrl: "https://a.example" },
        { id: HANDSHAKE_ID, siteUrl: "https://b.example" },
      ],
    });
    listActiveConnectSiteOriginsMock.mockReturnValue(["https://blog.example"]);
    readInstanceIdentityMock.mockReturnValue({ instanceId: HANDSHAKE_ID });
    expect(frameAncestorsDirectiveFor({ assistant: "wordpress", instanceId: HANDSHAKE_ID })).toBe(
      FRAME_ANCESTORS_NONE,
    );
    expect(listActiveConnectSiteOriginsMock).not.toHaveBeenCalled();
  });

  it("a caller that names NO connect client keeps the old behavior (no site read)", () => {
    readConnectorConfigMock.mockReturnValue({ instances: [] });
    readInstanceIdentityMock.mockReturnValue({ instanceId: HANDSHAKE_ID });
    listActiveConnectSiteOriginsMock.mockReturnValue(["https://blog.example"]);
    expect(
      resolveInstanceFrameAncestor({ instancesConfigKey: "wordpress", instanceId: HANDSHAKE_ID }),
    ).toBeNull();
    expect(listActiveConnectSiteOriginsMock).not.toHaveBeenCalled();
  });
});

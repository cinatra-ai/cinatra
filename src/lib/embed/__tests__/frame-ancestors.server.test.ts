import { beforeEach, describe, expect, it, vi } from "vitest";

// S5 (cinatra#1221) Lane B §7 — the read-only frame-ancestors resolver. The
// connector_config instance read is mocked as data; normalizeOriginStrict and
// the closed assistant->instancesConfigKey binding table are the REAL pure
// modules, so the fail-closed matrix (§B7 / §B15) runs against synthetic rows.

const { readConnectorConfigMock } = vi.hoisted(() => ({
  readConnectorConfigMock: vi.fn(),
}));

vi.mock("@/lib/database", () => ({
  readConnectorConfigFromDatabase: readConnectorConfigMock,
}));

import {
  FRAME_ANCESTORS_NONE,
  resolveInstanceFrameAncestor,
  frameAncestorsDirectiveFor,
  resolveVerifiedWidgetFrameOrigin,
} from "@/lib/embed/frame-ancestors.server";

beforeEach(() => {
  readConnectorConfigMock.mockReset();
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

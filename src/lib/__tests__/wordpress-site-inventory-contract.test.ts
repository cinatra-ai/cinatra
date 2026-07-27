import { describe, expect, it } from "vitest";
import {
  SITE_INVENTORY_MAX_SERVERS,
  SUPPORTED_SITE_INVENTORY_VERSIONS,
  wpSiteInventoryV1Schema,
  type WpSiteInventoryV1,
} from "@/lib/wordpress-site-inventory-contract";
import goldenFixture from "./__fixtures__/wp-site-inventory-v1.json";

// cinatra#2018 S3 — the wp-site-inventory contract v1. The golden fixture is
// the S6 coupling artifact: the site-side producer must reproduce its shape,
// and this suite proves the fixture ⇄ schema round-trip stays intact.

function fixture(): WpSiteInventoryV1 {
  return wpSiteInventoryV1Schema.parse(structuredClone(goldenFixture));
}

function rawFixture(): Record<string, unknown> {
  return structuredClone(goldenFixture) as Record<string, unknown>;
}

describe("wp-site-inventory v1 — golden fixture round-trip", () => {
  it("the golden fixture parses and survives a re-parse of its own output", () => {
    const parsed = fixture();
    expect(parsed.contractVersion).toBe("v1");
    expect(SUPPORTED_SITE_INVENTORY_VERSIONS).toContain(parsed.contractVersion);
    expect(parsed.servers).toHaveLength(4);
    // Round-trip: the parsed output is itself a valid payload (no stripping
    // surprises between producer and consumer).
    expect(wpSiteInventoryV1Schema.parse(parsed)).toEqual(parsed);
  });

  it("the fixture carries the acceptance matrix: default + eligible + custom-transport + custom-auth", () => {
    const parsed = fixture();
    const byId = new Map(parsed.servers.map((s) => [s.adapterServerId, s]));
    expect(byId.get("mcp-adapter-default-server")?.isDefault).toBe(true);
    const vendor = byId.get("fixture-vendor-server")!;
    expect(vendor.transports).toEqual(["streamable-http"]);
    expect(vendor.requiresDedicatedAuth).toBe(false);
    expect(byId.get("fixture-stdio-only-server")?.transports).toEqual(["stdio"]);
    expect(byId.get("fixture-dedicated-auth-server")?.requiresDedicatedAuth).toBe(true);
  });
});

describe("wp-site-inventory v1 — version + shape rejection", () => {
  it("rejects an unknown contract version", () => {
    const raw = rawFixture();
    raw.contractVersion = "v2";
    expect(wpSiteInventoryV1Schema.safeParse(raw).success).toBe(false);
  });

  it("rejects a restPath that does not canonically equal /namespace/route", () => {
    const raw = rawFixture();
    (raw.servers as Array<Record<string, unknown>>)[1]!.restPath = "/mcp/other-path";
    expect(wpSiteInventoryV1Schema.safeParse(raw).success).toBe(false);
  });

  it("rejects servers when adapterVersion is null (adapter absent ⇒ empty enumeration)", () => {
    const raw = rawFixture();
    (raw.site as Record<string, unknown>).adapterVersion = null;
    expect(wpSiteInventoryV1Schema.safeParse(raw).success).toBe(false);

    (raw.servers as unknown[]).length = 0;
    const ok = wpSiteInventoryV1Schema.safeParse(raw);
    expect(ok.success).toBe(true);
  });

  it("rejects duplicate adapterServerId entries (registry ids are unique per payload)", () => {
    const raw = rawFixture();
    const servers = raw.servers as Array<Record<string, unknown>>;
    servers.push(structuredClone(servers[1]!));
    expect(wpSiteInventoryV1Schema.safeParse(raw).success).toBe(false);
  });

  it("rejects isDefault on a non-default route (reserved for the adapter default server)", () => {
    const raw = rawFixture();
    (raw.servers as Array<Record<string, unknown>>)[1]!.isDefault = true;
    expect(wpSiteInventoryV1Schema.safeParse(raw).success).toBe(false);
  });

  it("rejects an out-of-vocabulary transport and an empty transport list", () => {
    const raw = rawFixture();
    const servers = raw.servers as Array<Record<string, unknown>>;
    servers[1]!.transports = ["websocket"];
    expect(wpSiteInventoryV1Schema.safeParse(raw).success).toBe(false);
    servers[1]!.transports = [];
    expect(wpSiteInventoryV1Schema.safeParse(raw).success).toBe(false);
    // The literal "unknown" IS vocabulary (the producer's unmappable bucket).
    servers[1]!.transports = ["unknown"];
    expect(wpSiteInventoryV1Schema.safeParse(raw).success).toBe(true);
  });

  it("caps the server list", () => {
    const raw = rawFixture();
    (raw.site as Record<string, unknown>).adapterVersion = "0.5.0";
    const template = (raw.servers as Array<Record<string, unknown>>)[1]!;
    raw.servers = Array.from({ length: SITE_INVENTORY_MAX_SERVERS + 1 }, (_, i) => ({
      ...structuredClone(template),
      adapterServerId: `srv-${i}`,
      namespace: "mcp",
      route: `srv-${i}`,
      restPath: `/mcp/srv-${i}`,
      isDefault: false,
    }));
    expect(wpSiteInventoryV1Schema.safeParse(raw).success).toBe(false);
  });
});

describe("wp-site-inventory v1 — inventorySeq bounds (JS-safe integer)", () => {
  const withSeq = (seq: unknown) => {
    const raw = rawFixture();
    raw.inventorySeq = seq;
    return wpSiteInventoryV1Schema.safeParse(raw).success;
  };

  it("accepts 0 and 2^53−1; rejects 2^53, negatives and non-integers", () => {
    expect(withSeq(0)).toBe(true);
    expect(withSeq(Number.MAX_SAFE_INTEGER)).toBe(true); // 2^53−1
    expect(withSeq(2 ** 53)).toBe(false);
    expect(withSeq(-1)).toBe(false);
    expect(withSeq(1.5)).toBe(false);
    expect(withSeq("42")).toBe(false);
  });
});

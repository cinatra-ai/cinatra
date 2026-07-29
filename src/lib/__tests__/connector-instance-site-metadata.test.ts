import { describe, expect, it, vi } from "vitest";
import {
  resolveConnectedSiteMetadata,
  type ConnectedSiteMetadata,
} from "@/lib/connector-instance-site-metadata";
import type { ServerStoreDeps, ServerStoreQuery } from "@/lib/connector-instance-server-store";
import goldenFixture from "./__fixtures__/wp-site-inventory-v1.json";

// cinatra#2021 S6 (design D8, PR α) — the tri-state read of the dormant
// `site_meta` column. `readSiteInventory` (connector-instance-server-store.ts)
// already has its own store-level coverage; this suite pins THIS module's own
// logic: no row -> unknown/no_inventory, a row whose `site_meta` fails the
// lenient re-parse -> unknown/unparseable, a well-formed row -> known + every
// field (never a plain nullable a caller could `??`-collapse into silence —
// see the module doc comment / design D8).

const TS = "2026-07-27T12:00:00.000Z";

// Mirrors the module-private `InventoryRow` shape in
// connector-instance-server-store.ts (same fields readSiteInventory's SELECT
// returns) — not exported, so re-declared structurally here, same as the
// store's own test suite does.
type InventoryRow = {
  connector_key: string;
  instance_id: string;
  contract_version: string;
  site_id: string;
  origin: string;
  credential_version: number;
  inventory_seq: number;
  site_meta: unknown;
  received_at: string;
};

function rowFor(siteMeta: unknown): InventoryRow {
  return {
    connector_key: "wordpress",
    instance_id: "instance-1",
    contract_version: "v1",
    site_id: "site-1",
    origin: "https://example.test",
    credential_version: 1,
    inventory_seq: 42,
    site_meta: siteMeta,
    received_at: TS,
  };
}

/** A typed `query` spy returning a single fixed row set for ANY SELECT (the
 * only statement `readSiteInventory` issues) — mirrors the injection seam
 * `connector-instance-server-store.test.ts` itself exercises against a real
 * SQL string, just without re-modeling the whole store's write paths (out of
 * scope here: this suite is testing the READ member's dispatch/parse logic,
 * not the store, which already has its own full suite). */
function makeDeps(row: InventoryRow | null) {
  const query = vi.fn<(text: string, values?: readonly unknown[]) => Promise<InventoryRow[]>>(
    async (_text, _values) => (row ? [row] : []),
  );
  const deps: ServerStoreDeps = { query: query as unknown as ServerStoreQuery };
  return { deps, query };
}

function expectKnown(result: ConnectedSiteMetadata): asserts result is Extract<
  ConnectedSiteMetadata,
  { status: "known" }
> {
  expect(result.status).toBe("known");
}

describe("resolveConnectedSiteMetadata — tri-state read of site_meta (design D8)", () => {
  it("no inventory row ever accepted for the instance -> unknown/no_inventory", async () => {
    const { deps, query } = makeDeps(null);
    const result = await resolveConnectedSiteMetadata("wordpress", "instance-1", deps);
    expect(result).toEqual({ status: "unknown", reason: "no_inventory" });
    expect(query).toHaveBeenCalledTimes(1);
    // connectorKey/instanceId flow straight through to the store read.
    expect(query.mock.calls[0]?.[1]).toEqual(["wordpress", "instance-1"]);
  });

  it("a row exists but site_meta is missing a required field -> unknown/unparseable", async () => {
    const { deps } = makeDeps(
      rowFor({
        wpVersion: "6.9.1",
        phpVersion: "8.3.2",
        adapterVersion: "0.5.0",
        // connectedUserRole omitted entirely — a required field.
        permalinkStructure: "pretty",
      }),
    );
    const result = await resolveConnectedSiteMetadata("wordpress", "instance-1", deps);
    expect(result).toEqual({ status: "unknown", reason: "unparseable" });
  });

  it("a row exists but site_meta is a wrong-shaped value entirely -> unknown/unparseable", async () => {
    const { deps } = makeDeps(rowFor("not-an-object"));
    const result = await resolveConnectedSiteMetadata("wordpress", "instance-1", deps);
    expect(result).toEqual({ status: "unknown", reason: "unparseable" });
  });

  it("a row exists but site_meta is null (e.g. tryAdvanceSiteInventory's own null default) -> unknown/unparseable", async () => {
    const { deps } = makeDeps(rowFor(null));
    const result = await resolveConnectedSiteMetadata("wordpress", "instance-1", deps);
    expect(result).toEqual({ status: "unknown", reason: "unparseable" });
  });

  it("a well-formed site_meta (the golden fixture's own site block) -> known, every field mapped, receivedAt from the row", async () => {
    const site = (goldenFixture as { site: Record<string, unknown> }).site;
    const { deps } = makeDeps(rowFor(site));
    const result = await resolveConnectedSiteMetadata("wordpress", "instance-1", deps);
    expectKnown(result);
    expect(result.wpVersion).toBe("6.9.1");
    expect(result.phpVersion).toBe("8.3.2");
    expect(result.adapterVersion).toBe("0.5.0");
    expect(result.abilitiesPluginVersion).toBe("1.0.0");
    expect(result.connectedUserRole).toBe("editor");
    expect(result.permalinkStructure).toBe("pretty");
    expect(result.receivedAt).toBe(TS);
  });

  it("known, but abilitiesPluginVersion omitted (optional) and adapterVersion explicitly null both normalize to null, never undefined", async () => {
    const { deps } = makeDeps(
      rowFor({
        wpVersion: "6.9.1",
        phpVersion: "8.3.2",
        adapterVersion: null,
        // abilitiesPluginVersion omitted (schema: nullable().optional()).
        connectedUserRole: "administrator",
        permalinkStructure: "plain",
      }),
    );
    const result = await resolveConnectedSiteMetadata("wordpress", "instance-1", deps);
    expectKnown(result);
    expect(result.adapterVersion).toBeNull();
    expect(result.abilitiesPluginVersion).toBeNull();
    expect(result.connectedUserRole).toBe("administrator");
  });

  it("tolerates an EXTRA/unknown field in site_meta (lenient re-parse, not the producer's strict schema)", async () => {
    const site = (goldenFixture as { site: Record<string, unknown> }).site;
    const { deps } = makeDeps(rowFor({ ...site, aFutureAdditiveField: "unseen-by-this-reader" }));
    const result = await resolveConnectedSiteMetadata("wordpress", "instance-1", deps);
    expectKnown(result);
    expect(result.connectedUserRole).toBe("editor");
  });
});

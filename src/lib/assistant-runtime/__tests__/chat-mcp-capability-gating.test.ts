/**
 * The chat self-MCP connection filter, over the REAL connector catalog
 * (cinatra#2771).
 *
 * THE DEFECT THIS PINS. The derivation used to match primitive names against
 * connector KEYS — slugs like `gmail-connector` — while every primitive is
 * underscore-named (`gmail_aliases_list`). No admitted name could ever match,
 * so no name got a capability key, so the connection gate in
 * `resolveChatMcpAllowedTools` never fired and every actor was offered the
 * whole list regardless of what they had connected. A test that builds its own
 * fixture catalog cannot see that: the bug lives in the relationship between
 * the REAL catalog's slugs and the REAL policy's primitive names. So this file
 * imports both — `listConnectorDescriptors()` and
 * `delegatedChatAllowedToolNames()` — and copies neither.
 */
import { describe, expect, it } from "vitest";

import { listConnectorDescriptors } from "@cinatra-ai/connectors-catalog/descriptors.mjs";
import {
  delegatedChatAllowedToolNames,
  resolveDelegatedChatClass,
} from "@cinatra-ai/mcp-server/delegated-chat-tool-policy";
import {
  resolveChatMcpAllowedTools,
  type ServableChatPrimitive,
} from "@cinatra-ai/llm/mcp-access";

import { buildCapabilityKeyResolver } from "@/lib/assistant-runtime/chat-mcp-capability-key";
import {
  buildConnectorInventory,
  type ConnectorInventoryDeps,
} from "@/lib/connector-inventory.server";

/** The REAL catalog, shaped exactly as the production `listCatalog` seam does. */
const REAL_CATALOG = listConnectorDescriptors().map((d) => ({
  packageId: d.packageId,
  connectorKey: d.slug,
  displayName: d.displayName,
  mcpPrimitivePrefixes: d.mcpPrimitivePrefixes,
}));

const ORG_ID = "org-1";
const ACTOR = {
  principalType: "HumanUser",
  principalId: "user-actor",
  organizationId: ORG_ID,
  orgRole: "member",
} as unknown as Parameters<ConnectorInventoryDeps["decideUse"]>[0]["actor"];

/**
 * Build the inventory over the REAL catalog with `authorizedPackageIds` the
 * only variable. Connection rows are synthesized because a unit test has no
 * database — but the CATALOG, the primitive names, the projector and the
 * resolver are all the production ones, which is where the defect lived.
 */
async function realInventory(authorizedPackageIds: readonly string[]) {
  const rows = authorizedPackageIds.map((packageId, i) => ({
    id: `conn-${i}`,
    organizationId: ORG_ID,
    connectorPackageId: packageId,
    connectorKey: packageId,
    connectionId: `nango-${i}`,
    ownerUserId: "user-actor",
    createdAt: new Date(0),
    deletedAt: null,
  })) as unknown as Awaited<ReturnType<ConnectorInventoryDeps["listConnectionRows"]>>;

  return buildConnectorInventory({
    resolveActor: async () => ({
      actor: ACTOR ?? null,
      subjectUserId: "user-actor",
      organizationId: ORG_ID,
    }),
    listCatalog: async () => REAL_CATALOG,
    listConnectionRows: async () => rows,
    decideUse: async () => ({ allowed: true }),
  });
}

/** The production seeding path, verbatim: real names, real classes, real derivation. */
function allowedToolsFor(inventory: Awaited<ReturnType<typeof realInventory>>) {
  const authorizedKeys = new Set(
    inventory.connectors.filter((r) => r.hasAuthorizedConnection).map((r) => r.connectorKey),
  );
  const capabilityKeyFor = buildCapabilityKeyResolver(inventory.connectors);
  const servable: ServableChatPrimitive[] = delegatedChatAllowedToolNames().map((name) => ({
    name,
    declaredClass: resolveDelegatedChatClass(name, undefined),
    capabilityKey: capabilityKeyFor(name),
  }));
  return resolveChatMcpAllowedTools({
    servable,
    isHostApproved: () => true,
    isCapabilityAvailable: (key) => authorizedKeys.has(key),
  });
}

const GMAIL_PACKAGE_ID = "@cinatra-ai/gmail-connector";
const GMAIL_PRIMITIVE = "gmail_aliases_list";

describe("chat self-MCP capability keys — derived from the REAL catalog", () => {
  it("the catalog premise holds: a slug-named connector owns underscore-named primitives", () => {
    // If this ever fails the fixture-free test below is testing nothing, so it
    // is asserted rather than assumed.
    const gmail = REAL_CATALOG.find((c) => c.packageId === GMAIL_PACKAGE_ID);
    expect(gmail, "the real catalog still ships a gmail connector").toBeDefined();
    expect(gmail!.connectorKey).toBe("gmail-connector");
    expect(gmail!.mcpPrimitivePrefixes).toContain("gmail_");
    expect(delegatedChatAllowedToolNames()).toContain(GMAIL_PRIMITIVE);
    // The exact shape of the old defect: the primitive is NOT prefixed with
    // the connector key, so a key-based match could never admit it.
    expect(GMAIL_PRIMITIVE.startsWith(`${gmail!.connectorKey}_`)).toBe(false);
  });

  it("maps a real primitive onto its real connector key", async () => {
    const inventory = await realInventory([]);
    const capabilityKeyFor = buildCapabilityKeyResolver(inventory.connectors);
    expect(capabilityKeyFor(GMAIL_PRIMITIVE)).toBe("gmail-connector");
  });

  it("leaves a host/platform primitive ungated", async () => {
    const inventory = await realInventory([]);
    const capabilityKeyFor = buildCapabilityKeyResolver(inventory.connectors);
    // Platform inventory is a HOST capability — no connector's prefix claims
    // it, so it must never be connection-gated.
    expect(capabilityKeyFor("connector_inventory_list")).toBeNull();
  });
});

describe("chat self-MCP connection filter — withholding, over the REAL catalog", () => {
  it("WITHHOLDS a connector's primitive when the actor has no authorized connection", async () => {
    const allowed = allowedToolsFor(await realInventory([]));
    expect(allowed).not.toContain(GMAIL_PRIMITIVE);
    // ...and the turn is not emptied: ungated host primitives survive, which
    // is what makes this a filter rather than a fail-closed blackout.
    expect(allowed).toContain("connector_inventory_list");
    expect(allowed.length).toBeGreaterThan(0);
  });

  it("ADMITS that same primitive once the connector has an authorized connection", async () => {
    const allowed = allowedToolsFor(await realInventory([GMAIL_PACKAGE_ID]));
    expect(allowed).toContain(GMAIL_PRIMITIVE);
  });

  it("an authorized connection admits ONLY its own connector's primitives", async () => {
    const allowed = allowedToolsFor(await realInventory([GMAIL_PACKAGE_ID]));
    const capabilityKeyFor = buildCapabilityKeyResolver(
      (await realInventory([])).connectors,
    );
    const foreignGated = delegatedChatAllowedToolNames().filter((name) => {
      const key = capabilityKeyFor(name);
      return key != null && key !== "gmail-connector";
    });
    expect(foreignGated.length, "the catalog gates some non-gmail primitive").toBeGreaterThan(0);
    for (const name of foreignGated) expect(allowed).not.toContain(name);
  });

  it("every catalog-gated primitive is withheld when nothing is connected", async () => {
    const inventory = await realInventory([]);
    const capabilityKeyFor = buildCapabilityKeyResolver(inventory.connectors);
    const gated = delegatedChatAllowedToolNames().filter((n) => capabilityKeyFor(n) != null);
    // The regression that shipped: this list was EMPTY, so "all withheld" held
    // vacuously while the filter did nothing.
    expect(gated.length, "the real catalog gates at least one allowlisted name").toBeGreaterThan(0);
    const allowed = allowedToolsFor(inventory);
    for (const name of gated) expect(allowed).not.toContain(name);
  });
});

describe("capability-key derivation — longest prefix wins", () => {
  // Nesting is a property the resolver must hold whatever the catalog happens
  // to declare today, so it is asserted directly rather than waiting for a
  // catalog entry to introduce it.
  const NESTED = [
    { connectorKey: "google-connector", mcpPrimitivePrefixes: ["google_"] },
    { connectorKey: "google-calendar-connector", mcpPrimitivePrefixes: ["google_calendar_"] },
  ];

  it("the most specific prefix decides, whatever the catalog order", () => {
    for (const catalog of [NESTED, [...NESTED].reverse()]) {
      const resolve = buildCapabilityKeyResolver(catalog);
      expect(resolve("google_calendar_events_list")).toBe("google-calendar-connector");
      expect(resolve("google_contacts_list")).toBe("google-connector");
    }
  });

  it("a connector declaring several prefixes gates every one of them", () => {
    const resolve = buildCapabilityKeyResolver([
      { connectorKey: "twenty-crm-connector", mcpPrimitivePrefixes: ["crm_", "twenty_"] },
    ]);
    expect(resolve("crm_people_list")).toBe("twenty-crm-connector");
    expect(resolve("twenty_objects_list")).toBe("twenty-crm-connector");
    expect(resolve("gmail_aliases_list")).toBeNull();
  });

  it("a connector that declares no prefixes gates nothing", () => {
    const resolve = buildCapabilityKeyResolver([
      { connectorKey: "a2a-connector", mcpPrimitivePrefixes: [] },
      { connectorKey: "broken-connector" },
    ]);
    expect(resolve("a2a_send")).toBeNull();
  });

  it("an empty-string prefix cannot capture the whole namespace", () => {
    const resolve = buildCapabilityKeyResolver([
      { connectorKey: "greedy-connector", mcpPrimitivePrefixes: [""] },
      { connectorKey: "gmail-connector", mcpPrimitivePrefixes: ["gmail_"] },
    ]);
    expect(resolve("projects_list")).toBeNull();
    expect(resolve("gmail_aliases_list")).toBe("gmail-connector");
  });
});

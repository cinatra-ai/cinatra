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
 * `coreDelegatedChatAdmittedNames()` — and copies neither.
 */
import { describe, expect, it } from "vitest";

import { listConnectorDescriptors } from "@cinatra-ai/connectors-catalog/descriptors.mjs";
import { coreDelegatedChatAdmittedNames } from "@cinatra-ai/mcp-server/core-delegated-chat-surface";
import { hostDeclaredDelegatedChatClass } from "@cinatra-ai/mcp-server/capability-plan";
import {
  resolveChatMcpAllowedTools,
  type ServableChatPrimitive,
} from "@cinatra-ai/llm/mcp-access";

import {
  buildCapabilityKeyResolver,
  buildConnectorInventory,
  type ConnectorInventoryDeps,
} from "@/lib/connector-inventory.server";

/** The REAL catalog, shaped exactly as the production `listCatalog` seam does. */
const REAL_CATALOG = listConnectorDescriptors().map((d) => ({
  packageId: d.packageId,
  connectorKey: d.slug,
  displayName: d.displayName,
  mcpPrimitivePrefixes: d.mcpPrimitivePrefixes,
  consumesConnectionFrom: d.consumesConnectionFrom,
}));

const ORG_ID = "org-1";
const ACTOR = {
  principalType: "HumanUser",
  principalId: "user-actor",
  organizationId: ORG_ID,
  orgRole: "member",
} as unknown as Parameters<ConnectorInventoryDeps["decideUse"]>[0]["actor"];

/**
 * Build the inventory over the REAL catalog with the CONNECTION ROWS and the
 * `use` decision over them the only variables. Connection rows are synthesized because a unit test has no
 * database — but the CATALOG, the primitive names, the projector and the
 * resolver are all the production ones, which is where the defect lived.
 */
async function realInventory(
  authorizedPackageIds: readonly string[],
  decideUse: ConnectorInventoryDeps["decideUse"] = async () => ({ allowed: true }),
) {
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
    decideUse,
  });
}

/**
 * The production seeding path, verbatim: real names, real classes, real
 * derivation.
 *
 * `extraServable` stands in for a primitive registered by a CONNECTOR's own
 * module rather than declared on the core surface (`appointment_schedule_list`
 * is one). Its capability key is still derived from the REAL catalog — only
 * the registration is synthesized, because a unit test registers no extension.
 */
function allowedToolsFor(
  inventory: Awaited<ReturnType<typeof realInventory>>,
  extraServable: readonly { name: string; declaredClass: string }[] = [],
) {
  const authorizedKeys = new Set(
    inventory.connectors.filter((r) => r.hasAuthorizedConnection).map((r) => r.connectorKey),
  );
  const capabilityKeyFor = buildCapabilityKeyResolver(inventory.connectors);
  const servable: ServableChatPrimitive[] = [
    ...coreDelegatedChatAdmittedNames().map((name) => ({
      name,
      declaredClass: hostDeclaredDelegatedChatClass(name),
      capabilityKey: capabilityKeyFor(name),
    })),
    ...extraServable.map((entry) => ({
      name: entry.name,
      declaredClass: entry.declaredClass,
      capabilityKey: capabilityKeyFor(entry.name),
    })),
  ];
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
    expect(coreDelegatedChatAdmittedNames()).toContain(GMAIL_PRIMITIVE);
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
    const foreignGated = coreDelegatedChatAdmittedNames().filter((name) => {
      const key = capabilityKeyFor(name);
      return key != null && key !== "gmail-connector";
    });
    expect(foreignGated.length, "the catalog gates some non-gmail primitive").toBeGreaterThan(0);
    for (const name of foreignGated) expect(allowed).not.toContain(name);
  });

  it("every catalog-gated primitive is withheld when nothing is connected", async () => {
    const inventory = await realInventory([]);
    const capabilityKeyFor = buildCapabilityKeyResolver(inventory.connectors);
    const gated = coreDelegatedChatAdmittedNames().filter((n) => capabilityKeyFor(n) != null);
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

// ---------------------------------------------------------------------------
// A CONNECTOR THAT HOLDS NO CONNECTION OF ITS OWN (cinatra#3108), over the REAL
// catalog.
//
// THE DEFECT THIS PINS. The appointment-schedules connector borrows the
// calendar connector's Google connection and never writes a connection row of
// its own, so keyed on its own package id it was unconnected for every person,
// forever: step 3 of the turn's allow-list dropped every
// `appointment_schedule_*` name before the list reached the provider, and the
// inventory answered "not connected" for a connector with no connect road at
// all. A fixture catalog cannot see that — the defect lives in the relationship
// between the REAL catalog's declaration and the REAL connection rows — so this
// block reads the real catalog and copies none of it.
// ---------------------------------------------------------------------------

const CALENDAR_PACKAGE_ID = "@cinatra-ai/google-calendar-connector";
const SCHEDULES_KEY = "google-appointment-schedules-connector";
const SCHEDULES_PRIMITIVE = "appointment_schedule_list";
const SCHEDULES_SERVABLE = [{ name: SCHEDULES_PRIMITIVE, declaredClass: "read" }];

describe("a connector that consumes another connector's connection — REAL catalog", () => {
  it("the catalog premise holds: it declares the connection it consumes", () => {
    const entry = REAL_CATALOG.find((c) => c.connectorKey === SCHEDULES_KEY);
    expect(entry, "the real catalog still ships the appointment-schedules connector").toBeDefined();
    expect(entry!.mcpPrimitivePrefixes).toContain("appointment_schedule_");
    expect(entry!.consumesConnectionFrom).toBe("google-calendar-connector");
    // The declaration names a connector the catalog actually has, or the
    // reading below would fail closed for the wrong reason.
    expect(REAL_CATALOG.map((c) => c.connectorKey)).toContain(entry!.consumesConnectionFrom);
  });

  it("KEEPS its primitives in the turn once the CONSUMED connection is authorized", async () => {
    const allowed = allowedToolsFor(await realInventory([CALENDAR_PACKAGE_ID]), SCHEDULES_SERVABLE);
    expect(allowed).toContain(SCHEDULES_PRIMITIVE);
  });

  it("WITHHOLDS them while the consumed connection is not authorized", async () => {
    const allowed = allowedToolsFor(await realInventory([]), SCHEDULES_SERVABLE);
    expect(allowed).not.toContain(SCHEDULES_PRIMITIVE);
  });

  it("another connector's authorized connection does not admit them", async () => {
    const allowed = allowedToolsFor(await realInventory([GMAIL_PACKAGE_ID]), SCHEDULES_SERVABLE);
    expect(allowed).not.toContain(SCHEDULES_PRIMITIVE);
  });

  it("the inventory row an assistant reads says the same thing, both ways", async () => {
    const rowWhen = async (authorized: readonly string[]) =>
      (await realInventory(authorized)).connectors.find((c) => c.connectorKey === SCHEDULES_KEY);
    expect(await rowWhen([CALENDAR_PACKAGE_ID])).toMatchObject({
      hasAuthorizedConnection: true,
      consumesConnectionFrom: "google-calendar-connector",
    });
    expect(await rowWhen([])).toMatchObject({
      hasAuthorizedConnection: false,
      consumesConnectionFrom: "google-calendar-connector",
    });
  });

  it("the CONSUMED connection passes the same `use` gate — a denied row admits nothing", async () => {
    // The safety claim of the declaration road, over the real catalog: it moves
    // the QUESTION, never the answer. The calendar connection row exists here
    // and the actor may not use it, so the borrowed primitives are withheld
    // exactly as they are with nothing connected at all — the declaration
    // cannot route around the per-row gate.
    const denied = await realInventory([CALENDAR_PACKAGE_ID], async () => ({ allowed: false }));
    expect(allowedToolsFor(denied, SCHEDULES_SERVABLE)).not.toContain(SCHEDULES_PRIMITIVE);
    expect(denied.connectors.find((c) => c.connectorKey === SCHEDULES_KEY)).toMatchObject({
      hasAuthorizedConnection: false,
      consumesConnectionFrom: "google-calendar-connector",
    });
  });

  it("a connector that owns its connection is untouched by the declaration road", async () => {
    const gmail = (await realInventory([GMAIL_PACKAGE_ID])).connectors.find(
      (c) => c.connectorKey === "gmail-connector",
    );
    expect(gmail).toMatchObject({ hasAuthorizedConnection: true, consumesConnectionFrom: null });
    const gmailUnconnected = (await realInventory([])).connectors.find(
      (c) => c.connectorKey === "gmail-connector",
    );
    expect(gmailUnconnected).toMatchObject({ hasAuthorizedConnection: false });
  });
});

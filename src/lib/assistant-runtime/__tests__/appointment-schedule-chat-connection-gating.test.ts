/**
 * `appointment_schedule_add` on the CHAT surface, over the REAL connector
 * catalog and the REAL admission records (cinatra#2368 acceptance item 3).
 *
 * WHAT THIS PINS, AND WHY IT IS NOT COVERED BY THE REGISTRATION SUITES.
 * Reaching the assistant takes THREE independent steps. Two already have
 * owners, and THIS FILE IS NOT ONE OF THEM: the primitive must be REGISTERED
 * on the pass the chat catalog derives from (owned by
 * `src/lib/__tests__/appointment-schedule-chat-registration.test.ts`, which
 * reads the generated authz inventory and the real `registerTool` sites), and
 * it must be DECLARED so the evaluator admits it (owned by
 * `src/lib/__tests__/appointment-schedule-chat-reachability.test.ts`). The
 * third step — the only one proved here — is that it must survive the chat
 * surface's connection-availability filter. That third step is not a property of the
 * registration: the filter reads the primitive's capability key off the LIVE
 * catalog's `mcpPrimitivePrefixes`, so a HOST-owned bridge whose name happens
 * to fall under a connector's declared prefix is gated on THAT connector.
 *
 * `appointment_schedule_add` is exactly such a bridge. The name sits under the
 * appointment-schedules connector's `appointment_schedule_` prefix, and that
 * connector owns no connection of its own — it declares
 * `consumesConnectionFrom: "google-calendar-connector"` (cinatra#3108), so the
 * Google CALENDAR connection is what decides whether the assistant is offered
 * the tool at all.
 *
 * A live acceptance run against an instance with no Google connection was
 * therefore answered — correctly — with "the appointment schedule tool isn't
 * available in this chat session". These cases fix that as the DESIGNED
 * behaviour on both sides, so a future change cannot quietly turn a missing
 * connection into a silently ungated tool, nor a live connection into a tool
 * the assistant still cannot see.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

const APPOINTMENT_PRIMITIVE = "appointment_schedule_add";
const APPOINTMENT_SLUG = "google-appointment-schedules-connector";
const CALENDAR_SLUG = "google-calendar-connector";
const CALENDAR_PACKAGE_ID = "@cinatra-ai/google-calendar-connector";

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

function allowedToolsFor(inventory: Awaited<ReturnType<typeof realInventory>>) {
  const authorizedKeys = new Set(
    inventory.connectors.filter((r) => r.hasAuthorizedConnection).map((r) => r.connectorKey),
  );
  const capabilityKeyFor = buildCapabilityKeyResolver(inventory.connectors);
  const servable: ServableChatPrimitive[] = coreDelegatedChatAdmittedNames().map((name) => ({
    name,
    declaredClass: hostDeclaredDelegatedChatClass(name),
    capabilityKey: capabilityKeyFor(name),
  }));
  return resolveChatMcpAllowedTools({
    servable,
    isHostApproved: () => true,
    isCapabilityAvailable: (key) => authorizedKeys.has(key),
  });
}

describe("appointment_schedule_add — the chat surface's connection gate", () => {
  it("is declared and admitted — the precondition the gate cases below stand on", () => {
    // DELIBERATELY NOT A REGISTRATION CHECK, despite reading like one.
    // `coreDelegatedChatAdmittedNames()` projects the host DECLARATION table
    // back through the real admission evaluator; its own module header says
    // production never calls it. It never inspects a live `registerTool` site,
    // so this case would stay green with the registration deleted. Registration
    // is owned by `appointment-schedule-chat-registration.test.ts`; this case
    // exists only so the gate cases below fail loudly on their premise rather
    // than passing over a name that was never admitted in the first place.
    expect(coreDelegatedChatAdmittedNames()).toContain(APPOINTMENT_PRIMITIVE);
    expect(hostDeclaredDelegatedChatClass(APPOINTMENT_PRIMITIVE)).toBe("dispatch");
  });

  it("the catalog premise holds: the name falls under the appointment connector's prefix, and that connector consumes the calendar connection", () => {
    const appointment = REAL_CATALOG.find((c) => c.connectorKey === APPOINTMENT_SLUG);
    expect(appointment, "the real catalog still ships the appointment connector").toBeDefined();
    expect(appointment!.mcpPrimitivePrefixes).toContain("appointment_schedule_");
    expect(APPOINTMENT_PRIMITIVE.startsWith("appointment_schedule_")).toBe(true);
    expect(appointment!.consumesConnectionFrom).toBe(CALENDAR_SLUG);
  });

  it("resolves onto the appointment connector's capability key, not the host's ungated null", async () => {
    const capabilityKeyFor = buildCapabilityKeyResolver((await realInventory([])).connectors);
    expect(capabilityKeyFor(APPOINTMENT_PRIMITIVE)).toBe(APPOINTMENT_SLUG);
  });

  it("WITHHOLDS the tool from an actor with no Google Calendar connection", async () => {
    const allowed = allowedToolsFor(await realInventory([]));
    expect(allowed).not.toContain(APPOINTMENT_PRIMITIVE);
    // Not a blackout: ungated host primitives still reach the turn.
    expect(allowed).toContain("connector_inventory_list");
  });

  it("ADMITS the tool once the CALENDAR connector holds an authorized connection", async () => {
    const inventory = await realInventory([CALENDAR_PACKAGE_ID]);
    const appointmentRow = inventory.connectors.find((r) => r.connectorKey === APPOINTMENT_SLUG);
    expect(appointmentRow, "the appointment connector still has an inventory row").toBeDefined();
    // It owns no connection of its own; the consumed declaration is what makes
    // it available — the acceptance item's precondition, stated as a fact.
    expect(appointmentRow!.authorizedConnectionIds).toEqual([]);
    expect(appointmentRow!.hasAuthorizedConnection).toBe(true);
    expect(allowedToolsFor(inventory)).toContain(APPOINTMENT_PRIMITIVE);
  });

  it("the production catalog-state seam still derives availability the way this harness mirrors it", () => {
    // `allowedToolsFor` above MIRRORS `resolveChatMcpCatalogState`, which is
    // module-private in runtime.ts and reachable only with the whole connector
    // /module/database graph behind it — so the cases above inject the seam
    // rather than call it. A mirror can drift, and the drift is invisible:
    // were production to key availability off `authorizedConnectionIds`
    // instead of `hasAuthorizedConnection`, the appointment connector (which
    // owns NO connection of its own and is available only through
    // `consumesConnectionFrom`) would be gated off forever while every case
    // above stayed green. This reads the production derivation itself so that
    // change cannot land silently.
    const runtime = readFileSync(
      resolve(__dirname, "..", "..", "..", "..", "src/lib/assistant-runtime/runtime.ts"),
      "utf8",
    );
    const seam = runtime.slice(
      runtime.indexOf("async function resolveChatMcpCatalogState("),
      runtime.indexOf("async function persistTurnSkillDelivery("),
    );
    // Vacuity guard: a renamed or relocated seam must fail loudly here rather
    // than let the assertions below pass over an empty slice.
    expect(seam.length).toBeGreaterThan(500);
    expect(seam).toContain("row.hasAuthorizedConnection");
    expect(seam).toContain("row.connectorKey");
    expect(seam).toContain("isCapabilityAvailable: (key) => authorizedKeys.has(key)");
    // The capability key must still come from the live catalog resolver this
    // file's third case pins, not from a name-keyed shortcut.
    expect(seam).toContain("buildCapabilityKeyResolver(inventory.connectors)");
    expect(seam).not.toContain("authorizedConnectionIds");
  });
});

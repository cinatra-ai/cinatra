/**
 * `connector_inventory_list` — the security contract (cinatra#2723).
 *
 * The primitive is on the injection-hardened delegated-chat allowlist, so its
 * guarantees are asserted here rather than described:
 *
 *   1. the schema takes NO scope or actor inputs;
 *   2. exactly ONE new name is chat-allowlisted, and the adjacent names a
 *      future edit might reach for stay denied;
 *   3. the emitted fields are a fixed allowlist — the snapshot fails on any
 *      added field;
 *   4. no credential, token, secret ref, owner identity, organization id, or
 *      RAW connection identifier ever reaches the output;
 *   5. a connection row the actor holds no `use` grant for NEVER serializes;
 *   6. an unresolvable actor yields nothing (fail closed).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  CONNECTOR_INVENTORY_RESULT_FIELDS,
  CONNECTOR_INVENTORY_ROW_FIELDS,
  buildConnectorInventory,
  projectConnectorInventoryRow,
  type ConnectorInventoryDeps,
} from "@/lib/connector-inventory.server";
import {
  CONNECTOR_INVENTORY_TOOL_NAME,
  connectorInventoryListSchema,
  CONNECTOR_INVENTORY_TOOL_DESCRIPTION,
} from "@/lib/connector-inventory-mcp";
import {
  coreDelegatedChatAdmittedNames,
  isCoreDelegatedChatAdmitted,
} from "@cinatra-ai/mcp-server/core-delegated-chat-surface";

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const DECLARATIONS_PATH = resolve(
  REPO_ROOT,
  "packages/mcp-server/src/host-primitive-declarations.ts",
);

// The RAW material a leak would expose. None of it may appear in the result.
const RAW_CONNECTION_ID = "nango-conn-raw-identifier-do-not-leak";
const FOREIGN_OWNER_USER_ID = "user-foreign-owner";
const ORG_ID = "org-1";

type Identity = Parameters<ConnectorInventoryDeps["decideUse"]>[0]["identity"];

function identity(over: Partial<Identity> & Pick<Identity, "id">): Identity {
  return {
    organizationId: ORG_ID,
    connectorPackageId: "@cinatra-ai/openai-connector",
    connectorKey: "openai",
    connectionId: RAW_CONNECTION_ID,
    ownerUserId: FOREIGN_OWNER_USER_ID,
    createdAt: new Date(0),
    deletedAt: null,
    ...over,
  } as Identity;
}

const CATALOG = [
  {
    packageId: "@cinatra-ai/openai-connector",
    connectorKey: "openai-connector",
    displayName: "OpenAI",
  },
  {
    packageId: "@cinatra-ai/tailscale-connector",
    connectorKey: "tailscale-connector",
    displayName: "Tailscale",
  },
];

const ACTOR = {
  principalType: "HumanUser",
  principalId: "user-actor",
  organizationId: ORG_ID,
  orgRole: "member",
} as unknown as Parameters<ConnectorInventoryDeps["decideUse"]>[0]["actor"];

function deps(over: Partial<ConnectorInventoryDeps> = {}): ConnectorInventoryDeps {
  return {
    resolveActor: async () => ({
      actor: ACTOR ?? null,
      subjectUserId: "user-actor",
      organizationId: ORG_ID,
    }),
    listCatalog: async () => CATALOG,
    listConnectionRows: async () => [],
    decideUse: async () => ({ allowed: true }),
    ...over,
  };
}

describe("connector_inventory_list — schema", () => {
  it("takes NO scope or actor inputs (the schema is empty)", () => {
    expect(Object.keys(connectorInventoryListSchema.shape)).toEqual([]);
  });

  it("rejects a smuggled scope/actor field instead of ignoring it", () => {
    for (const smuggled of [
      { organizationId: ORG_ID },
      { userId: "user-victim" },
      { orgId: ORG_ID },
      { scope: "workspace" },
      { actorUserId: "user-victim" },
      { connectorKey: "openai" },
    ]) {
      expect(connectorInventoryListSchema.safeParse(smuggled).success, JSON.stringify(smuggled)).toBe(
        false,
      );
    }
    expect(connectorInventoryListSchema.safeParse({}).success).toBe(true);
  });
});

describe("connector_inventory_list — delegated-chat allowlist", () => {
  it("is chat-callable", () => {
    expect(isCoreDelegatedChatAdmitted(CONNECTOR_INVENTORY_TOOL_NAME)).toBe(true);
  });

  it("is the ONLY `connector_`-namespaced name the core surface admits", () => {
    // Asked of the DECISION now, not of a source regex: the projection runs
    // every host declaration back through the real evaluator, so a name the
    // evaluator would refuse can never appear here however the declarations are
    // edited (cinatra#2817 slice 3).
    expect(coreDelegatedChatAdmittedNames().filter((n) => n.startsWith("connector_"))).toEqual([
      CONNECTOR_INVENTORY_TOOL_NAME,
    ]);
  });

  it("keeps the adjacent inventory-shaped names denied", () => {
    for (const denied of [
      "connectors_list",
      "connections_list",
      "connector_instances_list",
      "connector_inventory_get",
      "connector_inventory_create",
      "connector_instance_tool_call",
      "nango_connections_list",
    ]) {
      expect(isCoreDelegatedChatAdmitted(denied), denied).toBe(false);
    }
  });

  it("carries its field-allowlist rationale beside its host declaration", () => {
    const body = readFileSync(DECLARATIONS_PATH, "utf8");
    const at = body.indexOf(`${CONNECTOR_INVENTORY_TOOL_NAME}: "`);
    expect(at).toBeGreaterThan(-1);
    const rationale = body.slice(Math.max(0, at - 2200), at);
    expect(rationale).toMatch(/FIELD ALLOWLIST/);
    expect(rationale).toMatch(/PER-ROW AUTHORIZATION/);
    expect(rationale).toMatch(/NO SCOPE OR ACTOR INPUT/);
  });
});

describe("connector_inventory_list — field allowlist (snapshot)", () => {
  it("the row allowlist is exactly these five fields", () => {
    // A literal, not a re-export: adding a field to the projector without
    // adding it here — or here without a reviewer — fails.
    //
    // `mcpPrimitivePrefixes` (cinatra#2771) is build-time CATALOG data: it
    // says which primitive names a connector gates, never who may use it. It
    // is on the row because the row is the one carrier from the catalog to the
    // chat-catalog derivation, which cannot map `gmail_aliases_list` onto the
    // `gmail-connector` slug without it.
    expect([...CONNECTOR_INVENTORY_ROW_FIELDS]).toEqual([
      "connectorKey",
      "displayName",
      "hasAuthorizedConnection",
      "authorizedConnectionIds",
      "mcpPrimitivePrefixes",
    ]);
    expect([...CONNECTOR_INVENTORY_RESULT_FIELDS]).toEqual(["connectors"]);
  });

  it("the projector emits exactly the allowlisted row fields", () => {
    const row = projectConnectorInventoryRow({
      connectorKey: "openai-connector",
      displayName: "OpenAI",
      authorizedConnectionIds: ["conn-1"],
      mcpPrimitivePrefixes: ["openai_"],
    });
    expect(Object.keys(row).sort()).toEqual([...CONNECTOR_INVENTORY_ROW_FIELDS].sort());
  });

  it("a connector with no declared prefixes still emits the field, as empty", () => {
    const row = projectConnectorInventoryRow({
      connectorKey: "tailscale-connector",
      displayName: "Tailscale",
      authorizedConnectionIds: [],
    });
    expect(row.mcpPrimitivePrefixes).toEqual([]);
  });

  it("the emitted prefixes cannot mutate the catalog array behind them", () => {
    const catalogPrefixes = ["gmail_"];
    const row = projectConnectorInventoryRow({
      connectorKey: "gmail-connector",
      displayName: "Gmail",
      authorizedConnectionIds: [],
      mcpPrimitivePrefixes: catalogPrefixes,
    });
    row.mcpPrimitivePrefixes.push("hacked_");
    expect(catalogPrefixes).toEqual(["gmail_"]);
  });

  it("a built result emits exactly the allowlisted keys at both levels", async () => {
    const result = await buildConnectorInventory(
      deps({ listConnectionRows: async () => [identity({ id: "conn-1" })] }),
    );
    expect(Object.keys(result).sort()).toEqual([...CONNECTOR_INVENTORY_RESULT_FIELDS].sort());
    for (const row of result.connectors) {
      expect(Object.keys(row).sort()).toEqual([...CONNECTOR_INVENTORY_ROW_FIELDS].sort());
    }
  });
});

describe("connector_inventory_list — output never carries secrets", () => {
  it("excludes credentials, raw connection identifiers, owner identity and org id", async () => {
    const result = await buildConnectorInventory(
      deps({
        listConnectionRows: async () => [
          identity({ id: "conn-1" }),
          identity({
            id: "conn-2",
            connectorPackageId: "@cinatra-ai/tailscale-connector",
            connectorKey: "tailscale",
          }),
        ],
      }),
    );
    const serialized = JSON.stringify(result);
    for (const secret of [
      RAW_CONNECTION_ID,
      FOREIGN_OWNER_USER_ID,
      ORG_ID,
      "connectionId",
      "ownerUserId",
      "organizationId",
      "connectorPackageId",
      "accessToken",
      "credential",
      "secret",
    ]) {
      expect(serialized, `leaked: ${secret}`).not.toContain(secret);
    }
    // The AUTHORIZED target ids are what it DOES return.
    expect(result.connectors.find((c) => c.connectorKey === "openai-connector")).toMatchObject({
      hasAuthorizedConnection: true,
      authorizedConnectionIds: ["conn-1"],
    });
    expect(result.connectors.find((c) => c.connectorKey === "tailscale-connector")).toMatchObject({
      hasAuthorizedConnection: true,
      authorizedConnectionIds: ["conn-2"],
    });
  });
});

describe("connector_inventory_list — per-row authorization", () => {
  it("a row the actor holds no `use` grant for NEVER serializes", async () => {
    // The scope-filter reader returns EVERY live row of the org: `conn-mine` is
    // the actor's, `conn-foreign` is another member's owner-only connection.
    const result = await buildConnectorInventory(
      deps({
        listConnectionRows: async () => [
          identity({ id: "conn-mine" }),
          identity({
            id: "conn-foreign",
            connectorPackageId: "@cinatra-ai/tailscale-connector",
          }),
        ],
        decideUse: async ({ identity: row }) => ({ allowed: row.id === "conn-mine" }),
      }),
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("conn-foreign");
    expect(serialized).toContain("conn-mine");

    const tailscale = result.connectors.find((c) => c.connectorKey === "tailscale-connector");
    // The unauthorized row leaves NO trace — not an id, not a count, not a
    // "there is one you cannot see" flag.
    expect(tailscale).toEqual({
      connectorKey: "tailscale-connector",
      displayName: "Tailscale",
      hasAuthorizedConnection: false,
      authorizedConnectionIds: [],
      // Catalog data, unconditioned on authorization — it is the same for an
      // actor who may use the connector and one who may not, which is exactly
      // why it leaks nothing about the withheld row.
      mcpPrimitivePrefixes: [],
    });
  });

  it("every row is put through the `use` decision — none is emitted unchecked", async () => {
    const seen: string[] = [];
    await buildConnectorInventory(
      deps({
        listConnectionRows: async () => [
          identity({ id: "conn-a" }),
          identity({ id: "conn-b" }),
          identity({ id: "conn-c" }),
        ],
        decideUse: async ({ identity: row }) => {
          seen.push(row.id);
          return { allowed: false };
        },
      }),
    );
    expect(seen.sort()).toEqual(["conn-a", "conn-b", "conn-c"]);
  });

  it("a THROWING `use` decision is a deny, not a pass", async () => {
    const result = await buildConnectorInventory(
      deps({
        listConnectionRows: async () => [identity({ id: "conn-boom" })],
        decideUse: async () => {
          throw new Error("policy evaluation fault");
        },
      }),
    );
    expect(JSON.stringify(result)).not.toContain("conn-boom");
    expect(result.connectors.every((c) => c.hasAuthorizedConnection === false)).toBe(true);
  });

  it("fails closed when no trusted actor resolves (no catalog, no rows)", async () => {
    let readRows = false;
    const result = await buildConnectorInventory(
      deps({
        resolveActor: async () => ({ actor: null, subjectUserId: null, organizationId: null }),
        listConnectionRows: async () => {
          readRows = true;
          return [identity({ id: "conn-1" })];
        },
      }),
    );
    expect(result).toEqual({ connectors: [] });
    expect(readRows).toBe(false);
  });

  it("fails closed when the frame carries no human subject", async () => {
    const result = await buildConnectorInventory(
      deps({
        resolveActor: async () => ({ actor: ACTOR ?? null, subjectUserId: null, organizationId: ORG_ID }),
      }),
    );
    expect(result).toEqual({ connectors: [] });
  });
});

describe("connector_inventory_list — grounding half", () => {
  it("the tool description tells the model what an empty answer means", () => {
    expect(CONNECTOR_INVENTORY_TOOL_DESCRIPTION).toMatch(/hasAuthorizedConnection: false/);
    expect(CONNECTOR_INVENTORY_TOOL_DESCRIPTION).toMatch(/never report it as 'nothing is connected'/);
    expect(CONNECTOR_INVENTORY_TOOL_DESCRIPTION).toMatch(/Takes no arguments/);
  });

  it("the MCP client instructions point inventory questions at the tool", () => {
    const skill = readFileSync(
      resolve(REPO_ROOT, "packages/mcp-server/skills/mcp-autodiscovery/SKILL.md"),
      "utf8",
    );
    expect(skill).toContain(CONNECTOR_INVENTORY_TOOL_NAME);
    expect(skill).toMatch(/Never report the negative from a missing tool/);
  });
});

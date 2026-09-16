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
  "packages/mcp-server/src/capability-plan.ts",
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
  it("the row allowlist is exactly these six fields", () => {
    // A literal, not a re-export: adding a field to the projector without
    // adding it here — or here without a reviewer — fails.
    //
    // `mcpPrimitivePrefixes` (cinatra#2771) is build-time CATALOG data: it
    // says which primitive names a connector gates, never who may use it. It
    // is on the row because the row is the one carrier from the catalog to the
    // chat-catalog derivation, which cannot map `gmail_aliases_list` onto the
    // `gmail-connector` slug without it.
    //
    // `consumesConnectionFrom` (cinatra#3108) is build-time CATALOG data too:
    // the connector's own declaration of WHOSE connection gates it, for a
    // connector that holds none of its own. It names a catalog connector key
    // and nothing else — no actor, tenant, connection or credential material —
    // and it is what lets a reader tell "no connection you may use" apart from
    // "this connector holds no connection at all", which is the misreading
    // this field ships against.
    expect([...CONNECTOR_INVENTORY_ROW_FIELDS]).toEqual([
      "connectorKey",
      "displayName",
      "hasAuthorizedConnection",
      "authorizedConnectionIds",
      "mcpPrimitivePrefixes",
      "consumesConnectionFrom",
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
      // This connector owns its connection, so it declares no other connector's
      // — `null` is the reading for "judged on its own connection".
      consumesConnectionFrom: null,
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

  it("the MCP client instructions teach the consumed-connection reading too", () => {
    // The per-tool description is not the only model-facing authority: this
    // file is delivered in EVERY MCP `initialize` response
    // (src/lib/mcp-instructions.ts), so a reading taught in one place and not
    // the other leaves a client reading the row the old way.
    const skill = readFileSync(
      resolve(REPO_ROOT, "packages/mcp-server/skills/mcp-autodiscovery/SKILL.md"),
      "utf8",
    );
    expect(skill).toMatch(/consumesConnectionFrom/);
    expect(skill).toMatch(/never tell the user to connect it/);
    // And the invariant a reader would otherwise call a fault.
    expect(skill).toMatch(/empty `authorizedConnectionIds`/);
  });
});

// ---------------------------------------------------------------------------
// A CONNECTOR THAT HOLDS NO CONNECTION OF ITS OWN (cinatra#3108).
//
// Some connectors work off another connector's connection and never write a
// connection row of their own. Keyed on their OWN package id such a connector
// is unconnected for everyone, forever — so their chat primitives were dropped
// from every turn and the inventory answered "not connected or authorized",
// while the connector has no connect road to offer.
//
// The fixtures below name NO real connector on purpose: the declaration is the
// connector's and the host reads it generically, so nothing here — and nothing
// in the host — special-cases a slug.
// ---------------------------------------------------------------------------

const PROVIDER_PACKAGE_ID = "@cinatra-ai/provider-connector";
const CONSUMING_PACKAGE_ID = "@cinatra-ai/consuming-connector";

const CONSUMING_CATALOG = [
  {
    packageId: PROVIDER_PACKAGE_ID,
    connectorKey: "provider-connector",
    displayName: "Provider",
    mcpPrimitivePrefixes: ["provider_"],
  },
  {
    packageId: CONSUMING_PACKAGE_ID,
    connectorKey: "consuming-connector",
    displayName: "Consuming",
    mcpPrimitivePrefixes: ["consuming_"],
    // The whole declaration: judged on the provider's connection, because it
    // can never own one.
    consumesConnectionFrom: "provider-connector",
  },
];

function consumingDeps(authorizedPackageIds: readonly string[]) {
  return deps({
    listCatalog: async () => CONSUMING_CATALOG,
    listConnectionRows: async () =>
      authorizedPackageIds.map((packageId, i) =>
        identity({ id: `conn-${i}`, connectorPackageId: packageId }),
      ),
  });
}

async function consumingRow(authorizedPackageIds: readonly string[]) {
  const result = await buildConnectorInventory(consumingDeps(authorizedPackageIds));
  return result.connectors.find((c) => c.connectorKey === "consuming-connector")!;
}

describe("connector_inventory_list — a connector that consumes another's connection", () => {
  it("reports its state FROM the consumed connection", async () => {
    const row = await consumingRow([PROVIDER_PACKAGE_ID]);
    expect(row.hasAuthorizedConnection).toBe(true);
    expect(row.consumesConnectionFrom).toBe("provider-connector");
    // It owns no connection, so it carries no ids of its own: the ids behind
    // the reading sit on the PROVIDER's row, which the declaration names. The
    // reading is not backed by a duplicated id here.
    expect(row.authorizedConnectionIds).toEqual([]);
  });

  it("is withheld while the consumed connection is NOT authorized", async () => {
    const row = await consumingRow([]);
    expect(row.hasAuthorizedConnection).toBe(false);
    expect(row.consumesConnectionFrom).toBe("provider-connector");
  });

  it("reads the DECLARED connector only, never any authorized connection", async () => {
    const row = await consumingRow(["@cinatra-ai/unrelated-connector"]);
    expect(row.hasAuthorizedConnection).toBe(false);
  });

  it("a malformed declaration never ADDS availability, whatever else is connected", async () => {
    // The security property behind "fail closed": the two malformed shapes
    // below contribute NOTHING, on a workspace where several other connectors
    // ARE authorized. Neither can borrow a connection it did not name.
    const malformed = [
      { connectorKey: "dangling-connector", consumesConnectionFrom: "no-such-connector" },
      { connectorKey: "loop-connector", consumesConnectionFrom: "loop-connector" },
    ];
    for (const entry of malformed) {
      const result = await buildConnectorInventory(
        deps({
          listCatalog: async () => [
            {
              packageId: `@cinatra-ai/${entry.connectorKey}`,
              connectorKey: entry.connectorKey,
              displayName: entry.connectorKey,
              consumesConnectionFrom: entry.consumesConnectionFrom,
            },
            ...CONSUMING_CATALOG,
          ],
          listConnectionRows: async () => [
            identity({ id: "conn-p", connectorPackageId: PROVIDER_PACKAGE_ID }),
            identity({ id: "conn-x", connectorPackageId: "@cinatra-ai/unrelated-connector" }),
          ],
        }),
      );
      const row = result.connectors.find((c) => c.connectorKey === entry.connectorKey)!;
      expect(row.hasAuthorizedConnection, entry.connectorKey).toBe(false);
      expect(row.authorizedConnectionIds, entry.connectorKey).toEqual([]);
    }
  });

  it("a malformed declaration does not take away a connection the actor DOES hold", async () => {
    // Fail-closed means the declaration adds nothing — never that it deletes a
    // connection the person genuinely holds and may use. A connector with an
    // authorized row of its own reads exactly as it did before cinatra#3108,
    // whatever it declares.
    const result = await buildConnectorInventory(
      deps({
        listCatalog: async () => [
          {
            packageId: "@cinatra-ai/loop-connector",
            connectorKey: "loop-connector",
            displayName: "Loop",
            consumesConnectionFrom: "loop-connector",
          },
        ],
        listConnectionRows: async () => [
          identity({ id: "conn-own", connectorPackageId: "@cinatra-ai/loop-connector" }),
        ],
      }),
    );
    expect(result.connectors[0].hasAuthorizedConnection).toBe(true);
    expect(result.connectors[0].authorizedConnectionIds).toEqual(["conn-own"]);
  });

  it("the projector ignores a consumed reading that no declaration asked for", async () => {
    // `projectConnectorInventoryRow` is exported. A malformed call must not be
    // able to mint an available row that names no connector to connect.
    const row = projectConnectorInventoryRow({
      connectorKey: "smuggled-connector",
      displayName: "Smuggled",
      authorizedConnectionIds: [],
      consumedConnectionAuthorized: true,
    });
    expect(row.hasAuthorizedConnection).toBe(false);
    expect(row.consumesConnectionFrom).toBeNull();
  });

  it("the CONSUMED connection passes the same `use` gate — a denied row admits nothing", async () => {
    // The whole safety claim of the declaration road: it moves the question,
    // never the answer. The provider's connection row EXISTS here; the actor
    // may not use it, so the consuming connector is withheld exactly as the
    // provider is.
    const result = await buildConnectorInventory(
      deps({
        listCatalog: async () => CONSUMING_CATALOG,
        listConnectionRows: async () => [
          identity({ id: "conn-0", connectorPackageId: PROVIDER_PACKAGE_ID }),
        ],
        decideUse: async () => ({ allowed: false }),
      }),
    );
    const consuming = result.connectors.find((c) => c.connectorKey === "consuming-connector")!;
    const provider = result.connectors.find((c) => c.connectorKey === "provider-connector")!;
    expect(provider.hasAuthorizedConnection).toBe(false);
    expect(consuming.hasAuthorizedConnection).toBe(false);
    expect(consuming.consumesConnectionFrom).toBe("provider-connector");
  });

  it("a `use` decision that THROWS on the consumed row is a deny for the consumer too", async () => {
    const result = await buildConnectorInventory(
      deps({
        listCatalog: async () => CONSUMING_CATALOG,
        listConnectionRows: async () => [
          identity({ id: "conn-0", connectorPackageId: PROVIDER_PACKAGE_ID }),
        ],
        decideUse: async () => {
          throw new Error("evaluation fault");
        },
      }),
    );
    const consuming = result.connectors.find((c) => c.connectorKey === "consuming-connector")!;
    expect(consuming.hasAuthorizedConnection).toBe(false);
  });

  it("fails closed when the declaration names a connector the catalog has not got", async () => {
    const result = await buildConnectorInventory(
      deps({
        listCatalog: async () => [
          {
            packageId: "@cinatra-ai/dangling-connector",
            connectorKey: "dangling-connector",
            displayName: "Dangling",
            consumesConnectionFrom: "no-such-connector",
          },
        ],
        listConnectionRows: async () => [
          identity({ id: "conn-0", connectorPackageId: PROVIDER_PACKAGE_ID }),
        ],
      }),
    );
    expect(result.connectors[0].hasAuthorizedConnection).toBe(false);
  });

  it("a self-referential declaration cannot authorize itself", async () => {
    const result = await buildConnectorInventory(
      deps({
        listCatalog: async () => [
          {
            packageId: "@cinatra-ai/loop-connector",
            connectorKey: "loop-connector",
            displayName: "Loop",
            consumesConnectionFrom: "loop-connector",
          },
        ],
        listConnectionRows: async () => [],
      }),
    );
    expect(result.connectors[0].hasAuthorizedConnection).toBe(false);
  });

  it("leaves a connector that OWNS its connection exactly as it was", async () => {
    const result = await buildConnectorInventory(consumingDeps([PROVIDER_PACKAGE_ID]));
    const provider = result.connectors.find((c) => c.connectorKey === "provider-connector");
    expect(provider).toEqual({
      connectorKey: "provider-connector",
      displayName: "Provider",
      hasAuthorizedConnection: true,
      authorizedConnectionIds: ["conn-0"],
      mcpPrimitivePrefixes: ["provider_"],
      consumesConnectionFrom: null,
    });
  });

  it("the tool description teaches the reading and forbids a connect prompt for it", () => {
    expect(CONNECTOR_INVENTORY_TOOL_DESCRIPTION).toMatch(/consumesConnectionFrom/);
    expect(CONNECTOR_INVENTORY_TOOL_DESCRIPTION).toMatch(/never tell the user to connect it/);
  });
});

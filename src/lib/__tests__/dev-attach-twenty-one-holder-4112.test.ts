// cinatra#4112 — the preview attach of the Twenty connection read "not
// resolved" although the boot shell had pushed the first administrator.
//
// A reading of the Turbopack build of 2af80105 shows `external-mcp-registry.ts`
// under three module ids and the host binder under three. The boot shell
// pushes the owner through `setDevActorForExternalMcp` into the instance it
// shares with the binder that instrumentation loads; each binder instance
// publishes the process-wide external-MCP registry provider once, and a later
// publication replaces an earlier one. With a module-local holder, an attach
// through another instance reads no owner. The reading does not show that an
// entry evaluated another binder before the install hook ran.
//
// `vi.resetModules()` gives two module instances here: the first import is
// the instance the shell pushes into, the import after the reset is another
// instance whose attach a hook may call. The owner holder must be ONE per
// process.
//
// The second half pins the fixed failure word of an attach that does not
// resolve: one word per step, returned as `failure` and logged once on the
// line `[dev-attach:twenty] not resolved: <word>`, never with error text or a
// key.

import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const SECRET = "sk-twenty-synthetic-test-key";
const INSTANCE = "http://localhost:3300";
const CONNECTION_ID = `twenty-workspace-${createHash("sha256").update(INSTANCE).digest("hex").slice(0, 16)}`;
const OWNER = { userId: "admin-1", organizationId: "org-1" };

// ---- the external_mcp_servers table, in memory ------------------------------
const table: {
  row: Record<string, unknown> | null;
  failInsert: boolean;
  dropInsert: boolean;
  failSelect: boolean;
  failSelectAfterInsert: boolean;
  inserted: boolean;
} = {
  row: null,
  failSelect: false,
  failSelectAfterInsert: false,
  inserted: false,
  failInsert: false,
  dropInsert: false,
};
const runPostgresQueriesSync = vi.fn((arg: { queries: { text: string; values?: unknown[] }[] }) => {
  const query = arg.queries[0];
  const text = query?.text ?? "";
  if (/^\s*SELECT/i.test(text)) {
    if (table.failSelect) throw new Error(`select failed ${SECRET}`);
    if (table.failSelectAfterInsert && table.inserted) throw new Error(`select failed ${SECRET}`);
    return [{ rows: table.row ? [table.row] : [], rowCount: table.row ? 1 : 0 }];
  }
  if (/INSERT INTO .*external_mcp_servers/i.test(text)) {
    if (table.failInsert) throw new Error(`insert failed ${SECRET}`);
    if (table.dropInsert) return [{ rows: [], rowCount: 1 }];
    table.inserted = true;
    const v = query?.values ?? [];
    table.row = {
      id: v[0],
      label: v[1],
      server_url: v[2],
      nango_connection_id: v[3],
      scope: v[4],
      org_id: v[5],
      user_id: v[6],
      enabled: v[7],
      allowed_tools: v[8],
      allowed_catalog_tools: v[9],
      transport: v[10],
      created_at: "2026-11-03",
      updated_at: "2026-11-03",
    };
  }
  return [{ rows: [], rowCount: 1 }];
});
vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: (...a: unknown[]) => runPostgresQueriesSync(...(a as [never])),
}));
vi.mock("@/lib/database", () => ({
  getPostgresConnectionString: () => "postgres://test",
  ensurePostgresSchema: () => {},
  postgresSchema: "public",
}));
vi.mock("@/lib/url-policy", () => ({ isPrivateUrl: () => false }));
vi.mock("@cinatra-ai/mcp-server/credentials", () => ({ getMcpPublicBaseUrl: () => ({ publicBaseUrl: null }) }));
vi.mock("@/lib/connector-client-providers", () => ({ listManagedExternalMcpEndpointUrls: () => [] }));

// ---- the connection service (Nango) -----------------------------------------
const isNangoConfigured = vi.fn(() => true);
const ensureNangoIntegration = vi.fn(async () => {});
const importNangoConnection = vi.fn(async () => {});
const getNangoCredentials = vi.fn(async (): Promise<unknown> => ({ apiKey: SECRET }));
const deleteNangoConnection = vi.fn(async () => {});
vi.mock("@/lib/nango-system", () => ({
  isNangoConfigured: () => isNangoConfigured(),
  ensureNangoIntegration: (...a: unknown[]) => ensureNangoIntegration(...(a as [])),
  importNangoConnection: (...a: unknown[]) => importNangoConnection(...(a as [])),
  getNangoCredentials: (...a: unknown[]) => getNangoCredentials(...(a as [])),
  deleteNangoConnection: (...a: unknown[]) => deleteNangoConnection(...(a as [])),
}));

// ---- the identity store, the identity seam and the use gate -----------------
const identities = new Map<string, { id: string; ownerUserId: string; organizationId: string | null }>();
const grants = new Set<string>();
const seam = { fail: false };
const gate = { throwOther: false };
const store = { readThrowsOnce: false, softDeleteThrows: false, softDeleted: [] as string[] };
vi.mock("@cinatra-ai/extensions/connection-identity-store", () => ({
  readNangoConnectionByNaturalKey: async (_key: string, connectionId: string) => {
    if (store.readThrowsOnce) {
      store.readThrowsOnce = false;
      throw new Error(`identity store unavailable ${SECRET}`);
    }
    return identities.get(connectionId) ?? null;
  },
  softDeleteNangoConnection: async (id: string) => {
    store.softDeleted.push(id);
    if (store.softDeleteThrows) throw new Error(`soft delete failed ${SECRET}`);
  },
}));
vi.mock("@/lib/connection-identity-seam", () => ({
  registerSavedConnectionIdentity: async (input: {
    connectionId: string;
    ownerUserId: string;
    organizationId: string | null;
    seed: string;
  }) => {
    if (seam.fail) throw new Error(`identity seed failed ${SECRET}`);
    const id = `ident-${input.connectionId}`;
    identities.set(input.connectionId, { id, ownerUserId: input.ownerUserId, organizationId: input.organizationId });
    if (input.seed === "workspace") grants.add(id);
  },
}));
vi.mock("@/lib/connection-use-gate", () => {
  class ConnectionUseDeniedError extends Error {}
  return {
    ConnectionUseDeniedError,
    enforceConnectionUse: async (input: { identity: { id: string } }) => {
      if (gate.throwOther) throw new Error(`gate store unavailable ${SECRET}`);
      if (!grants.has(input.identity.id)) throw new ConnectionUseDeniedError("denied");
    },
  };
});
vi.mock("@/lib/authz/actor-context", () => ({ POLICY_VERSION: "test" }));

// ---- Twenty's REST probe -----------------------------------------------------
const twenty = { status: 200 };

type Registry = typeof import("@/lib/external-mcp-registry");
const CACHE_KEY = "__cinatraExternalMcpServerCache";

/** A fresh module instance of the registry (another module instance in the same process). */
async function freshInstance(): Promise<Registry> {
  vi.resetModules();
  return import("@/lib/external-mcp-registry");
}

let logSpy: ReturnType<typeof vi.spyOn>;

function loggedLines(): string[] {
  return logSpy.mock.calls.map((call: unknown[]) => call.map(String).join(" "));
}

beforeEach(async () => {
  vi.clearAllMocks();
  table.row = null;
  table.failInsert = false;
  table.dropInsert = false;
  table.failSelect = false;
  table.failSelectAfterInsert = false;
  table.inserted = false;
  gate.throwOther = false;
  store.readThrowsOnce = false;
  store.softDeleteThrows = false;
  store.softDeleted = [];
  identities.clear();
  grants.clear();
  seam.fail = false;
  twenty.status = 200;
  isNangoConfigured.mockImplementation(() => true);
  getNangoCredentials.mockImplementation(async () => ({ apiKey: SECRET }));
  importNangoConnection.mockImplementation(async () => {});
  ensureNangoIntegration.mockImplementation(async () => {});
  deleteNangoConnection.mockImplementation(async () => {});
  (globalThis as Record<string, unknown>)[CACHE_KEY] = null;
  vi.stubGlobal("fetch", async () => new Response(null, { status: twenty.status }));
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  // No owner left over from another case, through whatever holder the module keeps.
  (await freshInstance()).setDevActorForExternalMcp(null);
});

afterEach(() => {
  logSpy.mockRestore();
  vi.unstubAllGlobals();
});

describe("the dev owner holder is one per process (cinatra#4112)", () => {
  it("an owner pushed through one module instance is read by another instance", async () => {
    const instrumentation = await freshInstance();
    instrumentation.setDevActorForExternalMcp(OWNER);

    const other = await freshInstance();
    expect(other).not.toBe(instrumentation);
    expect(other.getDevInstallConnectionOwner()).toEqual(OWNER);

    instrumentation.setDevActorForExternalMcp(null);
    expect(other.getDevInstallConnectionOwner()).toBeNull();
  });

  it("the holder keeps a copy: changing the pushed object after the push changes nothing", async () => {
    const reg = await freshInstance();
    const pushed = { userId: "admin-1", organizationId: "org-1" };
    reg.setDevActorForExternalMcp(pushed);
    pushed.userId = "someone-else";
    pushed.organizationId = "";
    expect(reg.getDevInstallConnectionOwner()).toEqual(OWNER);
    expect((await freshInstance()).getDevInstallConnectionOwner()).toEqual(OWNER);
  });

  it("the attach of another module instance makes the connection for the pushed owner", async () => {
    const instrumentation = await freshInstance();
    instrumentation.setDevActorForExternalMcp(OWNER);

    // Another binder's publication would hand the hook this instance's attach.
    const other = await freshInstance();
    const result = await other.devAttachTwentyBearerFromMintedKey({ instanceUrl: INSTANCE, apiKey: SECRET });

    expect(result).toEqual({ resolved: true, connectionId: CONNECTION_ID });
    expect(importNangoConnection).toHaveBeenCalledTimes(1);
    expect(table.row?.nango_connection_id).toBe(CONNECTION_ID);
    expect(identities.get(CONNECTION_ID)).toEqual({
      id: `ident-${CONNECTION_ID}`,
      ownerUserId: OWNER.userId,
      organizationId: OWNER.organizationId,
    });
    expect(loggedLines().filter((l) => l.startsWith("[dev-attach:twenty]"))).toEqual([]);
  });

  it("the owner getter and the hand-over of another module instance read the same holder", async () => {
    const instrumentation = await freshInstance();
    instrumentation.setDevActorForExternalMcp(OWNER);

    const other = await freshInstance();
    expect(other.getDevInstallConnectionOwner()).toEqual(OWNER);
    // With the owner read, the hand-over goes on to the row (none here): not "no-owner".
    const checkKey = vi.fn(async () => "ok" as const);
    const outcome = await other.devReownRefusedFixtureConnection({
      serverId: "twenty-workspace",
      refusedFixtureUserId: "fixture-1",
      checkKey,
    });
    expect(outcome).toBe("no-connection");
    expect(checkKey).not.toHaveBeenCalled();

    // A clear through the instrumentation instance reaches both readers.
    instrumentation.setDevActorForExternalMcp(null);
    expect(other.getDevInstallConnectionOwner()).toBeNull();
    expect(
      await other.devReownRefusedFixtureConnection({
        serverId: "twenty-workspace",
        refusedFixtureUserId: "fixture-1",
        checkKey,
      }),
    ).toBe("no-owner");
  });
});

describe("an attach that does not resolve names its step with one fixed word (cinatra#4112)", () => {
  async function attachWith(setup: () => void, instanceUrl = INSTANCE) {
    const reg = await freshInstance();
    reg.setDevActorForExternalMcp(OWNER);
    setup();
    return reg.devAttachTwentyBearerFromMintedKey({ instanceUrl, apiKey: SECRET });
  }

  function expectOneLine(word: string) {
    const lines = loggedLines();
    expect(lines.filter((l) => l.startsWith("[dev-attach:twenty]"))).toEqual([
      `[dev-attach:twenty] not resolved: ${word}`,
    ]);
    // SECRET BOUNDARY: no logged line carries the key or a thrown message.
    expect(lines.some((l) => l.includes(SECRET))).toBe(false);
  }

  it("no-owner: no pushed owner, nothing is saved", async () => {
    const reg = await freshInstance();
    const result = await reg.devAttachTwentyBearerFromMintedKey({ instanceUrl: INSTANCE, apiKey: SECRET });
    expect(result).toEqual({ resolved: false, connectionId: null, failure: "no-owner" });
    expect(isNangoConfigured).not.toHaveBeenCalled();
    expectOneLine("no-owner");
  });

  it("no-owner: a pushed owner without an organisation", async () => {
    const reg = await freshInstance();
    reg.setDevActorForExternalMcp({ userId: "admin-1", organizationId: "" });
    const result = await reg.devAttachTwentyBearerFromMintedKey({ instanceUrl: INSTANCE, apiKey: SECRET });
    expect(result).toEqual({ resolved: false, connectionId: null, failure: "no-owner" });
    expectOneLine("no-owner");
  });

  it("key: a blank key stops the save at its first step", async () => {
    const reg = await freshInstance();
    reg.setDevActorForExternalMcp(OWNER);
    const result = await reg.devAttachTwentyBearerFromMintedKey({ instanceUrl: INSTANCE, apiKey: "   " });
    expect(result).toEqual({ resolved: false, connectionId: null, failure: "key" });
    expect(isNangoConfigured).not.toHaveBeenCalled();
    expectOneLine("key");
  });

  it("url: an address the connect rule refuses", async () => {
    const result = await attachWith(() => {}, "http://crm.example.com");
    expect(result).toEqual({ resolved: false, connectionId: null, failure: "url" });
    expectOneLine("url");
  });

  it("nango-config: the connection service is not configured", async () => {
    const result = await attachWith(() => isNangoConfigured.mockImplementation(() => false));
    expect(result).toEqual({ resolved: false, connectionId: null, failure: "nango-config" });
    expectOneLine("nango-config");
  });

  it("probe-unauthorized: Twenty refuses the key", async () => {
    const result = await attachWith(() => {
      twenty.status = 401;
    });
    expect(result).toEqual({ resolved: false, connectionId: null, failure: "probe-unauthorized" });
    expect(importNangoConnection).not.toHaveBeenCalled();
    expectOneLine("probe-unauthorized");
  });

  it("probe-unreachable: Twenty does not answer the probe", async () => {
    const result = await attachWith(() => {
      twenty.status = 503;
    });
    expect(result).toEqual({ resolved: false, connectionId: null, failure: "probe-unreachable" });
    expectOneLine("probe-unreachable");
  });

  it("foreign-owner: the connection belongs to another owner", async () => {
    const result = await attachWith(() => {
      identities.set(CONNECTION_ID, { id: "ident-other", ownerUserId: "someone-else", organizationId: "org-1" });
    });
    expect(result).toEqual({ resolved: false, connectionId: null, failure: "foreign-owner" });
    expect(importNangoConnection).not.toHaveBeenCalled();
    expectOneLine("foreign-owner");
  });

  it("row-read: the read of the prior row throws, before any import", async () => {
    const result = await attachWith(() => {
      table.failSelect = true;
    });
    expect(result).toEqual({ resolved: false, connectionId: null, failure: "row-read" });
    expect(importNangoConnection).not.toHaveBeenCalled();
    expectOneLine("row-read");
  });

  it("nango-import: the import throws, and its message is not logged", async () => {
    const result = await attachWith(() =>
      importNangoConnection.mockImplementation(async () => {
        throw new Error(`import failed for ${SECRET}`);
      }),
    );
    expect(result).toEqual({ resolved: false, connectionId: null, failure: "nango-import" });
    expectOneLine("nango-import");
  });

  it("readback: the stored key reads back different", async () => {
    const result = await attachWith(() => getNangoCredentials.mockImplementation(async () => ({ apiKey: "other" })));
    expect(result).toEqual({ resolved: false, connectionId: null, failure: "readback" });
    expect(table.row).toBeNull();
    expectOneLine("readback");
  });

  it("row-upsert: the row write throws, and its message is not logged", async () => {
    const result = await attachWith(() => {
      table.failInsert = true;
    });
    expect(result).toEqual({ resolved: false, connectionId: null, failure: "row-upsert" });
    expect(importNangoConnection).toHaveBeenCalledTimes(1);
    expect(identities.has(CONNECTION_ID)).toBe(false);
    expectOneLine("row-upsert");
  });

  it("no-row: the save completed but the row reads back absent", async () => {
    const result = await attachWith(() => {
      table.dropInsert = true;
    });
    expect(result).toEqual({ resolved: false, connectionId: null, failure: "no-row" });
    expect(identities.has(CONNECTION_ID)).toBe(true);
    expectOneLine("no-row");
  });

  it("resolver-error: the gated resolver throws, and its message is not logged", async () => {
    const result = await attachWith(() => {
      gate.throwOther = true;
    });
    expect(result).toEqual({ resolved: false, connectionId: CONNECTION_ID, failure: "resolver-error" });
    expectOneLine("resolver-error");
  });

  it("identity: the identity seed throws after the row upsert", async () => {
    const result = await attachWith(() => {
      seam.fail = true;
    });
    expect(result).toEqual({ resolved: false, connectionId: null, failure: "identity" });
    expect(table.row?.nango_connection_id).toBe(CONNECTION_ID);
    expectOneLine("identity");
  });

  it("resolver-null: the save completed but the gated resolver mints no bearer", async () => {
    const reg = await freshInstance();
    reg.setDevActorForExternalMcp(OWNER);
    // The resolver's own credential read fails after the save's readback passed.
    let reads = 0;
    getNangoCredentials.mockImplementation(async () => (++reads === 1 ? { apiKey: SECRET } : null));
    const result = await reg.devAttachTwentyBearerFromMintedKey({ instanceUrl: INSTANCE, apiKey: SECRET });
    expect(result).toEqual({ resolved: false, connectionId: CONNECTION_ID, failure: "resolver-null" });
    expectOneLine("resolver-null");
  });
});

describe("the attach on the remaining branches of the save (cinatra#4112)", () => {
  async function pushed(owner: { userId: string; organizationId: string } | null = OWNER) {
    const reg = await freshInstance();
    reg.setDevActorForExternalMcp(owner);
    return reg;
  }

  function lastWord(): string[] {
    return loggedLines().filter((l) => l.startsWith("[dev-attach:twenty]"));
  }

  it("a throwing log sink never fails the attach", async () => {
    const reg = await pushed(null);
    logSpy.mockImplementation(() => {
      throw new Error("log sink down");
    });
    await expect(reg.devAttachTwentyBearerFromMintedKey({ instanceUrl: INSTANCE, apiKey: SECRET })).resolves.toEqual({
      resolved: false,
      connectionId: null,
      failure: "no-owner",
    });
  });

  it("no-row: the read of the saved row throws after the save", async () => {
    const reg = await pushed();
    table.failSelectAfterInsert = true;
    const result = await reg.devAttachTwentyBearerFromMintedKey({ instanceUrl: INSTANCE, apiKey: SECRET });
    expect(result).toEqual({ resolved: false, connectionId: null, failure: "no-row" });
    expect(table.row?.nango_connection_id).toBe(CONNECTION_ID);
    expect(lastWord()).toEqual(["[dev-attach:twenty] not resolved: no-row"]);
  });

  it("key: a nullish key stops the save at its first step", async () => {
    for (const apiKey of [undefined, null]) {
      const reg = await pushed();
      const result = await reg.devAttachTwentyBearerFromMintedKey({
        instanceUrl: INSTANCE,
        apiKey: apiKey as unknown as string,
      });
      expect(result).toEqual({ resolved: false, connectionId: null, failure: "key" });
    }
    expect(isNangoConfigured).not.toHaveBeenCalled();
  });

  it("no-owner: a pushed owner with an empty user id, nothing is saved", async () => {
    const reg = await pushed({ userId: "", organizationId: "org-1" });
    const result = await reg.devAttachTwentyBearerFromMintedKey({ instanceUrl: INSTANCE, apiKey: SECRET });
    expect(result).toEqual({ resolved: false, connectionId: null, failure: "no-owner" });
    expect(isNangoConfigured).not.toHaveBeenCalled();
  });

  it("probe-unreachable: the probe request rejects", async () => {
    const reg = await pushed();
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    const result = await reg.devAttachTwentyBearerFromMintedKey({ instanceUrl: INSTANCE, apiKey: SECRET });
    expect(result).toEqual({ resolved: false, connectionId: null, failure: "probe-unreachable" });
    expect(importNangoConnection).not.toHaveBeenCalled();
  });

  it("probe-unreachable: the probe times out after its 8 s limit", async () => {
    const reg = await pushed();
    vi.stubGlobal(
      "fetch",
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let settled = false;
      const pending = reg.devAttachTwentyBearerFromMintedKey({ instanceUrl: INSTANCE, apiKey: SECRET });
      void pending.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(7999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual({ resolved: false, connectionId: null, failure: "probe-unreachable" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("foreign-owner: the same user under another organisation", async () => {
    const reg = await pushed();
    identities.set(CONNECTION_ID, { id: "ident-org", ownerUserId: OWNER.userId, organizationId: "org-other" });
    const result = await reg.devAttachTwentyBearerFromMintedKey({ instanceUrl: INSTANCE, apiKey: SECRET });
    expect(result).toEqual({ resolved: false, connectionId: null, failure: "foreign-owner" });
    expect(importNangoConnection).not.toHaveBeenCalled();
  });

  it("an unavailable identity store at the foreign-owner check lets the save go on", async () => {
    const reg = await pushed();
    store.readThrowsOnce = true;
    const result = await reg.devAttachTwentyBearerFromMintedKey({ instanceUrl: INSTANCE, apiKey: SECRET });
    expect(result).toEqual({ resolved: true, connectionId: CONNECTION_ID });
    expect(importNangoConnection).toHaveBeenCalledTimes(1);
  });

  it("nango-import: the integration setup rejects", async () => {
    const reg = await pushed();
    ensureNangoIntegration.mockImplementation(async () => {
      throw new Error(`integration failed ${SECRET}`);
    });
    const result = await reg.devAttachTwentyBearerFromMintedKey({ instanceUrl: INSTANCE, apiKey: SECRET });
    expect(result).toEqual({ resolved: false, connectionId: null, failure: "nango-import" });
    expect(importNangoConnection).not.toHaveBeenCalled();
    expect(loggedLines().some((l) => l.includes(SECRET))).toBe(false);
  });

  it("readback: the credential readback rejects", async () => {
    const reg = await pushed();
    getNangoCredentials.mockImplementation(async () => {
      throw new Error(`readback failed ${SECRET}`);
    });
    const result = await reg.devAttachTwentyBearerFromMintedKey({ instanceUrl: INSTANCE, apiKey: SECRET });
    expect(result).toEqual({ resolved: false, connectionId: null, failure: "readback" });
    expect(table.row).toBeNull();
    expect(loggedLines().some((l) => l.includes(SECRET))).toBe(false);
  });

  it("both clean-up steps of a prior key fail and the attach still resolves", async () => {
    const PRIOR = "twenty-workspace-prior0000000000";
    table.row = {
      id: "twenty-workspace",
      label: "Twenty CRM",
      server_url: "https://old.example.com/mcp",
      nango_connection_id: PRIOR,
      scope: "workspace",
      org_id: null,
      user_id: null,
      enabled: true,
      allowed_tools: null,
      allowed_catalog_tools: ["find_companies"],
      transport: "unknown",
      created_at: "2026-11-03",
      updated_at: "2026-11-03",
    };
    identities.set(PRIOR, { id: "ident-prior", ownerUserId: OWNER.userId, organizationId: OWNER.organizationId });
    store.softDeleteThrows = true;
    deleteNangoConnection.mockImplementation(async () => {
      throw new Error(`delete failed ${SECRET}`);
    });
    const reg = await pushed();
    const result = await reg.devAttachTwentyBearerFromMintedKey({ instanceUrl: INSTANCE, apiKey: SECRET });
    expect(result).toEqual({ resolved: true, connectionId: CONNECTION_ID });
    expect(store.softDeleted).toEqual(["ident-prior"]);
    expect(deleteNangoConnection).toHaveBeenCalledTimes(1);
    expect(deleteNangoConnection.mock.calls[0]).toEqual([expect.any(String), PRIOR]);
    expect(loggedLines().some((l) => l.includes(SECRET))).toBe(false);
  });

  it("a writer that clears or replaces the holder during the save does not change the owner of that save", async () => {
    const reg = await pushed();
    const otherInstance = await freshInstance();
    importNangoConnection.mockImplementation(async () => {
      otherInstance.setDevActorForExternalMcp(null);
      otherInstance.setDevActorForExternalMcp({ userId: "someone-else", organizationId: "org-other" });
    });
    const result = await reg.devAttachTwentyBearerFromMintedKey({ instanceUrl: INSTANCE, apiKey: SECRET });
    expect(result).toEqual({ resolved: true, connectionId: CONNECTION_ID });
    expect(identities.get(CONNECTION_ID)?.ownerUserId).toBe(OWNER.userId);
    expect(identities.get(CONNECTION_ID)?.organizationId).toBe(OWNER.organizationId);
  });
});

/**
 * Unit tests for store helpers:
 *   - upsertExternalAgentTemplate (idempotent, composite key)
 *   - readAgentTemplateByConnectorAndRemoteId (composite lookup)
 *   - findSavedConnectionForAgentUrl (normalized URL match)
 *   - normalizeAgentUrl (exercised indirectly via the above)
 *
 * Strategy: mock `../db` so we can inspect insert/update calls and return
 * deterministic rows. Mock `@cinatra-ai/nango-connector`'s
 * `listSavedNangoConnections` so findSavedConnectionForAgentUrl has data.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock state — db + nango
// ---------------------------------------------------------------------------

const memory = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  lastInsertValues: null as Record<string, unknown> | null,
  lastUpdateValues: null as Record<string, unknown> | null,
}));

const savedConnections = vi.hoisted(() => ({
  list: [] as Array<{
    connectionId: string;
    providerConfigKey: string;
    connectorKey: string;
    connectedAt: string;
    metadata?: Record<string, unknown>;
  }>,
}));

const mockDb = vi.hoisted(() => {
  // chainable fluent API — each terminal method resolves to a result.
  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    limit: async () => memory.rows,
    orderBy: () => selectChain,
    then: (onFulfilled: (value: unknown[]) => unknown) =>
      Promise.resolve(memory.rows).then(onFulfilled),
  };
  const insertChain = {
    values: (values: Record<string, unknown>) => {
      memory.lastInsertValues = values;
      memory.rows = [{ ...values }];
      return insertChain;
    },
    returning: async () => memory.rows,
    then: (onFulfilled: (value: unknown[]) => unknown) =>
      Promise.resolve(memory.rows).then(onFulfilled),
  };
  const updateChain = {
    set: (values: Record<string, unknown>) => {
      memory.lastUpdateValues = values;
      return updateChain;
    },
    where: async () => undefined,
  };
  return {
    select: () => selectChain,
    insert: () => insertChain,
    update: () => updateChain,
    delete: () => selectChain,
    transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ select: () => selectChain, insert: () => insertChain, update: () => updateChain }),
  };
});

vi.mock("../db", () => ({
  db: mockDb,
  agentBuilderPool: { on: () => {}, listenerCount: () => 1 },
}));

vi.mock("@/lib/nango-system", () => ({
  listSavedNangoConnections: (_key: string) => savedConnections.list,
  // (The former requireNangoSystem stub is gone: the host binder dropped its
  // last nango-system edge with the nango-connection-storage compat shim —
  // cinatra#151 Stage 7.)
}));

// ---------------------------------------------------------------------------
// Import after vi.mock
// ---------------------------------------------------------------------------

import {
  upsertExternalAgentTemplate,
  findSavedConnectionForAgentUrl,
  readAgentTemplateByConnectorAndRemoteId,
} from "../store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetMemory() {
  memory.rows = [];
  memory.lastInsertValues = null;
  memory.lastUpdateValues = null;
  savedConnections.list = [];
}

describe("upsertExternalAgentTemplate (composite key)", () => {
  beforeEach(() => {
    resetMemory();
  });

  it("inserts a new row when no matching (connector_slug, remote_agent_id) exists", async () => {
    // db.select returns [] on initial read → insert branch executes.
    memory.rows = [];
    await upsertExternalAgentTemplate({
      connectorSlug: "server-a",
      remoteAgentId: "skill-x",
      name: "Skill X",
      description: "d",
      agentUrl: "https://server-a.test/",
      version: "0.1.0",
    });
    const v = memory.lastInsertValues!;
    expect(v.sourceType).toBe("external");
    // trailing slash stripped by normalizeAgentUrl
    expect(v.agentUrl).toBe("https://server-a.test");
    expect(v.connectorSlug).toBe("server-a");
    expect(v.remoteAgentId).toBe("skill-x");
    expect(v.packageName).toBe("@server-a/skill-x");
    expect(v.status).toBe("active");
    expect(v.name).toBe("Skill X");
    expect(v.packageVersion).toBe("0.1.0");
  });

  it("URL normalization: lowercases host + strips trailing slash", async () => {
    memory.rows = [];
    await upsertExternalAgentTemplate({
      connectorSlug: "conn",
      remoteAgentId: "skill",
      name: "N",
      agentUrl: "HTTPS://Server-B.TEST/path/",
    });
    expect(memory.lastInsertValues!.agentUrl).toBe(
      "https://server-b.test/path",
    );
  });
});

describe("readAgentTemplateByConnectorAndRemoteId", () => {
  beforeEach(() => {
    resetMemory();
  });

  it("returns null when composite key has no matching row", async () => {
    memory.rows = [];
    const result = await readAgentTemplateByConnectorAndRemoteId(
      "no-such",
      "no-skill",
    );
    expect(result).toBeNull();
  });
});

describe("findSavedConnectionForAgentUrl", () => {
  beforeEach(() => {
    resetMemory();
  });

  it("returns the connection whose metadata.baseUrl matches (normalized)", () => {
    savedConnections.list = [
      {
        connectionId: "conn-1",
        providerConfigKey: "cinatra-a2a-server",
        connectorKey: "a2aServer",
        connectedAt: "2026-04-21T00:00:00Z",
        metadata: { baseUrl: "https://server-a.test/" },
      },
      {
        connectionId: "conn-2",
        providerConfigKey: "cinatra-a2a-server",
        connectorKey: "a2aServer",
        connectedAt: "2026-04-21T00:00:00Z",
        metadata: { baseUrl: "https://other.test" },
      },
    ];
    const result = findSavedConnectionForAgentUrl("https://server-a.test");
    expect(result).not.toBeNull();
    expect(result?.connectionId).toBe("conn-1");
    expect(result?.providerConfigKey).toBe("cinatra-a2a-server");
  });

  it("ignores trailing slash + scheme case differences", () => {
    savedConnections.list = [
      {
        connectionId: "conn-1",
        providerConfigKey: "cinatra-a2a-server",
        connectorKey: "a2aServer",
        connectedAt: "2026-04-21T00:00:00Z",
        metadata: { baseUrl: "https://server-a.test" },
      },
    ];
    const result = findSavedConnectionForAgentUrl("HTTPS://Server-A.TEST/");
    expect(result?.connectionId).toBe("conn-1");
  });

  it("returns null when no connection matches", () => {
    savedConnections.list = [
      {
        connectionId: "conn-1",
        providerConfigKey: "cinatra-a2a-server",
        connectorKey: "a2aServer",
        connectedAt: "2026-04-21T00:00:00Z",
        metadata: { baseUrl: "https://other.test" },
      },
    ];
    const result = findSavedConnectionForAgentUrl("https://server-a.test");
    expect(result).toBeNull();
  });

  it("returns null when there are no saved connections", () => {
    savedConnections.list = [];
    const result = findSavedConnectionForAgentUrl("https://anything.test");
    expect(result).toBeNull();
  });
});

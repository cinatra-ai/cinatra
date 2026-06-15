// Focused unit tests for cinatra#260 Steps 1+2 — `cinatra setup dev` hardening.
//
// Step 1 — Self-healing decryptable JWKS:
//   - `ensureDecryptableJwks` probes authoritatively via ONE real
//     client_credentials token mint and DELETEs the proven-bad jwks row ONLY on
//     the exact "Failed to decrypt private key" 5xx (bounded single retry).
//   - Transient/app-down and non-decrypt errors NEVER delete a key.
//
// Step 2 — Verify-before-reuse for the LLM-MCP / self OAuth secrets:
//   - `canReuseClientCredentials` uses Better Auth's EXACT hash recipe and
//     reuses the stored plaintext only when row+metadata fully agree.
//   - `ensureSelfMcpClient` / `ensureLlmMcpAccess` mint fresh + rewrite BOTH
//     halves (hashed oauthClient row + plaintext metadata) in a TRANSACTION on
//     any drift, and never falsely rotate a matching secret.
//
// All hermetic: a mock pg client + a stubbed global `fetch`. No live DB, no app.

import { createHash } from "node:crypto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  hashClientSecret,
  canReuseClientCredentials,
  ensureSelfMcpClient,
  ensureLlmMcpAccess,
  ensureDecryptableJwks,
  ensureMcpSettings,
  ensureDevPublicMcpUrl,
  probeTokenMint,
  resolveLocalOrigin,
  SELF_MCP_CLIENT_ID,
  SELF_MCP_CLIENT_SCOPE,
  SELF_MCP_CLIENT_SCOPES,
  LLM_MCP_PROVIDERS,
  LLM_MCP_CLIENT_SCOPES,
  LLM_MCP_SETTINGS_KEY,
  MCP_SETTINGS_KEY,
} from "../src/index.mjs";

const DECRYPT_ERROR_BODY =
  '{"error":"server_error","error_description":"Failed to decrypt private key. Make sure the secret currently in use is the same as the one used to encrypt the private key."}';

// Better Auth's recipe, duplicated here so the test is independent of the impl.
function baHash(plaintext) {
  return createHash("sha256").update(plaintext, "utf8").digest("base64url");
}

// --- Mock pg client -------------------------------------------------------
//
// Records every query (text + params), drives BEGIN/COMMIT/ROLLBACK bookkeeping,
// and answers SELECTs from a programmable handler map. Default: empty rows.
function createMockClient({ select } = {}) {
  const calls = [];
  const tx = { begins: 0, commits: 0, rollbacks: 0 };
  const client = {
    calls,
    tx,
    async query(text, params) {
      const sql = typeof text === "string" ? text : String(text);
      calls.push({ sql, params });
      const norm = sql.trim().toLowerCase();
      if (norm === "begin") {
        tx.begins += 1;
        return { rows: [], rowCount: 0 };
      }
      if (norm === "commit") {
        tx.commits += 1;
        return { rows: [], rowCount: 0 };
      }
      if (norm === "rollback") {
        tx.rollbacks += 1;
        return { rows: [], rowCount: 0 };
      }
      if (select) {
        const res = select(sql, params);
        if (res !== undefined) return res;
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return client;
}

function lastMetadataWrite(client, key) {
  // writeMetadataValue runs `insert into <schema>.metadata (key, value) ...`
  const writes = client.calls.filter(
    (c) => /insert into .*\.metadata/i.test(c.sql) && c.params?.[0] === key,
  );
  if (writes.length === 0) return undefined;
  return JSON.parse(writes[writes.length - 1].params[1]);
}

function oauthUpserts(client) {
  return client.calls.filter((c) => /insert into public\."oauthclient"/i.test(c.sql));
}

// =========================================================================
// Step 2 — hashClientSecret + canReuseClientCredentials
// =========================================================================

describe("hashClientSecret — Better Auth's exact recipe", () => {
  it("is SHA-256 base64url, byte-identical to Better Auth", () => {
    const plaintext = "some-plaintext-secret-value";
    expect(hashClientSecret(plaintext)).toBe(baHash(plaintext));
  });
});

describe("canReuseClientCredentials — verify-before-reuse predicate", () => {
  const expectedScopes = LLM_MCP_CLIENT_SCOPES;
  const plaintext = "reuse-me-plaintext";
  const goodRow = () => ({
    clientSecret: baHash(plaintext),
    grantTypes: ["client_credentials"],
    scopes: [...expectedScopes],
    disabled: false,
  });

  it("reuses when ALL conditions hold", () => {
    expect(
      canReuseClientCredentials({ plaintext, row: goodRow(), expectedScopes }),
    ).toBe(true);
  });

  it("does NOT falsely rotate a matching secret (same hash fn as writer)", () => {
    // The stored row was written by hashClientSecret — reuse must hold.
    const row = { ...goodRow(), clientSecret: hashClientSecret(plaintext) };
    expect(canReuseClientCredentials({ plaintext, row, expectedScopes })).toBe(true);
  });

  it("rotates when the hash does not match (drifted secret)", () => {
    const row = { ...goodRow(), clientSecret: baHash("a-different-secret") };
    expect(canReuseClientCredentials({ plaintext, row, expectedScopes })).toBe(false);
  });

  it("rotates when no plaintext is present", () => {
    expect(canReuseClientCredentials({ plaintext: null, row: goodRow(), expectedScopes })).toBe(false);
    expect(canReuseClientCredentials({ plaintext: "", row: goodRow(), expectedScopes })).toBe(false);
  });

  it("rotates when the row is absent", () => {
    expect(canReuseClientCredentials({ plaintext, row: undefined, expectedScopes })).toBe(false);
  });

  it("rotates when grantTypes is not exactly [client_credentials]", () => {
    expect(
      canReuseClientCredentials({
        plaintext,
        row: { ...goodRow(), grantTypes: ["client_credentials", "authorization_code"] },
        expectedScopes,
      }),
    ).toBe(false);
    expect(
      canReuseClientCredentials({
        plaintext,
        row: { ...goodRow(), grantTypes: ["authorization_code"] },
        expectedScopes,
      }),
    ).toBe(false);
  });

  it("rotates when scopes do not match", () => {
    expect(
      canReuseClientCredentials({
        plaintext,
        row: { ...goodRow(), scopes: ["mcp:connect", "extra:scope"] },
        expectedScopes,
      }),
    ).toBe(false);
  });

  it("rotates when disabled is not strictly false", () => {
    expect(
      canReuseClientCredentials({ plaintext, row: { ...goodRow(), disabled: true }, expectedScopes }),
    ).toBe(false);
  });

  it("tolerates jsonb columns returned as JSON strings", () => {
    const row = {
      clientSecret: baHash(plaintext),
      grantTypes: JSON.stringify(["client_credentials"]),
      scopes: JSON.stringify([...expectedScopes]),
      disabled: false,
    };
    expect(canReuseClientCredentials({ plaintext, row, expectedScopes })).toBe(true);
  });

  it("scope match is order-insensitive", () => {
    const row = {
      clientSecret: baHash(plaintext),
      grantTypes: ["client_credentials"],
      scopes: [...SELF_MCP_CLIENT_SCOPES].reverse(),
      disabled: false,
    };
    expect(
      canReuseClientCredentials({ plaintext, row, expectedScopes: SELF_MCP_CLIENT_SCOPES }),
    ).toBe(true);
  });
});

// =========================================================================
// Step 2 — ensureLlmMcpAccess two-table sync
// =========================================================================

describe("ensureLlmMcpAccess — verify-before-reuse + transactional two-table write", () => {
  it("is a no-op in production mode", async () => {
    const client = createMockClient();
    const result = await ensureLlmMcpAccess(client, "cinatra", { current: {}, next: {} }, "prod");
    expect(result).toBeNull();
    expect(client.calls).toHaveLength(0);
  });

  it("REUSES the stored plaintext when the row+metadata agree (no false rotation)", async () => {
    const plain = {};
    for (const p of LLM_MCP_PROVIDERS) plain[p.id] = `plaintext-${p.id}`;

    const metadata = {
      [LLM_MCP_SETTINGS_KEY]: {
        providers: Object.fromEntries(
          LLM_MCP_PROVIDERS.map((p) => [p.id, { clientId: p.clientId, clientSecret: plain[p.id] }]),
        ),
      },
    };

    const client = createMockClient({
      select(sql, params) {
        if (/from .*\.metadata/i.test(sql)) {
          const v = metadata[params[0]];
          return v ? { rows: [{ value: JSON.stringify(v) }], rowCount: 1 } : { rows: [], rowCount: 0 };
        }
        if (/from public\."oauthclient"/i.test(sql)) {
          const provider = LLM_MCP_PROVIDERS.find((p) => p.clientId === params[0]);
          return {
            rows: [
              {
                id: `row-${provider.id}`,
                createdAt: new Date("2025-01-01T00:00:00Z"),
                clientSecret: baHash(plain[provider.id]),
                grantTypes: ["client_credentials"],
                scopes: [...LLM_MCP_CLIENT_SCOPES],
                disabled: false,
              },
            ],
            rowCount: 1,
          };
        }
        return undefined;
      },
    });

    const result = await ensureLlmMcpAccess(client, "cinatra", { current: {}, next: {} }, "dev");

    // No rotation: every provider keeps its plaintext.
    for (const p of LLM_MCP_PROVIDERS) {
      expect(result.providers[p.id].clientSecret).toBe(plain[p.id]);
    }
    // And the upsert stored the SAME hash (writer hash === stored hash).
    for (const c of oauthUpserts(client)) {
      const clientId = c.params[1];
      const provider = LLM_MCP_PROVIDERS.find((p) => p.clientId === clientId);
      expect(c.params[2]).toBe(baHash(plain[provider.id]));
    }
    // Transaction wrapped the whole write.
    expect(client.tx.begins).toBe(1);
    expect(client.tx.commits).toBe(1);
    expect(client.tx.rollbacks).toBe(0);
  });

  it("MINTS FRESH and rewrites both halves when the row hash drifted", async () => {
    // Metadata plaintext exists, but the oauthClient row hash is for a DIFFERENT
    // secret — the two-table drift this guards against.
    const stalePlain = "stale-but-present-plaintext";
    const metadata = {
      [LLM_MCP_SETTINGS_KEY]: {
        providers: Object.fromEntries(
          LLM_MCP_PROVIDERS.map((p) => [p.id, { clientId: p.clientId, clientSecret: stalePlain }]),
        ),
      },
    };
    const client = createMockClient({
      select(sql, params) {
        if (/from .*\.metadata/i.test(sql)) {
          const v = metadata[params[0]];
          return v ? { rows: [{ value: JSON.stringify(v) }], rowCount: 1 } : { rows: [], rowCount: 0 };
        }
        if (/from public\."oauthclient"/i.test(sql)) {
          return {
            rows: [
              {
                id: "row-x",
                createdAt: new Date("2025-01-01T00:00:00Z"),
                clientSecret: baHash("a-totally-different-secret"),
                grantTypes: ["client_credentials"],
                scopes: [...LLM_MCP_CLIENT_SCOPES],
                disabled: false,
              },
            ],
            rowCount: 1,
          };
        }
        return undefined;
      },
    });

    const result = await ensureLlmMcpAccess(client, "cinatra", { current: {}, next: {} }, "dev");

    for (const p of LLM_MCP_PROVIDERS) {
      // Fresh secret — NOT the stale plaintext.
      expect(result.providers[p.id].clientSecret).not.toBe(stalePlain);
      expect(result.providers[p.id].clientSecret.length).toBeGreaterThan(0);
    }
    // Both halves rewritten consistently: the metadata write carries the new
    // plaintext and the row upsert carries its hash.
    const written = lastMetadataWrite(client, LLM_MCP_SETTINGS_KEY);
    expect(written).toBeDefined();
    for (const c of oauthUpserts(client)) {
      const clientId = c.params[1];
      const provider = LLM_MCP_PROVIDERS.find((p) => p.clientId === clientId);
      const newPlain = written.providers[provider.id].clientSecret;
      expect(c.params[2]).toBe(baHash(newPlain));
    }
    expect(client.tx.begins).toBe(1);
    expect(client.tx.commits).toBe(1);
  });

  it("rolls back and rethrows when the write fails mid-transaction", async () => {
    let upserts = 0;
    const client = createMockClient({
      select() {
        return undefined;
      },
    });
    const realQuery = client.query.bind(client);
    client.query = async (text, params) => {
      const sql = typeof text === "string" ? text : String(text);
      if (/insert into public\."oauthclient"/i.test(sql)) {
        upserts += 1;
        if (upserts === 2) {
          client.calls.push({ sql, params });
          throw new Error("boom mid-write");
        }
      }
      return realQuery(text, params);
    };

    await expect(
      ensureLlmMcpAccess(client, "cinatra", { current: {}, next: {} }, "dev"),
    ).rejects.toThrow(/boom mid-write/);
    expect(client.tx.begins).toBe(1);
    expect(client.tx.commits).toBe(0);
    expect(client.tx.rollbacks).toBe(1);
    // No metadata index written when the transaction rolled back.
    expect(lastMetadataWrite(client, LLM_MCP_SETTINGS_KEY)).toBeUndefined();
  });
});

// =========================================================================
// Step 2 — ensureSelfMcpClient two-table sync
// =========================================================================

describe("ensureSelfMcpClient — verify-before-reuse + transaction", () => {
  function clientWith({ metadataSecret, rowSecret, rowScopes, rowGrant, disabled = false }) {
    const metadata = metadataSecret
      ? {
          [MCP_SETTINGS_KEY]: {
            selfClient: { clientId: SELF_MCP_CLIENT_ID, clientSecret: metadataSecret },
          },
        }
      : {};
    return createMockClient({
      select(sql, params) {
        if (/from .*\.metadata/i.test(sql)) {
          const v = metadata[params[0]];
          return v ? { rows: [{ value: JSON.stringify(v) }], rowCount: 1 } : { rows: [], rowCount: 0 };
        }
        if (/from public\."oauthclient"/i.test(sql) && /select/i.test(sql)) {
          if (!rowSecret) return { rows: [], rowCount: 0 };
          return {
            rows: [
              {
                id: "self-row",
                createdAt: new Date("2025-01-01T00:00:00Z"),
                clientSecret: rowSecret,
                grantTypes: rowGrant ?? ["client_credentials"],
                scopes: rowScopes ?? [...SELF_MCP_CLIENT_SCOPES],
                disabled,
              },
            ],
            rowCount: 1,
          };
        }
        return undefined;
      },
    });
  }

  it("reuses the matching plaintext (no false rotation) inside a transaction", async () => {
    const plain = "self-plaintext-secret";
    const client = clientWith({ metadataSecret: plain, rowSecret: baHash(plain) });
    const mcpSettings = {
      current: { selfClient: { clientId: SELF_MCP_CLIENT_ID, clientSecret: plain } },
      next: {},
    };
    const result = await ensureSelfMcpClient(client, "cinatra", mcpSettings);
    expect(result.clientSecret).toBe(plain);
    expect(result.scope).toBe(SELF_MCP_CLIENT_SCOPE);
    const upsert = oauthUpserts(client)[0];
    expect(upsert.params[2]).toBe(baHash(plain));
    expect(client.tx.begins).toBe(1);
    expect(client.tx.commits).toBe(1);
  });

  it("mints fresh when the stored row hash drifted from the metadata plaintext", async () => {
    const plain = "self-plaintext-secret";
    const client = clientWith({ metadataSecret: plain, rowSecret: baHash("different") });
    const mcpSettings = {
      current: { selfClient: { clientId: SELF_MCP_CLIENT_ID, clientSecret: plain } },
      next: {},
    };
    const result = await ensureSelfMcpClient(client, "cinatra", mcpSettings);
    expect(result.clientSecret).not.toBe(plain);
    const written = lastMetadataWrite(client, MCP_SETTINGS_KEY);
    expect(written.selfClient.clientSecret).toBe(result.clientSecret);
    const upsert = oauthUpserts(client)[0];
    expect(upsert.params[2]).toBe(baHash(result.clientSecret));
  });

  it("runs the legacy-row cleanup DELETE INSIDE the transaction (after begin, before commit)", async () => {
    const plain = "self-plaintext-secret";
    const client = clientWith({ metadataSecret: plain, rowSecret: baHash(plain) });
    const mcpSettings = {
      current: { selfClient: { clientId: SELF_MCP_CLIENT_ID, clientSecret: plain } },
      next: {},
    };
    await ensureSelfMcpClient(client, "cinatra", mcpSettings);
    const idx = (re) => client.calls.findIndex((c) => re.test(c.sql));
    const beginIdx = idx(/^\s*begin\s*$/i);
    const deleteIdx = idx(/delete from public\."oauthclient"/i);
    const commitIdx = idx(/^\s*commit\s*$/i);
    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(deleteIdx).toBeGreaterThan(beginIdx);
    expect(commitIdx).toBeGreaterThan(deleteIdx);
  });

  it("rolls back the legacy DELETE + upsert + metadata write atomically on failure", async () => {
    const plain = "self-plaintext-secret";
    const client = clientWith({ metadataSecret: plain, rowSecret: baHash(plain) });
    const realQuery = client.query.bind(client);
    client.query = async (text, params) => {
      const sql = typeof text === "string" ? text : String(text);
      if (/insert into public\."oauthclient"/i.test(sql)) {
        client.calls.push({ sql, params });
        throw new Error("self upsert boom");
      }
      return realQuery(text, params);
    };
    const mcpSettings = {
      current: { selfClient: { clientId: SELF_MCP_CLIENT_ID, clientSecret: plain } },
      next: {},
    };
    await expect(ensureSelfMcpClient(client, "cinatra", mcpSettings)).rejects.toThrow(/self upsert boom/);
    expect(client.tx.begins).toBe(1);
    expect(client.tx.commits).toBe(0);
    expect(client.tx.rollbacks).toBe(1);
    expect(lastMetadataWrite(client, MCP_SETTINGS_KEY)).toBeUndefined();
  });
});

// =========================================================================
// Step 1 — probeTokenMint + ensureDecryptableJwks
// =========================================================================

describe("resolveLocalOrigin", () => {
  it("honors BETTER_AUTH_URL and strips trailing slashes", () => {
    expect(resolveLocalOrigin({ BETTER_AUTH_URL: "http://localhost:3011/" })).toBe("http://localhost:3011");
  });
  it("falls back to NEXT_PUBLIC_BETTER_AUTH_URL then localhost:3000", () => {
    expect(resolveLocalOrigin({ NEXT_PUBLIC_BETTER_AUTH_URL: "https://app.example" })).toBe("https://app.example");
    expect(resolveLocalOrigin({})).toBe("http://localhost:3000");
  });
});

describe("probeTokenMint — outcome classification", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("ok on a 2xx that returns a real access_token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"access_token":"x"}', { status: 200 })));
    const r = await probeTokenMint({ origin: "http://localhost:3000", clientId: "c", clientSecret: "s", scope: "mcp:connect" });
    expect(r.outcome).toBe("ok");
  });

  it("error (not ok) on a 2xx WITHOUT an access_token (misrouted 200 / malformed body)", async () => {
    // A 200 HTML page or an empty/garbage body must NOT be read as proof the
    // signing key is decryptable.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>login</html>", { status: 200 })));
    const r = await probeTokenMint({ origin: "http://localhost:3000", clientId: "c", clientSecret: "s", scope: "mcp:connect" });
    expect(r.outcome).toBe("error");
    expect(r.status).toBe(200);
  });

  it("app-down when the request phase times out (reachable but stalled route)", async () => {
    // fetch that respects the abort signal — never resolves until aborted.
    vi.stubGlobal(
      "fetch",
      vi.fn((_url, opts) =>
        new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          });
        }),
      ),
    );
    const r = await probeTokenMint({
      origin: "http://localhost:3000",
      clientId: "c",
      clientSecret: "s",
      scope: "mcp:connect",
      timeoutMs: 20,
    });
    expect(r.outcome).toBe("app-down");
  });

  it("app-down when the BODY stalls after headers (timer covers body read)", async () => {
    // A response whose headers arrived (.ok true) but whose body read aborts
    // because the timer fired during body consumption → app-down, never heal.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, opts) => ({
        ok: true,
        status: 200,
        async json() {
          await new Promise((_resolve, reject) => {
            if (opts?.signal?.aborted) {
              const e = new Error("aborted");
              e.name = "AbortError";
              reject(e);
              return;
            }
            opts?.signal?.addEventListener("abort", () => {
              const e = new Error("aborted");
              e.name = "AbortError";
              reject(e);
            });
          });
        },
        async text() {
          return "";
        },
      })),
    );
    const r = await probeTokenMint({
      origin: "http://localhost:3000",
      clientId: "c",
      clientSecret: "s",
      scope: "mcp:connect",
      timeoutMs: 20,
    });
    expect(r.outcome).toBe("app-down");
  });

  it("app-down when an error-response BODY stalls after headers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, opts) => ({
        ok: false,
        status: 500,
        async json() {
          return {};
        },
        async text() {
          await new Promise((_resolve, reject) => {
            opts?.signal?.addEventListener("abort", () => {
              const e = new Error("aborted");
              e.name = "AbortError";
              reject(e);
            });
          });
          return "";
        },
      })),
    );
    const r = await probeTokenMint({
      origin: "http://localhost:3000",
      clientId: "c",
      clientSecret: "s",
      scope: "mcp:connect",
      timeoutMs: 20,
    });
    expect(r.outcome).toBe("app-down");
  });

  it("decrypt-error ONLY on a 5xx carrying the exact marker", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(DECRYPT_ERROR_BODY, { status: 500 })));
    const r = await probeTokenMint({ origin: "http://localhost:3000", clientId: "c", clientSecret: "s", scope: "mcp:connect" });
    expect(r.outcome).toBe("decrypt-error");
    expect(r.status).toBe(500);
  });

  it("error (not decrypt) on a 500 WITHOUT the marker", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":"server_error"}', { status: 500 })));
    const r = await probeTokenMint({ origin: "http://localhost:3000", clientId: "c", clientSecret: "s", scope: "mcp:connect" });
    expect(r.outcome).toBe("error");
  });

  it("error (not decrypt) on a 4xx even if body somehow contains the marker", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(DECRYPT_ERROR_BODY, { status: 401 })));
    const r = await probeTokenMint({ origin: "http://localhost:3000", clientId: "c", clientSecret: "s", scope: "mcp:connect" });
    expect(r.outcome).toBe("error");
  });

  it("app-down when fetch throws (connection refused)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      const e = new Error("fetch failed");
      e.cause = { code: "ECONNREFUSED" };
      throw e;
    }));
    const r = await probeTokenMint({ origin: "http://localhost:3000", clientId: "c", clientSecret: "s", scope: "mcp:connect" });
    expect(r.outcome).toBe("app-down");
  });
});

describe("ensureDecryptableJwks — decrypt-error → delete-once self-heal", () => {
  const selfClient = { clientId: "cinatra-app-mcp-client", clientSecret: "secret-x", scope: "mcp:connect" };
  const env = { BETTER_AUTH_URL: "http://localhost:3000" };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  function jwksDeleteCalls(client) {
    return client.calls.filter((c) => /delete from public\."jwks"/i.test(c.sql));
  }

  it("healthy mint → no delete, status healthy", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"access_token":"x"}', { status: 200 })));
    const client = createMockClient();
    const r = await ensureDecryptableJwks(client, env, selfClient);
    expect(r.status).toBe("healthy");
    expect(jwksDeleteCalls(client)).toHaveLength(0);
  });

  it("decrypt-error → DELETEs the latest jwks row, retries once, heals", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(DECRYPT_ERROR_BODY, { status: 500 })) // probe
      .mockResolvedValueOnce(new Response('{"access_token":"x"}', { status: 200 })); // retry
    vi.stubGlobal("fetch", fetchMock);
    const client = createMockClient({
      select(sql) {
        if (/delete from public\."jwks"/i.test(sql)) return { rows: [], rowCount: 1 };
        return undefined;
      },
    });
    const r = await ensureDecryptableJwks(client, env, selfClient);
    expect(r.status).toBe("healed");
    expect(r.deleted).toBe(1);
    expect(r.retriedOk).toBe(true);
    expect(jwksDeleteCalls(client)).toHaveLength(1);
    // The DELETE is scoped to the single latest row (createdAt DESC limit 1).
    expect(jwksDeleteCalls(client)[0].sql).toMatch(/order by "createdAt" desc\s+limit 1/i);
    expect(fetchMock).toHaveBeenCalledTimes(2); // bounded single retry
  });

  it("app-down → SKIPS, never deletes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      const e = new Error("fetch failed");
      e.cause = { code: "ECONNREFUSED" };
      throw e;
    }));
    const client = createMockClient();
    const r = await ensureDecryptableJwks(client, env, selfClient);
    expect(r.status).toBe("skipped-app-down");
    expect(jwksDeleteCalls(client)).toHaveLength(0);
  });

  it("non-decrypt 500 → does NOT delete (loud-but-non-fatal)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":"server_error"}', { status: 500 })));
    const client = createMockClient();
    const r = await ensureDecryptableJwks(client, env, selfClient);
    expect(r.status).toBe("probe-error");
    expect(jwksDeleteCalls(client)).toHaveLength(0);
  });

  it("4xx → does NOT delete (not a JWKS fault)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad client", { status: 401 })));
    const client = createMockClient();
    const r = await ensureDecryptableJwks(client, env, selfClient);
    expect(r.status).toBe("probe-error");
    expect(jwksDeleteCalls(client)).toHaveLength(0);
  });

  it("decrypt-error but no row present → no-op delete, status decrypt-error-no-row", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(DECRYPT_ERROR_BODY, { status: 500 })));
    const client = createMockClient({
      select(sql) {
        if (/delete from public\."jwks"/i.test(sql)) return { rows: [], rowCount: 0 };
        return undefined;
      },
    });
    const r = await ensureDecryptableJwks(client, env, selfClient);
    expect(r.status).toBe("decrypt-error-no-row");
    expect(r.deleted).toBe(0);
  });

  it("decrypt-error, deleted, but verification mint still fails → healed-unverified", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(DECRYPT_ERROR_BODY, { status: 500 })) // probe
      .mockResolvedValueOnce(new Response(DECRYPT_ERROR_BODY, { status: 500 })); // retry still bad
    vi.stubGlobal("fetch", fetchMock);
    const client = createMockClient({
      select(sql) {
        if (/delete from public\."jwks"/i.test(sql)) return { rows: [], rowCount: 1 };
        return undefined;
      },
    });
    const r = await ensureDecryptableJwks(client, env, selfClient);
    expect(r.status).toBe("healed-unverified");
    expect(r.deleted).toBe(1);
    expect(r.retriedOk).toBe(false);
    // STILL only one delete — bounded, never loops.
    expect(jwksDeleteCalls(client)).toHaveLength(1);
  });

  it("skips with a warning when no self client credentials are available", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = createMockClient();
    const r = await ensureDecryptableJwks(client, env, { clientId: null, clientSecret: null });
    expect(r.status).toBe("skipped-no-client");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(jwksDeleteCalls(client)).toHaveLength(0);
  });
});

// =========================================================================
// Step 3 — ensureMcpSettings ownership-gated "preserve existing" branch
// =========================================================================
//
// The carry-forward must RELEASE a dead auto-provisioned (tailscale-auto /
// tailscale-funnel) URL when the later ensureDevPublicMcpUrl step owns
// re-validation (dev + no operator URL), so a dead hostname is replaced rather
// than survive a re-run. Operator ("manual") + legacy URLs still preserve.

describe("ensureMcpSettings — ownership-gated preserve (Step 3 item 3)", () => {
  function clientWithStored(row) {
    return createMockClient({
      select(sql, params) {
        if (/from .*\.metadata/i.test(sql) && params?.[0] === MCP_SETTINGS_KEY) {
          return { rows: [{ value: JSON.stringify(row) }], rowCount: 1 };
        }
        return undefined;
      },
    });
  }

  it("preserves an auto-provisioned URL by DEFAULT (no ownership gate)", async () => {
    const client = clientWithStored({
      publicBaseUrl: "https://cinatra-main.foo.ts.net",
      publicBaseUrlSource: "tailscale-auto",
    });
    const r = await ensureMcpSettings(client, "cinatra", null);
    expect(r.next.publicBaseUrl).toBe("https://cinatra-main.foo.ts.net");
  });

  it("RELEASES a dead auto-provisioned URL when ownershipGated (so Step 3 re-validates)", async () => {
    const client = clientWithStored({
      publicBaseUrl: "https://cinatra-main.foo.ts.net",
      publicBaseUrlSource: "tailscale-auto",
    });
    const r = await ensureMcpSettings(client, "cinatra", null, { ownershipGated: true });
    // Released → next is null (no incoming URL), so Step 3 owns re-establish.
    expect(r.next.publicBaseUrl).toBeNull();
  });

  it("STILL preserves an operator 'manual' URL even when ownershipGated", async () => {
    const client = clientWithStored({
      publicBaseUrl: "https://my-named-tunnel.example.com",
      publicBaseUrlSource: "manual",
    });
    const r = await ensureMcpSettings(client, "cinatra", null, { ownershipGated: true });
    expect(r.next.publicBaseUrl).toBe("https://my-named-tunnel.example.com");
  });

  it("STILL preserves a legacy/external URL even when ownershipGated", async () => {
    const client = clientWithStored({
      publicBaseUrl: "https://legacy.example.com",
      publicBaseUrlSource: "external",
    });
    const r = await ensureMcpSettings(client, "cinatra", null, { ownershipGated: true });
    expect(r.next.publicBaseUrl).toBe("https://legacy.example.com");
  });
});

// =========================================================================
// Step 3 — ensureDevPublicMcpUrl (self-establishing + self-healing URL)
// =========================================================================
//
// All hermetic: the Docker / Tailscale / tunnel-bring-up / DB boundaries are
// injected via `deps`. No Docker, no Tailscale, no live DB, no poller.

describe("ensureDevPublicMcpUrl — Step 3 self-establish + self-heal", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // A `deps` factory whose defaults make the helper behave as "sidecar down,
  // nothing established". Each test overrides only the seams it exercises.
  function makeDeps(overrides = {}) {
    return {
      composePathExists: () => true,
      composeAvailable: () => true,
      composeProjectUp: () => false, // sidecar down by default
      waitForTailscaleFunnelUrl: async () => null,
      verifyRegisteredHostnameMatchesPrediction: async () => ({
        ok: false,
        predicted: "cinatra-main",
        registered: "",
      }),
      runDevTunnel: vi.fn(async () => undefined),
      writeClonePublicBaseUrl: vi.fn(async () => undefined),
      readStoredMcpSettings: async () => ({}),
      ...overrides,
    };
  }

  // --- honor operator / env URLs -----------------------------------------

  it("HONORS an explicit env MCP_PUBLIC_BASE_URL — no docker, no bring-up, and RECONCILES the DB to it", async () => {
    const deps = makeDeps();
    const r = await ensureDevPublicMcpUrl({
      dbUrl: "postgres://x",
      schemaName: "cinatra",
      env: { MCP_PUBLIC_BASE_URL: "https://operator.example.com" },
      operatorUrl: { url: null },
      deps,
    });
    expect(r.status).toBe("operator-url");
    expect(r.owned).toBe(true);
    expect(r.publicBaseUrl).toBe("https://operator.example.com");
    expect(deps.runDevTunnel).not.toHaveBeenCalled();
    // codex must-fix: a stale auto row must not survive while the summary shows
    // the operator URL → the DB is reconciled to the operator URL, source
    // "manual", in the resolved schema.
    expect(deps.writeClonePublicBaseUrl).toHaveBeenCalledTimes(1);
    expect(deps.writeClonePublicBaseUrl.mock.calls[0][1]).toBe("https://operator.example.com");
    expect(deps.writeClonePublicBaseUrl.mock.calls[0][2]).toMatchObject({
      source: "manual",
      schemaName: "cinatra",
    });
  });

  it("reconciles the operator URL into the RESOLVED schema, never a hardcoded 'cinatra'", async () => {
    const deps = makeDeps();
    await ensureDevPublicMcpUrl({
      dbUrl: "postgres://x",
      schemaName: "branch_7",
      env: { MCP_PUBLIC_BASE_URL: "https://operator.example.com" },
      operatorUrl: { url: null },
      deps,
    });
    expect(deps.writeClonePublicBaseUrl.mock.calls[0][2]).toMatchObject({
      schemaName: "branch_7",
    });
  });

  it("does NOT treat a localhost BETTER_AUTH_URL fallback as an operator URL", async () => {
    // A localhost APP_PUBLIC_URL must NOT count as operator intent to publish,
    // so the self-establish path proceeds (here: bring-up, which we let fail).
    const deps = makeDeps({ runDevTunnel: vi.fn(async () => { throw new Error("no authkey"); }) });
    const r = await ensureDevPublicMcpUrl({
      dbUrl: "postgres://x",
      schemaName: "cinatra",
      env: { APP_PUBLIC_URL: "http://localhost:3000" },
      operatorUrl: { url: null },
      deps,
    });
    expect(r.status).toBe("bring-up-failed");
    expect(deps.runDevTunnel).toHaveBeenCalledTimes(1);
  });

  it("HONORS a stored operator 'manual' URL — never overrides it", async () => {
    const deps = makeDeps({
      readStoredMcpSettings: async () => ({
        publicBaseUrl: "https://operator-pasted.example.com",
        publicBaseUrlSource: "manual",
      }),
    });
    const r = await ensureDevPublicMcpUrl({
      dbUrl: "postgres://x",
      schemaName: "cinatra",
      env: {},
      operatorUrl: { url: null },
      deps,
    });
    expect(r.status).toBe("operator-url");
    expect(r.publicBaseUrl).toBe("https://operator-pasted.example.com");
    expect(deps.runDevTunnel).not.toHaveBeenCalled();
    expect(deps.writeClonePublicBaseUrl).not.toHaveBeenCalled();
  });

  // --- ownership validation (source/ownership, NOT reachability) ----------

  it("OWNED: sidecar up + funnel matches prediction → rewrites the live URL (no bring-up)", async () => {
    const deps = makeDeps({
      composeProjectUp: () => true,
      waitForTailscaleFunnelUrl: async () => ({
        url: "https://cinatra-main.foo.ts.net",
        registeredDnsName: "cinatra-main.foo.ts.net.",
      }),
      verifyRegisteredHostnameMatchesPrediction: async () => ({
        ok: true,
        predicted: "cinatra-main",
        registered: "cinatra-main",
      }),
      readStoredMcpSettings: async () => ({
        publicBaseUrl: "https://cinatra-main.foo.ts.net",
        publicBaseUrlSource: "tailscale-auto",
      }),
    });
    const r = await ensureDevPublicMcpUrl({
      dbUrl: "postgres://x",
      schemaName: "cinatra",
      env: {},
      operatorUrl: { url: null },
      deps,
    });
    expect(r.owned).toBe(true);
    expect(r.status).toBe("owned"); // stored === live → idempotent rewrite
    expect(r.broughtUp).toBe(false);
    expect(deps.runDevTunnel).not.toHaveBeenCalled();
    expect(deps.writeClonePublicBaseUrl).toHaveBeenCalledTimes(1);
  });

  it("OWNED but the write FAILS → reported NOT owned (loud warning fires; codex must-fix #2)", async () => {
    // The sidecar-already-up owned path: a write failure must NOT be reported
    // owned/established, or the loud summary warning (gated on !owned) is
    // suppressed — especially when ensureMcpSettings just released the old auto
    // URL, leaving the DB row empty.
    const deps = makeDeps({
      composeProjectUp: () => true,
      waitForTailscaleFunnelUrl: async () => ({
        url: "https://cinatra-main.foo.ts.net",
        registeredDnsName: "cinatra-main.foo.ts.net.",
      }),
      verifyRegisteredHostnameMatchesPrediction: async () => ({
        ok: true,
        predicted: "cinatra-main",
        registered: "cinatra-main",
      }),
      readStoredMcpSettings: async () => ({}), // released → empty
      writeClonePublicBaseUrl: vi.fn(async () => {
        throw new Error("owned-path write boom");
      }),
    });
    const r = await ensureDevPublicMcpUrl({
      dbUrl: "postgres://x",
      schemaName: "cinatra",
      env: {},
      operatorUrl: { url: null },
      deps,
    });
    expect(r.status).toBe("write-failed");
    expect(r.owned).toBe(false);
    expect(r.publicBaseUrl).toBeNull();
    expect(r.fixHint).toBe("cinatra dev tunnel start");
  });

  it("FRESH-NXDOMAIN-NOT-DEAD: a just-provisioned (un-propagated) matching URL is OWNED, never torn down", async () => {
    // The point of source/ownership validation: even though this URL would
    // NXDOMAIN (no reachability probe is performed), the node identity matches
    // the prediction, so it is owned and (re)written — NOT classified dead.
    const writeSpy = vi.fn(async () => undefined);
    const deps = makeDeps({
      composeProjectUp: () => true,
      waitForTailscaleFunnelUrl: async () => ({
        url: "https://cinatra-main.foo.ts.net",
        registeredDnsName: "cinatra-main.foo.ts.net.",
      }),
      verifyRegisteredHostnameMatchesPrediction: async () => ({
        ok: true,
        predicted: "cinatra-main",
        registered: "cinatra-main",
      }),
      // Stored URL is empty → the live owned URL must be written, not skipped.
      readStoredMcpSettings: async () => ({}),
      writeClonePublicBaseUrl: writeSpy,
    });
    const r = await ensureDevPublicMcpUrl({
      dbUrl: "postgres://x",
      schemaName: "cinatra",
      env: {},
      operatorUrl: { url: null },
      deps,
    });
    expect(r.owned).toBe(true);
    expect(r.status).toBe("rewritten"); // was missing → now established from live
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy.mock.calls[0][1]).toBe("https://cinatra-main.foo.ts.net");
  });

  it("HOSTNAME-MISMATCH: sidecar up but registered hostname collides → NO bring-up, NO write, loud fixHint", async () => {
    const deps = makeDeps({
      composeProjectUp: () => true,
      waitForTailscaleFunnelUrl: async () => ({
        url: "https://cinatra-main-1.foo.ts.net",
        registeredDnsName: "cinatra-main-1.foo.ts.net.",
      }),
      verifyRegisteredHostnameMatchesPrediction: async () => ({
        ok: false,
        predicted: "cinatra-main",
        registered: "cinatra-main-1",
      }),
    });
    const r = await ensureDevPublicMcpUrl({
      dbUrl: "postgres://x",
      schemaName: "cinatra",
      env: {},
      operatorUrl: { url: null },
      deps,
    });
    expect(r.owned).toBe(false);
    expect(r.status).toBe("hostname-mismatch");
    // fixHint must be an ESTABLISHING command, not the diagnostic `status`.
    expect(r.fixHint).toBe("cinatra dev tunnel stop && cinatra dev tunnel start");
    expect(r.fixHint).not.toContain("status");
    expect(deps.runDevTunnel).not.toHaveBeenCalled();
    expect(deps.writeClonePublicBaseUrl).not.toHaveBeenCalled();
  });

  // --- auto-bring-up (conditional + soft-fail) ----------------------------

  it("AUTO-BRING-UP: sidecar down → calls runDevTunnel(['start']) then writes the established URL", async () => {
    let up = false;
    const deps = makeDeps({
      composeProjectUp: () => up, // down until runDevTunnel flips it
      runDevTunnel: vi.fn(async (argv) => {
        expect(argv).toEqual(["start"]);
        up = true;
      }),
      waitForTailscaleFunnelUrl: async () =>
        up
          ? { url: "https://cinatra-main.foo.ts.net", registeredDnsName: "cinatra-main.foo.ts.net." }
          : null,
      verifyRegisteredHostnameMatchesPrediction: async ({ registered }) =>
        registered
          ? { ok: true, predicted: "cinatra-main", registered: "cinatra-main" }
          : { ok: false, predicted: "cinatra-main", registered: "" },
    });
    const r = await ensureDevPublicMcpUrl({
      dbUrl: "postgres://x",
      schemaName: "cinatra",
      env: {},
      operatorUrl: { url: null },
      deps,
    });
    expect(deps.runDevTunnel).toHaveBeenCalledTimes(1);
    expect(r.broughtUp).toBe(true);
    expect(r.owned).toBe(true);
    expect(r.status).toBe("established");
    expect(deps.writeClonePublicBaseUrl).toHaveBeenCalledTimes(1);
  });

  it("AUTO-BRING-UP SOFT-FAIL: runDevTunnel throws → status bring-up-failed, fixHint set, NEVER throws", async () => {
    const deps = makeDeps({
      runDevTunnel: vi.fn(async () => {
        throw new Error("No Tailscale auth-key: set TS_AUTHKEY or connect Tailscale");
      }),
    });
    const r = await ensureDevPublicMcpUrl({
      dbUrl: "postgres://x",
      schemaName: "cinatra",
      env: {},
      operatorUrl: { url: null },
      deps,
    });
    expect(r.status).toBe("bring-up-failed");
    expect(r.owned).toBe(false);
    expect(r.broughtUp).toBe(false);
    expect(r.fixHint).toBe("cinatra dev tunnel start");
    expect(deps.writeClonePublicBaseUrl).not.toHaveBeenCalled();
  });

  it("BROUGHT UP but no owned URL surfaced (collision/propagation) → established-unverified, soft-fail", async () => {
    let up = false; // down initially → takes the bring-up path
    const deps = makeDeps({
      composeProjectUp: () => up,
      runDevTunnel: vi.fn(async () => {
        up = true; // up after bring-up, but the funnel never surfaces a DNSName
      }),
      waitForTailscaleFunnelUrl: async () => null, // never surfaces a DNSName in the bound
    });
    const r = await ensureDevPublicMcpUrl({
      dbUrl: "postgres://x",
      schemaName: "cinatra",
      env: {},
      operatorUrl: { url: null },
      deps,
    });
    expect(r.broughtUp).toBe(true);
    expect(r.owned).toBe(false);
    expect(r.status).toBe("established-unverified");
    // fixHint names the ESTABLISHING command (not the diagnostic `status`).
    expect(r.fixHint).toBe("cinatra dev tunnel start");
    expect(deps.writeClonePublicBaseUrl).not.toHaveBeenCalled();
  });

  it("BROUGHT UP + owned, but the RESOLVED-SCHEMA write FAILS → reported NOT established (loud warning fires)", async () => {
    // codex must-fix: a write failure must NOT be reported as established/owned,
    // or the loud summary warning (gated on !owned) would be suppressed.
    let up = false;
    const deps = makeDeps({
      composeProjectUp: () => up,
      runDevTunnel: vi.fn(async () => {
        up = true;
      }),
      waitForTailscaleFunnelUrl: async () =>
        up
          ? { url: "https://cinatra-main.foo.ts.net", registeredDnsName: "cinatra-main.foo.ts.net." }
          : null,
      verifyRegisteredHostnameMatchesPrediction: async ({ registered }) =>
        registered
          ? { ok: true, predicted: "cinatra-main", registered: "cinatra-main" }
          : { ok: false, predicted: "cinatra-main", registered: "" },
      writeClonePublicBaseUrl: vi.fn(async () => {
        throw new Error("resolved-schema write boom");
      }),
    });
    const r = await ensureDevPublicMcpUrl({
      dbUrl: "postgres://x",
      schemaName: "cinatra",
      env: {},
      operatorUrl: { url: null },
      deps,
    });
    expect(r.broughtUp).toBe(true);
    expect(r.owned).toBe(false); // NOT owned → loud summary warning will fire
    expect(r.status).toBe("established-write-failed");
    expect(r.fixHint).toBe("cinatra dev tunnel start");
  });

  // --- honor schemaName (codex must-fix) ----------------------------------

  it("HONORS schemaName: the read AND the write use the RESOLVED schema, never a hardcoded 'cinatra'", async () => {
    const readSchemas = [];
    const writeSpy = vi.fn(async () => undefined);
    const verifySchemas = [];
    const deps = makeDeps({
      composeProjectUp: () => true,
      readStoredMcpSettings: async (_conn, schema) => {
        readSchemas.push(schema);
        return {};
      },
      waitForTailscaleFunnelUrl: async () => ({
        url: "https://cinatra-myschema.foo.ts.net",
        registeredDnsName: "cinatra-myschema.foo.ts.net.",
      }),
      verifyRegisteredHostnameMatchesPrediction: async ({ schema }) => {
        verifySchemas.push(schema);
        return { ok: true, predicted: "cinatra-myschema", registered: "cinatra-myschema" };
      },
      writeClonePublicBaseUrl: writeSpy,
    });
    const r = await ensureDevPublicMcpUrl({
      dbUrl: "postgres://x",
      schemaName: "branch_42",
      env: {},
      operatorUrl: { url: null },
      deps,
    });
    expect(r.owned).toBe(true);
    expect(readSchemas).toContain("branch_42");
    expect(verifySchemas).toContain("branch_42");
    // The write must thread the resolved schema (codex must-fix).
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy.mock.calls[0][2]).toMatchObject({ schemaName: "branch_42" });
  });

  it("skips cleanly with no DB url (no docker, no bring-up)", async () => {
    const deps = makeDeps();
    const r = await ensureDevPublicMcpUrl({
      dbUrl: null,
      schemaName: "cinatra",
      env: {},
      operatorUrl: { url: null },
      deps,
    });
    expect(r.status).toBe("skipped-no-db");
    expect(deps.runDevTunnel).not.toHaveBeenCalled();
  });
});

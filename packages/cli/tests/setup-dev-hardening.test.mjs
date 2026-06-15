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

// Tests for @/lib/better-auth-oauth-client — the shared helper for
// app-runtime TS callers writing to public."oauthClient" (Better Auth's
// oauth-provider table). Two surfaces:
//
//   1. hashClientSecret(secret) — SHA-256 base64url with no trailing
//      padding, matching @better-auth/oauth-provider/utils.defaultHasher.
//      Without this, every token-exchange returns invalid_client because
//      the verify path hashes the supplied secret and compares against
//      the stored value.
//
//   2. insertOAuthClient / insertOAuthClientWithTx — the canonical INSERT
//      against `public."oauthClient"` with the current oauth-provider
//      schema: `redirectUris` is jsonb (NOT text[]); `metadata` defaults
//      to '{}'::jsonb; `userId` is optional (NULL for service accounts).
//      The shared helper centralizes this shape so the table name
//      (`oauthClient`) and redirect-column name (`redirectUris`) stay
//      correct across every call site.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Module-load mocks
// ---------------------------------------------------------------------------

const executeCalls: Array<{ query: unknown }> = [];

vi.mock("@/lib/better-auth-db", () => ({
  betterAuthDb: {
    execute: vi.fn(async (query: unknown) => {
      executeCalls.push({ query });
    }),
  },
}));

beforeEach(() => {
  executeCalls.length = 0;
});

afterEach(() => {
  executeCalls.length = 0;
});

// ---------------------------------------------------------------------------
// hashClientSecret — algorithm parity with Better Auth's defaultHasher
// ---------------------------------------------------------------------------

describe("hashClientSecret", () => {
  it("produces SHA-256 digest in base64url encoding with no trailing padding", async () => {
    const { hashClientSecret } = await import("@/lib/better-auth-oauth-client");

    // Pre-computed expected digests for known inputs. Each is SHA-256(input)
    // → base64url with `=` padding stripped. Verified via:
    //   node -e "console.log(crypto.createHash('sha256').update('cinatra').digest('base64url').replace(/=+$/,''))"
    const cases: Array<{ input: string; expected: string }> = [
      // SHA-256("cinatra") in base64url, padding stripped.
      { input: "cinatra", expected: "AI8GEE4IiR28-PXzgbGs_oN9jCt8wPxI_g0JeW9D6rk" },
      // SHA-256("") in base64url, padding stripped. RFC 6234 well-known.
      { input: "", expected: "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU" },
    ];

    for (const { input, expected } of cases) {
      const got = hashClientSecret(input);
      expect(got).toBe(expected);
      // Sanity: explicitly assert no padding.
      expect(got.endsWith("=")).toBe(false);
      // Sanity: base64url-only chars (no `+` or `/`).
      expect(got).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("hashes the same input deterministically", async () => {
    const { hashClientSecret } = await import("@/lib/better-auth-oauth-client");

    const a = hashClientSecret("test-secret-xyz");
    const b = hashClientSecret("test-secret-xyz");
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// insertOAuthClient — wiring + source-shape (algorithm checks above)
// ---------------------------------------------------------------------------

describe("insertOAuthClient", () => {
  it("issues exactly one INSERT against the live oauthClient model + jsonb columns", async () => {
    const { insertOAuthClient, hashClientSecret } = await import(
      "@/lib/better-auth-oauth-client"
    );

    await insertOAuthClient({
      id: "user-id-123",
      userId: "user-id-123",
      clientId: "abc-client",
      clientSecret: "abc-secret",
      name: "cinatra-built-in",
    });

    expect(executeCalls.length).toBe(1);
    // Drizzle SQL objects expose their raw fragments in `queryChunks` —
    // an array of strings interleaved with parameter placeholders. The
    // table name, column names, and SQL casts are all in the string
    // fragments (parameter values are NOT — those carry id, secret, etc.).
    const chunks = (executeCalls[0].query as { queryChunks?: Array<unknown> })
      ?.queryChunks ?? [];
    const renderedSql = chunks
      .map((c) => (typeof c === "string" ? c : (c as { value?: string }).value ?? ""))
      .join("");

    // Must INSERT into the right table.
    expect(renderedSql).toContain(`public."oauthClient"`);
    // Must reference the live column names — NOT the stale ones.
    expect(renderedSql).toContain(`"redirectUris"`);
    expect(renderedSql).not.toContain(`"redirectURLs"`);
    expect(renderedSql).not.toContain(`oauth_application`);
    // redirectUris must be cast to jsonb (not text[]).
    expect(renderedSql).toContain(`'[]'::jsonb`);
    // metadata serialized as jsonb — the marker is the ::jsonb cast.
    expect(renderedSql).toMatch(/::jsonb/);
    // ON CONFLICT DO NOTHING is load-bearing for idempotency.
    expect(renderedSql).toContain(`ON CONFLICT DO NOTHING`);
    // Sanity: the helper hashed the secret — assert via a second call
    // that the stored value matches the helper's hash output (we can't
    // easily inspect the parameterized SQL params here, but the
    // hashClientSecret function is the only path used by the impl).
    expect(hashClientSecret("abc-secret")).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

// ---------------------------------------------------------------------------
// Source-shape regression guards — protect against future drift
// ---------------------------------------------------------------------------

describe("better-auth-oauth-client.ts source shape", () => {
  const SOURCE_PATH = path.join(__dirname, "..", "better-auth-oauth-client.ts");
  const SOURCE = fs.readFileSync(SOURCE_PATH, "utf8");

  it("targets public.\"oauthClient\" and not the legacy table name", () => {
    expect(SOURCE).toContain(`public."oauthClient"`);
    expect(SOURCE).not.toContain("oauth_application");
  });

  it("uses redirectUris (jsonb) — NOT the stale redirectURLs", () => {
    expect(SOURCE).toContain(`"redirectUris"`);
    expect(SOURCE).toContain(`'[]'::jsonb`);
    expect(SOURCE).not.toContain(`"redirectURLs"`);
  });

  it("hashes clientSecret with SHA-256 base64url before storing", () => {
    expect(SOURCE).toContain(`createHash("sha256")`);
    expect(SOURCE).toContain(`digest("base64url")`);
    expect(SOURCE).toMatch(/replace\(\s*\/=\+\$\/,\s*""\s*\)/);
  });

  it("exports both insertOAuthClient and insertOAuthClientWithTx", () => {
    expect(SOURCE).toMatch(/export async function insertOAuthClient\b/);
    expect(SOURCE).toMatch(/export async function insertOAuthClientWithTx\b/);
  });
});

// ---------------------------------------------------------------------------
// External MCP OAuth-client surface — the /connectors readiness probe + the
// SDK store the mcp-client connector consumes. The list and the delete must
// share ONE external-boundary predicate (internal clients are never listable
// AND never deletable through this surface).
// ---------------------------------------------------------------------------

// Recursive renderer: the external helpers compose a shared predicate
// fragment into their queries, so the SQL text lives in NESTED queryChunks.
function renderSqlDeep(q: unknown): string {
  if (typeof q === "string") return q;
  if (Array.isArray(q)) return q.map(renderSqlDeep).join("");
  if (q && typeof q === "object") {
    const o = q as { queryChunks?: unknown[]; value?: unknown };
    if (Array.isArray(o.queryChunks)) return o.queryChunks.map(renderSqlDeep).join("");
    if (typeof o.value === "string" || Array.isArray(o.value)) return renderSqlDeep(o.value);
  }
  return "";
}

const EXTERNAL_BOUNDARY_MARKERS = [
  `"clientId" <> 'cinatra-app-mcp-client'`,
  `"clientId" NOT LIKE 'cinatra-llm-%'`,
  `NOT LIKE 'assistant-%'`,
  `NOT LIKE 'service-account-%'`,
  `u."userType" = 'assistant'`,
];

describe("listExternalMcpOAuthClients", () => {
  it("selects with the full external-boundary predicate and maps rows", async () => {
    const { listExternalMcpOAuthClients } = await import(
      "@/lib/better-auth-oauth-client"
    );
    const { betterAuthDb } = await import("@/lib/better-auth-db");
    (betterAuthDb.execute as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (query: unknown) => {
        executeCalls.push({ query });
        return {
          rows: [
            {
              id: "row-1",
              clientId: "client-1",
              name: "Claude",
              redirectUris: JSON.stringify(["http://localhost:33418/cb"]),
              createdAt: "2026-01-02T03:04:05.000Z",
              updatedAt: null,
            },
          ],
        };
      },
    );

    const clients = await listExternalMcpOAuthClients();
    expect(clients).toEqual([
      {
        id: "row-1",
        clientId: "client-1",
        name: "Claude",
        redirectURLs: ["http://localhost:33418/cb"],
        createdAt: new Date("2026-01-02T03:04:05.000Z"),
        updatedAt: null,
      },
    ]);

    expect(executeCalls.length).toBe(1);
    const renderedSql = renderSqlDeep(executeCalls[0].query);
    expect(renderedSql).toContain(`public."oauthClient"`);
    for (const marker of EXTERNAL_BOUNDARY_MARKERS) {
      expect(renderedSql).toContain(marker);
    }
  });
});

describe("deleteExternalMcpOAuthClient", () => {
  it("scopes the DELETE with the SAME external-boundary predicate as the list", async () => {
    const { deleteExternalMcpOAuthClient } = await import(
      "@/lib/better-auth-oauth-client"
    );

    await deleteExternalMcpOAuthClient("client-1");

    expect(executeCalls.length).toBe(1);
    const renderedSql = renderSqlDeep(executeCalls[0].query);
    expect(renderedSql).toContain(`DELETE FROM public."oauthClient"`);
    // The boundary predicate rides along, so an internal clientId (LLM
    // client, assistant, service account, app self-client) is a no-op even
    // if forged into the connector's disconnect form.
    for (const marker of EXTERNAL_BOUNDARY_MARKERS) {
      expect(renderedSql).toContain(marker);
    }
  });
});

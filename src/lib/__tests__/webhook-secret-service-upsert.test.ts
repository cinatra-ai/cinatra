// Service-level coverage for the webhook-secret-service tuple-scoped upserts
// (cinatra#343 legacy bridge, cinatra#974 standard bindings). pg and the
// secretsCodec are mocked so this pins the LOGIC each upsert arm executes —
// which SQL runs, under which field-scoped AAD each blob is (re-)encrypted,
// and that the bindingId is preserved — in the default CI tier (the real
// DB semantics are exercised on the live verify stack, not here).
//
// The conversion arms matter for cinatra#974's WordPress half: an updated
// plugin negotiating `webhook_contract: "standard-webhooks"` re-provisions a
// site whose binding was previously LEGACY-bridged (upsertStandard must
// convert in place), and a rolled-back old plugin re-provisions a STANDARD
// binding back to legacy (upsertLegacy must re-enable the bridge) — both
// WITHOUT changing the bindingId the sender's stored inbound URL carries.

import { beforeEach, describe, expect, it, vi } from "vitest";

interface CapturedQuery {
  sql: string;
  params: unknown[];
}

const captured = vi.hoisted(() => ({
  queries: [] as CapturedQuery[],
  // Rows the next SELECT ... FOR UPDATE returns (the existing-binding lookup).
  selectRows: [] as Record<string, unknown>[],
}));

vi.mock("pg", () => {
  class FakePool {
    on() {
      return this;
    }
    listenerCount() {
      return 1;
    }
    async query(sql: string, params: unknown[] = []) {
      captured.queries.push({ sql, params });
      return { rows: [], rowCount: 0 };
    }
    async connect() {
      return {
        query: async (sql: string, params: unknown[] = []) => {
          captured.queries.push({ sql, params });
          if (/SELECT/i.test(sql) && /FOR UPDATE/i.test(sql)) {
            return { rows: captured.selectRows, rowCount: captured.selectRows.length };
          }
          return { rows: [], rowCount: 1 };
        },
        release: () => undefined,
      };
    }
  }
  return { Pool: FakePool };
});

vi.mock("@/lib/postgres-config", () => ({
  getPostgresConnectionString: () => "postgres://mocked/db",
  postgresSchema: "public",
}));

// Reversible fake codec: the "ciphertext" embeds plaintext + AAD so tests can
// assert WHICH value was encrypted under WHICH field-scoped AAD, and decrypt
// verifies the AAD it is asked to open with matches the one it was sealed
// under (the codec invariant the real AES-GCM AAD enforces).
vi.mock("@/lib/instance-secrets", () => ({
  encryptSecret: (plain: string, aad: string) => ({
    ciphertext: `ct|${plain}|${aad}`,
    iv: "iv",
  }),
  decryptSecret: (blob: { ciphertext: string }, aad: string) => {
    const [, plain, sealedAad] = blob.ciphertext.split("|");
    if (sealedAad !== aad) throw new Error(`AAD mismatch: ${sealedAad} != ${aad}`);
    return plain;
  },
}));

import { webhookSecretService } from "@/lib/webhook-secret-service";

const TUPLE = {
  vendor: "cinatra-ai",
  slug: "wordpress-mcp-connector",
  hook: "post-published",
  siteId: "site-1",
} as const;

function updates(): CapturedQuery[] {
  return captured.queries.filter((q) => /^\s*UPDATE/i.test(q.sql));
}
function inserts(): CapturedQuery[] {
  return captured.queries.filter((q) => /^\s*INSERT/i.test(q.sql));
}

beforeEach(() => {
  captured.queries.length = 0;
  captured.selectRows.length = 0;
});

describe("upsertStandard — legacy→standard CONVERSION (cinatra#974 WordPress reconnect)", () => {
  it("converts the existing legacy row in place: legacy columns cleared, bindingId preserved, new secret under the current AAD", async () => {
    captured.selectRows.push({
      binding_id: "b-legacy-1",
      legacy_enabled: true,
      // The legacy row's current column is an UNUSED placeholder.
      current_secret_ciphertext: "ct|placeholder|webhook-binding.b-legacy-1.current",
      current_secret_iv: "iv",
    });
    const r = await webhookSecretService.upsertStandard({ ...TUPLE, secret: "whsec_new" });
    // bindingId preserved — the plugin's stored inbound URL stays valid.
    expect(r).toEqual({ bindingId: "b-legacy-1", secret: "whsec_new" });
    expect(inserts()).toHaveLength(0);
    const [u] = updates();
    expect(u).toBeDefined();
    // One statement: install the new current, DISABLE the legacy bridge, clear
    // the legacy blobs AND the previous window (the placeholder current was
    // never handed to any sender — nothing to keep verifying).
    expect(u.sql).toMatch(/legacy_enabled\s*=\s*false/);
    expect(u.sql).toMatch(/legacy_secret_ciphertext\s*=\s*NULL/);
    expect(u.sql).toMatch(/legacy_secret_iv\s*=\s*NULL/);
    expect(u.sql).toMatch(/previous_secret_ciphertext\s*=\s*NULL/);
    expect(u.sql).toMatch(/rotated_at\s*=\s*now\(\)/);
    // Addressed by the SAME bindingId; new secret sealed under ITS current AAD.
    expect(u.params[0]).toBe("b-legacy-1");
    expect(u.params[1]).toBe("ct|whsec_new|webhook-binding.b-legacy-1.current");
  });

  it("rotates an existing STANDARD row through the dual-secret window (outgoing current re-sealed under the previous AAD)", async () => {
    captured.selectRows.push({
      binding_id: "b-std-1",
      legacy_enabled: false,
      current_secret_ciphertext: "ct|whsec_old|webhook-binding.b-std-1.current",
      current_secret_iv: "iv",
    });
    const r = await webhookSecretService.upsertStandard({ ...TUPLE, secret: "whsec_new" });
    expect(r).toEqual({ bindingId: "b-std-1", secret: "whsec_new" });
    const [u] = updates();
    expect(u.sql).toMatch(/previous_secret_ciphertext\s*=\s*\$2/);
    expect(u.sql).toMatch(/previous_expires_at\s*=\s*now\(\)\s*\+/);
    // The outgoing current moved to previous under the PREVIOUS field AAD; the
    // fresh secret installed as current under the CURRENT field AAD.
    expect(u.params[0]).toBe("b-std-1");
    expect(u.params[1]).toBe("ct|whsec_old|webhook-binding.b-std-1.previous");
    expect(u.params[4]).toBe("ct|whsec_new|webhook-binding.b-std-1.current");
  });

  it("INSERTs a fresh non-legacy binding when the tuple has no active row", async () => {
    const r = await webhookSecretService.upsertStandard({ ...TUPLE, secret: "whsec_new" });
    expect(r.secret).toBe("whsec_new");
    expect(r.bindingId).toBeTruthy();
    expect(updates()).toHaveLength(0);
    const [i] = inserts();
    expect(i.sql).toMatch(/INSERT INTO/);
    expect(i.sql).toMatch(/false,\s*NULL,\s*NULL,\s*now\(\)/);
    expect(i.params[0]).toBe(r.bindingId);
    expect(i.params[5]).toBe(`ct|whsec_new|webhook-binding.${r.bindingId}.current`);
  });
});

describe("upsertLegacy — standard→legacy RE-ENABLE (rolled-back old plugin reconnect)", () => {
  it("re-enables the legacy bridge on the existing row, preserving the bindingId", async () => {
    captured.selectRows.push({ binding_id: "b-std-2" });
    const r = await webhookSecretService.upsertLegacy({ ...TUPLE, legacySecret: "shared-1" });
    expect(r).toEqual({ bindingId: "b-std-2", secret: "shared-1" });
    const [u] = updates();
    expect(u.sql).toMatch(/legacy_enabled\s*=\s*true/);
    expect(u.params[0]).toBe("b-std-2");
    // The shared secret is sealed under THIS binding's legacy field AAD.
    expect(u.params[1]).toBe("ct|shared-1|webhook-binding.b-std-2.legacy");
  });
});

import "server-only";

// Host-backed per-webhook / per-site secret service (cinatra#340).
//
// Concrete WebhookSecretService over the `webhook_secret_bindings` table + the
// host secretsCodec (src/lib/instance-secrets encryptSecret/decryptSecret —
// AES-256-GCM over the instance key). The binding row stores the ENCRYPTED
// secret BLOB (ciphertext + iv), not a ref; field-scoped AAD
// (`webhook-binding.<binding_id>.<field>`) binds each blob to its column so the
// current/previous blobs cannot be swapped (D3b).
//
// Rotation is a bounded dual-secret window (single txn): current → previous
// (valid until previous_expires_at), a fresh current installed, rotated_at
// stamped (a concurrency guard). resolveByBindingId returns the candidate
// secrets the route verifies against (current, then a non-expired previous).
//
// #343: the legacy single-shared-secret bridge (D3c option A). A binding minted
// with legacyEnabled stores the bridged shared HMAC secret ENCRYPTED in the
// legacy_secret_ciphertext/iv columns under a field-scoped AAD ("legacy");
// resolveByBindingId returns it as `legacySecret` (with empty `secrets`) so the
// route verifies the in-field plugin's bespoke `sha256=<hex>` HMAC instead of
// Standard-Webhooks. `upsertLegacy` is the tuple-scoped idempotent provisioning
// entry point (reconnect/rotation-safe; preserves the bindingId).

import { Pool } from "pg";
import {
  encryptSecret,
  decryptSecret,
} from "@/lib/instance-secrets";
import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
import {
  mintWebhookSecret,
  mintBindingId,
  type WebhookSecretService,
  type ResolvedBinding,
  type MintBindingInput,
  type MintedBinding,
  type UpsertLegacyBindingInput,
} from "@cinatra-ai/webhooks";

// Bounded dual-secret rotation window: the previous secret stays valid this
// long after a rotation so a webhook in flight signed under the old secret
// still verifies. Five minutes comfortably exceeds the Standard-Webhooks
// timestamp tolerance (also 5m), so any message that would pass the timestamp
// check during the window can still verify under the previous secret.
const ROTATION_WINDOW_SECONDS = 5 * 60;

declare global {
  var __cinatraWebhookSecretPool: Pool | undefined;
}

let poolInstance: Pool | undefined;
function getPool(): Pool {
  if (poolInstance) return poolInstance;
  if (globalThis.__cinatraWebhookSecretPool) {
    return (poolInstance = globalThis.__cinatraWebhookSecretPool);
  }
  const connectionString = getPostgresConnectionString();
  const pool = new Pool({ connectionString });
  if (!pool.listenerCount("error")) {
    pool.on("error", (err) => {
      console.error("[webhook-secret-service] pg pool idle client error:", err.message);
    });
  }
  poolInstance = pool;
  if (process.env.NODE_ENV !== "production") {
    globalThis.__cinatraWebhookSecretPool = pool;
  }
  return pool;
}

function table(): string {
  const s = postgresSchema.replaceAll('"', '""');
  return `"${s}"."webhook_secret_bindings"`;
}

// Field-scoped AAD so a current blob can never decrypt in another column. The
// binding_id keys the row; the field name keys the column ("legacy" is the #343
// single-shared-secret bridge blob — it can never decrypt as current/previous).
function aad(bindingId: string, field: "current" | "previous" | "legacy"): string {
  return `webhook-binding.${bindingId}.${field}`;
}

interface BindingRow {
  binding_id: string;
  vendor: string;
  slug: string;
  hook: string;
  site_id: string;
  current_secret_ciphertext: string;
  current_secret_iv: string;
  previous_secret_ciphertext: string | null;
  previous_secret_iv: string | null;
  // Computed in SQL: true only when previous_expires_at > now() (the DB clock
  // that minted it), so the rotation-window check uses the SAME clock that set
  // the expiry — never the app clock (codex: app/DB skew could accept past
  // expiry or reject early).
  previous_active: boolean;
  legacy_enabled: boolean;
  legacy_secret_ciphertext: string | null;
  legacy_secret_iv: string | null;
  revoked_at: Date | null;
}

export const webhookSecretService: WebhookSecretService = {
  async mint(input: MintBindingInput): Promise<MintedBinding> {
    const pool = getPool();
    const bindingId = mintBindingId();
    const legacy = input.legacyEnabled === true;
    if (legacy && (typeof input.legacySecret !== "string" || input.legacySecret.length === 0)) {
      throw new Error(
        "[webhook-secret-service] legacyEnabled mint requires a non-empty legacySecret",
      );
    }
    // The current_secret_ciphertext column is NOT NULL. A legacy binding (#343)
    // verifies via the bespoke `sha256=<hex>` HMAC over its legacy secret, NOT a
    // Standard-Webhooks secret, so its current column is an UNUSED placeholder —
    // we mint a throwaway to satisfy the constraint and the route never reads
    // `binding.secrets` for a legacy binding (resolveByBindingId returns []).
    const currentSecret = mintWebhookSecret();
    const enc = encryptSecret(currentSecret, aad(bindingId, "current"));
    const legacyEnc = legacy
      ? encryptSecret(input.legacySecret as string, aad(bindingId, "legacy"))
      : null;
    // The partial-unique active index (vendor,slug,hook,site WHERE revoked_at IS
    // NULL) enforces at most one active binding per tuple — a second active mint
    // for the same tuple raises a unique violation. We translate that to a
    // clear "rotate instead" error rather than leaking the constraint name.
    try {
      await pool.query(
        `INSERT INTO ${table()}
           (binding_id, vendor, slug, hook, site_id,
            current_secret_ciphertext, current_secret_iv,
            legacy_enabled, legacy_secret_ciphertext, legacy_secret_iv, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())`,
        [
          bindingId,
          input.vendor,
          input.slug,
          input.hook,
          input.siteId,
          enc.ciphertext,
          enc.iv,
          legacy,
          legacyEnc?.ciphertext ?? null,
          legacyEnc?.iv ?? null,
        ],
      );
    } catch (err) {
      if (err && typeof err === "object" && (err as { code?: string }).code === "23505") {
        throw new Error(
          `[webhook-secret-service] an active binding already exists for ${input.vendor}/${input.slug}/${input.hook} on this site — rotate instead of minting a second`,
        );
      }
      throw err;
    }
    // A legacy binding's "secret" is the bridged shared HMAC secret (what the
    // caller stored), not the unused Standard-Webhooks placeholder.
    return { bindingId, secret: legacy ? (input.legacySecret as string) : currentSecret };
  },

  // Tuple-scoped idempotent legacy-binding upsert (cinatra#343). Provisioning
  // has only the (vendor, slug, hook, site) tuple — never an existing bindingId
  // — so a reconnect/credential-rotation cannot address an existing binding by
  // id. This INSERTs a fresh active legacy binding when none exists, or UPDATEs
  // the active one's legacy secret IN PLACE (preserving its bindingId so the
  // plugin's stored inbound URL stays valid). The partial-unique active index
  // makes "exactly one active row per tuple" the upsert target.
  async upsertLegacy(input: UpsertLegacyBindingInput): Promise<MintedBinding> {
    if (typeof input.legacySecret !== "string" || input.legacySecret.length === 0) {
      throw new Error("[webhook-secret-service] upsertLegacy requires a non-empty legacySecret");
    }
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Lock the existing active row for this tuple (if any). The partial-unique
      // active index guarantees at most one.
      const { rows } = await client.query<{ binding_id: string }>(
        `SELECT binding_id FROM ${table()}
          WHERE vendor = $1 AND slug = $2 AND hook = $3 AND site_id = $4
            AND revoked_at IS NULL
          FOR UPDATE`,
        [input.vendor, input.slug, input.hook, input.siteId],
      );
      const existing = rows[0];
      if (existing) {
        // Re-encrypt the (possibly rotated) shared secret under THIS binding's
        // legacy AAD and store it in place. Keep legacy_enabled true.
        const enc = encryptSecret(input.legacySecret, aad(existing.binding_id, "legacy"));
        await client.query(
          `UPDATE ${table()}
              SET legacy_enabled = true,
                  legacy_secret_ciphertext = $2,
                  legacy_secret_iv = $3
            WHERE binding_id = $1`,
          [existing.binding_id, enc.ciphertext, enc.iv],
        );
        await client.query("COMMIT");
        return { bindingId: existing.binding_id, secret: input.legacySecret };
      }
      // No active binding — INSERT a fresh legacy binding.
      const bindingId = mintBindingId();
      const currentSecret = mintWebhookSecret();
      const enc = encryptSecret(currentSecret, aad(bindingId, "current"));
      const legacyEnc = encryptSecret(input.legacySecret, aad(bindingId, "legacy"));
      await client.query(
        `INSERT INTO ${table()}
           (binding_id, vendor, slug, hook, site_id,
            current_secret_ciphertext, current_secret_iv,
            legacy_enabled, legacy_secret_ciphertext, legacy_secret_iv, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, $9, now())`,
        [
          bindingId,
          input.vendor,
          input.slug,
          input.hook,
          input.siteId,
          enc.ciphertext,
          enc.iv,
          legacyEnc.ciphertext,
          legacyEnc.iv,
        ],
      );
      await client.query("COMMIT");
      return { bindingId, secret: input.legacySecret };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  },

  async resolveByBindingId(bindingId: string): Promise<ResolvedBinding | null> {
    const pool = getPool();
    const { rows } = await pool.query<BindingRow>(
      `SELECT binding_id, vendor, slug, hook, site_id,
              current_secret_ciphertext, current_secret_iv,
              previous_secret_ciphertext, previous_secret_iv,
              (previous_expires_at IS NOT NULL AND previous_expires_at > now()) AS previous_active,
              legacy_enabled, legacy_secret_ciphertext, legacy_secret_iv, revoked_at
         FROM ${table()}
        WHERE binding_id = $1`,
      [bindingId],
    );
    const row = rows[0];
    // Unknown OR revoked → null (no oracle: the route returns the same 401 for
    // both so it cannot be used to probe which binding ids exist).
    if (!row || row.revoked_at !== null) return null;

    // A LEGACY binding (#343 bridge) carries NO Standard-Webhooks secret — the
    // route verifies it via the bespoke `sha256=<hex>` HMAC over the decrypted
    // legacy secret. We return EMPTY `secrets` (the route never feeds a legacy
    // binding through verifyInbound) and the decrypted legacySecret. The current
    // column holds an unused placeholder we never decrypt for a legacy binding.
    if (row.legacy_enabled) {
      if (!row.legacy_secret_ciphertext || !row.legacy_secret_iv) {
        // A legacy_enabled binding with no stored legacy secret is a
        // misprovisioned row — fail closed (null → the route 401s, no oracle).
        return null;
      }
      return {
        bindingId: row.binding_id,
        vendor: row.vendor,
        slug: row.slug,
        hook: row.hook,
        siteId: row.site_id,
        secrets: [],
        legacyEnabled: true,
        legacySecret: decryptSecret(
          { ciphertext: row.legacy_secret_ciphertext, iv: row.legacy_secret_iv },
          aad(bindingId, "legacy"),
        ),
      };
    }

    const secrets: string[] = [
      decryptSecret(
        { ciphertext: row.current_secret_ciphertext, iv: row.current_secret_iv },
        aad(bindingId, "current"),
      ),
    ];
    // A previous secret is a candidate ONLY while its window is open — the
    // open/closed verdict is computed by the DB clock (previous_active) that
    // also set the expiry, so app/DB skew cannot widen or narrow the window.
    if (
      row.previous_active &&
      row.previous_secret_ciphertext &&
      row.previous_secret_iv
    ) {
      secrets.push(
        decryptSecret(
          { ciphertext: row.previous_secret_ciphertext, iv: row.previous_secret_iv },
          aad(bindingId, "previous"),
        ),
      );
    }
    return {
      bindingId: row.binding_id,
      vendor: row.vendor,
      slug: row.slug,
      hook: row.hook,
      siteId: row.site_id,
      secrets,
      legacyEnabled: row.legacy_enabled,
    };
  },

  async rotate(bindingId: string): Promise<MintedBinding> {
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Lock the row; reject rotating a revoked/absent binding.
      const { rows } = await client.query<BindingRow>(
        `SELECT binding_id, current_secret_ciphertext, current_secret_iv, revoked_at
           FROM ${table()}
          WHERE binding_id = $1
          FOR UPDATE`,
        [bindingId],
      );
      const row = rows[0];
      if (!row || row.revoked_at !== null) {
        throw new Error("[webhook-secret-service] cannot rotate an unknown or revoked binding");
      }
      // Re-encrypt the OUTGOING current under the PREVIOUS AAD (it now lives in
      // the previous column). Decrypt-then-re-encrypt rather than copy-blob so
      // the field-scoped AAD invariant holds (a current blob must never sit in
      // the previous column under the current AAD).
      const outgoing = decryptSecret(
        { ciphertext: row.current_secret_ciphertext, iv: row.current_secret_iv },
        aad(bindingId, "current"),
      );
      const prevEnc = encryptSecret(outgoing, aad(bindingId, "previous"));
      const newSecret = mintWebhookSecret();
      const newEnc = encryptSecret(newSecret, aad(bindingId, "current"));
      await client.query(
        `UPDATE ${table()}
            SET previous_secret_ciphertext = $2,
                previous_secret_iv = $3,
                previous_expires_at = now() + ($4 || ' seconds')::interval,
                current_secret_ciphertext = $5,
                current_secret_iv = $6,
                rotated_at = now()
          WHERE binding_id = $1`,
        [
          bindingId,
          prevEnc.ciphertext,
          prevEnc.iv,
          String(ROTATION_WINDOW_SECONDS),
          newEnc.ciphertext,
          newEnc.iv,
        ],
      );
      await client.query("COMMIT");
      return { bindingId, secret: newSecret };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  },

  async revoke(bindingId: string): Promise<void> {
    const pool = getPool();
    await pool.query(
      `UPDATE ${table()} SET revoked_at = now() WHERE binding_id = $1 AND revoked_at IS NULL`,
      [bindingId],
    );
  },
};

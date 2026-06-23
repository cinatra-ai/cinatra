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
// #340 SCOPE: legacyEnabled is returned (always false in #340) but no
// legacySecret — the legacy single-shared-secret bridge + its storage are #343
// (D3c option A).

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

// Field-scoped AAD so a current blob can never decrypt in the previous column
// (and vice versa). The binding_id keys the row; the field name keys the column.
function aad(bindingId: string, field: "current" | "previous"): string {
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
  revoked_at: Date | null;
}

export const webhookSecretService: WebhookSecretService = {
  async mint(input: MintBindingInput): Promise<MintedBinding> {
    const pool = getPool();
    const secret = mintWebhookSecret();
    const bindingId = mintBindingId();
    const enc = encryptSecret(secret, aad(bindingId, "current"));
    // The partial-unique active index (vendor,slug,hook,site WHERE revoked_at IS
    // NULL) enforces at most one active binding per tuple — a second active mint
    // for the same tuple raises a unique violation. We translate that to a
    // clear "rotate instead" error rather than leaking the constraint name.
    try {
      await pool.query(
        `INSERT INTO ${table()}
           (binding_id, vendor, slug, hook, site_id,
            current_secret_ciphertext, current_secret_iv, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
        [
          bindingId,
          input.vendor,
          input.slug,
          input.hook,
          input.siteId,
          enc.ciphertext,
          enc.iv,
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
    return { bindingId, secret };
  },

  async resolveByBindingId(bindingId: string): Promise<ResolvedBinding | null> {
    const pool = getPool();
    const { rows } = await pool.query<BindingRow>(
      `SELECT binding_id, vendor, slug, hook, site_id,
              current_secret_ciphertext, current_secret_iv,
              previous_secret_ciphertext, previous_secret_iv,
              (previous_expires_at IS NOT NULL AND previous_expires_at > now()) AS previous_active,
              legacy_enabled, revoked_at
         FROM ${table()}
        WHERE binding_id = $1`,
      [bindingId],
    );
    const row = rows[0];
    // Unknown OR revoked → null (no oracle: the route returns the same 401 for
    // both so it cannot be used to probe which binding ids exist).
    if (!row || row.revoked_at !== null) return null;

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

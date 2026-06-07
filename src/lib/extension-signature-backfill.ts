import "server-only";

// ---------------------------------------------------------------------------
// Instance signature backfill.
//
// The boot trust gate reads the Ed25519 signature from the persisted install
// ROW (`installed_extension.source.signature`, via the install anchor) — NOT
// from the live packument. So once the marketplace starts serving
// `dist.cinatraSignature`, EXISTING install rows (installed before signing) keep
// a null `source.signature` and would be denied activation the moment
// `CINATRA_EXTENSION_REQUIRE_SIGNATURES=true`. This one-shot, boot-time
// pass backfills `source.signature` onto those rows so the fleet is ready BEFORE
// the flip.
//
// FAIL-CLOSED: for each active `verdaccio` row with a null signature, it
// re-resolves the served signature for the row's CONCRETE version and verifies it
// against the row's STORED {packageName, version, integrity}. It writes the
// signature ONLY when that verifies — it NEVER replaces the stored integrity/
// version, so a re-published / digest-changed artifact can never silently re-sign
// a stale row (those rows skip and require an operator re-install/update).
//
// Inert + safe by construction: key-guarded (no-op until
// `CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS` is set), kill-switchable
// (`CINATRA_EXTENSION_SIGNATURE_BACKFILL=off`), idempotent (only touches
// null-signature rows), bounded per-row timeout, and soft-failing (never blocks
// boot). Writes ONLY through the sanctioned `sourceSwitchExtension` (so it stays
// out of the `installed_extension` raw-SQL guard, and provenance is
// re-validated on write).
// ---------------------------------------------------------------------------

import type { ExtensionSourceVerdaccio } from "@cinatra-ai/extensions/canonical-types";

/** Env lever: set to `off` to disable the pass entirely (kill switch). */
const KILL_SWITCH_ENV = "CINATRA_EXTENSION_SIGNATURE_BACKFILL";
const DEFAULT_PER_ROW_TIMEOUT_MS = 8000;

export type SignatureBackfillResult = {
  scanned: number;
  written: number;
  skipped: number;
  failed: number;
  /** Set when the whole pass short-circuited before scanning. */
  skippedReason?: "kill-switch" | "no-trusted-keys";
};

export type SignatureBackfillDeps = {
  /** Number of host-configured trusted public keys (the key guard). */
  loadTrustedKeyCount: () => number;
  /** Active `verdaccio` install rows whose `source.signature` is null/empty. */
  listActiveVerdaccioRowsMissingSignature: () => Promise<
    Array<{ id: string; source: ExtensionSourceVerdaccio }>
  >;
  /**
   * The signature the registry currently SERVES for this exact package@version
   * (`dist.cinatraSignature`), or null when none is served. MAY throw on a
   * registry/network error (→ counted as `failed`, retried next boot).
   */
  resolveServedSignature: (input: { packageName: string; version: string }) => Promise<string | null>;
  /**
   * Verify the served signature against the row's STORED fields. `true` only when
   * it verifies against a trusted key for the stored {packageName, version,
   * integrity}; anything else (false/undefined) → skip (never write).
   */
  verifySignature: (
    fields: { packageName: string; version: string; integrity: string },
    signature: string,
  ) => boolean | undefined;
  /**
   * COMPARE-AND-SET write. Re-reads the row by id and persists the signature via
   * the sanctioned source-switch writer ONLY if the row is STILL active+verdaccio,
   * still has a null signature, and its stored {packageName, version, integrity}
   * STILL equal the `verified` fields the signature was checked against — so a
   * concurrent update/reinstall between scan and write can never be clobbered with
   * stale fields. Returns "written" on success, "skipped-changed" on a CAS miss.
   */
  writeBackfilledSignature: (
    id: string,
    verified: { packageName: string; version: string; integrity: string },
    signature: string,
  ) => Promise<"written" | "skipped-changed">;
  perRowTimeoutMs?: number;
  log?: (msg: string) => void;
};

/**
 * The compare-and-set predicate for the write leg: write the backfilled signature
 * ONLY if the (re-read) row is still active + verdaccio + unsigned and its stored
 * {packageName, version, integrity} STILL equal the fields the signature was
 * verified against. Pure + exported for direct testing.
 */
export function casShouldWrite(
  current:
    | { status: string; source: { type: string; signature?: string; packageName?: string; version?: string; integrity?: string } }
    | null
    | undefined,
  verified: { packageName: string; version: string; integrity: string },
): boolean {
  if (!current || current.status !== "active") return false;
  const s = current.source;
  return (
    s.type === "verdaccio" &&
    !s.signature &&
    s.packageName === verified.packageName &&
    s.version === verified.version &&
    s.integrity === verified.integrity
  );
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`signature-backfill: per-row timeout after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * Run the backfill. Tests inject in-memory deps; boot uses the real deps wired by
 * `makeDefaultSignatureBackfillDeps()`. Never throws — soft-fails per row.
 */
export async function runExtensionSignatureBackfill(
  overrides: Partial<SignatureBackfillDeps> = {},
): Promise<SignatureBackfillResult> {
  const empty: SignatureBackfillResult = { scanned: 0, written: 0, skipped: 0, failed: 0 };

  // Kill switch — flat no-op.
  if ((process.env[KILL_SWITCH_ENV] ?? "").trim().toLowerCase() === "off") {
    return { ...empty, skippedReason: "kill-switch" };
  }

  const deps = overrides.loadTrustedKeyCount
    ? (overrides as SignatureBackfillDeps)
    : { ...(await makeDefaultSignatureBackfillDeps()), ...overrides };

  // Key guard — inert until the host trusts at least one signing key.
  if (deps.loadTrustedKeyCount() === 0) {
    return { ...empty, skippedReason: "no-trusted-keys" };
  }

  const timeoutMs = deps.perRowTimeoutMs ?? DEFAULT_PER_ROW_TIMEOUT_MS;
  let written = 0;
  let skipped = 0;
  let failed = 0;
  let scanned = 0;

  // Wrapped so the pass NEVER throws (enumeration/deps errors included) — the
  // contract is a soft no-op that boot can ignore.
  try {
    const rows = await deps.listActiveVerdaccioRowsMissingSignature();
    scanned = rows.length;

    for (const row of rows) {
      const { packageName, version, integrity } = row.source;
      try {
        const served = await withTimeout(deps.resolveServedSignature({ packageName, version }), timeoutMs);
        if (!served) {
          skipped++;
          continue;
        }
        // FAIL-CLOSED: verify the served signature against the row's STORED
        // {packageName, version, integrity}. Never trust a signature that doesn't
        // bind the bytes we actually installed; never replace `integrity`.
        const verdict = deps.verifySignature({ packageName, version, integrity }, served);
        if (verdict !== true) {
          skipped++;
          deps.log?.(`[signature-backfill] skip ${packageName}@${version}: served signature did not verify against the stored integrity`);
          continue;
        }
        // COMPARE-AND-SET: re-read + write only if the row still matches what we
        // verified (a concurrent update/reinstall cannot be clobbered).
        const outcome = await deps.writeBackfilledSignature(row.id, { packageName, version, integrity }, served);
        if (outcome === "written") written++;
        else {
          skipped++;
          deps.log?.(`[signature-backfill] skip ${packageName}@${version}: row changed between scan and write (CAS miss)`);
        }
      } catch (err) {
        failed++;
        deps.log?.(`[signature-backfill] FAILED ${packageName}@${version} (soft, retried next boot): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    deps.log?.(`[signature-backfill] enumeration failed (soft, retried next boot): ${err instanceof Error ? err.message : String(err)}`);
    return { scanned, written, skipped, failed: failed + 1 };
  }

  return { scanned, written, skipped, failed };
}

/** Build the real (server-only) deps. */
export async function makeDefaultSignatureBackfillDeps(): Promise<SignatureBackfillDeps> {
  const [{ listInstalledExtensions, readInstalledExtensionById }, { sourceSwitchExtension }, { resolveExtensionDistIntegrity }, { loadVerdaccioConfigForServer }, { resolveSignatureVerdict, loadTrustedPublicKeys }] =
    await Promise.all([
      import("@cinatra-ai/extensions/canonical-store"),
      import("@cinatra-ai/extensions/lifecycle-primitive"),
      import("@cinatra-ai/registries"),
      import("@/lib/verdaccio-config"),
      import("@/lib/extension-signature"),
    ]);

  return {
    loadTrustedKeyCount: () => loadTrustedPublicKeys().length,

    listActiveVerdaccioRowsMissingSignature: async () => {
      const rows = await listInstalledExtensions({ status: "active" });
      return rows
        .filter((r) => r.source.type === "verdaccio" && !(r.source as ExtensionSourceVerdaccio).signature)
        .map((r) => ({ id: r.id, source: r.source as ExtensionSourceVerdaccio }));
    },

    resolveServedSignature: async ({ packageName, version }) => {
      const config = await loadVerdaccioConfigForServer();
      const resolved = await resolveExtensionDistIntegrity({ packageName, packageVersion: version }, config);
      return resolved.signature ?? null;
    },

    verifySignature: (fields, signature) =>
      // required:false — this backfill verifies additively; the fleet-wide flip
      // to mandatory signatures happens separately.
      resolveSignatureVerdict({ ...fields, signature }, { trustedKeys: loadTrustedPublicKeys(), required: false }),

    writeBackfilledSignature: async (id, verified, signature) => {
      // CAS: re-read the row and write only if it STILL matches what we verified.
      const current = await readInstalledExtensionById(id);
      if (!casShouldWrite(current, verified)) return "skipped-changed";
      await sourceSwitchExtension(
        id,
        { ...(current!.source as ExtensionSourceVerdaccio), signature },
        { actor: { source: "system:signature-backfill" }, reason: "instance signature backfill" },
      );
      return "written";
    },
  };
}

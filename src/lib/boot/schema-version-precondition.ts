// Schema-version precondition (cinatra#789 item 4).
//
// Required-extension activation (and the rest of the app) assumes the runtime DB
// schema is at least as new as the core migration chain the IMAGE ships. When it
// is NOT — the ledger is BEHIND the image's core migrations — the failure today is
// a CRYPTIC downstream error (a query against a column/table a not-yet-applied
// migration adds). This precondition turns that into a CLEAR, actionable boot abort.
//
// NARROW CLAIM (important): this detects the LEDGER-BEHIND case — the DB is reachable
// but the applied core-migration ledger's MAX sequence is LOWER than the image's MAX
// shipped core migration (e.g. the boot core-migrations phase SKIPPED because the DB
// only became reachable after its check, or a partial/foreign ledger). It does NOT
// detect a hand-corrupted schema whose ledger LIES about being current (a faked
// ledger with the wrong physical schema is a different failure mode that the setup
// fresh-schema-fake path owns). We only compare applied-vs-shipped sequence numbers.
//
// ORDERING: runs AFTER the core-migrations phase (which runs the chain `up`) and
// BEFORE extension activation. In the NORMAL prod path core-migrations just applied
// everything, so applied_max == shipped_max and this passes with no double-fail.
//
// POLICY: prod fatal (actionable throw), dev warn+continue. Skips cleanly when the
// DB is not configured (fresh install / pre-setup-wizard). In prod the required-env
// preflight guarantees SUPABASE_DB_URL is present, so the skip branch is dev-only there.
//
// Deliberately NOT importing "server-only": vitest unit tests import this module.

// Reuse the migrations package's single source of truth for the ledger table +
// namespace so this check can never drift from the runner.
import {
  CORE_MIGRATIONS_TABLE,
  CORE_MIGRATION_NAMESPACE,
} from "@cinatra-ai/migrations";

// LEDGER-name regex: the ledger (`pgmigrations.name`) stores the migration filename
// WITHOUT the `.mjs` extension (see MIGRATION_NAME_MAX_LENGTH docstring). The
// migrations package's CORE_MIGRATION_FILE_RE requires `.mjs`, so it must NOT be used
// against ledger rows. We parse only the leading `core__NNNN_` sequence.
const CORE_LEDGER_SEQ_RE = /^core__(\d{4})_/;
// FILE name: the on-disk seed carries the `.mjs` extension.
const CORE_FILE_SEQ_RE = /^core__(\d{4})_[a-z0-9][a-z0-9-]*\.mjs$/;

/** Parse the highest applied CORE migration sequence from ledger row names. */
export function maxAppliedCoreSeq(ledgerNames: readonly string[]): number {
  let max = -1;
  for (const name of ledgerNames) {
    const m = CORE_LEDGER_SEQ_RE.exec(name);
    if (m) max = Math.max(max, Number.parseInt(m[1], 10));
  }
  return max;
}

/** Parse the highest CORE migration sequence the image ships (on-disk filenames). */
export function maxShippedCoreSeq(fileNames: readonly string[]): number {
  let max = -1;
  for (const name of fileNames) {
    const m = CORE_FILE_SEQ_RE.exec(name);
    if (m) max = Math.max(max, Number.parseInt(m[1], 10));
  }
  return max;
}

export type SchemaVersionVerdict =
  | { kind: "ok"; appliedMax: number; shippedMax: number }
  | { kind: "behind"; appliedMax: number; shippedMax: number; message: string }
  | { kind: "no-shipped-migrations" };

/**
 * PURE verdict: compare the applied ledger max against the shipped file max.
 * Exported for unit testing.
 */
export function evaluateSchemaVersion(
  ledgerNames: readonly string[],
  shippedFileNames: readonly string[],
): SchemaVersionVerdict {
  const shippedMax = maxShippedCoreSeq(shippedFileNames);
  if (shippedMax < 0) {
    // The image shipped no core migrations we can parse — nothing to assert.
    return { kind: "no-shipped-migrations" };
  }
  const appliedMax = maxAppliedCoreSeq(ledgerNames);
  if (appliedMax < shippedMax) {
    const appliedLabel =
      appliedMax < 0
        ? "no core migrations applied"
        : `${CORE_MIGRATION_NAMESPACE}${String(appliedMax).padStart(4, "0")}`;
    const shippedLabel = `${CORE_MIGRATION_NAMESPACE}${String(shippedMax).padStart(4, "0")}`;
    const message =
      `[schema-version-precondition] the runtime DB core schema is BEHIND this image: applied ` +
      `${appliedLabel} but this image requires ${shippedLabel}. Run \`cinatra db migrate\` against ` +
      `this database, or roll the image back to one that matches the schema. Refusing to boot against ` +
      `a schema too old for required-extension activation (a downstream query would otherwise fail cryptically).`;
    return { kind: "behind", appliedMax, shippedMax, message };
  }
  return { kind: "ok", appliedMax, shippedMax };
}

export { CORE_MIGRATIONS_TABLE, CORE_MIGRATION_NAMESPACE };

import { z } from "zod";

// ---------------------------------------------------------------------------
// Zod schemas for extensions MCP tools
// ---------------------------------------------------------------------------

const packageNameSchema = z
  .string()
  .regex(
    /^@[a-z][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/,
    "packageName must be a scoped package with lowercase alphanumeric + hyphens",
  );

export const extensionsSearchSchema = z.object({
  query: z.string().optional(),
  limit: z.number().int().positive().max(200).optional(),
});

export const extensionsInstallSchema = z.object({
  packageName: packageNameSchema,
  packageVersion: z.string().min(1),
});

export const extensionsUpdateSchema = z.object({
  packageName: packageNameSchema,
  packageVersion: z.string().min(1),
});

export const extensionsUninstallSchema = z.object({
  packageName: packageNameSchema,
  packageVersion: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Lifecycle management schemas
// ---------------------------------------------------------------------------

export const extensionsArchiveSchema = z.object({
  packageName: packageNameSchema,
  packageVersion: z.string().min(1),
});

export const extensionsRestoreSchema = z.object({
  packageName: packageNameSchema,
  // version resolved server-side from the archived row
});

export const extensionsForceDeleteSchema = z.object({
  packageName: packageNameSchema,
  packageVersion: z.string().min(1),
  reason: z.string().optional(),
  confirmDestructive: z.literal(true), // explicit acknowledgement required
});

// extensions_purge is the MCP-side DRY-RUN ONLY surface. It never mutates: it
// returns the full blast-radius (kind, every published version, installed
// template snapshot id, active dependents) plus a `digest` the operator carries
// to the non-model destructive path (`cinatra extensions purge` CLI →
// admin+loopback `/api/extensions/purge`). There is intentionally NO
// `confirmDestructive` here — the MCP tool cannot destroy anything, so a
// model-set boolean would be meaningless theater.
export const extensionsPurgeSchema = z.object({
  packageName: packageNameSchema,
});

// extensions_purge_execute is the DESTRUCTIVE saga, admin-gated and
// assistant/MCP-invocable. Requires the `expectedDigest` minted by the
// extensions_purge dry-run (mandatory TOCTOU handshake) plus
// confirmDestructive. Runs the fail-closed saga: lifecycle lock → validate →
// full quarantine → audit purge_started → re-scan → strict disk delete →
// atomic DB delete (rollback dir from quarantine on failure) → audit
// purge_committed. Purge does NOT unpublish versions from the
// Verdaccio registry — lifecycle primitives never delete from the registry;
// registry version cleanup is a separate ops operation (deferred).
export const extensionsPurgeExecuteSchema = z.object({
  packageName: packageNameSchema,
  expectedDigest: z.string().min(1),
  confirmDestructive: z.literal(true),
  reason: z.string().optional(),
});

// Registry-only ops. Kind-agnostic: a Verdaccio package-name+version operation
// with NO DB/disk/extensionRegistry semantics (kind only matters for
// uninstall/force_delete/purge). Admin-only.
export const extensionsRegistryUnpublishSchema = z.object({
  packageName: packageNameSchema,
  packageVersion: z.string().min(1),
  message: z.string().optional(),
});

export const extensionsRegistryDeleteSchema = z.object({
  packageName: packageNameSchema,
  packageVersion: z.string().min(1),
  // Hard registry delete is irreversible; require explicit acknowledgement
  // (parity with extensions_force_delete). The handler also quarantines the
  // target version and writes a durable audit row BEFORE the delete (a
  // model-set boolean alone is not the control).
  confirmDestructive: z.literal(true),
});

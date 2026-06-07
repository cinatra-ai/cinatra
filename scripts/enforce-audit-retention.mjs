#!/usr/bin/env node
/**
 * Documented deletion path.
 *
 * Deletes authz audit events older than the configured retention window
 * (default 12 months; admin-configurable via the `audit_retention` metadata
 * key). Intended to run daily (cron / BullMQ scheduled job) but is also
 * runnable on demand:
 *
 *   pnpm authz:retention                 # purge using the configured window
 *   pnpm authz:retention --dry-run       # report the cutoff without deleting
 *   pnpm authz:retention --days 90       # one-off purge with a custom window
 *
 * Requires SUPABASE_DB_URL (read from .env.local via --env-file in the
 * package.json script).
 */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const daysIdx = args.indexOf("--days");
const retentionDays = daysIdx >= 0 ? Number(args[daysIdx + 1]) : undefined;

// tsx is registered via the package.json script's --import flag so this .mjs
// can import the TS audit module directly.
const auditModuleUrl = pathToFileURL(resolve(process.cwd(), "src/lib/authz/audit.ts")).href;
const { enforceAuditRetention } = await import(auditModuleUrl);

const result = await enforceAuditRetention({ dryRun, retentionDays });
console.log(
  `[authz:retention] cutoff=${result.cutoffIso} retentionDays=${result.retentionDays} ` +
    (dryRun ? "(dry-run — nothing deleted)" : `deleted=${result.deleted}`),
);
process.exit(0);

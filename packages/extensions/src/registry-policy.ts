// Registry temp-policy reader.
//
// Declares — via root `package.json` config — whether the currently-resolved
// package registry is operating under a TEMPORARY policy, i.e. private packages
// on it are allowed only provisionally and may be deleted without notice.
//
// This is intentionally NOT a hard-coded property of any particular registry
// (the public registry is NOT inherently "temporary"). It is a deployment-level
// declaration the operator opts into. The default is `temporary: false`, so no
// warning banner ships unless an operator explicitly configures one.
//
// Source of truth (in precedence order):
//   1. env override `CINATRA_REGISTRY_POLICY_TEMPORARY` ("1"/"true" → temporary)
//      with optional `CINATRA_REGISTRY_POLICY_NOTICE` for the banner copy
//   2. root `package.json` top-level key `cinatraRegistryPolicy`
//      (mirrors the flat `cinatraDevExtensions` convention — NO nested
//      `cinatra` object)
//   3. safe default { temporary: false }
import "server-only";

import { readFileSync } from "node:fs";
import * as path from "node:path";

export type RegistryPolicy = {
  /** When true, the resolved registry's private-package retention is provisional. */
  temporary: boolean;
  /** Operator-facing notice rendered in the warning banner when `temporary`. */
  notice: string;
};

const DEFAULT_NOTICE =
  "Private packages on this registry are allowed temporarily and may be deleted without notice.";

const DEFAULT_POLICY: RegistryPolicy = {
  temporary: false,
  notice: DEFAULT_NOTICE,
};

// Repo root relative to this module (packages/extensions/src/registry-policy.ts).
// Resolving against __dirname (not process.cwd()) keeps the reader correct in
// both the Next.js runtime and the vitest sandbox.
function rootPackageJsonPath(): string {
  return path.resolve(__dirname, "../../..", "package.json");
}

function coerceTemporaryEnv(raw: string | undefined): boolean | null {
  if (raw === undefined) return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "1" || normalized === "true") return true;
  if (normalized === "0" || normalized === "false") return false;
  return null;
}

/**
 * Resolve the registry temp-policy. Fail-safe: any read/parse error falls back
 * to the non-temporary default so a malformed config never hides the catalog
 * behind an unexpected banner (and never throws into a server component).
 *
 * @param packageJsonPath optional override (tests inject a fixture path)
 */
export function readRegistryPolicy(packageJsonPath?: string): RegistryPolicy {
  // 1. env override wins (lets an operator flip the banner without editing the
  //    checked-in package.json).
  const envTemporary = coerceTemporaryEnv(
    process.env.CINATRA_REGISTRY_POLICY_TEMPORARY,
  );
  const envNotice = process.env.CINATRA_REGISTRY_POLICY_NOTICE?.trim();

  // 2. root package.json `cinatraRegistryPolicy`.
  let fileTemporary: boolean | null = null;
  let fileNotice: string | null = null;
  try {
    const raw = readFileSync(packageJsonPath ?? rootPackageJsonPath(), "utf8");
    const parsed = JSON.parse(raw) as {
      cinatraRegistryPolicy?: { temporary?: unknown; notice?: unknown };
    };
    const policy = parsed.cinatraRegistryPolicy;
    if (policy && typeof policy === "object") {
      if (typeof policy.temporary === "boolean") {
        fileTemporary = policy.temporary;
      }
      if (typeof policy.notice === "string" && policy.notice.trim().length > 0) {
        fileNotice = policy.notice.trim();
      }
    }
  } catch {
    // Missing / unreadable / malformed package.json → defaults.
  }

  const temporary =
    envTemporary ?? fileTemporary ?? DEFAULT_POLICY.temporary;
  const notice = envNotice || fileNotice || DEFAULT_POLICY.notice;

  return { temporary, notice };
}

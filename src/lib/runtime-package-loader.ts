import "server-only";

// The PROD half of "dual loaders, single activation": the host wrapper around
// the pure `runRuntimePackageActivation` core (the runtime installer).
//
// Mirrors `static-bundle-loader.ts` (the dev half) but sources records from the
// on-disk package store (`/data/extensions/packages`) instead of a generated
// import map, and injects the REAL dependencies the pure core needs:
//   - `fs`           : node:fs/promises over the store;
//   - `importModule` : a realpath-bound dynamic `file://` import of the
//                      verified serverEntry (rejects link-escape);
//   - `makeContext`  : the grant-aware `createExtensionHostContext`;
//   - `verifyIntegrity`: re-verify the materialized package on EVERY boot
//                      against a TRUSTED anchor (not the in-store sidecar).
//
// TRUST ROOT (vendor-agnostic): a package is activated in-process
// ONLY when a TRUSTED install record (the installer flow's DB record — OUTSIDE the
// writable store) resolves for it AND the vendor-agnostic classifier passes
// (integrity verified + persisted decision + resolved host ∈ trustedActivationHosts
// + a verified signature OR marketplace-bootstrap during the transition). Scope is
// NEVER a trust factor. Without a trusted record the loader FAILS CLOSED — the
// in-store sidecar is informational, never the root of trust. the runtime loader
// ships the seam with a deny-all default; the installer flow injects the DB-backed
// resolver. Untrusted isolation (subprocess/container) is untrusted isolation.

import { pathToFileURL } from "node:url";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import {
  runRuntimePackageActivation,
  discoverPackageStoreRecords,
  recordDeclaresHostMigrations,
  DEFAULT_PACKAGE_STORE_PATH,
  type PackageStoreFs,
  type PackageStoreRecord,
  type ActivationResult,
} from "@cinatra-ai/sdk-extensions";
import { createExtensionHostContext } from "@/lib/extension-host-context";
import {
  verifyMaterializedPackageIntegrity,
  type InstallTrustAnchor,
} from "@/lib/extension-package-store";
import { classifyExtensionTrust, untrustedActivationMode } from "@/lib/extension-trust";
import { resolveSignatureVerdict } from "@/lib/extension-signature";
import {
  trustedActivationHosts,
  allowMarketplaceBootstrapTrust,
} from "@/lib/extension-trust-config";

/** Real filesystem surface for the pure loader core. */
const realFs: PackageStoreFs = {
  exists: async (p) => {
    try {
      await stat(p);
      return true;
    } catch {
      return false;
    }
  },
  isDirectory: async (p) => {
    try {
      return (await stat(p)).isDirectory();
    } catch {
      return false;
    }
  },
  readdir: (p) => readdir(p),
  readFile: (p) => readFile(p, "utf8"),
};

/**
 * Resolve the TRUSTED install anchor for a package from a source OUTSIDE the
 * writable store (the installer flow = the DB install record). Returning null = no
 * trusted record → the package is refused (fail closed).
 */
export type InstallAnchorResolver = (packageName: string) => Promise<InstallTrustAnchor | null>;

const denyAllResolver: InstallAnchorResolver = async () => null;

export type RuntimeLoaderHostDeps = {
  /** the installer flow injects the DB-backed resolver; default denies all (fail closed). */
  resolveInstallAnchor?: InstallAnchorResolver;
  /**
   * Restrict the scan to a SINGLE package (targeted activation, e.g. immediately
   * after a hot-install). When undefined, the full store is scanned (boot
   * behavior, unchanged). When set, only the discovered record whose
   * `packageName` matches is considered — every downstream trust/integrity/
   * signature/migration/activation gate is reused unchanged.
   */
  onlyPackage?: string;
};

/**
 * Discover + activate trusted runtime-installed packages from the store through
 * the SAME shared activation driver the dev loader uses. Returns one result per
 * activation attempt; never throws (a missing `/data` volume / empty store / no
 * trusted records is a clean no-op).
 */
export async function loadRuntimePackageExtensions(
  storeRoot: string = DEFAULT_PACKAGE_STORE_PATH,
  hostDeps: RuntimeLoaderHostDeps = {},
): Promise<ActivationResult[]> {
  const resolveInstallAnchor = hostDeps.resolveInstallAnchor ?? denyAllResolver;
  const discovered = await discoverPackageStoreRecords(storeRoot, realFs);
  if (discovered.length === 0) return [];

  // Targeted activation: when a single package is requested, narrow the scan to
  // just that record. Empty (the requested package isn't materialized in the
  // store) is a clean no-op, exactly like an empty store.
  const candidates = hostDeps.onlyPackage
    ? discovered.filter((r) => r.packageName === hostDeps.onlyPackage)
    : discovered;
  if (candidates.length === 0) return [];

  // Trust filter BEFORE activation: a trusted DB anchor must resolve,
  // integrity must verify against THAT anchor (not the sidecar), and the
  // classifier must pass. Anything else is refused.
  const trusted: PackageStoreRecord[] = [];
  const anchorByName = new Map<string, InstallTrustAnchor>();
  // Track which trusted records reached the `trusted-signed` tier — only those are
  // eligible for boot-time host DDL (the capability split): a
  // `trusted-bootstrap` package may import in-process, but its declared migrations
  // must NOT run (running host DDL is a privileged capability gated on a verified
  // signature). Computed ONCE (boot-safe; no auth, no DB) outside the loop.
  const signedTrustedNames = new Set<string>();
  const activationHosts = trustedActivationHosts();
  const bootstrapTrust = allowMarketplaceBootstrapTrust();
  const refused: string[] = [];
  for (const rec of candidates) {
    const anchor = await resolveInstallAnchor(rec.packageName);
    if (!anchor) {
      refused.push(`${rec.packageName}: no trusted install record`);
      continue;
    }
    const integrityOk = await verifyMaterializedPackageIntegrity(rec, {
      trustedIntegrity: anchor.integrity,
      trustedContentHash: anchor.contentHash,
    });
    // The additive signature factor. resolveSignatureVerdict returns
    // true (verified against a trusted key), false (present-but-invalid, OR
    // required-but-missing → REFUSE), or undefined (no signing configured →
    // no-op, today's behavior). The signed payload binds packageName+version+
    // the recorded tarball integrity.
    const signatureVerified = resolveSignatureVerdict({
      packageName: rec.packageName,
      version: anchor.version ?? "",
      integrity: anchor.integrity,
      signature: anchor.signature,
    });
    const verdict = classifyExtensionTrust({
      packageName: rec.packageName,
      registryUrl: anchor.registryUrl,
      integrityVerified: integrityOk,
      persistedTrustDecision: anchor.trustDecision,
      signatureVerified,
      trustedActivationHosts: activationHosts,
      allowMarketplaceBootstrapTrust: bootstrapTrust,
    });
    if (verdict.trusted) {
      // Grant ONLY the admin-approved port subset — NOT the raw manifest's
      // requestedHostPorts. The pure driver passes rec.requestedHostPorts into
      // makeContext, so we rewrite the record to the approved set here. (Privileged
      // ports for a bootstrap package are only ever non-empty if an admin already
      // approved them — the install pipeline's auto-approve is signed-only.)
      trusted.push({ ...rec, requestedHostPorts: [...(anchor.approvedPorts ?? [])] as typeof rec.requestedHostPorts });
      anchorByName.set(rec.packageName, anchor);
      if (verdict.tier === "trusted-signed") signedTrustedNames.add(rec.packageName);
    } else {
      refused.push(`${rec.packageName}: ${verdict.reason}`);
    }
  }

  if (refused.length > 0) {
    const mode = untrustedActivationMode();
    console.warn(
      `[runtime-package-loader] refusing ${refused.length} package(s) for in-process import ` +
        `(untrusted-activation-mode=${mode}; subprocess isolation is a untrusted isolation prototype, not yet wired): ` +
        refused.join("; "),
    );
  }
  if (trusted.length === 0) return [];

  // Apply each TRUSTED-SIGNED package's declared migrations (the node-pg-migrate
  // modules under `cinatra.migrationsDir`, #118) BEFORE activation, under the SAME
  // trust verdict used for in-process import. Capability split: running host DDL
  // is a PRIVILEGED capability gated on a verified signature — so only
  // `trusted-signed` records run migrations here. A `trusted-bootstrap` record
  // that DECLARES migrations is refused for import (its host-owned tables would
  // never be created, so importing it is unsafe); a bootstrap record that declares
  // none imports normally. A signed package whose migration fails — including one
  // that still declares the RETIRED legacy `cinatra.migrations` JSON-DSL field,
  // which the host rejects fail-closed — is also refused. Idempotent via the
  // shared ledger; a no-op for the common case (no extension declares migrations).
  // FAIL-CLOSED on ambiguous identity BEFORE any DDL: the activation driver
  // (runRuntimePackageActivation) refuses every record of a packageName that
  // appears more than once in the store — but it runs AFTER this migration
  // pass. Running migrations for an ambiguous name could execute DDL from a
  // record that activation then refuses, so the same refusal applies here,
  // computed over the full discovered candidate set.
  const candidateCountByName = new Map<string, number>();
  for (const rec of candidates) {
    candidateCountByName.set(rec.packageName, (candidateCountByName.get(rec.packageName) ?? 0) + 1);
  }
  const ambiguousNames = new Set(
    [...candidateCountByName].filter(([, n]) => n > 1).map(([name]) => name),
  );
  if (ambiguousNames.size > 0) {
    console.warn(
      `[runtime-package-loader] refusing ${ambiguousNames.size} ambiguous package name(s) before the ` +
        `migration pass (multiple store records; fail-closed): ${[...ambiguousNames].join(", ")}`,
    );
  }
  const signedTrusted = trusted.filter(
    (rec) => signedTrustedNames.has(rec.packageName) && !ambiguousNames.has(rec.packageName),
  );
  const bootstrapWithDeclaredMigrations = trusted.filter(
    (rec) => !signedTrustedNames.has(rec.packageName) && recordDeclaresHostMigrations(rec),
  );
  if (bootstrapWithDeclaredMigrations.length > 0) {
    console.warn(
      `[runtime-package-loader] refusing ${bootstrapWithDeclaredMigrations.length} bootstrap-trusted ` +
        `package(s) that declare host migrations (DDL requires a verified signature): ` +
        bootstrapWithDeclaredMigrations.map((r) => r.packageName).join(", "),
    );
  }
  const { applyMigrationsForTrustedRecords } = await import("@/lib/extension-migration-host");
  const migration = await applyMigrationsForTrustedRecords(signedTrusted);
  if (migration.refused.length > 0) {
    console.warn(
      `[runtime-package-loader] refusing ${migration.refused.length} package(s) whose migrations failed: ` +
        migration.refused.map((r) => `${r.packageName}: ${r.error}`).join("; "),
    );
  }
  const migrationRefused = new Set<string>([
    ...migration.refused.map((r) => r.packageName),
    ...bootstrapWithDeclaredMigrations.map((r) => r.packageName),
    // Ambiguous names skipped the migration pass above, so they must not
    // activate either — and the activation driver's own duplicate fence only
    // fires when BOTH records reach it, which trust refusals can prevent.
    ...ambiguousNames,
  ]);
  const activatable = trusted.filter((rec) => !migrationRefused.has(rec.packageName));
  if (activatable.length === 0) return [];

  return runRuntimePackageActivation(storeRoot, {
    fs: realFs,
    records: activatable,
    importModule: async (abs, rec) => {
      // realpath-bound: the resolved server entry must stay INSIDE the verified
      // package dir even after following filesystem links (defense beyond the
      // string-based serverEntry guard + the post-extract symlink rejection).
      let realAbs: string;
      let realStore: string;
      try {
        [realAbs, realStore] = await Promise.all([realpath(abs), realpath(rec.storeDir)]);
      } catch (error) {
        // A missing resolved entry surfaces as a realpath ENOENT. Rethrow it in
        // the actionable built-artifacts-only shape (cinatra#161) instead of
        // leaking a bare ENOENT into an opaque `failed` activation — this is
        // the legacy-store defense for dirs written by OLDER installers (the
        // materializer's install-time gate refuses new ones).
        if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
          const rel = rec.serverEntryRel ?? rec.serverEntry;
          throw new Error(
            `[runtime-package-loader] serverEntry "${rec.serverEntry}" for ${rec.packageName} — ` +
              `resolved entry "${rel}" does not exist in the materialized package. ` +
              `The runtime store activates BUILT artifacts only: publish a built ESM entry ` +
              `(e.g. cinatra.serverEntry "./register.mjs") and reinstall the package from the marketplace.`,
          );
        }
        throw error;
      }
      if (realAbs !== realStore && !realAbs.startsWith(realStore + "/")) {
        throw new Error(
          `[runtime-package-loader] serverEntry for ${rec.packageName} resolves outside its package dir — refusing import`,
        );
      }
      return import(/* webpackIgnore: true */ /* @vite-ignore */ pathToFileURL(realAbs).href);
    },
    makeContext: (packageName, grantedPorts) => createExtensionHostContext(packageName, grantedPorts),
    verifyIntegrity: (rec) => {
      const anchor = anchorByName.get(rec.packageName);
      return verifyMaterializedPackageIntegrity(
        rec,
        anchor ? { trustedIntegrity: anchor.integrity, trustedContentHash: anchor.contentHash } : {},
      );
    },
  });
}

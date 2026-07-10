import "server-only";

// The PROD half of "dual loaders, single activation": the host wrapper around
// the pure `runRuntimePackageActivation` core (the runtime installer).
//
// Mirrors `static-bundle-loader.ts` (the dev half) but sources records from the
// on-disk runtime store (the configured extension data root, cinatra#791:
// `<root>/<kind>/<slug>/<digest>/`) instead of a generated
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
import { realpath } from "node:fs/promises";
import {
  runRuntimePackageActivation,
  recordDeclaresHostMigrations,
  type PackageStoreRecord,
  type ActivationResult,
} from "@cinatra-ai/sdk-extensions";
import { discoverStoreRecordsV2, realStoreFs, type PackageStoreRecordV2 } from "@/lib/extension-store-io";
import { isExtensionStoreKind } from "@/lib/extension-package-store-core";
import { createExtensionHostContext } from "@/lib/extension-host-context";
import {
  verifyMaterializedPackageIntegrity,
  type InstallTrustAnchor,
} from "@/lib/extension-package-store";
import { isContainedRealpath } from "@/lib/fs-safety";
import { classifyExtensionTrust, untrustedActivationMode } from "@/lib/extension-trust";
import { resolveSignatureVerdict } from "@/lib/extension-signature";
import {
  trustedActivationHosts,
  allowMarketplaceBootstrapTrust,
} from "@/lib/extension-trust-config";
import { markPackageSignedActivated } from "@/lib/extension-capabilities-registry";

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
  /**
   * DEPENDENCY-ORDERED ACTIVATION (#180 item 8): the persisted dependency
   * edges per package name. When provided (or resolved by the default reader
   * below), activatable records are TOPO-SORTED dependencies-first before
   * activation — a dependency's `register(ctx)` runs before its dependents'.
   * Deterministic lexicographic tie-break; a cycle falls back to
   * lexicographic order with a loud warning. Optional: unit harnesses may
   * omit it AND the default read is best-effort (an unreachable canonical
   * store degrades to discovery order with a warning — boot must not gain a
   * new hard DB dependency from ordering alone).
   */
  readDependencyEdgesByPackage?: () => Promise<
    Map<string, import("@cinatra-ai/extensions/canonical-types").ExtensionDependency[]>
  >;
};

/** Default edge reader for dependency-ordered activation: the LIVE canonical
 *  rows' persisted edges (platform row preferred — boot activates
 *  platform-scoped installs; an org row only fills a gap). Best-effort. */
async function readLiveDependencyEdgesByPackage(): Promise<
  Map<string, import("@cinatra-ai/extensions/canonical-types").ExtensionDependency[]>
> {
  const { listInstalledExtensions } = await import("@cinatra-ai/extensions/canonical-store");
  const rows = await listInstalledExtensions({});
  const byName = new Map<string, import("@cinatra-ai/extensions/canonical-types").ExtensionDependency[]>();
  for (const row of rows) {
    if (row.status !== "active" && row.status !== "locked") continue;
    const existing = byName.get(row.packageName);
    if (existing === undefined || (row.organizationId ?? null) === null) {
      byName.set(row.packageName, row.dependencies);
    }
  }
  return byName;
}

/**
 * Discover + activate trusted runtime-installed packages from the store through
 * the SAME shared activation driver the dev loader uses. Returns one result per
 * activation attempt; never throws (a missing `/data` volume / empty store / no
 * trusted records is a clean no-op).
 */
export async function loadRuntimePackageExtensions(
  storeRoot?: string,
  hostDeps: RuntimeLoaderHostDeps = {},
): Promise<ActivationResult[]> {
  // The extension DATA ROOT (cinatra#791): env > DB metadata > /data/extensions.
  const dataRoot =
    storeRoot ?? (await import("@/lib/extension-data-root")).resolveExtensionDataRoot();
  const resolveInstallAnchor = hostDeps.resolveInstallAnchor ?? denyAllResolver;
  const discovered = await discoverStoreRecordsV2(dataRoot, realStoreFs);
  if (discovered.length === 0) return [];

  // Targeted activation: when a single package is requested, narrow the scan to
  // just that record. Empty (the requested package isn't materialized in the
  // store) is a clean no-op, exactly like an empty store.
  const candidates = hostDeps.onlyPackage
    ? discovered.filter((r) => r.packageName === hostDeps.onlyPackage)
    : discovered;
  if (candidates.length === 0) return [];

  // PER-PACKAGE ANCHOR NARROWING (cinatra#792). Multi-digest discovery is
  // NORMAL once retention lands (#796): the store may legitimately hold the
  // active digest plus retained prior digests for one package. So instead of
  // refusing ambiguity wholesale, the loader resolves the trusted anchor ONCE
  // per package name and narrows the discovered records to EXACTLY the
  // anchor-bound digest:
  //   - no anchor                        → refuse every record of the name;
  //   - anchor kind (the canonical row's) contradicts a record's PATH kind
  //     (`<root>/<kind>/...`)            → that record is refused (fail closed);
  //   - anchor digest BOUND              → select the single record whose
  //     declaredDigest matches; none on disk → refuse (a flat/undeclared-digest
  //     record can never satisfy a bound anchor — same fail-closed as before);
  //   - anchor digest UNBOUND (legacy)   → exactly one discovered digest may
  //     proceed (the integrity/contentHash re-verify remains the backstop);
  //     >1 digest with an unbound anchor → refuse (ambiguous, fail closed).
  // The selected single record then runs the UNCHANGED integrity/signature/
  // trust gates below.
  const byName = new Map<string, PackageStoreRecordV2[]>();
  for (const rec of candidates) {
    const bucket = byName.get(rec.packageName);
    if (bucket) bucket.push(rec);
    else byName.set(rec.packageName, [rec]);
  }

  // Trust filter BEFORE activation: a trusted DB anchor must resolve,
  // integrity must verify against THAT anchor (not the sidecar), and the
  // classifier must pass. Anything else is refused.
  const trusted: PackageStoreRecord[] = [];
  const narrowed: PackageStoreRecordV2[] = [];
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
  for (const [packageName, recs] of byName) {
    const anchor = await resolveInstallAnchor(packageName);
    if (!anchor) {
      refused.push(`${packageName}: no trusted install record`);
      continue;
    }
    // cinatra#792 — ANCHOR KIND BINDING. The V2 store is kind-segregated, so
    // the canonical row's kind must agree with the record's path-derived kind;
    // a contradiction (or an anchor kind outside the store enum) is refused.
    const kindBound = recs.filter((r) => {
      if (anchor.kind == null) return true; // unbound (legacy resolvers/tests)
      if (!isExtensionStoreKind(anchor.kind) || anchor.kind !== r.kind) {
        refused.push(
          `${packageName}: install-anchor kind binding failed (canonical row kind ` +
            `${JSON.stringify(anchor.kind)} != store path kind "${r.kind}") — refusing`,
        );
        return false;
      }
      return true;
    });
    if (kindBound.length === 0) continue;
    // cinatra#158 — ANCHOR DIGEST BINDING. With the append-only journal, a NEW
    // canonical source could (after a crash mid durable-restore) coexist with the
    // OLD `finalized` journal op. NEW bytes would verify against NEW source, so the
    // integrity/contentHash re-verify alone is NOT sufficient to refuse them. The
    // anchor digest (journal-gated `source.activeDigest` selection, cinatra#792)
    // names the install the DB pins; a real-pipeline install is ALWAYS
    // digest-pinned on disk (`<kind>/<slug>/<digest>/` → rec.declaredDigest). So a
    // BOUND anchor selects exactly the matching record and FAILS CLOSED when none
    // exists (a flat-layout record that claims a digest-bound anchor is suspect —
    // never trust it). An UNBOUND anchor digest (legacy/test rows) proceeds only
    // when the on-disk digest is unambiguous.
    let rec: PackageStoreRecordV2;
    if (anchor.digest) {
      const match = kindBound.find((r) => r.declaredDigest === anchor.digest);
      if (!match) {
        refused.push(
          `${packageName}: install-anchor digest binding failed (anchor ${anchor.digest} != on-disk ` +
            `${kindBound.map((r) => r.declaredDigest ?? "(flat/none)").join(", ")}) — refusing`,
        );
        continue;
      }
      rec = match;
    } else {
      if (kindBound.length > 1) {
        refused.push(
          `${packageName}: ${kindBound.length} store digests on disk but the install anchor is ` +
            `digest-unbound — refusing (ambiguous)`,
        );
        continue;
      }
      rec = kindBound[0];
    }
    narrowed.push(rec);
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
      // cinatra#181: a closure package (recorded closureHash) re-verifies ONLY
      // against a v2 signature binding that hash — never a v1/absent one.
      closureHash: anchor.closureHash ?? null,
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
  // record that activation then refuses, so the same refusal applies here.
  // cinatra#792: computed over the anchor-NARROWED set (at most one record per
  // package name survives narrowing, so this is a defensive fence that should
  // never fire) — computing it over the raw discovered candidates would refuse
  // the legitimate multi-digest-retention case the narrowing just resolved.
  const candidateCountByName = new Map<string, number>();
  for (const rec of narrowed) {
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

  // DEPENDENCY-ORDERED ACTIVATION (#180 item 8): topo-sort the activatable
  // records DEPENDENCIES-FIRST over the persisted canonical edges, so a
  // dependency's `register(ctx)` (capability/provider registrations) commits
  // before any dependent's. Best-effort: an unreadable edge map degrades to
  // the previous discovery order with a loud warning — ordering must never
  // turn a bootable store into a non-bootable one.
  let orderedActivatable = activatable;
  if (activatable.length > 1) {
    try {
      const edgesByPackage = await (hostDeps.readDependencyEdgesByPackage ??
        readLiveDependencyEdgesByPackage)();
      const { orderPackagesByDependencyFirst } = await import(
        "@cinatra-ai/extensions/dependency-closure"
      );
      const order = orderPackagesByDependencyFirst(
        activatable.map((r) => r.packageName),
        edgesByPackage,
      );
      const rank = new Map(order.map((name, i) => [name, i]));
      orderedActivatable = [...activatable].sort(
        (a, b) => (rank.get(a.packageName) ?? 0) - (rank.get(b.packageName) ?? 0),
      );
    } catch (err) {
      console.warn(
        `[runtime-package-loader] dependency-ordered activation degraded to discovery order ` +
          `(edge read failed): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const activationResults = await runRuntimePackageActivation(dataRoot, {
    fs: realStoreFs,
    records: orderedActivatable,
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
      if (!isContainedRealpath(realAbs, realStore)) {
        throw new Error(
          `[runtime-package-loader] serverEntry for ${rec.packageName} resolves outside its package dir — refusing import`,
        );
      }
      return import(/* webpackIgnore: true */ /* @vite-ignore */ pathToFileURL(realAbs).href);
    },
    // `record.envOverrides` is the RAW `cinatra.envOverrides` pass-through
    // (cinatra#982); `resolution` is deliberately omitted for a materialized
    // package-store record (a marketplace install is never the host-locked
    // `"required"` systemExtensions set — see `PackageStoreRecord` in
    // `@cinatra-ai/sdk-extensions`), so only NAMESPACED env keys validate here.
    makeContext: (packageName, grantedPorts, record) =>
      createExtensionHostContext(packageName, grantedPorts, { envOverrides: record.envOverrides }),
    verifyIntegrity: (rec) => {
      const anchor = anchorByName.get(rec.packageName);
      return verifyMaterializedPackageIntegrity(
        rec,
        anchor ? { trustedIntegrity: anchor.integrity, trustedContentHash: anchor.contentHash } : {},
      );
    },
  });

  // engineering#534 S1 — publish the SUCCESSFULLY-ACTIVATED `trusted-signed`
  // set for actor-free, request-time lookup by the widget-auth owner resolver.
  // Gate on the FINAL per-package activation success, NOT the pre-activation
  // `signedTrustedNames` classification alone: a package emits ONE result per
  // phase (register, then bootstrap), so a register-passes/bootstrap-throws
  // activation yields BOTH a `registered` AND a `failed` result. Success ==
  // registered|bootstrapped AND no failure (the exact rule of
  // `summarizeActivation`, replicated inline to avoid a static edge onto that
  // heavy module, which dynamically imports THIS loader). Only a package that
  // truly registered may satisfy a credential-store ownership boundary.
  // `signedTrustedNames` is the trust tier; `ambiguousNames` were already fenced
  // out of activation, re-excluded here as defense in depth. The capability
  // teardown chokepoint clears these markers.
  const failedNames = new Set(
    activationResults.filter((r) => r.status === "failed").map((r) => r.packageName),
  );
  for (const result of activationResults) {
    if (
      (result.status === "registered" || result.status === "bootstrapped") &&
      !failedNames.has(result.packageName) &&
      signedTrustedNames.has(result.packageName) &&
      !ambiguousNames.has(result.packageName)
    ) {
      markPackageSignedActivated(result.packageName);
    }
  }
  return activationResults;
}

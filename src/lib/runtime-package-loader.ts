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
  type HostPortName,
} from "@cinatra-ai/sdk-extensions";
import { discoverStoreRecordsV2, realStoreFs, type PackageStoreRecordV2 } from "@/lib/extension-store-io";
import { isExtensionStoreKind } from "@/lib/extension-package-store-core";
import { createExtensionHostContext, createNonDefaultVersionHostContext } from "@/lib/extension-host-context";
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
   * MULTI-VERSION resolver (cinatra#1040 S4): returns EVERY live version anchor
   * for a package (the default + non-default siblings). When present it takes
   * precedence over `resolveInstallAnchor` — boot + default re-election wire it so
   * side-by-side versions activate together, keyed by (packageName, version), with
   * the DEFAULT version owning global names. When absent the loader falls back to
   * the singular `resolveInstallAnchor` (each package resolves to at most its one
   * default anchor) — the exact pre-S4 single-version behavior, preserved for the
   * exact-org hot-activate/pre-verify callers.
   */
  resolveInstallAnchors?: (packageName: string) => Promise<InstallTrustAnchor[]>;
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

  // MULTI-VERSION anchor resolution (cinatra#1040 S4): the plural resolver
  // returns EVERY live version anchor for a package (default + non-default
  // siblings); the singular resolver (legacy/exact-org pre-verify callers) is
  // adapted to at most its one default anchor. Each anchor runs the UNCHANGED
  // per-record kind/digest/integrity/signature/trust gates below, keyed by
  // (packageName, version) — its own `anchor.digest` selects its own store record.
  const resolveAnchors: (packageName: string) => Promise<InstallTrustAnchor[]> =
    hostDeps.resolveInstallAnchors ??
    (async (packageName: string) => {
      const one = await resolveInstallAnchor(packageName);
      return one ? [one] : [];
    });

  // Trust filter BEFORE activation: a trusted DB anchor must resolve,
  // integrity must verify against THAT anchor (not the sidecar), and the
  // classifier must pass. Anything else is refused.
  const trusted: PackageStoreRecord[] = [];
  const narrowed: PackageStoreRecordV2[] = [];
  // Keyed by (packageName, version) so verifyIntegrity re-selects the exact
  // side-by-side anchor for the record it is re-verifying (name is no longer
  // unique across versions).
  const anchorByIdentity = new Map<string, InstallTrustAnchor>();
  const identityKey = (packageName: string, version: string | null | undefined): string =>
    `${packageName}\u0000${version ?? ""}`;
  // Track which trusted records reached the `trusted-signed` tier — only those are
  // eligible for boot-time host DDL (the capability split): a
  // `trusted-bootstrap` package may import in-process, but its declared migrations
  // must NOT run (running host DDL is a privileged capability gated on a verified
  // signature). cinatra#1040 S4: this is keyed per (name, version) IDENTITY, NOT
  // per name — otherwise a SIGNED non-default sibling would authorize the UNSIGNED
  // DEFAULT version's privileged migrations (a signature-scope escalation). The
  // package-level signed-activated MARKER (widget-auth owner resolver) is a
  // separate name-keyed set gated on the DEFAULT version's own signed tier.
  const signedIdentities = new Set<string>();
  const signedDefaultNames = new Set<string>();
  const activationHosts = trustedActivationHosts();
  const bootstrapTrust = allowMarketplaceBootstrapTrust();
  const refused: string[] = [];
  for (const [packageName, recs] of byName) {
    const anchors = await resolveAnchors(packageName);
    if (anchors.length === 0) {
      refused.push(`${packageName}: no trusted install record`);
      continue;
    }
    for (const anchor of anchors) {
      const label = `${packageName}@${anchor.version ?? "(unversioned)"}`;
      // cinatra#792 — ANCHOR KIND BINDING. The V2 store is kind-segregated, so
      // the canonical row's kind must agree with the record's path-derived kind;
      // a contradiction (or an anchor kind outside the store enum) is refused.
      const kindBound = recs.filter((r) => {
        if (anchor.kind == null) return true; // unbound (legacy resolvers/tests)
        if (!isExtensionStoreKind(anchor.kind) || anchor.kind !== r.kind) {
          refused.push(
            `${label}: install-anchor kind binding failed (canonical row kind ` +
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
      // when the on-disk digest is unambiguous. With SIDE-BY-SIDE versions this
      // per-version digest binding is what pairs each version anchor to ITS OWN
      // store record.
      let rec: PackageStoreRecordV2;
      if (anchor.digest) {
        const match = kindBound.find((r) => r.declaredDigest === anchor.digest);
        if (!match) {
          refused.push(
            `${label}: install-anchor digest binding failed (anchor ${anchor.digest} != on-disk ` +
              `${kindBound.map((r) => r.declaredDigest ?? "(flat/none)").join(", ")}) — refusing`,
          );
          continue;
        }
        rec = match;
      } else {
        if (kindBound.length > 1) {
          refused.push(
            `${label}: ${kindBound.length} store digests on disk but the install anchor is ` +
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
        // requestedHostPorts. cinatra#1040 S4: the host-port grant is per
        // (package, org) and SHARED across a package's side-by-side versions, so
        // each version's activation receives approved_union ∩ that version's OWN
        // manifest-declared ports (rec.requestedHostPorts is still the manifest set
        // here, before the rewrite) — no version gains a port it never declared,
        // and no cross-version port leakage. The DEFAULT version owns global names;
        // a non-default sibling activates against a side-effect-free host context
        // (elected downstream at makeContext via `record.isDefault`).
        const ownDeclared = new Set<HostPortName>((rec.requestedHostPorts ?? []) as HostPortName[]);
        const intersectedPorts = ((anchor.approvedPorts ?? []) as HostPortName[]).filter((p) =>
          ownDeclared.has(p),
        );
        trusted.push({
          ...rec,
          version: anchor.version ?? undefined,
          isDefault: anchor.isDefault !== false,
          requestedHostPorts: intersectedPorts as typeof rec.requestedHostPorts,
        });
        anchorByIdentity.set(identityKey(rec.packageName, anchor.version), anchor);
        if (verdict.tier === "trusted-signed") {
          // Per-identity: THIS version's own signed tier authorizes ITS OWN
          // migrations (never a sibling's).
          signedIdentities.add(identityKey(rec.packageName, anchor.version));
          // Package-level marker gated on the DEFAULT version's signed tier.
          if (anchor.isDefault !== false) signedDefaultNames.add(rec.packageName);
        }
      } else {
        refused.push(`${label}: ${verdict.reason}`);
      }
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
  // cinatra#1040 S4: side-by-side versions mean ONE package name legitimately has
  // several narrowed records — so ambiguity is keyed by (name, version) now.
  // Anchor-narrowing binds each version anchor to its own unique digest, so a
  // duplicated (name, version) here is a genuine identity collision that must
  // fail closed (defensive — it should never fire).
  const candidateCountByIdentity = new Map<string, number>();
  for (const rec of narrowed) {
    const k = identityKey(rec.packageName, rec.version);
    candidateCountByIdentity.set(k, (candidateCountByIdentity.get(k) ?? 0) + 1);
  }
  const ambiguousIdentities = new Set(
    [...candidateCountByIdentity].filter(([, n]) => n > 1).map(([k]) => k),
  );
  if (ambiguousIdentities.size > 0) {
    console.warn(
      `[runtime-package-loader] refusing ${ambiguousIdentities.size} ambiguous (name, version) identity(ies) ` +
        `before the migration pass (multiple store records; fail-closed): ${[...ambiguousIdentities].join(", ")}`,
    );
  }
  // CROSS-VERSION migration UNION (cinatra#1040 S5): migrations are a PER-PACKAGE
  // append-only namespace, not per-version — so EVERY signed live version of a
  // package contributes its declared `cinatra.migrationsDir` to the one shared
  // ledger, applied as an ordered union (semver asc, filename tiebreak) with a
  // package-wide preflight BEFORE any DDL and a whole-package refusal on the first
  // failure (`applyMigrationUnionForTrustedRecords`). This lifts S4's default-only
  // restriction: a non-default sibling that ships migrations beyond the default no
  // longer silently activates against a schema missing its tables. The per-IDENTITY
  // signed gate is preserved — only per-(name, version) `trusted-signed`,
  // non-ambiguous records are eligible; an unsigned sibling that DECLARES migrations
  // is still a WHOLE-PACKAGE refusal (its DDL would be unverified privileged code and
  // its absence leaves the shared schema incomplete for every version).
  const signedTrusted = trusted.filter(
    (rec) =>
      signedIdentities.has(identityKey(rec.packageName, rec.version)) &&
      !ambiguousIdentities.has(identityKey(rec.packageName, rec.version)),
  );
  const bootstrapWithDeclaredMigrations = trusted.filter(
    (rec) => !signedIdentities.has(identityKey(rec.packageName, rec.version)) && recordDeclaresHostMigrations(rec),
  );
  if (bootstrapWithDeclaredMigrations.length > 0) {
    console.warn(
      `[runtime-package-loader] refusing ${bootstrapWithDeclaredMigrations.length} bootstrap-trusted ` +
        `package(s) that declare host migrations (DDL requires a verified signature): ` +
        bootstrapWithDeclaredMigrations.map((r) => r.packageName).join(", "),
    );
  }
  const { applyMigrationUnionForTrustedRecords } = await import("@/lib/extension-migration-host");
  const migration = await applyMigrationUnionForTrustedRecords(signedTrusted);
  if (migration.refused.length > 0) {
    console.warn(
      `[runtime-package-loader] refusing ${migration.refused.length} package(s) whose migrations failed: ` +
        migration.refused.map((r) => `${r.packageName}: ${r.error}`).join("; "),
    );
  }
  // A migration failure / unrunnable-declared-migration is a PACKAGE-level refusal
  // (name-keyed): the shared schema namespace is broken, so NO version of that
  // package may activate.
  const migrationRefused = new Set<string>([
    ...migration.refused.map((r) => r.packageName),
    ...bootstrapWithDeclaredMigrations.map((r) => r.packageName),
  ]);
  const activatable = trusted.filter(
    (rec) =>
      !migrationRefused.has(rec.packageName) &&
      !ambiguousIdentities.has(identityKey(rec.packageName, rec.version)),
  );
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
    // DEFAULT-OWNS-GLOBAL-NAMES ELECTION (cinatra#1040 S4): the DEFAULT version
    // gets the normal grant-aware host context (it registers the package's
    // unversioned global names — MCP tools, capability providers, object types,
    // UI surfaces). A NON-DEFAULT side-by-side version (`record.isDefault ===
    // false`) gets the register-only, SIDE-EFFECT-FREE context so it activates
    // without claiming global names or mutating package-keyed shared state
    // (settings/secrets/objects/nango). The driver additionally skips a
    // non-default version's bootstrap pass. Edge-bound serving of a non-default
    // version is threaded in a later slice (S5).
    makeContext: (packageName, grantedPorts, record) =>
      record.isDefault === false
        ? createNonDefaultVersionHostContext(packageName, grantedPorts, { envOverrides: record.envOverrides })
        : createExtensionHostContext(packageName, grantedPorts, { envOverrides: record.envOverrides }),
    verifyIntegrity: (rec) => {
      const anchor = anchorByIdentity.get(identityKey(rec.packageName, rec.version));
      // FAIL CLOSED on a miss (cinatra#1040 S4): every record reaching activation
      // carries a resolved per-(name, version) anchor, so a missing lookup means an
      // identity-keying bug — NEVER fall back to verifying against the self-attested
      // in-store sidecar (that would re-verify NEW-source residue against itself).
      if (!anchor) return Promise.resolve(false);
      return verifyMaterializedPackageIntegrity(rec, {
        trustedIntegrity: anchor.integrity,
        trustedContentHash: anchor.contentHash,
      });
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
  // `signedTrustedNames` is the trust tier. The marker is PACKAGE-level (the
  // widget-auth owner resolver keys on the name): a package is signed-activated
  // when a signed version of it registered — with side-by-side versions
  // (cinatra#1040 S4) the DEFAULT version is the one that registers global names,
  // and ambiguous identities were already fenced out of `activatable` so they
  // never reach `registered` here. The capability teardown chokepoint clears
  // these markers.
  const failedNames = new Set(
    activationResults.filter((r) => r.status === "failed").map((r) => r.packageName),
  );
  for (const result of activationResults) {
    if (
      (result.status === "registered" || result.status === "bootstrapped") &&
      !failedNames.has(result.packageName) &&
      signedDefaultNames.has(result.packageName)
    ) {
      markPackageSignedActivated(result.packageName);
    }
  }
  return activationResults;
}

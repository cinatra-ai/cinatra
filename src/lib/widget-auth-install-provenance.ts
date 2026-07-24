import "server-only";

// ---------------------------------------------------------------------------
// Marketplace-install PROVENANCE resolution for the widget-auth credential-store
// owner (owner ruling 2026-07-23 — the widget-auth delivery fix, path B).
//
// THE GAP THIS CLOSES. On a released image the wordpress/drupal connectors are
// NOT baked into the generated extension tree; they are installed at runtime as
// marketplace riders. The host loader reconstructs their in-process trust state
// on EVERY boot (a TRUSTED install anchor resolves the canonical
// `installed_extension` row, the materialized store integrity-verifies against
// that anchor, the package classifies `trusted-signed`+activated so
// `isPackageSignedActivated` returns true, and the connector's `register(ctx)`
// registers its `@cinatra-ai/host:*-widget-auth` capability provider). What the
// loader does NOT reconstruct is an admin-approved capability-OWNERSHIP GRANT:
// that row is written only by the interactive install pipeline's
// `autoGrantPrivileged` auto-approve, so an auto-staged rider never gets one and
// the grant-based runtime owner arm fails closed forever — the exact "connect/
// token exchange fails with `WordPress widget-auth capability unavailable` on a
// released image" symptom.
//
// THE TRUST RULE (fail-closed; sanctioned marketplace-install provenance only).
// A runtime package owns the widget-auth credential store for a `tokenConfigKey`
// via install provenance ONLY when ALL of the following hold — the SAME trust
// root the loader itself used to decide to import + run the package in-process,
// so this never lowers the bar below the loader's own import gate:
//   (P1) it has a LIVE registered capability provider for the store's capability
//        id that satisfies the structural guard (never an arbitrary on-disk
//        manifest — the provider must be a package the loader ACTIVATED, whose
//        `register(ctx)` ran; a package that merely exists under /data/extensions
//        never appears here);
//   (P2) it currently classifies `trusted-signed`+activated
//        (`isPackageSignedActivated`) — a bootstrap/untrusted package can never
//        own a credential store even if its code somehow registered a provider;
//   (P3) a TRUSTED install anchor resolves for it — the canonical
//        `installed_extension` DB row (real sha512 SRI + content hash, and the
//        tarball signature when the producer signed it), read from OUTSIDE the
//        writable package store, bound to a concrete tarball digest (an
//        unfinalized / placeholder / legacy-unbound row yields no anchor →
//        refuse);
//   (P4) the anchor-bound materialized store INTEGRITY-VERIFIES against that
//        anchor (the on-disk bytes re-hash to the recorded SRI + content hash) —
//        a tampered / swapped store dir refuses;
//   (P5) the CANONICAL `installed_extension` row DECLARES this exact
//        `tokenConfigKey` in its recorded `widget_auth_token_keys` column (owner
//        ruling 2026-07-23 — the widget-auth delivery fix, path B). The install
//        pipeline records the SRI-verified materialized manifest's declared
//        `cinatra.widgetStream[.auth].tokenConfigKey` set onto the canonical row
//        at the install FINALIZE seam (crash-consistent with the row's source);
//        the resolver reads it from the DB row surfaced on the TRUSTED anchor
//        (`anchor.widgetAuthTokenKeys`) — NEVER by re-reading the mutable
//        `/data/extensions` store. This CLOSES the RESOLVE-TIME P4→P5 TOCTOU: the
//        former arm read the declaration from the store on EVERY unauthenticated
//        request, so a `/data/extensions` writer could swap→read→restore against
//        that read every time; now the declaration is read ONCE, at install, and
//        frozen in the DB — post-install store tampering has NO effect on P5.
//        RESIDUAL (documented, tracked hardening): the install-time source of the
//        recorded value is still a manifest read of the just-materialized store,
//        so a writer could in principle race THAT one-time install read — but this
//        is the EXACT same trust root the ownership GRANT (arm (b)) already
//        records from (the pipeline's `readWidgetAuthTokenKeys(mat.storeDir)`), so
//        arm (c) is no weaker than the admin-grant axis it falls back for; the
//        fully-robust source is the SIGNED tarball / catalog bytes, tracked as a
//        follow-up. A LEGACY row persisted before the recorder ran carries a NULL
//        column → arm (c) FAILS CLOSED on it (never guesses, never falls back to
//        the store). The reviewed, signed declaration IS the ownership claim
//        (mirrors the build-time arm's "the extension whose manifest declares the
//        store owns it"). AND
//   (P6) it is the UNIQUE such package (0 or >1 distinct owners → refuse) — two
//        signed packages declaring the same store key is an ambiguous,
//        unsafe state, never a silent pick.
//
// THREAT MODEL — an attacker who can WRITE /data/extensions.
//   BEFORE this arm: connect/token is fail-closed (unavailable) — the attacker's
//   dropped connector is never honored, but neither is a legitimate rider.
//   AFTER this arm: the attacker still cannot become an owner, because every
//   provenance factor is rooted OUTSIDE the writable store the attacker controls:
//     - P1 requires the loader to have ACTIVATED the package (run its register),
//       which the loader refuses without a trusted anchor (P3) — so a bare
//       dropped store never yields a live provider;
//     - P3's anchor is the canonical DB row (SRI + signature), which the attacker
//       cannot write by touching the filesystem;
//     - P4 re-hashes the store bytes against the DB-recorded SRI/content hash, so
//       a store the attacker swapped/tampered after install fails integrity;
//     - P2 requires a host-trusted signature classification (`trusted-signed`),
//       which an attacker-produced tarball cannot forge without the signing key.
//   The rule is therefore a WIDENING that trusts a package the host has ALREADY
//   decided to trust-signed-activate to own ITS OWN declared store — it does NOT
//   trust arbitrary runtime registration and does NOT path-scan /data/extensions
//   for manifests to trust.
//
// This module is the SINGLE reach for the marketplace-install-provenance axis
// (mirrors how `extension-capability-ownership-grants` is the single reach for
// the grant axis). It is dependency-injected end-to-end so the unauthenticated
// server-to-server resolvers are unit-testable without a pg pool or an on-disk
// store; production callers pass nothing and every default resolves the real
// authority lazily (no eager pool/store work on the import graph).
// ---------------------------------------------------------------------------

import { resolveCapabilityProviders, isPackageSignedActivated } from "@/lib/extension-capabilities-registry";
import type { InstallTrustAnchor } from "@/lib/extension-package-store";

/** A store dir located via the TRUSTED anchor (kind- and digest-bound) AND
 * integrity-verified against that anchor at its recorded SRI/content hash. */
export type VerifiedProvenanceStoreDir = {
  storeDir: string;
  digest: string;
};

/**
 * Injectable seams for the install-provenance owner resolution — every default
 * resolves the real authority lazily; every seam is overridable so the
 * unauthenticated resolvers are unit-testable DB-free / disk-free.
 */
export type InstallProvenanceDeps = {
  /** Distinct package names that currently register a LIVE provider for the
   * capability AND satisfy the structural guard. Default: the in-process
   * capability registry filtered by the caller's guard. */
  listGuardedProviderPackages?: (capability: string, providerGuard: (impl: unknown) => boolean) => string[];
  /** Trust classification (default `isPackageSignedActivated`). */
  isSignedActivated?: (packageName: string) => boolean;
  /** The TRUSTED install anchor, sourced OUTSIDE the writable store (default: the
   * canonical install-record resolver at platform-global scope — these callers
   * are unauthenticated and org-agnostic). */
  resolveInstallAnchor?: (packageName: string) => Promise<InstallTrustAnchor | null>;
  /** Locate the anchor-bound materialized store record (kind + digest binding)
   * AND integrity-verify it against the anchor. Null on any missing / ambiguous
   * / failed factor. */
  resolveVerifiedStoreDir?: (
    packageName: string,
    anchor: InstallTrustAnchor,
  ) => Promise<VerifiedProvenanceStoreDir | null>;
};

/** Default `resolveInstallAnchor` — the canonical `installed_extension` anchor at
 * `platform-global` scope, exactly as the widget-stream runtime arm resolves it.
 *
 * SCOPE (codex security rounds). A runtime marketplace/verdaccio connector is
 * always ORGANIZATION-anchored (a global, non-bundled connector is rejected at
 * install), so `exact-org`+`orgId:null` would resolve NOTHING for a legitimate
 * rider and silently break the fix. `platform-global` resolves the UNIQUE live
 * install across orgs and FAILS CLOSED (null) on 0 or >1 (an ambiguous multi-org
 * install) — so it can never let one of several orgs' installs own the store; it
 * only resolves when there is exactly ONE install instance-wide, which is the
 * correct semantics for the org-agnostic `connector_config` singleton this store
 * is (the same global-singleton scope model arms (a)/(b) and the widget-stream
 * runtime arm use). Unbound/legacy/unfinalized rows resolve to null. */
async function defaultResolveInstallAnchor(packageName: string): Promise<InstallTrustAnchor | null> {
  const { makeDefaultInstallAnchorResolver } = await import("@/lib/extension-install-anchor");
  const resolver = await makeDefaultInstallAnchorResolver(null, "platform-global");
  return resolver(packageName);
}

/**
 * Default `resolveVerifiedStoreDir` — the anchor-bound, integrity-verified store
 * record. Byte-for-byte the widget-stream runtime arm's resolver: a runtime
 * widget-auth owner only ever comes from a real marketplace install whose
 * finalized journal binds the anchor to a tarball digest, so an unbound (legacy)
 * anchor digest is REFUSED, exactly one anchor-digest-bound record must exist,
 * and it must integrity-verify against the anchor's recorded SRI + content hash.
 */
async function defaultResolveVerifiedStoreDir(
  packageName: string,
  anchor: InstallTrustAnchor,
): Promise<VerifiedProvenanceStoreDir | null> {
  if (!anchor.digest) return null;
  const { resolveExtensionDataRoot } = await import("@/lib/extension-data-root");
  const { discoverStoreRecordsV2, realStoreFs } = await import("@/lib/extension-store-io");
  const { isExtensionStoreKind } = await import("@/lib/extension-package-store-core");
  const { verifyMaterializedPackageIntegrity } = await import("@/lib/extension-package-store");
  const records = await discoverStoreRecordsV2(resolveExtensionDataRoot(), realStoreFs);
  const candidates = records.filter((r) => {
    if (r.packageName !== packageName) return false;
    // Anchor-kind binding (mirrors the runtime loader): a bound kind must be a
    // known store kind AND equal the record's PATH kind — else refuse.
    if (anchor.kind != null && (!isExtensionStoreKind(anchor.kind) || anchor.kind !== r.kind)) {
      return false;
    }
    return r.declaredDigest === anchor.digest;
  });
  // Exactly one anchor-digest-bound record or fail closed.
  if (candidates.length !== 1) return null;
  const record = candidates[0]!;
  const ok = await verifyMaterializedPackageIntegrity(record, {
    trustedIntegrity: anchor.integrity,
    trustedContentHash: anchor.contentHash,
  });
  if (!ok) return null;
  return { storeDir: record.storeDir, digest: anchor.digest };
}

/** Default candidate enumeration — the in-process capability registry filtered by
 * the caller's structural guard, deduplicated to distinct package names. A
 * package appears here ONLY because the loader ACTIVATED it and its
 * `register(ctx)` ran (never a bare on-disk manifest). */
function defaultListGuardedProviderPackages(
  capability: string,
  providerGuard: (impl: unknown) => boolean,
): string[] {
  const names = new Set<string>();
  for (const p of resolveCapabilityProviders(capability)) {
    if (providerGuard(p.impl)) names.add(p.packageName);
  }
  return Array.from(names);
}

export type ResolveInstallProvenanceOwnerArgs = {
  /** The capability id whose live providers form the candidate set. */
  capability: string;
  /** The connector_config token key of the credential store to find the owner of. */
  tokenConfigKey: string;
  /** Structural guard applied to each live provider impl so only a genuine store
   * provider counts as a candidate. */
  providerGuard: (impl: unknown) => boolean;
};

/** The resolved marketplace-install-provenance owner: the UNIQUE package name
 * AND the DERIVED org scope of its trusted install anchor. The org is surfaced
 * so the caller can veto a revoked/pending ownership grant at the install's
 * ACTUAL org scope AND global (owner ruling 2026-07-23) — an org-anchored
 * install writes its grant at its org, so a global-only veto would miss it. */
export type ResolvedProvenanceOwner = {
  packageName: string;
  /** The anchor's derived org (`platform-global` → the single live row's org),
   * or null when the row is global/unbound. */
  orgId: string | null;
};

/**
 * Resolve the UNIQUE package that owns `tokenConfigKey`'s credential store via
 * sanctioned marketplace-install provenance (rule P1–P6 above), or null.
 *
 * FAIL-CLOSED CONTRACT. This throws on an INFRASTRUCTURE error (a DB / store-IO
 * failure) so the caller's arm-level try/catch treats the whole arm as
 * unresolved (null) and logs once — a swallowed error never silently masks the
 * arm. It NEVER throws for a NEGATIVE outcome (unknown package, no anchor,
 * integrity mismatch, missing declaration, ambiguity): those return null.
 */
export async function resolveInstallProvenanceOwner(
  args: ResolveInstallProvenanceOwnerArgs,
  deps?: InstallProvenanceDeps,
): Promise<ResolvedProvenanceOwner | null> {
  const listGuardedProviderPackages =
    deps?.listGuardedProviderPackages ?? defaultListGuardedProviderPackages;
  const isSignedActivated = deps?.isSignedActivated ?? isPackageSignedActivated;
  const resolveInstallAnchor = deps?.resolveInstallAnchor ?? defaultResolveInstallAnchor;
  const resolveVerifiedStoreDir = deps?.resolveVerifiedStoreDir ?? defaultResolveVerifiedStoreDir;

  // package name → the anchor's derived org (for the caller's org-scope veto).
  const owners = new Map<string, string | null>();
  for (const packageName of listGuardedProviderPackages(args.capability, args.providerGuard)) {
    // (P2) trusted-signed + activated — cheap in-memory gate first.
    if (!isSignedActivated(packageName)) continue;
    // (P3) a TRUSTED install anchor bound to a concrete digest.
    const anchor = await resolveInstallAnchor(packageName);
    if (!anchor || !anchor.digest) continue;
    // (P4) anchor-bound, integrity-verified materialized store (binds the LIVE
    // provider's on-disk bytes to the DB-recorded digest — a swapped/tampered
    // store dir fails closed).
    const verified = await resolveVerifiedStoreDir(packageName, anchor);
    if (!verified) continue;
    // (P5) the CANONICAL `installed_extension` row DECLARES this exact token key,
    // read from the `widget_auth_token_keys` column surfaced on the trusted anchor
    // (owner ruling 2026-07-23) — NEVER the mutable store at resolve time. This
    // closes the RESOLVE-TIME P4→P5 TOCTOU (the value is frozen in the DB at
    // install; post-install store tampering has no effect). A LEGACY row (null
    // column) fails closed here (never guessed, never re-read from the store).
    const declared = anchor.widgetAuthTokenKeys;
    if (!declared || !declared.includes(args.tokenConfigKey)) continue;
    owners.set(packageName, anchor.orgId ?? null);
  }
  // (P6) unique or fail closed.
  if (owners.size !== 1) return null;
  const [packageName, orgId] = owners.entries().next().value as [string, string | null];
  return { packageName, orgId };
}

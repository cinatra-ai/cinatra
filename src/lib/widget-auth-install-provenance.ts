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
//   (P5) the integrity-verified materialized manifest DECLARES this exact
//        `tokenConfigKey` in `cinatra.widgetStream[.auth].tokenConfigKey` (the
//        reviewed, signed declaration IS the ownership claim — mirrors the
//        build-time arm's "the extension whose manifest declares the store owns
//        it"). The declaration read is BRACKETED by integrity verification (P4
//        verify → read declaration → re-verify at the same anchor digest), which
//        NARROWS a filesystem swap-in of a fake declaration to a swap→read→
//        restore→re-verify race window (defense in depth). It does NOT fully bind
//        the bytes (codex final round) — the fully-robust source is the signed
//        catalog / verified tarball bytes, tracked as a hardening follow-up. This
//        residual grants NO practical power beyond the accepted widening: any
//        package that can be a candidate is already `trusted-signed` and a LIVE
//        provider of the store capability, and could simply DECLARE the key in
//        its own manifest to own the store legitimately — and if the real
//        declaring connector is also present, P6 uniqueness fails closed. AND
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
import { readWidgetAuthTokenKeysFromStore } from "@/lib/extension-capability-ownership-grants";
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
  /** Read the widget-auth token keys the integrity-verified materialized manifest
   * DECLARES (default: the strict `cinatra.widgetStream[.auth].tokenConfigKey`
   * reader — the exact declaration the ownership grant binds). */
  readDeclaredTokenKeys?: (storeDir: string) => Promise<string[]>;
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
): Promise<string | null> {
  const listGuardedProviderPackages =
    deps?.listGuardedProviderPackages ?? defaultListGuardedProviderPackages;
  const isSignedActivated = deps?.isSignedActivated ?? isPackageSignedActivated;
  const resolveInstallAnchor = deps?.resolveInstallAnchor ?? defaultResolveInstallAnchor;
  const resolveVerifiedStoreDir = deps?.resolveVerifiedStoreDir ?? defaultResolveVerifiedStoreDir;
  const readDeclaredTokenKeys = deps?.readDeclaredTokenKeys ?? readWidgetAuthTokenKeysFromStore;

  const owners = new Set<string>();
  for (const packageName of listGuardedProviderPackages(args.capability, args.providerGuard)) {
    // (P2) trusted-signed + activated — cheap in-memory gate first.
    if (!isSignedActivated(packageName)) continue;
    // (P3) a TRUSTED install anchor bound to a concrete digest.
    const anchor = await resolveInstallAnchor(packageName);
    if (!anchor || !anchor.digest) continue;
    // (P4) anchor-bound, integrity-verified materialized store.
    const verified = await resolveVerifiedStoreDir(packageName, anchor);
    if (!verified) continue;
    // (P5) the materialized manifest DECLARES this exact token key — READ, then
    // RE-VERIFY integrity at the SAME anchor digest immediately after. This
    // NARROWS (defense in depth) a filesystem swap-in of a fake declaration to a
    // swap→read→restore→re-verify race; it does not fully bind the bytes (codex
    // final round — the robust source is the signed catalog / verified tarball,
    // tracked as a hardening follow-up). The residual grants no practical power
    // beyond the accepted widening: a candidate is already trusted-signed and a
    // live store provider, so it could simply declare the key legitimately, and
    // if the real declaring connector is also present P6 fails closed.
    const declared = await readDeclaredTokenKeys(verified.storeDir);
    if (!declared.includes(args.tokenConfigKey)) continue;
    const rebound = await resolveVerifiedStoreDir(packageName, anchor);
    if (!rebound || rebound.digest !== verified.digest || rebound.storeDir !== verified.storeDir) {
      continue;
    }
    owners.add(packageName);
  }
  // (P6) unique or fail closed.
  if (owners.size !== 1) return null;
  return owners.values().next().value ?? null;
}

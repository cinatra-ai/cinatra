import "server-only";

// ---------------------------------------------------------------------------
// The boot-time SYSTEM artifact-renderer registrar (epic #1620 M1 Slice B —
// cinatra#1630, plan §5.1 "the four system `-artifact` bases", §5.3 guardrail 4).
//
// The four build-bundled system bases (image/pdf/audio/video-artifact) ship in
// the host build map `GENERATED_ARTIFACT_RENDERERS`. But the representation-
// provider arbitration registry is ORG-SCOPED (`registerProvider(orgId, …)`) —
// so a build-map entry alone does NOT make `resolveRepresentationDispatch` return
// tier "extension"; nothing binds the bases into the registry, so the legacy
// first-party host handlers keep rendering (the "no boot registrar" dormancy
// gap). This module closes it: it derives the canonical per-org provider bindings
// straight FROM the generated map and binds them under the generation-safe
// lifecycle contract, so after reconciliation the dispatch spine routes the four
// MIME families to the build-map fast path.
//
// GENERATION-SAFE LIFECYCLE (plan §5.3.4):
//   - per-org `registerProvider` binding (the existing arbitration API — this
//     module changes NEITHER arbitration registry);
//   - generation-ordered rebind: system bases carry a fixed monotonic generation
//     (they are build-bundled — a "system upgrade" is a host redeploy, i.e. a new
//     process that rebinds fresh at boot); a re-reconcile is an idempotent
//     replace-by-(pattern, slot);
//   - reconcile MISSING bindings: reconciliation is self-healing — it (re)binds
//     any spec the org is missing, so a fresh worker / a new org / a torn-down
//     epoch converges to the full system set;
//   - system extensions REJECT uninstall: the capability-teardown path skips the
//     system packages (see `extension-artifact-renderers-teardown.ts`), so their
//     bindings + generation floor are never retired — reconcile at the fixed
//     generation therefore always remains valid (never tombstoned);
//   - the floor covers transient gaps: before the first reconcile for an org (or
//     in a stale worker) the row falls to the never-blank generic floor, never a
//     blank.
//
// DERIVED, NOT HARDCODED: the bound provider set is a projection of
// `GENERATED_ARTIFACT_RENDERERS` — every build-map entry that declares
// `representations` binds one representation provider per (representation, slot).
// The generated map only ever carries the build-bundled system bases (a runtime/
// marketplace renderer is admitted through the runtime asset registry, never the
// generated map), so "every generated-map entry is a system provider" is exactly
// the set of platform bases — a new base appears purely by regenerating the map.
// ---------------------------------------------------------------------------

import {
  representationProviderRegistry,
  representationMatchSpecificity,
} from "@cinatra-ai/objects/artifact-renderer-registry";
import type { ArtifactUiSlot } from "@cinatra-ai/sdk-extensions/artifact-contract";

import {
  GENERATED_ARTIFACT_RENDERERS,
  type GeneratedArtifactRendererEntry,
} from "@/lib/generated/artifact-renderers";
import { PREVIEW_INLINE_MIME_ALLOWLIST_FOR_TESTS } from "@/lib/artifacts/artifact-read";

/**
 * The fixed activation generation the system bases bind under. They are build-
 * bundled — effectively always at generation 1 within a process; a genuine
 * "upgrade" is a host redeploy (a new process that rebinds fresh). Because the
 * teardown path never retires a system package, this generation is never
 * tombstoned, so a self-healing reconcile at generation 1 always stays valid.
 */
export const SYSTEM_ARTIFACT_RENDERER_GENERATION = 1;

/** One canonical per-org representation-provider binding for a system base. */
export interface SystemRepresentationProviderSpec {
  packageName: string;
  /** A representation pattern (an exact MIME / a type-wildcard / catch-all). */
  pattern: string;
  slot: ArtifactUiSlot;
}

/**
 * The generated build-map entries that are SYSTEM bases. `resolution: "required"`
 * is EXACTLY membership in `cinatra.systemExtensions`: the generator classifies
 * every entry `resolutionOf(pkg) = systemExtensions.has(pkg) ? "required" :
 * "guardedOptional"` (scripts/extensions/generate-extension-manifest.mjs). The map
 * carries an entry for EVERY bundled `kind:"artifact"` extension that declares
 * `cinatra.artifact.ui.renderers` — NOT only system ones — so a bundled NON-system
 * (`guardedOptional`) artifact could otherwise leak into the "system" set. That
 * would auto-bind it for every org AND exempt it from capability teardown — an
 * isolation break (activate-without-install + survive-uninstall). Filtering to
 * `required` here ENFORCES the "system = host-release-locked" boundary instead of
 * assuming the map only ever carries system bases (Codex convergence, cinatra#1630).
 */
function requiredSystemRendererEntries(): GeneratedArtifactRendererEntry[] {
  return Object.values(GENERATED_ARTIFACT_RENDERERS).filter(
    (entry) => entry.resolution === "required",
  );
}

/**
 * The set of package names the generated build map ships AS SYSTEM BASES — the
 * `resolution: "required"` (== `systemExtensions`) artifact-renderer packages.
 * THESE are the "system extensions" the teardown path must refuse to uninstall
 * (they are part of the host release, not marketplace installs). Derived from the
 * map (filtered to `required`) so it can never drift from what is built.
 */
export function systemArtifactRendererPackages(): ReadonlySet<string> {
  const names = new Set<string>();
  for (const entry of requiredSystemRendererEntries()) {
    names.add(entry.packageName);
  }
  return names;
}

/** True iff `packageName` is a build-bundled system artifact-renderer base. */
export function isSystemArtifactRendererPackage(packageName: string): boolean {
  return systemArtifactRendererPackages().has(packageName);
}

/**
 * The canonical system representation-provider bindings, projected from the
 * generated build map AND GATED BY THE PREVIEW-INLINE ALLOWLIST. Each declared
 * representation (a wildcard like `image/*` or an exact MIME) is EXPANDED to the
 * set of allowlisted MIMEs it matches, and a spec is bound per EXACT allowlisted
 * MIME — never the raw wildcard.
 *
 * WHY (Codex): a system base renders inline by pointing at the host preview route
 * (`urls.preview`), which serves ONLY the allowlisted MIMEs and 415s the rest. A
 * raw `image/*` / `audio/*` / `video/*` provider would therefore claim rows the
 * byte route refuses (e.g. `image/bmp`, `audio/midi`, `video/quicktime`) and
 * mount a broken player instead of the never-blank fallback. Binding at the
 * allowlist granularity preserves the pre-cutover invariant exactly: the detail
 * page inline-renders precisely the MIMEs the preview route serves; everything
 * else falls to the generic floor. An entry with no `representations` contributes
 * none. Only `resolution: "required"` (== `systemExtensions`) entries are
 * projected — a bundled `guardedOptional` artifact renderer is NEVER auto-bound as
 * a system provider (Codex convergence, cinatra#1630).
 */
export function systemRepresentationProviderSpecs(): SystemRepresentationProviderSpec[] {
  const specs: SystemRepresentationProviderSpec[] = [];
  const seen = new Set<string>();
  for (const entry of requiredSystemRendererEntries()) {
    for (const pattern of entry.representations ?? []) {
      for (const mime of PREVIEW_INLINE_MIME_ALLOWLIST_FOR_TESTS) {
        // Bind an EXACT allowlisted MIME whenever the declared representation
        // matches it (exact / type-wildcard / catch-all).
        if (representationMatchSpecificity(pattern, mime) < 0) continue;
        const key = `${entry.packageName}\u0000${mime}\u0000${entry.slot}`;
        if (seen.has(key)) continue;
        seen.add(key);
        specs.push({ packageName: entry.packageName, pattern: mime, slot: entry.slot });
      }
    }
  }
  return specs;
}

/**
 * Bind (idempotently, self-healing) every system base representation provider
 * for `orgId` into the arbitration registry under the fixed system generation.
 * Cheap in-memory registry writes; safe to call on every resolve — a spec the
 * org already carries is an idempotent replace, and a missing spec (fresh worker
 * / new org / post-`_clearForTests`) is re-bound. Returns the number of specs
 * (re)bound this call.
 *
 * SELF-HEALING over a memo: reconciliation reads the LIVE registry snapshot
 * rather than a per-process "already reconciled" flag, so it converges after a
 * test-reset or any transient gap without stale-cache coupling. When the org
 * already carries every system spec, this is a no-op fast path.
 */
export function reconcileSystemRepresentationProviders(orgId: string): number {
  const specs = systemRepresentationProviderSpecs();
  if (specs.length === 0) return 0;

  // Fast path: skip the writes when the org already carries every system spec
  // (the steady state on a warm worker).
  const present = representationProviderRegistry._snapshotOrgProviders(orgId);
  const has = (s: SystemRepresentationProviderSpec): boolean =>
    present.some(
      (d) => d.packageName === s.packageName && d.pattern === s.pattern && d.slot === s.slot,
    );
  if (specs.every(has)) return 0;

  for (const spec of specs) {
    representationProviderRegistry.registerProvider(orgId, {
      packageName: spec.packageName,
      pattern: spec.pattern,
      slot: spec.slot,
      generation: SYSTEM_ARTIFACT_RENDERER_GENERATION,
    });
  }
  return specs.length;
}


// ===========================================================================
// FOLDED-IN (cinatra#2044 S6 L-A3): the ACTIVATION-COUPLED per-org binder lives
// in THIS module rather than its own file. It is the SECOND writer into the same
// org-scoped `representationProviderRegistry` and imports the exact same three
// modules the system registrar above imports, so co-locating costs nothing and
// keeps both registry writers — the system (`required`) projection and the
// activation-coupled (`guardedOptional`) binding — readable side by side. It is
// also what keeps the route-graph ratchet at baseline: a separate leaf module
// would have added exactly +1 reachable first-party module to all five locked
// FIXED_ROUTES (it is reached from every route through
// `extension-runtime-activate`), and the sanctioned alternative would have been
// an absorb record for growth that is avoidable outright.
// ===========================================================================

// ---------------------------------------------------------------------------
// ACTIVATION-COUPLED per-org representation-provider binding for NON-SYSTEM
// (`resolution: "guardedOptional"`) build-bundled artifact-renderer packs
// (cinatra#2044 S6 L-A3; the lifecycle cinatra#1630's ratified plan of record
// deferred as "the un-wired activation-bind + teardown-retire lifecycle …
// it lands with the real bases").
//
// THE GAP THIS CLOSES
// -------------------
// `system-artifact-renderer-registrar.ts` is the ONLY production writer into the
// org-scoped `representationProviderRegistry`, and it deliberately projects ONLY
// `resolution === "required"` (== `cinatra.systemExtensions`) entries: admitting a
// bundled `guardedOptional` renderer THERE would auto-bind it for every org AND
// exempt it from capability teardown — the ratified #1630 isolation break
// (activate-without-install + survive-uninstall). That filter is CORRECT and is
// left exactly as it is.
//
// The consequence was that a bundled, dev-enrolled, non-system renderer had NO
// production binding path at all, so `resolveRepresentationDispatch` returned null
// for its MIME and an artifact review target floored to "review target
// unavailable". This module supplies the missing path WITHOUT reversing the
// guardrail, by making the binding ACTIVATION-COUPLED and per-org:
//
//   * BINDS only for an org that has a LIVE (`active|locked`) canonical
//     `installed_extension` row of kind `artifact` GOVERNING that org
//     (org-owned row first, else an ambient platform/workspace row) — so there is
//     no activation-without-install, and no other org sees the provider;
//   * RETIRES the org's binding the moment that governing row stops being live —
//     `reconcileActivatedRepresentationProviders` is a TRUE reconcile (bind the
//     governed, retire the ungoverned), so uninstall isolation converges even in a
//     worker that never received the in-memory capability teardown;
//   * carries GENERATION semantics that survive long-lived processes (below).
//
// WHY NOT THE `PREVIEW_INLINE_MIME_ALLOWLIST`
// -------------------------------------------
// The preview BYTE route gates on `isInlineTransportEligible(orgId, mime)` — the
// capability-resolved gate #1630 AC-2 installed precisely so that "preview
// eligibility resolves through the effective representation-provider capability …
// WITHOUT knowing concrete MIME identities". A pack that ships a `preview`-slot
// renderer therefore opens the byte route for ITS OWN MIME, FOR THAT ORG ONLY,
// coupled to its install, and fails closed on uninstall. Adding the MIME to the
// concrete `PREVIEW_INLINE_MIME_ALLOWLIST` instead would open the route for EVERY
// org unconditionally and re-introduce a concrete MIME identity into core — the
// exact coupling AC-2 removed. So the allowlist is NOT touched by this lane. The
// host's safe-transport profile is unchanged and still applied by MIME CLASS
// (byte cap, `nosniff`, sandbox CSP, inline disposition, range handling).
//
// FAIL-CLOSED NARROWINGS (each is a test)
// ---------------------------------------
//   1. specs derive ONLY from the host-built `GENERATED_ARTIFACT_RENDERERS` — never
//      from caller input and never from a package-supplied manifest read at bind
//      time;
//   2. ONLY `resolution === "guardedOptional"` entries (strict equality, not
//      `!== "required"`) — `required` entries stay exclusively the system
//      registrar's, so there is no double-binding and no required-path regression;
//   3. ONLY EXACT MIME patterns bind. A wildcard (`image/*`) or catch-all (`*/*`)
//      declared by a non-system pack is REFUSED — a third-party pack may not claim
//      a whole representation family per org;
//   4. a pattern that COLLIDES with any system (`required`) entry's declared
//      representation at the same slot is REFUSED — the registry's resolve ranks
//      extension-vs-extension by generation, so without this a `guardedOptional`
//      pack could out-rank and shadow a host system base (e.g. by declaring
//      `application/pdf`);
//   5. no governing live row ⇒ NO binding (a merely bundled / dev-enrolled pack is
//      inert);
//   6. a canonical-store READ FAILURE retires the org's activated providers rather
//      than leaving them effective — an unreadable store cannot PROVE the install
//      is still live, and the never-blank generic floor is the safe degrade.
//      (Deliberately NOT the CG-1 "no row ⇒ ungoverned ⇒ allow" allowance that
//      `isArtifactExtensionWriteAllowed` grants for WRITES: this is a rendering
//      capability grant, so absence of proof is refusal. The org-scoped LIVE-row
//      PICK is the same as that gate's; the no-row default is deliberately the
//      opposite.)
//
// NO CACHE, BY DESIGN. The reconcile reads the canonical store on every call. A
// TTL memo would leave a stale provider effective after an uninstall for the
// length of the TTL in every worker that missed the teardown — fail-open for
// revocation. The read is ONE indexed `IN (…)` query over the handful of
// guardedOptional renderer packages the host actually built.
// ---------------------------------------------------------------------------


/** One canonical per-org representation-provider binding for an activated,
 *  non-system (guardedOptional) renderer pack. */
export interface ActivatedRepresentationProviderSpec {
  packageName: string;
  /** An EXACT MIME. Wildcards never reach this type (refused upstream). */
  pattern: string;
  slot: ArtifactUiSlot;
}

/**
 * The package names the build map carries at least one `resolution: "required"`
 * entry for — the SYSTEM bases, owned exclusively by the system registrar.
 */
function packagesWithRequiredEntries(): ReadonlySet<string> {
  const names = new Set<string>();
  for (const entry of Object.values(GENERATED_ARTIFACT_RENDERERS)) {
    if (entry.resolution === "required") names.add(entry.packageName);
  }
  return names;
}

/**
 * The generated build-map entries that are NON-SYSTEM renderer packs.
 *
 * PACKAGE-PURITY GUARD (closure-review finding): a package is excluded outright if
 * the map carries ANY `required` entry for it, even when some of its entries are
 * `guardedOptional`. Retirement is necessarily PACKAGE-scoped
 * (`retireOrgProvider(orgId, packageName)` — the registry has no per-(pattern,
 * slot) retire), so admitting a MIXED package would let this module retire that
 * package's SYSTEM bindings and strand the host's own MIME families. The
 * generator classifies resolution per PACKAGE today
 * (`systemExtensions.has(pkg) ? "required" : "guardedOptional"`), so no mixed
 * package exists — but this ENFORCES that invariant rather than assuming it,
 * exactly as the system registrar's own `required` filter does in the other
 * direction (cinatra#1630).
 */
function guardedOptionalRendererEntries(): GeneratedArtifactRendererEntry[] {
  const systemPackages = packagesWithRequiredEntries();
  return Object.values(GENERATED_ARTIFACT_RENDERERS).filter(
    (entry) =>
      entry.resolution === "guardedOptional" && !systemPackages.has(entry.packageName),
  );
}

/** True iff `pattern` is an EXACT MIME (`type/subtype`) — not a type-wildcard
 *  and not the universal catch-all. */
function isExactMimePattern(pattern: string): boolean {
  if (pattern.includes("*")) return false;
  const slash = pattern.indexOf("/");
  return slash > 0 && slash < pattern.length - 1;
}

/**
 * True iff a SYSTEM (`required`) build-map entry already claims `mime` at `slot`.
 * Refusing these keeps a non-system pack from shadowing a host base per org.
 */
function collidesWithSystemBase(mime: string, slot: ArtifactUiSlot): boolean {
  for (const entry of Object.values(GENERATED_ARTIFACT_RENDERERS)) {
    if (entry.resolution !== "required") continue;
    if (entry.slot !== slot) continue;
    for (const pattern of entry.representations ?? []) {
      if (representationMatchSpecificity(pattern, mime) >= 0) return true;
    }
  }
  return false;
}

/**
 * The bindable specs for ONE non-system renderer package, projected from the
 * generated build map under narrowings 1–4 above. A package that is absent from
 * the map, is `required`, declares no representations, or declares only refused
 * patterns yields an EMPTY list (and therefore never binds).
 */
export function activatedRepresentationProviderSpecs(
  packageName: string,
): ActivatedRepresentationProviderSpec[] {
  const specs: ActivatedRepresentationProviderSpec[] = [];
  const seen = new Set<string>();
  for (const entry of guardedOptionalRendererEntries()) {
    if (entry.packageName !== packageName) continue;
    for (const pattern of entry.representations ?? []) {
      if (!isExactMimePattern(pattern)) {
        console.warn(
          `[activated-artifact-renderers] refusing non-exact representation "${pattern}" ` +
            `declared by non-system pack ${packageName} (slot ${entry.slot}) — a guardedOptional ` +
            `pack may claim only EXACT MIMEs`,
        );
        continue;
      }
      if (collidesWithSystemBase(pattern, entry.slot)) {
        console.warn(
          `[activated-artifact-renderers] refusing representation "${pattern}" declared by ` +
            `non-system pack ${packageName} (slot ${entry.slot}) — a host system base already ` +
            `claims it; a guardedOptional pack may not shadow a system base`,
        );
        continue;
      }
      const key = `${pattern} ${entry.slot}`;
      if (seen.has(key)) continue;
      seen.add(key);
      specs.push({ packageName, pattern, slot: entry.slot });
    }
  }
  return specs;
}

/** Every non-system renderer package the host actually built (the reconcile's
 *  candidate set — nothing outside the build map is ever considered). */
export function activatableRendererPackages(): string[] {
  return [...new Set(guardedOptionalRendererEntries().map((e) => e.packageName))].sort();
}

// ---------------------------------------------------------------------------
// GENERATION SEMANTICS (long-lived processes).
//
// `representationProviderRegistry` keeps a MONOTONIC per-(org, package) generation
// FLOOR that teardown KEEPS as a tombstone, so a re-bind after an uninstall MUST
// carry a STRICTLY HIGHER generation or it is (correctly) rejected as a delayed
// straggler from the torn-down epoch.
//
// A wall-clock generation (`updatedAt.getTime()`) is NOT a safe source: two
// lifecycle events inside one millisecond collide, and an application-clock
// rollback or cross-worker skew can mint a generation BELOW the tombstone —
// permanently suppressing a legitimate reinstall (design-review finding).
//
// The floor is PROCESS-LOCAL (an in-memory Map), so the generation only has to be
// monotonic with respect to what THIS process itself bound. So we allocate it
// locally: a durable EPOCH TOKEN derived from the governing row identifies the
// epoch; while the token is unchanged the same generation number is reused (an
// idempotent same-epoch re-bind), and ANY durable change mints `previous + 1`.
// Strictly increasing by construction — immune to clock skew, ms collisions and
// rollback — and needs no schema column, hence NO MIGRATION.
// ---------------------------------------------------------------------------

/** The durable epoch token for a governing install row. Any lifecycle event that
 *  matters (reinstall ⇒ new row id; update ⇒ new version; archive/restore ⇒ new
 *  status + bumped `updatedAt`) changes it. */
export function installEpochToken(row: {
  id: string;
  status: string;
  version: string | null;
  updatedAt: Date | string | null;
}): string {
  const updated =
    row.updatedAt instanceof Date
      ? row.updatedAt.toISOString()
      : typeof row.updatedAt === "string"
        ? row.updatedAt
        : "";
  return `${row.id} ${row.status} ${row.version ?? ""} ${updated}`;
}

/** Process-local `(orgId, packageName)` → the epoch token + the generation we
 *  allocated for it. */
const allocatedGenerations = new Map<string, { token: string; generation: number }>();

function generationKey(orgId: string, packageName: string): string {
  return `${orgId} ${packageName}`;
}

/**
 * The generation to bind `(orgId, packageName)` under for the given durable epoch
 * token — stable while the token is unchanged, `previous + 1` on any change.
 * Exported for the lifecycle tests.
 */
export function generationForEpoch(orgId: string, packageName: string, token: string): number {
  const key = generationKey(orgId, packageName);
  const prior = allocatedGenerations.get(key);
  if (prior && prior.token === token) return prior.generation;
  const generation = (prior?.generation ?? 0) + 1;
  allocatedGenerations.set(key, { token, generation });
  return generation;
}

/**
 * A token that can never equal a real epoch token (a real one is built from
 * `installEpochToken`, whose parts never contain a NUL). Parking this on the
 * allocator entry keeps the allocated GENERATION but guarantees the next bind
 * takes the "token changed" branch.
 */
const RETIRED_EPOCH_TOKEN = " retired";

/**
 * Invalidate the process-local epoch allocation for `(orgId, packageName)` after
 * THIS module retired its bindings.
 *
 * WHY (closure-review finding — a recovery deadlock): the registry KEEPS the
 * generation floor as a tombstone when bindings are retired. If the allocator
 * then handed back the SAME generation for an UNCHANGED install row — which is
 * exactly what happens after a fail-closed retire on a transient canonical-store
 * outage — `registerProvider` would see `generation === floor` with no live
 * binding, classify the write as a delayed straggler from a torn-down epoch, and
 * REJECT it. The provider could never come back until the install row itself
 * changed. Keeping the generation but clearing the token means the next bind
 * mints `previous + 1`, which is strictly above the tombstone floor, so a
 * transient outage recovers on the very next reconcile while a genuine
 * torn-down-epoch straggler (which does NOT go through this allocator) still
 * cannot resurrect anything.
 */
function invalidateEpochAllocation(orgId: string, packageName: string): void {
  const key = generationKey(orgId, packageName);
  const prior = allocatedGenerations.get(key);
  if (prior) allocatedGenerations.set(key, { ...prior, token: RETIRED_EPOCH_TOKEN });
}

/** @internal test-only reset of the process-local generation allocator. */
export function _resetActivatedGenerationsForTests(): void {
  allocatedGenerations.clear();
}

// ---------------------------------------------------------------------------
// The governing-row pick + the reconcile.
// ---------------------------------------------------------------------------

/** The minimum canonical-row shape the binder reads (structural, so the tests can
 *  supply rows without constructing a full `InstalledExtension`). */
export interface GoverningInstallRow {
  id: string;
  kind: string;
  status: string;
  version: string | null;
  organizationId: string | null;
  updatedAt: Date | string | null;
}

/**
 * The LIVE canonical row that governs `orgId` for a package, or null.
 *
 * Row PICK identical to `isArtifactExtensionWriteAllowed` (kind `artifact`, LIVE
 * = `active|locked`, org-owned row first then an ambient platform/workspace row,
 * never another org's row) so discovery and write authz cannot diverge. The NO-ROW
 * default is deliberately the OPPOSITE of that gate's CG-1 allowance: a rendering
 * capability is granted only on a PROVEN live install.
 */
export function pickGoverningRow(
  rows: readonly GoverningInstallRow[],
  orgId: string,
): GoverningInstallRow | null {
  const live = rows.filter(
    (r) => r.kind === "artifact" && (r.status === "active" || r.status === "locked"),
  );
  if (live.length === 0) return null;
  return (
    live.find((r) => r.organizationId === orgId) ??
    live.find((r) => r.organizationId == null) ??
    null
  );
}

/** Bind one package's specs for one org at one generation. Returns the count. */
function bindSpecs(orgId: string, packageName: string, generation: number): number {
  const specs = activatedRepresentationProviderSpecs(packageName);
  for (const spec of specs) {
    representationProviderRegistry.registerProvider(orgId, {
      packageName: spec.packageName,
      pattern: spec.pattern,
      slot: spec.slot,
      generation,
    });
  }
  return specs.length;
}

export interface ActivatedReconcileResult {
  bound: string[];
  retired: string[];
  /** True when the reconcile could not PROVE the install state — every candidate
   *  was retired (fail-closed) rather than left effective. */
  degraded: boolean;
}

/** Retire every activatable package for `orgId` and invalidate their epoch
 *  allocations so the next PROVEN reconcile can rebind above the tombstone
 *  floor. The single fail-closed degrade used by every unprovable path. */
function retireAllForOrg(orgId: string, packages: readonly string[]): string[] {
  const retired: string[] = [];
  for (const packageName of packages) {
    if (representationProviderRegistry.retireOrgProvider(orgId, packageName) > 0) {
      retired.push(packageName);
    }
    invalidateEpochAllocation(orgId, packageName);
  }
  return retired;
}

/**
 * TRUE RECONCILE of every activatable (non-system, build-bundled) renderer pack
 * for ONE org: bind the ones a live install row governs, retire the ones it does
 * not. Idempotent, self-healing, and symmetric with capability teardown — this is
 * what makes a fresh worker, a restarted process, or a worker that missed the
 * in-memory teardown converge to the truth in the canonical store.
 *
 * Never throws: a canonical-store failure degrades to "retire everything" and the
 * row falls to the never-blank generic floor.
 */
export async function reconcileActivatedRepresentationProviders(
  orgId: string,
): Promise<ActivatedReconcileResult> {
  const packages = activatableRendererPackages();
  if (packages.length === 0) return { bound: [], retired: [], degraded: false };

  const bound: string[] = [];
  const retired: string[] = [];

  let byPackage: Map<string, GoverningInstallRow[]>;
  try {
    const { readInstalledExtensionsByPackageNames } = await import(
      "@cinatra-ai/extensions/canonical-store"
    );
    byPackage = (await readInstalledExtensionsByPackageNames(packages)) as unknown as Map<
      string,
      GoverningInstallRow[]
    >;
  } catch (err) {
    // FAIL-CLOSED: an unreadable canonical store cannot prove the install is still
    // live, so no activated provider stays effective. The generic floor renders.
    console.warn(
      "[activated-artifact-renderers] canonical-store read failed — retired every activated " +
        `provider for org (fail-closed): ${err instanceof Error ? err.message : String(err)}`,
    );
    return { bound: [], retired: retireAllForOrg(orgId, packages), degraded: true };
  }

  for (const packageName of packages) {
    const governing = pickGoverningRow(byPackage.get(packageName) ?? [], orgId);
    if (!governing) {
      // A genuine uninstall/archive (or another org's row). Invalidate the epoch
      // allocation too, so a later REINSTALL that happens to reuse the same
      // durable epoch still binds above the tombstone floor.
      if (representationProviderRegistry.retireOrgProvider(orgId, packageName) > 0) {
        retired.push(packageName);
      }
      invalidateEpochAllocation(orgId, packageName);
      continue;
    }
    const generation = generationForEpoch(orgId, packageName, installEpochToken(governing));
    if (bindSpecs(orgId, packageName, generation) > 0) bound.push(packageName);
  }
  return { bound, retired, degraded: false };
}

/**
 * The ASYNC pre-step the resolve surfaces await before the SYNC
 * `resolveRepresentationDispatch` / `isInlineTransportEligible`. Total by
 * contract — never throws, so a resolve path can always call it.
 */
export async function ensureActivatedRepresentationProviders(orgId: string): Promise<void> {
  try {
    await reconcileActivatedRepresentationProviders(orgId);
  } catch (err) {
    // FAIL-CLOSED, NOT FAIL-OPEN (closure-review finding): a throw AFTER the
    // canonical read — a malformed row, a registry write error — would otherwise
    // leave already-bound providers effective, which is fail-open for revocation.
    // An unprovable reconcile retires exactly like an unreadable store does, so
    // the ONLY outcome of any failure is the never-blank generic floor.
    console.warn(
      "[activated-artifact-renderers] reconcile threw — retired every activated provider for " +
        "org (fail-closed; the row falls to the floor):",
      err instanceof Error ? err.message : err,
    );
    try {
      retireAllForOrg(orgId, activatableRendererPackages());
    } catch {
      // Total by contract — a resolve path must always be able to call this.
    }
  }
}

/**
 * The INSTALL/ACTIVATION-TRANSACTION bind: called from the artifact install hook
 * for the just-activated package so the running process picks the renderer up
 * WITHOUT waiting for the next resolve. Only ever binds for a CONCRETE org — an
 * AMBIENT (platform/workspace, `organizationId === null`) install has no single
 * org to bind and is left to the per-org reconcile, which resolves ambient rows
 * correctly for whichever org actually renders.
 *
 * Returns the number of specs bound (0 when the package is not an activatable
 * build-map pack, or the install is ambient). Never throws.
 */
export function bindActivatedRepresentationProvidersForInstall(input: {
  packageName: string;
  row: GoverningInstallRow;
}): number {
  try {
    const orgId = input.row.organizationId;
    if (!orgId) return 0;
    if (!pickGoverningRow([input.row], orgId)) return 0;
    const generation = generationForEpoch(
      orgId,
      input.packageName,
      installEpochToken(input.row),
    );
    return bindSpecs(orgId, input.packageName, generation);
  } catch (err) {
    console.warn(
      `[activated-artifact-renderers] install-time bind threw for "${input.packageName}" (non-fatal):`,
      err instanceof Error ? err.message : err,
    );
    return 0;
  }
}

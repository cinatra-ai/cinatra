import type { EffectiveIdentity } from "./effective-identity";
import type { ArtifactUiSlot } from "@cinatra-ai/sdk-extensions/artifact-contract";

// ---------------------------------------------------------------------------
// Artifact-renderer arbitration — the TWO registries of the dispatch spine
// (cinatra#1629, epic #1620 S2).
//
// An artifact extension ships its type's view (the `cinatra.artifact.ui` block,
// S1). The BUILD table of which renderer modules exist is the generated
// literal-import map `GENERATED_ARTIFACT_RENDERERS` (connector-setup-pages
// pattern). These two registries are the RUNTIME arbitration tables that resolve
// a row to a key INTO that build table. They deliberately NEVER share a keyspace
// (see {@link assertDisjointKeyspaces}):
//
//   1. SEMANTIC-TYPE renderers — keyed by `objectTypeId`. Resolution is bound to
//      the per-org effective-identity WINNER: a descriptor renders ONLY when the
//      org's winning extension for the row IS its claimant, so a LOSING
//      claimant's renderer never leaks (arbitration = effective identity, not
//      this table). Populated at claim/type registration; retired on
//      teardown/uninstall (removeByPackage).
//
//   2. REPRESENTATION providers — keyed by `(representation pattern, slot)`,
//      ORG-SCOPED. Exact > type-wildcard > catch-all precedence; extension
//      providers bind per org at an activation GENERATION (upgrade supersedes a
//      lower generation; a stale generation is ignored); ALWAYS-EFFECTIVE
//      first-party defaults sit under the extension providers. Until a provider
//      is effective for an org, resolution falls through to the first-party
//      default (the host handler/floor) — never blank.
//
// Both are process-global `Symbol.for(...)` singletons (same cross-compilation
// anchor as `objectTypeRegistry`): an extension registers at boot/activation in
// one Next.js bundler compilation; the dispatch surface reads them at request
// time in another. PURE (no React / DB / server-only) so the arbitration is
// unit-testable.
// ---------------------------------------------------------------------------

/** The separator joining `(packageName, slot)` into a `GENERATED_ARTIFACT_RENDERERS`
 * key. `::` is safe — it never appears in an npm package name or a slot token.
 * The generator emits the identical format (mirror; a well-formed but non-built
 * key is the "requires rebuild" signal, so the two producers must agree). */
const GENERATED_KEY_SEP = "::";

/** The `GENERATED_ARTIFACT_RENDERERS` key for a `(package, slot)` renderer
 * module. Shared by the boot registrar (which stores it in a descriptor) and the
 * generator (which emits it), so the runtime "is this claimant in the build?"
 * check is a plain `key in GENERATED_ARTIFACT_RENDERERS`. */
export function generatedArtifactRendererKey(
  packageName: string,
  slot: ArtifactUiSlot,
): string {
  return `${packageName}${GENERATED_KEY_SEP}${slot}`;
}

// ===========================================================================
// 1. Semantic-type renderer registry — objectTypeId keyspace.
// ===========================================================================

/**
 * The slots the SEMANTIC registry arbitrates: `detail` (the artifact detail
 * view) and — since S7/M2 (cinatra#1631) activated it — `listRow` (the compact
 * row capability the artifacts-library glyph cell resolves for a claimed row).
 * `preview` stays a REPRESENTATION-only capability (the neutral in-core reuse
 * seam) and never enters this keyspace.
 */
export const SEMANTIC_RENDERER_SLOTS = ["detail", "listRow"] as const;
export type SemanticRendererSlot = (typeof SEMANTIC_RENDERER_SLOTS)[number];

/** A registered extension-shipped renderer for one (object type, slot). The
 * `generatedKey` is DERIVED from `(packageName, slot)` inside the registry
 * — never caller-supplied — so a claimant can only ever resolve to ITS OWN
 * module. */
export interface SemanticRendererDescriptor {
  /** KEYSPACE part 1: the object type id the renderer renders (namespaced, e.g.
   * `@scope/contract-artifact:artifact`). Never a representation pattern. */
  objectTypeId: string;
  /** KEYSPACE part 2 / claimant: the extension that ships the renderer. Two
   * different claimants of the SAME type each keep their own descriptor, so the
   * per-org effective-identity winner resolves independently (they never
   * overwrite each other). */
  packageName: string;
  /** Derived key into `GENERATED_ARTIFACT_RENDERERS` — resolves to the build
   * entry (or is absent from the build ⇒ "never built" ⇒ requires-rebuild). */
  generatedKey: string;
  /** KEYSPACE part 3: the semantic slot this renderer serves (`detail` for the
   * pre-S7 call shape). */
  slot: SemanticRendererSlot;
}

function semanticStoreKey(
  objectTypeId: string,
  packageName: string,
  slot: SemanticRendererSlot,
): string {
  return `${objectTypeId}\u0000${packageName}\u0000${slot}`;
}

class SemanticRendererRegistryImpl {
  // Keyed by (objectTypeId, packageName, slot) so competing claimants of the
  // SAME type each retain their own renderers per slot — resolution binds to
  // the org winner.
  private byTypeAndPackage = new Map<string, SemanticRendererDescriptor>();

  /**
   * Register (idempotent replace-by-(type,package,slot)) an extension's
   * semantic renderer for an object type. Called at type/claim registration for
   * any artifact type whose manifest declares a semantic
   * `cinatra.artifact.ui.renderers` slot (`detail`, and since S7 `listRow`).
   * `slot` defaults to `detail` (the pre-S7 call shape). The generated-map key
   * is DERIVED from the package + slot (never trusted from a caller). A
   * MIME-pattern-shaped `objectTypeId` is rejected (keyspace guard) — the
   * semantic keyspace is object-type ids, never representation forms.
   */
  register(input: {
    objectTypeId: string;
    packageName: string;
    slot?: SemanticRendererSlot;
  }): void {
    if (isRepresentationPatternKey(input.objectTypeId)) {
      console.warn(
        `[artifact-renderer] refusing to register a semantic renderer keyed by a MIME-pattern-shaped id "${input.objectTypeId}" (keyspace guard — semantic keys are object-type ids)`,
      );
      return;
    }
    const slot: SemanticRendererSlot = input.slot ?? "detail";
    const desc: SemanticRendererDescriptor = {
      objectTypeId: input.objectTypeId,
      packageName: input.packageName,
      slot,
      generatedKey: generatedArtifactRendererKey(input.packageName, slot),
    };
    this.byTypeAndPackage.set(
      semanticStoreKey(input.objectTypeId, input.packageName, slot),
      desc,
    );
  }

  /** Deregister every semantic renderer a package registered, across all slots
   * (archive/uninstall teardown). Returns the removed object-type ids
   * (deduplicated — a type registered at both `detail` and `listRow` reports
   * once). */
  removeByPackage(packageName: string): string[] {
    const removed = new Set<string>();
    for (const [key, desc] of this.byTypeAndPackage) {
      if (desc.packageName === packageName) {
        this.byTypeAndPackage.delete(key);
        removed.add(desc.objectTypeId);
      }
    }
    return Array.from(removed);
  }

  /**
   * Resolve the semantic renderer for a row at `slot` (default `detail` — the
   * pre-S7 call shape), BOUND to the per-org effective-identity winner. Returns
   * the descriptor ONLY when the effective identity names an installed
   * extension AND that exact winner registered a renderer for the row's base
   * object type at that slot. The lookup is keyed by (objectTypeId, winner,
   * slot) so a LOSING claimant's renderer for the same type is never reachable
   * — it lives under a different key. A non-extension identity or an unrendered
   * type/slot resolves to null (dispatch falls through).
   */
  resolve(
    objectTypeId: string,
    identity: EffectiveIdentity,
    slot: SemanticRendererSlot = "detail",
  ): SemanticRendererDescriptor | null {
    if (identity.kind !== "extension") return null;
    return (
      this.byTypeAndPackage.get(semanticStoreKey(objectTypeId, identity.extension, slot)) ?? null
    );
  }

  /**
   * Every semantic renderer THIS package registered, across all slots.
   *
   * The read that makes an UNREACHABLE display nameable. A display is reachable
   * only through an object type some package registers; a pack whose declared
   * type-id sits in a namespace no installed package owns registers no type at
   * all, yet its renderer registration still lands here keyed by that orphaned
   * id (the cross-namespace claim road). Pairing this list with the object-type
   * registry reading of who registers that id is what lets a caller tell a pure
   * matcher pack — nothing declared, nothing to report — apart from a pack whose
   * display can never be reached, instead of treating both as silence.
   *
   * Ordered by registration; the descriptors are copies, so a caller cannot
   * mutate the registry through them.
   */
  listByPackage(packageName: string): SemanticRendererDescriptor[] {
    const out: SemanticRendererDescriptor[] = [];
    for (const desc of this.byTypeAndPackage.values()) {
      if (desc.packageName === packageName) out.push({ ...desc });
    }
    return out;
  }

  /** @internal test-only reset. */
  _clearForTests(): void {
    this.byTypeAndPackage.clear();
  }

  /** @internal test/diagnostic snapshot — the registered (type, package) pairs. */
  _snapshot(): SemanticRendererDescriptor[] {
    return Array.from(this.byTypeAndPackage.values()).map((d) => ({ ...d }));
  }
}

// ===========================================================================
// 2. Representation-provider registry — (representation pattern, slot) keyspace,
//    org-scoped.
// ===========================================================================

/** An org-bound extension representation provider (a viewer for a representation
 * form). Binds at install/activation with the org's activation generation. The
 * `generatedKey` is DERIVED from `(packageName, slot)` inside the registry —
 * never caller-supplied — so a provider can only ever resolve to ITS OWN
 * module. */
export interface RepresentationProviderDescriptor {
  packageName: string;
  /** KEYSPACE part 1: a representation pattern — an exact MIME (`application/pdf`),
   * a type-wildcard (image slash star), or the universal catch-all. Never an
   * objectTypeId. */
  pattern: string;
  /** KEYSPACE part 2: the renderer slot this provider serves. */
  slot: ArtifactUiSlot;
  /** Derived key into `GENERATED_ARTIFACT_RENDERERS`. */
  generatedKey: string;
  /** The activation generation this binding was written under. A later
   * registration with a HIGHER generation supersedes; a LOWER (stale) one is
   * ignored on resolve. */
  generation: number;
}

/** The register INPUT — no `generatedKey` (the registry derives it from
 * `(packageName, slot)`, so a caller can never point a provider at another
 * package's module). */
export interface RepresentationProviderRegistration {
  packageName: string;
  pattern: string;
  slot: ArtifactUiSlot;
  generation: number;
}

/** An always-effective first-party default provider (the host handler/floor a
 * provider must beat). Org-agnostic; no generation. `ref` is an opaque token the
 * host maps back to its built-in handler. */
export interface FirstPartyRepresentationDefault {
  pattern: string;
  slot: ArtifactUiSlot;
  ref: string;
}

export type RepresentationResolution =
  | {
      tier: "extension";
      packageName: string;
      generatedKey: string;
      pattern: string;
      slot: ArtifactUiSlot;
    }
  | { tier: "first-party"; ref: string; pattern: string; slot: ArtifactUiSlot }
  | null;

/** Representation-pattern → mime match specificity (higher = more specific), or
 * -1 when the pattern does not match the mime. Exact(3) > type-wildcard(2) >
 * universal catch-all(1). */
export function representationMatchSpecificity(pattern: string, mime: string): number {
  if (pattern === mime) return 3;
  if (pattern === "*/*") return 1;
  const star = pattern.indexOf("/*");
  if (star > 0 && star === pattern.length - 2) {
    const prefix = pattern.slice(0, star + 1); // includes the "/"
    if (mime.startsWith(prefix)) return 2;
  }
  return -1;
}

function firstPartyKey(pattern: string, slot: ArtifactUiSlot): string {
  return `${pattern}${GENERATED_KEY_SEP}${slot}`;
}

function orgPackageKey(orgId: string, packageName: string): string {
  return `${orgId} ${packageName}`;
}

class RepresentationProviderRegistryImpl {
  // orgId -> descriptor list.
  private byOrg = new Map<string, RepresentationProviderDescriptor[]>();
  // MONOTONIC generation FLOOR per (orgId, packageName) — the highest activation
  // generation ever seen. An install/activation of a package for an org is ONE
  // generation carrying the package's WHOLE provider set; a generation advance
  // retires the package's entire prior set for that org. The floor is NEVER
  // lowered and NEVER cleared (teardown keeps it as a tombstone): so a delayed
  // registration from a torn-down epoch (generation <= the floor, with no live
  // binding) is rejected rather than resurrecting the provider (ABA-safe). A real
  // reinstall carries a strictly higher activation generation and opens a new
  // epoch; if it ever carried a lower one it fails SAFE (the row renders the
  // never-blank generic floor, never a stale renderer).
  private activeGeneration = new Map<string, number>();
  // Always-effective, org-agnostic first-party defaults.
  private firstParty = new Map<string, FirstPartyRepresentationDefault>();

  /**
   * Register an org-bound extension provider under the package's activation
   * GENERATION for the org. Generation is tracked per (orgId, packageName) as a
   * MONOTONIC FLOOR — a package's whole provider set shares one generation:
   *   - generation <  the floor ⇒ STALE (ignored — a superseded or torn-down epoch);
   *   - generation >  the floor ⇒ UPGRADE / new epoch: retire ALL of the
   *     package's prior bindings for the org (so a removed/changed pattern from an
   *     older declaration cannot survive), advance the floor, then add this binding;
   *   - generation == the floor ⇒ SAME activation batch, but ONLY while the epoch
   *     is live (the package still has ≥1 binding for the org): add/replace this
   *     (pattern, slot). At the floor generation with NO live binding, the epoch
   *     was torn down — the registration is a delayed straggler and is REJECTED
   *     (no resurrection). The very first registration of any package always takes
   *     the `>` branch (floor starts at 0), so a live epoch's follow-on batch
   *     registrations always find a live binding.
   * The generated-map key is DERIVED from `(packageName, slot)` (never trusted).
   */
  registerProvider(orgId: string, reg: RepresentationProviderRegistration): void {
    const genKey = orgPackageKey(orgId, reg.packageName);
    const floor = this.activeGeneration.get(genKey) ?? 0;
    if (reg.generation < floor) return; // stale — a superseded/torn-down epoch

    const desc: RepresentationProviderDescriptor = {
      packageName: reg.packageName,
      pattern: reg.pattern,
      slot: reg.slot,
      generation: reg.generation,
      generatedKey: generatedArtifactRendererKey(reg.packageName, reg.slot),
    };

    let list = this.byOrg.get(orgId) ?? [];
    if (reg.generation > floor) {
      // Upgrade / new epoch: the package's ENTIRE prior generation for this org
      // is retired; the floor advances.
      list = list.filter((d) => d.packageName !== reg.packageName);
      this.activeGeneration.set(genKey, reg.generation);
      list.push(desc);
      this.byOrg.set(orgId, list);
      return;
    }
    // generation === floor: only valid as a follow-on of a LIVE epoch. If the
    // package has no live binding, the epoch was torn down — reject the straggler.
    if (!list.some((d) => d.packageName === reg.packageName)) return;
    const idx = list.findIndex(
      (d) =>
        d.packageName === desc.packageName &&
        d.pattern === desc.pattern &&
        d.slot === desc.slot,
    );
    if (idx >= 0) list[idx] = desc;
    else list.push(desc);
    this.byOrg.set(orgId, list);
  }

  /** Seed an always-effective first-party default (idempotent replace-by-key).
   * These are the host handlers/floor a provider must beat. */
  registerFirstPartyDefault(def: FirstPartyRepresentationDefault): void {
    this.firstParty.set(firstPartyKey(def.pattern, def.slot), { ...def });
  }

  /** Uninstall/teardown: drop every org binding of a package across ALL orgs.
   * The per-(org,package) generation FLOOR is KEPT as a tombstone (never
   * cleared) so a delayed straggler from the torn-down epoch cannot resurrect a
   * provider; a real reinstall carries a strictly higher generation. Returns the
   * number of bindings removed. */
  retireProvidersByPackage(packageName: string): number {
    let removed = 0;
    for (const [orgId, list] of this.byOrg) {
      const kept = list.filter((d) => d.packageName !== packageName);
      removed += list.length - kept.length;
      if (kept.length === 0) this.byOrg.delete(orgId);
      else this.byOrg.set(orgId, kept);
    }
    return removed;
  }

  /** Per-org uninstall: drop a package's bindings for ONE org. The generation
   * floor is KEPT as a tombstone (see `retireProvidersByPackage`). */
  retireOrgProvider(orgId: string, packageName: string): number {
    const list = this.byOrg.get(orgId);
    if (!list) return 0;
    const kept = list.filter((d) => d.packageName !== packageName);
    const removed = list.length - kept.length;
    if (kept.length === 0) this.byOrg.delete(orgId);
    else this.byOrg.set(orgId, kept);
    return removed;
  }

  /**
   * Resolve the representation provider for `(orgId, mime, slot)` over a UNIFIED
   * candidate pool of effective extension providers AND always-effective
   * first-party defaults, ranked by a single total order:
   *   1. SPECIFICITY first — exact(3) > type-wildcard(2) > catch-all(1). This
   *      dominates the tier, so a first-party EXACT default beats an extension
   *      CATCH-ALL provider (the host's specific handler is not overridden by a
   *      generic extension viewer).
   *   2. TIER breaks a specificity tie — an extension provider outranks a
   *      first-party default at EQUAL specificity (a dedicated pdf extension
   *      beats the host pdf handler).
   *   3. then newest activation GENERATION, then lexicographic PACKAGE/pattern —
   *      total + deterministic.
   * Returns null when nothing matches (dispatch falls through to the generic
   * floor). Until an extension provider is effective for the org, this yields
   * the always-effective first-party default (the host handler/floor).
   */
  resolve(orgId: string, mime: string, slot: ArtifactUiSlot): RepresentationResolution {
    type Candidate = {
      spec: number;
      tierRank: number; // 1 = extension, 0 = first-party
      generation: number;
      tiebreak: string;
      value: RepresentationResolution;
    };
    const candidates: Candidate[] = [];
    for (const d of this.byOrg.get(orgId) ?? []) {
      if (d.slot !== slot) continue;
      const spec = representationMatchSpecificity(d.pattern, mime);
      if (spec < 0) continue;
      candidates.push({
        spec,
        tierRank: 1,
        generation: d.generation,
        tiebreak: d.packageName,
        value: {
          tier: "extension",
          packageName: d.packageName,
          generatedKey: d.generatedKey,
          pattern: d.pattern,
          slot,
        },
      });
    }
    for (const def of this.firstParty.values()) {
      if (def.slot !== slot) continue;
      const spec = representationMatchSpecificity(def.pattern, mime);
      if (spec < 0) continue;
      candidates.push({
        spec,
        tierRank: 0,
        generation: -1,
        tiebreak: def.pattern,
        value: { tier: "first-party", ref: def.ref, pattern: def.pattern, slot },
      });
    }
    if (candidates.length === 0) return null;
    candidates.sort(
      (a, b) =>
        b.spec - a.spec ||
        b.tierRank - a.tierRank ||
        b.generation - a.generation ||
        (a.tiebreak < b.tiebreak ? -1 : a.tiebreak > b.tiebreak ? 1 : 0),
    );
    return candidates[0]!.value;
  }

  /** @internal test/diagnostic snapshot — the org's provider bindings. */
  _snapshotOrgProviders(orgId: string): RepresentationProviderDescriptor[] {
    return (this.byOrg.get(orgId) ?? []).map((d) => ({ ...d }));
  }

  /** @internal test-only reset (clears org bindings + generations; keeps seeded
   * first-party defaults unless `includeFirstParty`). */
  _clearForTests(includeFirstParty = false): void {
    this.byOrg.clear();
    this.activeGeneration.clear();
    if (includeFirstParty) this.firstParty.clear();
  }

  /** @internal diagnostic — count of first-party defaults seeded. */
  _firstPartyCount(): number {
    return this.firstParty.size;
  }
}

// ===========================================================================
// Keyspace-disjointness assertion (the "never share a keyspace" invariant).
// ===========================================================================

/**
 * The two registries are keyed in structurally disjoint spaces:
 *   - semantic renderers by a namespaced OBJECT TYPE id (`@scope/pkg:local`);
 *   - representation providers by a `(representation pattern, slot)` pair whose
 *     pattern is a MIME form (an exact `type/subtype`, a type-wildcard, or the
 *     universal catch-all).
 * A representation pattern is NEVER a valid object-type id (an object-type id
 * carries the `@scope/pkg:` prefix; a MIME pattern does not), so the two key
 * families cannot collide. This predicate makes the invariant testable.
 */
export function isRepresentationPatternKey(key: string): boolean {
  return key === "*/*" || /^[a-z0-9][a-z0-9!#$&^_.+-]*\/(\*|[a-z0-9!#$&^_.+-]+)$/i.test(key);
}

export function isSemanticTypeKey(key: string): boolean {
  // Namespaced object-type id: `@scope/pkg:local` or `scope/pkg:local`.
  return key.includes(":") && !isRepresentationPatternKey(key);
}

// ===========================================================================
// Cross-compilation singletons (Symbol.for anchors — see registry.ts).
// ===========================================================================

const SEMANTIC_REGISTRY_KEY = Symbol.for(
  "@cinatra-ai/objects:semantic-renderer-registry/v1",
);
const REPRESENTATION_REGISTRY_KEY = Symbol.for(
  "@cinatra-ai/objects:representation-provider-registry/v1",
);
type RegistryHolder = {
  [SEMANTIC_REGISTRY_KEY]?: SemanticRendererRegistryImpl;
  [REPRESENTATION_REGISTRY_KEY]?: RepresentationProviderRegistryImpl;
};
const holder = globalThis as unknown as RegistryHolder;

export const semanticRendererRegistry: SemanticRendererRegistryImpl =
  holder[SEMANTIC_REGISTRY_KEY] ??
  (holder[SEMANTIC_REGISTRY_KEY] = new SemanticRendererRegistryImpl());

export const representationProviderRegistry: RepresentationProviderRegistryImpl =
  holder[REPRESENTATION_REGISTRY_KEY] ??
  (holder[REPRESENTATION_REGISTRY_KEY] = new RepresentationProviderRegistryImpl());

export type {
  SemanticRendererRegistryImpl,
  RepresentationProviderRegistryImpl,
};

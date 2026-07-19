import type { ObjectCategory, ObjectTypeDefinition } from "./types";
import { OBJECT_TYPE_NAMESPACE_RE, isTombstonedObjectTypeId } from "./namespace";

// ---------------------------------------------------------------------------
// Object type registry
// ---------------------------------------------------------------------------

/**
 * Structured install-time conflict raised when a SECOND definer tries to define
 * an object type another definer already registered (the ratified one-defining-
 * extension-per-type model, epic #1785). A duplicate definition is a real
 * misconfiguration — two extensions (or an extension and a host built-in)
 * defining the same type id — and MUST surface, never silently clobber the
 * first definition (empirically: a hybrid artifact pack's cross-namespace
 * `objectTypes` claim silently replaced the host `@cinatra-ai/email:body`
 * content/identityKey definition with a generic report/no-identityKey one, and
 * dropped the `@cinatra-ai/email:sent-email` idempotencyKey identity). A
 * re-registration by the SAME definer (reboot / re-install / dev-watcher rescan)
 * is NOT a conflict — it stays an idempotent replace.
 *
 * `existingDefiner` / `attemptedDefiner` are the owning package names, or `null`
 * for a host / built-in (provenance-less) registration.
 */
export class ObjectTypeDefinitionConflictError extends Error {
  readonly code = "OBJECT_TYPE_DEFINITION_CONFLICT" as const;
  constructor(
    readonly typeId: string,
    readonly existingDefiner: string | null,
    readonly attemptedDefiner: string | null,
  ) {
    super(
      `Object type '${typeId}' is already defined by ${existingDefiner ?? "the host (built-in)"}; ` +
        `${attemptedDefiner ?? "the host (built-in)"} cannot redefine it. ` +
        `One defining extension per type (epic #1785) — a duplicate definition is an install-time conflict, not a silent replace.`,
    );
    this.name = "ObjectTypeDefinitionConflictError";
  }
}

/**
 * Runtime registry of object type definitions. Mirrors the contract of
 * `fieldRendererRegistry`:
 *
 * - One defining registrar per type (epic #1785): a re-registration by the SAME
 *   definer (same `packageName`, or both host/built-in) is an idempotent replace;
 *   a registration by a DIFFERENT definer of an already-registered type is a
 *   structured install-time CONFLICT (`ObjectTypeDefinitionConflictError`), never
 *   a silent clobber.
 * - Dev-mode `console.warn` when a non-namespaced ID is registered.
 * - Permanent-tombstone backstop (cinatra#1789): a retired dynamic-namespace
 *   id (`@dynamic/types:` / `@cinatra-ai/dynamic:`) is NEVER registered (skip +
 *   warn) — the universal guard under EVERY registration path, including the
 *   SDK `ctx.objects.registerType` provider (src/lib/register-objects-provider).
 * - Zero React / DB / server-only imports (safe to include in the SSR
 *   module graph — see CLAUDE.md Turbopack constraint).
 *
 * SCOPE DIRECTION (cinatra#1425, epic #1424): type-OWNERSHIP authority is
 * moving to the DB claim registry (`artifact_type_claims`), arbitrated by
 * the pure claims leaf and resolved per org + actor by the host
 * effective-type-catalog resolver (src/lib/objects/effective-type-catalog
 * .ts). #1425 ships that authority surface; existing consumers (e.g.
 * `listArtifacts()` readers) still read THIS registry and are cut over by
 * the epic's later sub-issues — until then this registry remains
 * operationally load-bearing, destined to become a render/schema cache
 * (process-global, replace-by-id, unscoped — what a cache may be and an
 * ownership authority must not).
 */
class ObjectTypeRegistryImpl {
  private entries: Map<string, ObjectTypeDefinition<unknown>> = new Map();
  // Parallel provenance index: type id -> the package that registered it. Only
  // populated when a caller passes `packageName`; built-in/host registrations
  // (no package) are absent here, so removeByPackage never touches them.
  private packageByType: Map<string, string> = new Map();

  /**
   * Register (or idempotently replace) an object type. `packageName` records
   * which extension package owns the type so the runtime teardown hook can
   * deregister exactly that package's types on archive/uninstall via
   * `removeByPackage`. It is OPTIONAL — built-in / host registrations omit it
   * and are therefore never removed by `removeByPackage`.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  register<T = any>(def: ObjectTypeDefinition<T>, packageName?: string): void {
    // PERMANENT namespace tombstone (cinatra#1789, epic #1785): a retired
    // dynamic namespace (`@dynamic/types:` / `@cinatra-ai/dynamic:`) can NEVER
    // (re)enter the registry — the universal backstop under every registration
    // path (the artifact bridge, the SDK `ctx.objects.registerType` provider in
    // src/lib/register-objects-provider.ts, any direct caller). SKIP (never
    // throw — a stray registration must not crash boot) + warn; a HARDER stance
    // than the non-namespaced dev-warn below, which still registers.
    if (isTombstonedObjectTypeId(def.type)) {
      console.warn(
        `Object type ID '${def.type}' is under a permanently-retired dynamic namespace (cinatra#1789) — NOT registered.`,
      );
      return;
    }
    if (
      process.env.NODE_ENV !== "production" &&
      !OBJECT_TYPE_NAMESPACE_RE.test(def.type)
    ) {
      console.warn(
        `Object type ID '${def.type}' is not namespaced. Use '@scope/package:local-id' format.`,
      );
    }
    // CONFLICT-ON-DUPLICATE (epic #1785): if this type is already defined, only
    // the ORIGINAL definer may re-register it. `packageByType.get` returns the
    // owning package or `undefined` (a host / built-in registration). A caller
    // with a different definer — a package clobbering a host built-in, a package
    // clobbering another package, or a host taking over a package's type — raises
    // a structured install-time conflict instead of silently replacing the prior
    // definition. Same-definer re-registration (reboot / re-install / dev-watcher
    // rescan, the bridge's reconcile-then-re-register) stays an idempotent
    // replace. Normalize both sides to `null` so host↔host compares equal.
    if (this.entries.has(def.type)) {
      const existingDefiner = this.packageByType.get(def.type) ?? null;
      const attemptedDefiner = packageName ?? null;
      if (existingDefiner !== attemptedDefiner) {
        throw new ObjectTypeDefinitionConflictError(
          def.type,
          existingDefiner,
          attemptedDefiner,
        );
      }
    }
    // Idempotent replace-by-id (same definer). Cast to unknown for internal
    // storage — callers retrieve via resolve() which returns
    // ObjectTypeDefinition<unknown>.
    this.entries.set(def.type, def as ObjectTypeDefinition<unknown>);
    if (packageName) {
      this.packageByType.set(def.type, packageName);
    } else {
      // A host re-register of a host-owned type keeps it provenance-less (the
      // conflict guard above already rejected a host takeover of a PACKAGE type).
      this.packageByType.delete(def.type);
    }
  }

  /** The type ids a package registered (empty when the package registered none
   *  or registered without provenance). */
  getTypesForPackage(packageName: string): readonly string[] {
    const out: string[] = [];
    for (const [type, pkg] of this.packageByType) {
      if (pkg === packageName) out.push(type);
    }
    return out;
  }

  /**
   * Deregister every object type a package registered (archive/uninstall
   * teardown). Returns the removed type ids. Without this, an archived /
   * uninstalled extension's object types stayed resolvable + listable in the
   * running process until restart. Safe no-op for a package that registered
   * nothing (or registered without provenance).
   */
  removeByPackage(packageName: string): string[] {
    const removed: string[] = [];
    for (const [type, pkg] of this.packageByType) {
      if (pkg === packageName) {
        this.entries.delete(type);
        this.packageByType.delete(type);
        removed.push(type);
      }
    }
    return removed;
  }

  resolve(typeId: string): ObjectTypeDefinition<unknown> | null {
    return this.entries.get(typeId) ?? null;
  }

  /**
   * The package that DEFINES `typeId` — the provenance the Artifacts console's
   * Type definitions tab reads for its "Defined by" column (cinatra#1786, epic
   * #1785: exactly one defining extension per type). Returns the owning package
   * name, or `null` for a host / built-in (provenance-less) registration and
   * for a type id that is not registered at all. This is the READ side of the
   * same `packageByType` provenance `getTypesForPackage` / `removeByPackage`
   * write against — a pure, allocation-free lookup with no mutation surface.
   */
  definerOf(typeId: string): string | null {
    return this.packageByType.get(typeId) ?? null;
  }

  listByCategory(category: ObjectCategory): readonly ObjectTypeDefinition<unknown>[] {
    const out: ObjectTypeDefinition<unknown>[] = [];
    for (const def of this.entries.values()) {
      if (def.category === category) out.push(def);
    }
    return out;
  }

  list(): readonly ObjectTypeDefinition<unknown>[] {
    return Array.from(this.entries.values());
  }

  /**
   * Every registered object type that carries an `isArtifact` descriptor.
   * The Artifacts library / serving / MCP layers call this and read the
   * descriptor GENERICALLY: a new artifact type shipped as a `kind:"artifact"`
   * extension appears here with zero per-type branches in any consuming layer.
   * This is the pluggability guarantee, covered by the fixture-extension test.
   */
  listArtifacts(): readonly ObjectTypeDefinition<unknown>[] {
    const out: ObjectTypeDefinition<unknown>[] = [];
    for (const def of this.entries.values()) {
      if (def.isArtifact) out.push(def);
    }
    return out;
  }

  /** @internal Only call this from test `beforeEach` blocks — not in production code. */
  _clearForTests(): void {
    this.entries.clear();
    this.packageByType.clear();
  }
}

// CROSS-COMPILATION SINGLETON: Next.js 16 builds separate bundler compilations
// (instrumentation / route / RSC), each with its own module cache. An extension
// registers its object types at boot/activation (instrumentation compilation);
// the object-resolution + listing layers read them at request time (route / RSC
// compilation) — so the registry MUST be a true per-process singleton, anchored
// on a namespaced+versioned `Symbol.for(...)` key (same pattern as the
// extension MCP / email / social connector registries). Without this anchor a
// hot-installed extension's type would register into one compilation's module
// instance and be invisible to the others.
const OBJECT_TYPE_REGISTRY_KEY = Symbol.for("@cinatra-ai/objects:object-type-registry/v1");
type ObjectTypeRegistryHolder = { [k: symbol]: ObjectTypeRegistryImpl | undefined };
const _objectTypeRegistryHolder = globalThis as unknown as ObjectTypeRegistryHolder;
export const objectTypeRegistry: ObjectTypeRegistryImpl =
  _objectTypeRegistryHolder[OBJECT_TYPE_REGISTRY_KEY] ??
  (_objectTypeRegistryHolder[OBJECT_TYPE_REGISTRY_KEY] = new ObjectTypeRegistryImpl());

import type { ObjectCategory, ObjectTypeDefinition } from "./types";
import { OBJECT_TYPE_NAMESPACE_RE, isTombstonedObjectTypeId } from "./namespace";

// ---------------------------------------------------------------------------
// Object type registry
// ---------------------------------------------------------------------------

/**
 * Runtime registry of object type definitions. Mirrors the contract of
 * `fieldRendererRegistry`:
 *
 * - Idempotent replace-by-id (calling `register` twice with the same `type`
 *   replaces the first entry).
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
    // Idempotent replace-by-id. Cast to unknown for internal storage — callers
    // retrieve via resolve() which returns ObjectTypeDefinition<unknown>.
    this.entries.set(def.type, def as ObjectTypeDefinition<unknown>);
    if (packageName) {
      this.packageByType.set(def.type, packageName);
    } else {
      // A re-registration WITHOUT a package clears any stale provenance for this
      // type (e.g. a host re-register replacing a former package registration).
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

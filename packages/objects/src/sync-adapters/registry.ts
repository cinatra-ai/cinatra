import type { ObjectSyncAdapter } from "./adapter";

// ---------------------------------------------------------------------------
// ObjectSyncAdapterRegistry — in-memory registry for object sync adapters
// ---------------------------------------------------------------------------

/**
 * In-memory registry for `ObjectSyncAdapter` instances. Mirrors the
 * idempotent replace-by-id semantics of `objectTypeRegistry`.
 *
 * No `server-only` — the registry is populated at server startup but the
 * exported singleton is TypeScript-safe in the client bundle too (it only
 * holds interface references, no live connections).
 *
 * Register concrete adapters from a connector package's
 * `integration/module.ts` during startup.
 *
 * The object sync adapter registry is named to disambiguate it from
 * transport "connector" packages.
 */
class ObjectSyncAdapterRegistryImpl {
  private entries: Map<string, ObjectSyncAdapter> = new Map();

  register(adapter: ObjectSyncAdapter): void {
    if (this.entries.has(adapter.id) && this.entries.get(adapter.id) !== adapter) {
      // Dev-mode warning for adapter ID collisions. Replace-by-id semantics
      // match objectTypeRegistry.
      console.warn(
        `[objectSyncAdapterRegistry] Replacing existing adapter with id "${adapter.id}"`,
      );
    }
    this.entries.set(adapter.id, adapter);
  }

  getAdaptersForType(type: string): ObjectSyncAdapter[] {
    return Array.from(this.entries.values()).filter((a) =>
      a.supportedTypes.includes(type),
    );
  }

  getAdapter(id: string): ObjectSyncAdapter | null {
    return this.entries.get(id) ?? null;
  }

  listAll(): readonly ObjectSyncAdapter[] {
    return Array.from(this.entries.values());
  }

  /** @internal Only for tests. */
  _clearForTests(): void {
    this.entries.clear();
  }
}

export const objectSyncAdapterRegistry = new ObjectSyncAdapterRegistryImpl();

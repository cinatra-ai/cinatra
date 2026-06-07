// Host-injected OBJECTS provider for connectors that own object types backed by
// the objects subsystem (today: crm-connector).
//
// A connector that registers object types, registers an outbound sync adapter,
// projects a Graphiti episode for a pointer row, or writes an actor-scoped object
// pointer needs the concrete registries + graphiti client + objects_save handler
// that live in the host package `@cinatra-ai/objects`. Importing them by name
// re-anchors the connector to a non-SDK first-party package (the `sdkOnly` gate
// edge) and breaks standalone extraction.
//
// Instead the host injects ONE provider at boot via `setObjectsProvider`, and the
// connector calls `requireObjectsProvider()`. The SDK stays a leaf contract — it
// owns the shape (object-type contract types live in `./objects-contract`), the
// host owns the binding (to the real registries + graphiti + objects_save). This
// is a DI slot (same class as crm-request-actor / a2a-connection / google-oauth-
// connection), NOT a new `ctx` host-port, so it does not bump the SDK ABI version.
//
// Works on BOTH call paths uniformly: the inline MCP-handler request path AND the
// ctx-less BullMQ graphiti-projector / pointer-repair worker — the in-process
// worker shares the boot that runs the host binder, so the slot is populated when
// the worker dynamically imports the connector's register/sync code.

import type { ObjectSyncAdapter, ObjectTypeDefinition } from "./objects-contract";

/**
 * The actor-scoped result of an `objects_save` pointer write. Mirrors the host
 * `objects_save` primitive's return shape (the connector reads only these fields).
 */
export type ObjectsSaveResult = {
  objectId: string;
  type: string;
  isNew: boolean;
  wasMerged: boolean;
  confidence: number;
  changeSetId: string;
};

/**
 * The host-supplied objects surface. Bound once at boot to the real
 * `objectTypeRegistry` / `objectSyncAdapterRegistry` / graphiti client /
 * `objects_save` handler. All async methods MUST be resolved within the caller's
 * trusted request/run ALS frame (the host binder preserves it).
 */
export interface ObjectsProvider {
  /**
   * Register an object-type definition (idempotent, replace-by-id). Mirrors
   * `objectTypeRegistry.register`.
   */
  registerObjectType(definition: ObjectTypeDefinition): void;

  /**
   * Register an outbound object-sync adapter (idempotent, replace-by-id).
   * Mirrors `objectSyncAdapterRegistry.register`.
   */
  registerSyncAdapter(adapter: ObjectSyncAdapter): void;

  /**
   * Project a single pointer row into Graphiti as an append-only episode. The
   * host derives the deterministic org group-id + episode UUID and creates the
   * episode WITHOUT a `uuid` param (Graphiti 0.28.2 misinterprets `uuid` as
   * "re-process existing node"). Returns the derived episode UUID for the
   * caller's Postgres bookkeeping (the adapter returns it as its `externalId`).
   */
  addGraphitiEpisodeForObject(input: {
    objectId: string;
    orgId: string | null;
    name: string;
    /** JSON-encoded episode body. */
    episodeBody: string;
    sourceDescription: string;
    /** ISO timestamp; defaults host-side when omitted. */
    referenceTime?: string;
  }): Promise<{ episodeUuid: string }>;

  /**
   * Write an actor-scoped object pointer via the real `objects_save` primitive
   * (classify → identity-resolve → authz → upsert + enqueue Graphiti projection).
   * The host binder runs it inside the caller's ALS frame so `objects_save`'s
   * actor/run/projectContext fallback resolves correctly.
   */
  saveObject(request: {
    typeHint: string;
    rawData: Record<string, unknown>;
    /** Opaque PrimitiveActorContext (the connector mints it; the host casts). */
    actor: unknown;
    mode: "agentic";
  }): Promise<ObjectsSaveResult>;
}

// Anchor the provider on `globalThis` via a namespaced+versioned Symbol so the
// host `setObjectsProvider` boot call and an extension's `requireObjectsProvider`
// call resolve the SAME slot even when Next.js compiles `@cinatra-ai/sdk-extensions`
// into more than one module instance (server / RSC / route segments / the BullMQ
// worker bundle). Same cross-compilation reason as the action-guard + the other
// DI contracts.
const OBJECTS_PROVIDER_KEY = Symbol.for("@cinatra-ai/sdk-extensions:objects-provider/v1");
type ProviderHolder = { [k: symbol]: ObjectsProvider | null | undefined };
const _holder = globalThis as unknown as ProviderHolder;

/**
 * Wire the host objects provider. Called exactly once at boot (host
 * instrumentation: src/lib/register-objects-provider.ts). Re-calling replaces the
 * previous impl — tests can swap a stub between blocks.
 */
export function setObjectsProvider(impl: ObjectsProvider): void {
  _holder[OBJECTS_PROVIDER_KEY] = impl;
}

/** @internal test-only — clear the provider so a fresh wiring is required. */
export function _resetObjectsProviderForTests(): void {
  _holder[OBJECTS_PROVIDER_KEY] = null;
}

/**
 * Resolve the host-bound objects provider. Fails CLOSED (throws) if the host
 * never wired it — an unbound provider is a boot-wiring bug, never a silent no-op
 * that could strand a pointer row unprojected or mis-scoped.
 */
export function requireObjectsProvider(): ObjectsProvider {
  const provider = _holder[OBJECTS_PROVIDER_KEY];
  if (!provider) {
    throw new Error(
      "[sdk-extensions] requireObjectsProvider() was called before the host wired the objects " +
        "provider. The host must call setObjectsProvider(...) at boot " +
        "(src/lib/register-objects-provider.ts, imported from instrumentation.node.ts).",
    );
  }
  return provider;
}

/**
 * Resolve the host-bound objects provider, or NULL if not yet wired. Unlike
 * `requireObjectsProvider()` (fail-closed, for RUNTIME call paths), this is for the
 * BOOT-TIME registration calls (`registerObjectType` / `registerSyncAdapter`) that
 * also run during `next build` page-data collection — when the host binder
 * (instrumentation) has NOT executed, so the provider is unbound. The build-process
 * registry is discarded, so a no-op there is correct; at RUNTIME, Next.js runs
 * `instrumentation.register()` (which wires the provider) before any route handler /
 * worker, so this resolves the real provider when the connector actually registers.
 */
export function getObjectsProviderOrNull(): ObjectsProvider | null {
  return _holder[OBJECTS_PROVIDER_KEY] ?? null;
}

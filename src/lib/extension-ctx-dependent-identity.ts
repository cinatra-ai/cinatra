import "server-only";

// EXTENSION-CTX DEPENDENT IDENTITY (cinatra#1392 S8).
//
// An extension calling `ctx.mcp.callPrimitive(name, input)` is itself the
// CONSUMER of the target primitive: when the target is another extension's
// tool, the dependency edges that decide which VERSION serves are the CALLING
// EXTENSION INSTALL's — not the outer agent run's. Before S8 the self-invoke
// path carried no install identity, so an extension-ctx caller was always
// served the global/default handler regardless of its resolved edges.
//
// This module is the narrow, host-owned carrier: `ctx.mcp.callPrimitive`
// (built per-record by the host ctx factory, which KNOWS the record's
// (packageName, version, isDefault) identity) runs the invocation inside this
// ALS frame; `resolveEdgeBoundExtensionVersion` consults it as the
// HIGHEST-PRECEDENCE identity source (the immediate caller outranks the run
// lineage — the outer run's edges are the wrong consumer for an inner
// extension-initiated dispatch). The descriptor is host-injected activation
// identity, never extension input. Kept as its own leaf module (no imports
// beyond node) so the host ctx factory and the edge-bound resolver can both
// consume it without growing the locked dev-perf route graphs by more than
// this one node.
//
// CROSS-COMPILATION SINGLETON (critical): Next.js builds separate bundler
// compilations (instrumentation / route / RSC), each with its own module cache
// — the ctx closure that ENTERS the frame (built by the loader, often the
// instrumentation compilation) and the resolver that READS it (route/RSC
// compilation) can hold DIFFERENT instances of this module. AsyncLocalStorage
// context propagation is per-INSTANCE, so a module-scoped `new
// AsyncLocalStorage()` would split-brain (the reader's instance never sees the
// writer's frame). The storage is therefore anchored on a namespaced+versioned
// `Symbol.for(...)` globalThis key, the same pattern as the sibling extension
// registries.

import { AsyncLocalStorage } from "node:async_hooks";

/** The activation identity of the ctx-owning record (host-injected, trusted). */
export type ExtensionCtxIdentity = {
  packageName: string;
  /**
   * The EXACT canonical install-row id (threaded from the trusted anchor by
   * the runtime loader; cinatra#1392 S8 codex round-0 #1). When present the
   * edge-bound resolver binds THIS row directly — no shape-based derivation
   * that could match a same-shape sibling (org/owner axes, default
   * re-election). Absent for dev static-bundle / lifecycle-special ctxs.
   */
  installId?: string | null;
  /** The record's version; `null` for a legacy/unversioned default record. */
  version: string | null;
  /** Whether the record is the DEFAULT version of its package. */
  isDefault: boolean;
};

const EXTENSION_CTX_IDENTITY_ALS_KEY = Symbol.for(
  "@cinatra-ai/host:extension-ctx-dependent-identity-als/v1",
);
type Holder = { [k: symbol]: AsyncLocalStorage<ExtensionCtxIdentity> | undefined };
const _holder = globalThis as unknown as Holder;
const storage: AsyncLocalStorage<ExtensionCtxIdentity> =
  _holder[EXTENSION_CTX_IDENTITY_ALS_KEY] ??
  (_holder[EXTENSION_CTX_IDENTITY_ALS_KEY] = new AsyncLocalStorage<ExtensionCtxIdentity>());

/** Run `fn` with `identity` as the current extension-ctx dependent identity. */
export function runWithExtensionCtxIdentity<T>(identity: ExtensionCtxIdentity, fn: () => T): T {
  return storage.run(identity, fn);
}

/** The current extension-ctx dependent identity, if inside a `ctx.mcp.callPrimitive` frame. */
export function getExtensionCtxIdentity(): ExtensionCtxIdentity | undefined {
  return storage.getStore();
}

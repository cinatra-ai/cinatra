import "server-only";

// SAGA-OWNED-FAN-OUT CONTEXT (#157).
//
// The dependency-BATCH install saga (src/lib/extension-install-batch.ts) PLANS
// the entire dependency closure itself (manifest-edge walk, topo order,
// pre-state capture, ledger, inverse-order compensation) and then installs
// each member ROOT-ONLY through the real dispatcher (extensionRegistry.install)
// — dependencies first, the root last.
//
// The agent extension handler, however, historically fanned the dependency
// tree out a SECOND time: its install/update ran
// installAgentPackageWithDependencies, the @cinatra-ai/registries dep-resolver
// (conflict policy "prefer-newer"). Inside a saga install that means TWO
// independent resolvers walk the same graph with DIFFERENT conflict policies
// (saga = exact pins; registries = prefer-newer) — the two-resolver-
// disagreement risk #157 closes.
//
// Mechanism (the same AsyncLocalStorage shape the install locks + grant context
// use): the saga enters this context around its member-install sequence. The
// agent handler reads it: when active, the SAGA owns the fan-out, so the
// handler installs ONLY the requested root package (installAgentFromPackage),
// never the nested registries resolver. Outside the saga (UI extension update,
// MCP extensions_update, reinstall-latest, and any other direct
// extensionRegistry.install/update caller) the context is absent and the
// handler keeps its full-tree behavior unchanged — those direct paths do NOT
// go through the saga and still rely on the handler to install newly-required
// dependencies.
//
// This context is ALWAYS-ON inside the saga (independent of the gatekept
// master switch — unlike the grant context, which only exists on the gatekept
// path), so the collapse applies to BOTH the gatekept and the legacy/dev saga
// install paths.

import { AsyncLocalStorage } from "node:async_hooks";

type SagaFanoutContext = {
  /** The root package the saga authorized + is fanning out. Informational. */
  rootPackageName: string;
};

const storage = new AsyncLocalStorage<SagaFanoutContext>();

/**
 * Run `fn` with the saga-owned-fan-out context active. The agent handler's
 * install/update, dispatched per-member by the saga inside this scope, install
 * ONLY the root package they were handed — the saga drives the dependency
 * fan-out.
 *
 * Re-entrant: nesting (e.g. the dispatcher re-entering for the same async
 * context) re-runs `fn` with the same flag; nothing is corrupted.
 */
export function withSagaOwnedFanout<T>(
  ctx: SagaFanoutContext,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(ctx, fn);
}

/**
 * True iff the current async context is inside a saga that owns the dependency
 * fan-out. The agent handler installs root-only when this is true.
 */
export function isSagaOwnedFanoutActive(): boolean {
  return storage.getStore() !== undefined;
}

// Vitest stub for `@cinatra-ai/mcp-server`.
//
// The real barrel imports React UI components from the host app
// (`@/components/ui/*`) which are not resolvable from this package's
// vitest config. Stubbing it here lets tests in @cinatra-ai/agents that
// transitively touch `src/lib/auth.ts` (via @/lib/authz → auth-session
// → auth) load without dragging the host UI tree into the module graph.
//
// Only runtime values used by `src/lib/auth.ts` need to be present;
// types are erased at runtime. ALS storage is a real AsyncLocalStorage
// so any code that reads/writes it during a test still works.
//
// THIS FILE NOW BACKS TWO SPECIFIERS (cinatra#2817 N2): the bare barrel
// `@cinatra-ai/mcp-server` AND the `@cinatra-ai/mcp-server/request-context`
// subpath, both aliased here by this package's vitest config. They MUST keep
// resolving to this one file. `mcpRequestContextStorage` is a live
// AsyncLocalStorage, so two resolutions would be two storages: a frame opened
// through one is invisible through the other, and a writer would silently see
// no context instead of failing. Anything the subpath's real module
// (`packages/mcp-server/src/request-context.ts`) exports and a test needs must
// be added HERE, never by re-pointing the subpath at real source.
import { AsyncLocalStorage } from "node:async_hooks";

export const mcpRequestContextStorage = new AsyncLocalStorage<unknown>();

export function createMcpServerAuthPlugins(_options: unknown = {}) {
  return [] as never[];
}

export function createMcpServerMount(_options: unknown) {
  return {
    TransportHandlers: {},
  } as never;
}

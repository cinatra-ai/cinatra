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

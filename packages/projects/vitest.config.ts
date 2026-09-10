import { defineConfig } from "vitest/config";
import * as path from "node:path";

const root = path.resolve(__dirname, "../..");

// Vitest config for @cinatra-ai/projects.
//
// Mirrors packages/objects/vitest.config.ts: alias host-app `@/lib/*`
// paths used by handlers.ts to stub modules + real source paths so the
// node test runner can resolve them without spinning up server-only
// Drizzle/pg modules at import time. Tests that need behaviour control
// override these with `vi.mock("@/lib/...")` factories.
export default defineConfig({
  resolve: {
    alias: {
      // Workspace package aliases for tests.
      "@cinatra-ai/projects": path.join(__dirname, "src/index.ts"),
      // Authz sub-files used by the projects handlers — resolve to the
      // real sources so type/shape compatibility is preserved. The barrel
      // (`@/lib/authz`) goes to a tiny stub so we don't pull `audit.ts`
      // (which creates a pg Pool at module-load).
      // Pure pg text[] literal serializer used by handlers.ts (no imports) —
      // resolve to the real source.
      "@/lib/pg-array": path.join(root, "src/lib/pg-array.ts"),
      "@/lib/authz/enforce-resource-access": path.join(root, "src/lib/authz/enforce-resource-access.ts"),
      "@/lib/authz/errors": path.join(root, "src/lib/authz/errors.ts"),
      "@/lib/authz/build-actor-context": path.join(root, "src/lib/authz/build-actor-context.ts"),
      "@/lib/authz/permissions": path.join(root, "src/lib/authz/permissions.ts"),
      "@/lib/authz/resource-ref": path.join(root, "src/lib/authz/resource-ref.ts"),
      "@/lib/authz/actor-context": path.join(root, "src/lib/authz/actor-context.ts"),
      "@/lib/authz": path.join(__dirname, "src/__tests__/__stubs__/authz.ts"),
      // Host-app paths used by handlers.ts — projects-store / DAO /
      // co-owners. Tests mock these with `vi.mock(...)` so the real
      // pg.Pool init in projects-store never fires.
      "@/lib/projects-store": path.join(__dirname, "src/__tests__/__stubs__/projects-store.ts"),
      "@/lib/projects-store-dao": path.join(__dirname, "src/__tests__/__stubs__/projects-store-dao.ts"),
      "@/lib/project-co-owners-store": path.join(__dirname, "src/__tests__/__stubs__/project-co-owners-store.ts"),
      // Write-block helper consumed by the bindings handlers. The real
      // module imports postgres-sync + database modules with pg.Pool init at
      // module-load; route it to a stub that resolves to a no-op. The binding
      // tests don't exercise the archive gate's I/O; they assert the SQL
      // emission shape.
      "@/lib/project-writable": path.join(__dirname, "src/__tests__/__stubs__/project-writable.ts"),
      // PURE OBO scope-ceiling subpath (W2/#1051) — resolve to the REAL source
      // (no server-only / no heavy deps) so the ceiling logic is exercised, not
      // stubbed. MUST precede the general `@cinatra-ai/mcp-server` stub alias
      // below: Vite matches aliases in order and the stub is a single file, so
      // a subpath falling through to it resolves to an invalid `mcp-server.ts/
      // obo-ceiling` path. Reached transitively via the aliased
      // `@/lib/authz/enforce-resource-access` and directly by handlers.ts.
      "@cinatra-ai/mcp-server/obo-ceiling": path.join(root, "packages/mcp-server/src/obo-ceiling.ts"),
      // cinatra#2771: the host's extension MCP registry + version-keyed
      // retention normalize the typed delegated-chat declaration through this
      // subpath, and both are reachable from `@/lib` chains these tests pull
      // in. It is a PURE module (dependency-free on purpose — the same species
      // as instance-tool-policy / known-destructive-floor above), so alias to
      // REAL source, BEFORE the barrel stub, or the stub swallows it.
      "@cinatra-ai/mcp-server/delegated-chat-tool-policy": path.join(
        root,
        "packages/mcp-server/src/delegated-chat-tool-policy.ts",
      ),
      // cinatra#2817 N1/N2 — THE NEW `@cinatra-ai/mcp-server` SUBPATHS.
      // Every subpath the exports map gains must appear here AND in the root
      // tsconfig `paths` map, or the three maps disagree and only production
      // resolves.
      // The barrel below is aliased to a single-file stub, and vite matches
      // aliases by PREFIX in order, so ANY subpath that is not listed above it
      // falls through and resolves to an invalid `mcp-server.ts/<sub>` path (the
      // same trap the `obo-ceiling` entry documents). Two species, and the
      // distinction is load-bearing:
      //
      //   PURE LEAF  -> alias to REAL source, like obo-ceiling and
      //                 delegated-chat-tool-policy. No server-only, no host dep,
      //                 no cross-module shared instance; exercising the real logic
      //                 is the point. (`core-delegated-chat-surface` does memoize
      //                 ONE deterministic snapshot of this build's own core
      //                 records — a pure derivation of a frozen literal, not state
      //                 a caller can observe or a second resolution can split.)
      //   SINGLETON  -> alias to THE SAME STUB FILE the barrel resolves to.
      //                 `request-context` exports a live `AsyncLocalStorage`, so
      //                 pointing the subpath at real source while the barrel
      //                 stays stubbed would make them TWO storages: a frame
      //                 established through a barrel-imported storage would be
      //                 invisible to a writer that read the subpath one, and the
      //                 row would be written unscoped instead of failing loudly.
      //                 `src/lib/__tests__/sealed-room-inheritance.test.ts` mocks
      //                 both specifiers onto one storage for exactly this reason.
      "@cinatra-ai/mcp-server/request-context": path.join(__dirname, "src/__tests__/__stubs__/mcp-server.ts"),
      "@cinatra-ai/mcp-server/capability-plan": path.join(
        root,
        "packages/mcp-server/src/capability-plan.ts",
      ),
      "@cinatra-ai/mcp-server/delegated-chat-admission": path.join(
        root,
        "packages/mcp-server/src/delegated-chat-admission.ts",
      ),
      "@cinatra-ai/mcp-server/core-delegated-chat-surface": path.join(
        root,
        "packages/mcp-server/src/core-delegated-chat-surface.ts",
      ),
      // mcp-server stub — only need `mcpRequestContextStorage`, mirror
      // objects/__stubs__/mcp-server.ts.
      "@cinatra-ai/mcp-server": path.join(__dirname, "src/__tests__/__stubs__/mcp-server.ts"),
    },
  },
  test: {
    // The wholesale package suite runs on the same constrained self-hosted
    // runner as the root suite and hits the same starvation under load —
    // imports and hooks alone can cross vitest's 5s/10s defaults. Give
    // tests and hooks the same 30s headroom as the root suite.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});

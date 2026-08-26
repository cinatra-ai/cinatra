import { defineConfig } from "vitest/config";
import * as path from "node:path";

const root = path.resolve(__dirname, "../..");

export default defineConfig({
  resolve: {
    alias: {
      // Workspace package aliases for tests
      // Leaf-subpath alias must be listed BEFORE the barrel alias so vite's
      // alias resolver picks the more-specific match first.
      // cinatra#2582: graphiti-client publishes its per-episode usage row on the
      // shared bus. Point at the real leaf (dependency-free — node:events + types)
      // so every test that loads the client resolves it without a stub.
      "@cinatra-ai/metric-contracts": path.join(root, "packages/metric-contracts/src/index.ts"),
      "@cinatra-ai/objects/classifier-signals": path.join(__dirname, "src/classifier-signals.ts"),
      "@cinatra-ai/objects": path.join(__dirname, "src/index.ts"),
      "@cinatra-ai/objects/renderer-types": path.join(__dirname, "src/renderer-types.ts"),
      // Alias host-app paths used by mcp/handlers.ts to local test stubs so
      // tests that import handlers.ts can be loaded by vitest without pulling
      // in server-only Drizzle/pg modules. Tests still override these with
      // `vi.mock("@/lib/...")` for behaviour assertions.
      "@/lib/objects-dual-write": path.join(__dirname, "src/__tests__/__stubs__/objects-dual-write.ts"),
      "@/lib/database": path.join(__dirname, "src/__tests__/__stubs__/database.ts"),
      // Alias the host-app objects-store + postgres-sync modules to their real
      // source paths so tests for the Postgres-primary CRUD functions can
      // import them. Tests use `vi.mock("@/lib/postgres-sync")` and
      // `vi.mock("@/lib/database")` factories to control behaviour without
      // touching a real PG instance.
      "@/lib/objects-store": path.join(root, "src/lib/objects-store.ts"),
      "@/lib/postgres-sync": path.join(root, "src/lib/postgres-sync.ts"),
      // Host-app claim registry + effective-identity resolver. The graphiti
      // projector / rebuild worker call these for claimed-row faceted
      // projection (cinatra#1427 AC-3), importing them at top level. The real
      // modules pull server-only + postgres-config/schema-init; route to
      // lightweight stubs (safe no-claims / floor-identity defaults) so the
      // projector loads in the sandbox. Behaviour tests vi.mock these locally.
      "@/lib/objects/artifact-claim-store": path.join(__dirname, "src/__tests__/__stubs__/artifact-claim-store.ts"),
      "@/lib/objects/effective-identity": path.join(__dirname, "src/__tests__/__stubs__/effective-identity.ts"),
      // Per-claim activation gate (cinatra#1429). The objects_save /
      // objects_update handlers import the NEW-write enforcement + the claim
      // probe at top level; the real module pulls server-only + postgres reads.
      // Route to a stub (claim probe → false, real pure enforcement logic) so
      // the handler tests load; behaviour tests vi.mock locally.
      "@/lib/objects/claim-activation-gate": path.join(__dirname, "src/__tests__/__stubs__/claim-activation-gate.ts"),
      // Binding write path (cinatra#1429). `src/lib/objects-store.ts` (aliased
      // to real source) calls `reconcileArtifactBindingForWrite` after every
      // object write; the real module pulls server-only + postgres reads. Route
      // to a stub (no-op reconcile) so the objects-store CRUD tests load;
      // behaviour tests vi.mock locally.
      "@/lib/objects/binding-write-path": path.join(__dirname, "src/__tests__/__stubs__/binding-write-path.ts"),
      // objects-store.ts resolves project inheritance for new object rows at
      // INSERT time via this pure helper (its only side-effecting import is
      // `server-only`, already neutralised by the stub alias below). Route to
      // the real source so the objects-store CRUD + type-register handler tests
      // can load it.
      "@/lib/project-inheritance": path.join(root, "src/lib/project-inheritance.ts"),
      // objects-store.ts derives the ownership WHERE-filter via this pure
      // helper (its only import is a type-only ActorContext). Route to real
      // source so the objects-store CRUD + type-register handler tests load.
      "@/lib/derived-store-ownership": path.join(root, "src/lib/derived-store-ownership.ts"),
      // Archive gate support: the objects_update handler calls
      // assertProjectWritable on a project-move; the upsertObject* writer paths
      // in src/lib/objects-store.ts call assertProjectWritableSync inside the
      // host-app objects-store alias. The real module imports postgres-sync +
      // database; route to a stub that no-ops so the handler / writer tests pass
      // through the gate. Tests that need to exercise the archive-reject path
      // stub locally via vi.mock.
      "@/lib/project-writable": path.join(__dirname, "src/__tests__/__stubs__/project-writable.ts"),
      "@/lib/resource-project-move": path.join(__dirname, "src/__tests__/__stubs__/resource-project-move.ts"),
      // Memory-recall team-lane resolver (cinatra#1379 AC4). handlers.ts imports
      // `readTeamsForUser` from here; the real module builds a pg Pool / drizzle
      // bridge at import. Route to a no-teams stub so every handler test loads;
      // the recall test vi.mocks it locally to assert the entitled lane set.
      "@/lib/better-auth-db": path.join(__dirname, "src/__tests__/__stubs__/better-auth-db.ts"),
      // Alias the authz sub-files used by the objects handlers so vitest can
      // resolve them. The barrel (`@/lib/authz`) is also aliased for tests that
      // vi.mock it.
      // Sealed-room read filter (cinatra#1031 cluster): handlers.ts imports
      // assertProjectReadAccess from here. Route to the REAL source (pure
      // predicate logic); its `import "server-only"` marker is neutralized by
      // the server-only stub alias below.
      "@/lib/sealed-room": path.join(root, "src/lib/sealed-room.ts"),
      "server-only": path.join(__dirname, "src/__tests__/__stubs__/server-only.ts"),
      "@/lib/authz/enforce-resource-access": path.join(root, "src/lib/authz/enforce-resource-access.ts"),
      "@/lib/authz/errors": path.join(root, "src/lib/authz/errors.ts"),
      "@/lib/authz/build-actor-context": path.join(root, "src/lib/authz/build-actor-context.ts"),
      "@/lib/authz/permissions": path.join(root, "src/lib/authz/permissions.ts"),
      "@/lib/authz/resource-ref": path.join(root, "src/lib/authz/resource-ref.ts"),
      // Barrel itself goes to a stub: the real barrel pulls authz/audit.ts
      // which creates a pg Pool at module-load and crashes in unit tests.
      // The stub provides the same surface with allow-by-default `can()`
      // because handler tests assume authz is open, plus a no-op audit logger.
      // Tests that need different kernel behaviour can `vi.mock("@/lib/authz")`
      // locally; the deny-path tests do exactly this.
      "@/lib/authz": path.join(__dirname, "src/__tests__/__stubs__/authz.ts"),
      // Object-history substrate. The real module imports
      // postgres-sync + ensurePostgresSchema, which are not initialised in
      // vitest. The stub provides the same public surface for type-level
      // imports; behaviour tests should vi.mock locally.
      "@/lib/object-history": path.join(__dirname, "src/__tests__/__stubs__/object-history.ts"),
      // PURE OBO scope-ceiling subpath (W2/#1051) — resolve to the REAL source
      // (no server-only / no heavy deps) so the ceiling logic is exercised, not
      // stubbed. MUST precede the general `@cinatra-ai/mcp-server` stub alias
      // below (Vite matches in order; the stub is a single file, so a subpath
      // falling through resolves to an invalid `mcp-server.ts/obo-ceiling`
      // path). Reached transitively via the aliased
      // `@/lib/authz/enforce-resource-access` the objects handlers import.
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
      // Alias @cinatra-ai/mcp-server to a tiny stub so registry-orgid.test.ts
      // can import `mcpRequestContextStorage` without pulling in the real
      // next/navigation + better-auth entry point.
      "@cinatra-ai/mcp-server": path.join(__dirname, "src/__tests__/__stubs__/mcp-server.ts"),
      // Draftable write-path lock, reached by a DYNAMIC import inside
      // `enforceDraftableLock` in src/mcp/handlers.ts. The real module imports
      // server-only + the pooled-pg publication ledger. Route to a stub whose
      // default is the real module's own behaviour under this sandbox's
      // no-claims reader (see the stub header). Without it eight handler suites
      // fail at assertion time with ERR_MODULE_NOT_FOUND — the state they sat
      // in for as long as this package had no CI runner (cinatra#2439).
      "@/lib/objects/draftable-lock-gate": path.join(
        __dirname,
        "src/__tests__/__stubs__/draftable-lock-gate.ts",
      ),
    },
  },
  test: {
    environment: "node",
    // The UNIT tier. `src/**/*.test.ts` is the discovery set the whole-package
    // CI runner executes (cinatra#2439); every non-unit tier below is carved
    // out EXPLICITLY, by name, so a tier can never leave the gate by omission.
    include: ["src/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      // MANUAL tier. `*.manual.test.ts` files drive a live Graphiti instance
      // (wire negotiation + a search-nodes smoke). They self-skip without one,
      // so leaving them in would be harmless-but-vacuous; naming them here
      // makes the tier a decision instead of an accident. Run them by hand
      // against a live Graphiti:
      //   pnpm exec vitest run src/__tests__/<name>.manual.test.ts
      "src/**/*.manual.test.ts",
    ],
  },
});

import { defineConfig } from "vitest/config";
import * as path from "node:path";
import * as fs from "node:fs";

const root = path.resolve(__dirname, "../..");


// Auto-load .env.local from the repo root so integration tests
// (trigger-store, extension-handler) see the real
// SUPABASE_DB_URL / SUPABASE_SCHEMA without each developer having to
// `source` it manually. The `process.env.X ?? ...` pattern below already
// honors this. Silently no-ops when .env.local is absent (CI). Existing
// process.env values win — we never overwrite.
function loadEnvLocal() {
  const envPath = path.join(root, ".env.local");
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, "utf-8");
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip surrounding single or double quotes if present.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadEnvLocal();

// Keep agent test aliases aligned with the @cinatra-ai/agents import surface.
// extension-handler.test.ts mocks @cinatra-ai/agents directly.
export default defineConfig({
  resolve: {
    // Vite 8 native: read tsconfig.json `paths` so this alias map only
    // needs to carry test-only stubs/mocks + dir-form overrides + entries
    // not present in tsconfig. Vite runs `alias` BEFORE this (and before
    // user plugins, even enforce:"pre"), so stubs (server-only, mcp-server,
    // @/lib/auth, etc.) and dir-form aliases continue to win. Closes the
    // recurring ERR_MODULE_NOT_FOUND class for tsconfig-mapped subpaths.
    tsconfigPaths: true,
    alias: {
      "@cinatra-ai/registries": path.join(root, "packages/registries/src/index.ts"),
      // `@modelcontextprotocol/server` is a vendored, workspace-private
      // package mapped via the root
      // tsconfig.json `paths` entry. vitest doesn't read that, so .tsx
      // tests that transitively touch `src/mcp/discovery.ts` (which imports
      // `ResourceTemplate`) fail at vite import-analysis with
      // "Failed to resolve import". Mirror the tsconfig mapping here.
      // Affects: grouped-setup-form-renderer.test.tsx,
      // permissions-tab-client.test.tsx (and any future test that loads
      // discovery.ts transitively).
      "@modelcontextprotocol/server": path.join(
        __dirname,
        "src/__tests__/__mocks__/modelcontextprotocol-server.ts",
      ),
      // Explicit subpath alias for skills/mcp-client. The tsconfig path map points to
      // deterministic-client.ts (not src/mcp-client.ts), so the
      // bare-skills alias below cannot resolve it naturally. MUST come
      // before the bare-skills alias so vite's prefix matcher picks the
      // more specific entry first.
      "@cinatra-ai/skills/mcp-client": path.join(
        root,
        "packages/skills/src/mcp/client/deterministic-client.ts",
      ),
      "@cinatra-ai/skills/mcp-handlers": path.join(
        root,
        "packages/skills/src/mcp/handlers.ts",
      ),
      // tsconfig.json:187 maps @cinatra-ai/skills/store to
      // packages/skills/src/skills-store.ts (different basename from the
      // subpath). vitest does NOT read tsconfig paths, and the bare-skills
      // dir alias below can only resolve subpaths whose basename matches
      // the file (store/ -> store.ts, which does not exist; the real file
      // is skills-store.ts). Mirror the /mcp-client and /mcp-handlers
      // explicit-alias pattern.
      "@cinatra-ai/skills/store": path.join(
        root,
        "packages/skills/src/skills-store.ts",
      ),
      // Point to src directory (not index.ts) so subpath imports whose basename DOES match the file
      // (auto-registrar -> auto-registrar.ts, llm-matching/* etc.) resolve
      // via vite's natural extension resolution. Pointing at index.ts
      // caused ENOTDIR because vite tried to traverse into a file.
      // Different-basename subpaths need their own alias above (see /store).
      "@cinatra-ai/skills": path.join(root, "packages/skills/src"),
      "@cinatra-ai/extension-types": path.join(root, "packages/extension-types/src/index.ts"),
      "@cinatra-ai/extensions": path.join(root, "packages/extensions/src"),
      // server-only stub so packages guarded by import("server-only") don't crash.
      "server-only": path.join(__dirname, "src/__tests__/__mocks__/server-only.ts"),
      // Sandbox stub for the host-app verdaccio-config wrapper. The real
      // wrapper at src/lib/verdaccio-config.ts wires
      // loadVerdaccioConfigAsync with the host-app's identity reader +
      // decryptor; the stub re-exports loadVerdaccioConfigAsync directly so
      // tests that mock @cinatra-ai/registries automatically intercept the
      // wrapper path too. publishToRegistry tests rely on this cascade.
      "@/lib/verdaccio-config": path.join(
        __dirname,
        "src/__tests__/__mocks__/verdaccio-config.ts",
      ),
      // Stub `@/lib/auth`. The real module instantiates better-auth at
      // load time and pulls in @cinatra-ai/mcp-server,
      // @cinatra-ai/google-oauth-connection → @/lib/nango →
      // @cinatra-ai/nango-connector (React UI). Stubbing here breaks the chain
      // at the right layer; tests that exercise auth.* vi.mock per-test.
      "@/lib/auth": path.join(
        __dirname,
        "src/__tests__/__mocks__/auth.ts",
      ),
      // Stub primitive-handlers. The real module aggregates handlers from every connector package
      // (gmail, wordpress, drupal, linkedin, apollo, etc.), each pulling
      // in heavy React UI trees. Tests don't need the aggregation.
      "@/lib/primitive-handlers": path.join(
        __dirname,
        "src/__tests__/__mocks__/primitive-handlers.ts",
      ),
      // Stub mcp-instructions. The real module runs an IIFE at top-level that calls
      // `readLocalPackageSkillContent` from `@cinatra-ai/skills`; in vitest
      // the named export resolves undefined (ESM/CJS barrel interop in
      // the workspace chain) and the IIFE crashes module load.
      "@/lib/mcp-instructions": path.join(
        __dirname,
        "src/__tests__/__mocks__/mcp-instructions.ts",
      ),
      // Stub @/lib/cinatra-toast. The real module does
      // `sonnerToast.promise.bind(...)` at top level, but the Node test
      // environment resolves `sonner` to a CJS shim where the named
      // export is undefined → crash at module load.
      "@/lib/cinatra-toast": path.join(
        __dirname,
        "src/__tests__/__mocks__/toast.ts",
      ),
      // Host-app `@/lib/*` alias for tests in this package that import
      // authz, database, auth-session, background-jobs, etc.
      // More specific aliases above (verdaccio-config, auth) take precedence.
      "@/lib": path.join(root, "src/lib"),
      // `@cinatra-ai/mcp-server`'s package.json `exports` field only
      // declares `.`, but tsconfig.json path-maps the
      // `/credentials` subpath to llm-credentials.ts. The host app's
      // src/lib/auth.ts uses this subpath, which is reachable from any
      // test that imports `@/lib/authz` (barrel transitively touches
      // auth-session → auth). Mirror the tsconfig map here so vitest
      // resolves it.
      "@cinatra-ai/mcp-server/credentials": path.join(
        root,
        "packages/mcp-server/src/llm-credentials.ts",
      ),
      // Stub the mcp-server barrel itself. The real index.tsx imports React UI components from the host app
      // (`@/components/ui/*`), which are out of reach for this package's
      // vitest config. Our stub exports the runtime values used by
      // `src/lib/auth.ts` (`mcpRequestContextStorage`,
      // `createMcpServerAuthPlugins`, `createMcpServerMount`).
      "@cinatra-ai/mcp-server": path.join(
        __dirname,
        "src/__tests__/__mocks__/mcp-server.ts",
      ),
      // Mirror tsconfig.json path map for workspace packages used transitively by tests in this package.
      // Subpath aliases must come BEFORE the bare-package alias so vite's
      // prefix matcher prefers the more specific one.
      "@cinatra-ai/agent-ui-protocol/server": path.join(
        root,
        "packages/agent-ui-protocol/src/server.ts",
      ),
      "@cinatra-ai/agent-ui-protocol": path.join(
        root,
        "packages/agent-ui-protocol/src/index.ts",
      ),
      "@/lib/blog/mcp/handlers": path.join(
        root,
        "src/lib/blog/mcp/handlers.ts",
      ),
      "@/lib/blog/integration/register-object-types": path.join(
        root,
        "src/lib/blog/integration/register-object-types.ts",
      ),
      "@cinatra-ai/openai-connector/actions": path.join(
        root,
        "extensions/cinatra-ai/openai-connector/src/actions.ts",
      ),
      // Use the src DIRECTORY (not index.ts) so FLAT subpath imports resolve via
      // vite's natural extension resolution — same pattern + reason as
      // @cinatra-ai/objects / @cinatra-ai/skills above. The host-app
      // src/lib/logging.ts imports `@cinatra-ai/llm/anthropic-log-directory`
      // (reachable from any test that touches the store → @/lib/logging chain);
      // the index.ts file-form made that subpath resolve to
      // `…/src/index.ts/anthropic-log-directory` → ENOTDIR, breaking every
      // agents integration test.
      "@cinatra-ai/llm": path.join(
        root,
        "packages/llm/src",
      ),
      "@cinatra-ai/objects/namespace": path.join(
        root,
        "packages/objects/src/namespace.ts",
      ),
      // src/lib/register-all-object-types.ts (reached via the @/lib alias) imports
      // @cinatra-ai/objects/register-artifact-extensions. Its package.json
      // export + tsconfig path both map to src/integration/..., but vitest
      // does NOT read tsconfig paths, and the bare @cinatra-ai/objects dir
      // alias below only resolves FLAT subpaths (auto-registrar,
      // graphiti-projector at src/*.ts). NESTED-target subpaths
      // (register-artifact-extensions, module, mcp-handlers under
      // src/integration|mcp/) need an explicit alias — mirrors /namespace.
      "@cinatra-ai/objects/register-artifact-extensions": path.join(
        root,
        "packages/objects/src/integration/register-artifact-extensions.ts",
      ),
      // crm-connector's mcp/module.ts imports from this subpath; tests
      // that transitively pull crm-connector (via @cinatra-ai/agents barrel
      // or its plugin layer) need the explicit alias because the bare
      // `@cinatra-ai/objects` dir alias below only resolves FLAT subpaths.
      // Must precede the bare alias.
      "@cinatra-ai/objects/mcp-handlers": path.join(
        root,
        "packages/objects/src/mcp/handlers.ts",
      ),
      // Use src dir so FLAT subpath imports (auto-registrar,
      // graphiti-projector, etc.) resolve via vite's natural extension
      // resolution. NESTED-target subpaths need their own alias above.
      "@cinatra-ai/objects": path.join(
        root,
        "packages/objects/src",
      ),
      // Host-app component tree — needed by .tsx tests that render
      // components which transitively import shadcn-style primitives.
      "@/components": path.join(root, "src/components"),
      // Host-app context tree used by @cinatra-ai/google-oauth-connection's settings-form.tsx.
      "@/context": path.join(root, "src/context"),
      // The mcp-client connector and anthropic-connector are
      // required by llm's registry imports.
      "@cinatra-ai/mcp-client-connector": path.join(
        root,
        "extensions/cinatra-ai/mcp-client-connector/src/index.ts",
      ),
      "@cinatra-ai/anthropic-connector": path.join(
        root,
        "extensions/cinatra-ai/anthropic-connector/src/index.ts",
      ),
      "@cinatra-ai/a2a": path.join(root, "packages/a2a/src/index.ts"),
      "@cinatra-ai/metric-cost-api": path.join(
        root,
        "packages/metric-cost-api/src",
      ),
      // openai-connector is reached transitively via @/app/campaigns. Use
      // src-dir form so subpath imports (e.g. /actions) resolve via vite's
      // natural extension resolution.
      "@cinatra-ai/openai-connector": path.join(
        root,
        "extensions/cinatra-ai/openai-connector/src",
      ),
      "@cinatra-ai/mcp-client": path.join(
        root,
        "packages/mcp-client/src/index.ts",
      ),
      // Host-app `@/app/*` for server actions referenced from connector
      // packages (e.g. google-oauth-connection).
      "@/app": path.join(root, "src/app"),
    },
  },
  test: {
    environment: "node",
    // Several suites do an in-body `await import("../mcp/handlers")` (deferred so
    // `vi.mock(...)` is set up first). That dynamic import pulls the heavy agents
    // MCP module graph; on a loaded CI runner the FIRST such import can exceed the
    // 5s vitest default and time the test out (a flake unrelated to the assertion
    // under test — e.g. mcp-run-create-execute-gate / mcp-run-read-policy). Give
    // the import headroom so the gate measures behavior, not runner contention.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ["src/**/__tests__/**/*.test.{ts,tsx}"],
    // Integration tests requiring an isolated Postgres schema are
    // excluded from the default run. Run
    // them via `pnpm test:integration` after `cinatra setup branch`
    // has provisioned `cinatra_<slug>`. See AGENTS.md "Integration tests".
    exclude: ["**/*.integration.test.ts"],
    // Use forks pool for true process isolation. Several tests dynamically import modules that other tests mock; the
    // default threads pool shares a worker process and the module-cache
    // pollution causes spurious failures (e.g.,
    // mcp-actor-context-a2a.test.ts vi.mock("../mcp/schemas") leaks vs.
    // tests that don't mock schemas at all). Forks isolates per file.
    pool: "forks",
    env: {
      SUPABASE_DB_URL:
        process.env.SUPABASE_DB_URL ??
        "postgres://unused:unused@localhost:5432/unused",
    },
  },
});

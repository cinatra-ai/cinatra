import { defineConfig } from "vitest/config";
import * as path from "node:path";

const root = path.resolve(__dirname, "../..");
const serverOnlyStub = path.join(__dirname, "tests/__stubs__/server-only.ts");
const llmStub = path.join(__dirname, "tests/__stubs__/llm.ts");
const skillsBarrelStub = path.join(__dirname, "tests/__stubs__/skills-barrel.ts");
const authStub = path.join(__dirname, "tests/__stubs__/auth.ts");
const objectsStub = path.join(__dirname, "tests/__stubs__/objects.ts");

// Package-scoped vitest config for @cinatra-ai/skills. The root vitest config
// only includes src/**/__tests__/**/*.test.{ts,tsx}; package tests live at
// packages/skills/src/**/*.test.ts. This config stubs "server-only" (the
// package-wide no-op import) so index.ts and personal-skills.ts can load in the
// test process, and aliases @/* to the workspace src/ directory so imports like
// `@/lib/agents-store` resolve. Individual tests vi.mock() all DB / LLM / store
// modules so no real network, DB, or LLM calls happen.
//
// When `GOLDEN_EVAL_LIVE=1` is set, skip the
// @cinatra-ai/llm stub so the live golden eval test
// (golden-eval.live.test.ts) can call the real OpenAI gateway. The
// describe.skipIf(!OPENAI_API_KEY) gate inside the test still applies; this env
// var only un-stubs the alias.
const stubLlmOrchestration = process.env.GOLDEN_EVAL_LIVE !== "1";

export default defineConfig({
  resolve: {
    // Vite 8 native: resolve tsconfig.json `paths` so the deep app-boot graph
    // reached transitively by these tests (blog/artifact materializers pulling
    // @cinatra-ai/objects/* leaf subpaths, etc.) resolves without hand-
    // mirroring every workspace subpath here. Vite runs the `alias` block
    // BEFORE this, so the stubs below (objects barrel, @/lib/auth, llm) still
    // win; tsconfigPaths only catches the subpaths that lack an explicit alias.
    tsconfigPaths: true,
    alias: [
      { find: "server-only", replacement: serverOnlyStub },
      ...(stubLlmOrchestration
        ? [
            // Subpath before bare (rollup prefix-match): keep `/actor-context`
            // imports from being rewritten to `<stub>.ts/actor-context` if a
            // future skills test ever pulls a module that uses the leaf subpath.
            { find: "@cinatra-ai/llm/actor-context", replacement: llmStub },
            { find: "@cinatra-ai/llm", replacement: llmStub },
          ]
        : []),
      { find: /^@cinatra\/skills$/, replacement: skillsBarrelStub },
      {
        find: "@cinatra/agent-builder/store",
        replacement: path.join(__dirname, "tests/__stubs__/agent-builder-store.ts"),
      },
      // Subpath BEFORE the bare prefix (vitest aliases match in order; the
      // bare `@cinatra-ai/extensions` find is a prefix-match that would
      // otherwise rewrite `/permissions-store` onto `index.ts/permissions-store`
      // — ENOTDIR). tsconfig already maps this subpath for the app/tsgo build;
      // mirror it here so skills tests that drive `uninstallSkillPackage`'s
      // dynamic `import("@cinatra-ai/extensions/permissions-store")` resolve.
      {
        find: "@cinatra-ai/extensions/permissions-store",
        replacement: path.join(__dirname, "../extensions/src/permissions-store.ts"),
      },
      // Exact-match the bare barrel so subpaths (e.g. `/mcp-handlers`, reached
      // via src/lib/primitive-handlers.ts) fall through to tsconfigPaths instead
      // of being prefix-rewritten onto `index.ts/<subpath>` (ENOTDIR).
      { find: /^@cinatra-ai\/extensions$/, replacement: path.join(__dirname, "../extensions/src/index.ts") },
      // The objects package barrel (packages/objects/src/index.ts) eagerly
      // re-exports React screens + the workflows/host-app boot graph, none of it
      // reachable from a skills unit test. The only symbol skills-reachable app
      // code (the blog register-object-types bridge) needs is the object-type
      // registry, so alias the BARE barrel to a light stub. Exact-match so the
      // `@cinatra-ai/objects/renderer-types` type-only subpath (erased at
      // runtime) is untouched.
      { find: /^@cinatra-ai\/objects$/, replacement: objectsStub },
      // @cinatra-ai/artifacts is not symlinked into node_modules (like objects
      // and workflows, it resolves via tsconfig paths in the app build). The
      // blog/artifact app-boot graph reached transitively by skills tests (e.g.
      // actions.ts, agents-store.ts) pulls it via src/lib/artifacts/
      // artifact-creation.ts. Its barrel is pure (types + error classes + the
      // SEMANTIC_ARTIFACT_OBJECT_TYPE constant — no server-only/react/workspace
      // deps), so alias to the REAL source (no drift). Exact-match so any future
      // subpath import surfaces rather than being silently rewritten.
      { find: /^@cinatra-ai\/artifacts$/, replacement: path.join(__dirname, "../artifacts/src/index.ts") },
      // Exact-match `@/lib/auth` (the better-auth boot module — throws at
      // module-load without BETTER_AUTH_SECRET and pulls the whole host-app
      // auth graph). Skills tests reach it transitively via auth-session.ts
      // (imported by @cinatra-ai/agents/auth-policy). Regex-anchored so
      // `@/lib/auth-session`, `@/lib/auth-policy`, `@/lib/better-auth-db` etc.
      // still resolve to their real sources via the `@/(.+)` catch-all below.
      { find: /^@\/lib\/auth$/, replacement: authStub },
      { find: /^@\/(.+)$/, replacement: path.join(root, "src") + "/$1" },
    ],
  },
  test: {
    environment: "node",
    // This suite pulls a deep app-boot graph through the aliases above (auth /
    // objects / artifacts / blog materializers), so the first test in a file
    // pays a heavy transitive-import cost. Under full-suite parallelism that
    // occasionally pushes a lightweight test just past vitest's 5s default and
    // it times out spuriously. 20s absorbs the import contention without hiding
    // a genuine hang.
    testTimeout: 20_000,
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "tests/**/*.test.ts",
      "tests/**/*.test.tsx",
    ],
    env: {
      SUPABASE_DB_URL:
        process.env.SUPABASE_DB_URL ??
        "postgres://unused:unused@localhost:5432/unused",
      // Unit tests run with the dev-bypass env enabled so legacy tests that
      // don't pass an explicit userId still resolve via the LOCAL_USER_ID
      // fallback path.
      BETTER_AUTH_DEV_BYPASS: "true",
    },
  },
});

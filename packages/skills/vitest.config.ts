import { defineConfig } from "vitest/config";
import * as path from "node:path";

const root = path.resolve(__dirname, "../..");
const serverOnlyStub = path.join(__dirname, "tests/__stubs__/server-only.ts");
const llmStub = path.join(__dirname, "tests/__stubs__/llm.ts");
const skillsBarrelStub = path.join(__dirname, "tests/__stubs__/skills-barrel.ts");

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
      { find: "@cinatra-ai/extensions", replacement: path.join(__dirname, "../extensions/src/index.ts") },
      { find: /^@\/(.+)$/, replacement: path.join(root, "src") + "/$1" },
    ],
  },
  test: {
    environment: "node",
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

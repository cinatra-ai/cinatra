import { defineConfig } from "vitest/config";
import * as path from "node:path";
import { createRequire } from "node:module";

const serverOnlyStub = path.join(
  __dirname,
  "tests/__stubs__/server-only.ts",
);

const agentBuilderStub = path.join(
  __dirname,
  "tests/__stubs__/agent-builder.ts",
);

// @cinatra-ai/llm is a runtime dep of agent-executor.ts
// (it provides getActorContext for the ALS-frame org read), but its real impl
// transitively imports @cinatra-ai/openai-connector -> host-only @/lib/database,
// which is not resolvable inside @cinatra-ai/a2a's vitest. Alias to a tiny stub.
const llmStub = path.join(__dirname, "tests/__stubs__/llm.ts");

// When running from a git worktree, this package's own node_modules/ may be
// empty (pnpm hoists deps to the canonical workspace root). Resolve @a2a-js/sdk
// via the canonical packages/a2a location so worktree test runs find the real
// package even when __dirname points to the worktree path.
//
// createRequire(__filename) resolves from this config file's location, which
// is always the canonical packages/a2a dir when vitest is invoked via
// `pnpm --filter @cinatra-ai/a2a exec vitest` or via `--root` override.
const req = createRequire(__filename);
let a2aSdkRoot: string;
try {
  a2aSdkRoot = path.dirname(req.resolve("@a2a-js/sdk/package.json"));
} catch {
  // Fallback: use canonical packages/a2a node_modules directly.
  a2aSdkRoot = path.join(
    __dirname,
    "..",
    "..",
    "packages",
    "a2a",
    "node_modules",
    "@a2a-js",
    "sdk",
  );
}

export default defineConfig({
  resolve: {
    alias: {
      "server-only": serverOnlyStub,
      // Stub out @cinatra/agent-builder and @cinatra-ai/agents to avoid pulling
      // in Drizzle/DB deps. agent-builder was consolidated into agents; both
      // aliases must resolve to the same stub so imports under either package
      // name are intercepted.
      "@cinatra/agent-builder": agentBuilderStub,
      "@cinatra-ai/agents": agentBuilderStub,
      // Subpath must precede the bare alias (rollup prefix-match) so
      // `@cinatra-ai/llm/actor-context` hits the stub directly
      // instead of being rewritten to `<stub>.ts/actor-context`.
      "@cinatra-ai/llm/actor-context": llmStub,
      "@cinatra-ai/llm": llmStub,
      // Ensure @a2a-js/sdk sub-path exports resolve correctly in worktree runs
      // where the local node_modules is empty.
      "@a2a-js/sdk/server": path.join(a2aSdkRoot, "dist", "server", "index.js"),
      "@a2a-js/sdk/client": path.join(a2aSdkRoot, "dist", "client", "index.js"),
      "@a2a-js/sdk": path.join(a2aSdkRoot, "dist", "index.js"),
    },
  },
  test: {
    environment: "node",
    include: ["src/__tests__/**/*.test.ts"],
    // Integration tests require real Postgres + Redis + worker; run them
    // separately via `pnpm test:integration` (vitest.integration.config.ts).
    exclude: ["**/node_modules/**", "src/__tests__/**/*.integration.test.ts"],
  },
});

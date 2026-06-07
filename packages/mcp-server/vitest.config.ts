import { defineConfig } from "vitest/config";
import path from "node:path";

const __dirname_local = path.dirname(new URL(import.meta.url).pathname);
// Repo root is needed so "../../../../src/lib/mcp-instructions" relative imports
// in the contract test can escape the packages/mcp-server/ vite root.
const repoRoot = path.resolve(__dirname_local, "../..");

export default defineConfig({
  root: repoRoot,
  test: {
    environment: "node",
    include: [
      "packages/mcp-server/src/__tests__/**/*.test.ts",
    ],
    // The vendored SDK ships ESM at packages/mcp-server/vendor/.../dist/index.mjs
    // and is wired via package.json `dependencies` -> `file:./vendor/...` so vitest
    // resolves it through normal node_modules without explicit alias.
    // No React, no JSX - pure server-side handshake test.
    testTimeout: 5000,
  },
  resolve: {
    alias: {
      // The production module `src/lib/mcp-instructions.ts` imports
      // `server-only`, which throws outside Next.js's server condition.
      // Aliased to a local empty stub so tests run cleanly.
      "server-only": path.join(__dirname_local, "__mocks__/server-only.ts"),
      // `src/lib/mcp-instructions.ts` imports @cinatra-ai/skills, whose package
      // index pulls in @/lib/database from the app layer. That app-layer module
      // is not available in the mcp-server test sandbox, so this alias targets
      // the standalone local-skill-files module with only node: built-in imports.
      "@cinatra-ai/skills": path.join(repoRoot, "packages/skills/src/local-skill-files.ts"),
    },
  },
});

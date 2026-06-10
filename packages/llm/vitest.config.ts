import { defineConfig } from "vitest/config";
import * as path from "node:path";

const root = path.resolve(__dirname, "../..");
const serverOnlyStub = path.join(__dirname, "tests/__stubs__/server-only.ts");

// Package-scoped vitest for @cinatra-ai/llm. The root
// vitest config only includes src/**/__tests__/**/*.test.{ts,tsx}; package
// tests live at packages/llm/src/**/*.test.ts. This config
// stubs "server-only" (the package-wide no-op import) so index.ts and
// registry.ts can load in the test process, and aliases @/* to the workspace
// src/ directory so imports like `@/lib/external-mcp-registry` resolve.
// Individual tests vi.mock() the @/lib/external-mcp-registry and ./mcp-access
// modules so no real DB / Nango / tunnel calls happen.
export default defineConfig({
  resolve: {
    alias: [
      { find: "server-only", replacement: serverOnlyStub },
      { find: /^@\/(.+)$/, replacement: path.join(root, "src") + "/$1" },
      // tools/skills.ts imports @cinatra-ai/skills/mcp-client
      // (mapped via tsconfig path alias in app builds). The package's
      // exports field intentionally omits it (lib-only sub-module), so
      // vitest needs an explicit resolver. We alias to a lightweight stub
      // so vitest can resolve the import without pulling in the
      // agents+objects+drizzle module graph the real client transitively
      // imports. Individual tests vi.mock() this path with their own factory.
      {
        find: "@cinatra-ai/skills/mcp-client",
        replacement: path.join(__dirname, "tests/__stubs__/skills-mcp-client.ts"),
      },
      // mcp-access.ts imports @cinatra-ai/mcp-server/credentials (mapped via
      // tsconfig path alias in app builds); the package's exports field omits
      // the subpath under node conditions, so vitest needs an explicit
      // resolver. Inert stub; tests vi.mock() the specifier when needed.
      {
        find: "@cinatra-ai/mcp-server/credentials",
        replacement: path.join(__dirname, "tests/__stubs__/mcp-server-credentials.ts"),
      },
    ],
  },
  test: {
    environment: "node",
    include: [
      "src/**/*.test.ts",
      "tests/**/*.test.ts",
    ],
    exclude: [
      "**/node_modules/**",
    ],
    env: {
      SUPABASE_DB_URL:
        process.env.SUPABASE_DB_URL ??
        "postgres://unused:unused@localhost:5432/unused",
    },
  },
});

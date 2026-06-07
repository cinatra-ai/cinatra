import { defineConfig } from "vitest/config";
import * as path from "node:path";

const root = path.resolve(__dirname, "../..");

// Minimal vitest config for @cinatra-ai/chat unit tests.
// Mirrors packages/agent-builder/vitest.config.ts — stubs server-only so
// "use server" files can be imported in tests, and pins React to the
// workspace copy shared by @testing-library/react.
const serverOnlyStub = path.join(root, "packages/agents/tests/__stubs__/server-only.ts");

export default defineConfig({
  resolve: {
    alias: {
      "server-only": serverOnlyStub,
      // Resolve the workspace subpath exports used by chat — tsconfig.json
      // maps these to package source files; vite needs the same hint because
      // the chat package's package.json does not declare `exports`.
      // Compatibility alias for @cinatra/agent-builder imports that now resolve
      // through the agents package.
      "@cinatra/agent-builder/client-entry": path.join(
        root,
        "packages/agents/src/client-entry.ts",
      ),
      "@cinatra/agent-builder": path.join(
        root,
        "packages/agents/src/index.ts",
      ),
      "@cinatra-ai/agents": path.join(
        root,
        "packages/agents/src/index.ts",
      ),
      // The useAgentCreationProgress hook imports the app
      // `@/lib/notifications*` modules. vite import-analysis must resolve the
      // bare specifier before a test's vi.mock() can replace it — map the two
      // `@/` paths the hook touches to their app source files.
      "@/lib/notifications/flyout-state": path.join(
        root,
        "src/lib/notifications/flyout-state.ts",
      ),
      "@/lib/notifications": path.join(root, "src/lib/notifications.ts"),
      // Pin React to the root workspace copy so react-dom and react match
      // (avoids "Invalid hook call" from two resolved copies in a pnpm workspace).
      // Resolve via the stable top-level `node_modules/react(-dom)` symlink
      // instead of a package-manager-internal `.pnpm` path, and add the
      // jsx-runtime subpaths the automatic JSX transform needs for `.test.tsx`.
      react: path.join(root, "node_modules/react"),
      "react/jsx-runtime": path.join(
        root,
        "node_modules/react/jsx-runtime.js",
      ),
      "react/jsx-dev-runtime": path.join(
        root,
        "node_modules/react/jsx-dev-runtime.js",
      ),
      "react-dom": path.join(root, "node_modules/react-dom"),
      "react-dom/client": path.join(
        root,
        "node_modules/react-dom/client.js",
      ),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts", "src/**/__tests__/**/*.test.tsx"],
    // @ts-ignore — environmentMatchGlobs is a valid vitest option but missing from InlineConfig types
    environmentMatchGlobs: [["src/**/__tests__/**/*.test.tsx", "jsdom"]],
  },
});

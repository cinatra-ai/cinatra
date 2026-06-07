import { defineConfig } from "vitest/config";
import * as path from "node:path";

// Self-reference alias: tests inside this package import via "@cinatra-ai/registries"
// (matching downstream consumer code paths). Without this, the test process
// cannot resolve the package name against its own sources. pnpm does not
// symlink a workspace package back into its own node_modules.
const indexPath = path.join(__dirname, "src/index.ts");

export default defineConfig({
  resolve: {
    alias: {
      "@cinatra-ai/registries": indexPath,
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});

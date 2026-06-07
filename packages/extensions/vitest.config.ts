import { defineConfig } from "vitest/config";
import * as path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "server-only": path.join(__dirname, "src/__tests__/__mocks__/server-only.ts"),
      "@cinatra-ai/mcp-client": path.join(
        __dirname,
        "../../packages/mcp-client/src/index.ts",
      ),
      "@cinatra-ai/extension-types": path.join(
        __dirname,
        "../../packages/extension-types/src/index.ts",
      ),
      // Leaf subpath for the byte-mirror lock test. Drops the agents
      // barrel, which would drag drizzle + pacote + better-auth init
      // into vitest.
      "@cinatra-ai/agents/package-contract": path.join(
        __dirname,
        "../../packages/agents/src/verdaccio/package-contract.ts",
      ),
      "@cinatra-ai/registries": path.join(
        __dirname,
        "../../packages/registries/src/index.ts",
      ),
      "@/lib/auth-session": path.join(__dirname, "src/__tests__/__mocks__/auth-session.ts"),
      // destination-resolver + license-detection sub-path aliases
      "@cinatra-ai/extensions/destination-resolver": path.join(__dirname, "src/destination-resolver.ts"),
      "@cinatra-ai/extensions/license-detection": path.join(__dirname, "src/license-detection.ts"),
      // @/ alias resolution for fixture and deployment-registry-config imports
      "@/lib/__fixtures__/deployment-registry-config.fixture": path.join(
        __dirname,
        "../../src/lib/__fixtures__/deployment-registry-config.fixture.ts",
      ),
      "@/lib/deployment-registry-config": path.join(
        __dirname,
        "../../src/lib/deployment-registry-config.ts",
      ),
      // aliases for imports in destination-resolver.ts
      "@/lib/instance-secrets": path.join(
        __dirname,
        "../../src/lib/instance-secrets.ts",
      ),
      "@/lib/drizzle-store": path.join(
        __dirname,
        "../../src/lib/drizzle-store.ts",
      ),
      "@/lib/instance-identity-store": path.join(
        __dirname,
        "../../src/lib/instance-identity-store.ts",
      ),
      // @/lib/database — transitive dep of @/lib/instance-identity-store (imported by mcp/handlers.ts).
      // The root-level stub exports readMetadataValueFromDatabase + writeMetadataValueToDatabase
      // which are the only symbols instance-identity-store.ts needs.
      "@/lib/database": path.join(__dirname, "../../tests/__stubs__/database.ts"),
      // @/lib/instance-identity-cache — imported by instance-identity-store.ts. The module
      // exports only invalidateInstanceIdentityCache; map to the real source so vitest can
      // resolve it before vi.mock("@/lib/instance-identity-store") intercepts the chain.
      "@/lib/instance-identity-cache": path.join(
        __dirname,
        "../../src/lib/instance-identity-cache.ts",
      ),
      // @/lib/instance-identity-write-lock — promise-tail mutex used by ensureInstanceId().
      // Lives in its own module so the bridge mcp-tools test can spy on lock acquisition
      // without same-module mocking complications. Vitest needs this aliased too because
      // it is a direct dep of @/lib/instance-identity-store, not just a transitive of
      // the test fixtures.
      "@/lib/instance-identity-write-lock": path.join(
        __dirname,
        "../../src/lib/instance-identity-write-lock.ts",
      ),
      // @/lib/postgres-sync — synchronous Postgres query runner used by
      // instance-identity-store. Tests don't issue real queries (the @/lib/database
      // stub above is the no-op), but the module must resolve.
      "@/lib/postgres-sync": path.join(
        __dirname,
        "../../src/lib/postgres-sync.ts",
      ),
      // @/lib/marketplace-credentials — viewer-scope helper used by the
      // extensions MCP handlers. Tests don't exercise the credential resolvers,
      // but the import must resolve.
      "@/lib/marketplace-credentials": path.join(
        __dirname,
        "../../src/lib/marketplace-credentials.ts",
      ),
      "@cinatra-ai/agents/store": path.join(__dirname, "../../packages/agents/src/store.ts"),
      "@cinatra-ai/agents/schema": path.join(__dirname, "../../packages/agents/src/schema.ts"),
      // Skill-kind hooks dynamically import @cinatra-ai/skills/store.
      // Aliased so vite can resolve the (lazy) specifier when the uniform-access
      // modules are in the test module graph; the foundation test never executes
      // the skill hook, so the heavy store deps are resolved but not run.
      "@cinatra-ai/skills/store": path.join(__dirname, "../../packages/skills/src/skills-store.ts"),
      // aliases for promotion-action.test.ts
      "@cinatra-ai/agents/verdaccio/client": path.join(__dirname, "../../packages/agents/src/verdaccio/client.ts"),
      "@cinatra-ai/agents/verdaccio/publish-metadata": path.join(__dirname, "../../packages/agents/src/verdaccio/publish-metadata.ts"),
      "@cinatra-ai/extensions/actions": path.join(__dirname, "src/actions.ts"),
      "@/lib/authz": path.join(__dirname, "../../src/lib/authz/index.ts"),
      "@/lib/verdaccio-config": path.join(__dirname, "../../src/lib/verdaccio-config.ts"),
      // The real @/lib/gatekept-install pulls in the marketplace MCP SDK
      // (server-only) which is out of reach in this package's vitest sandbox.
      // resolveInstallEnvironment / resolveExtensionTypeId /
      // resolveExtensionPackageForLifecycle dynamically import it for the
      // flag-OFF default path; gatekept-branch tests inject the resolver via the
      // options seam instead. The stub only provides an env-reading
      // isGatekeptInstallEnabled.
      "@/lib/gatekept-install": path.join(
        __dirname,
        "src/__tests__/__mocks__/gatekept-install.ts",
      ),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/__tests__/**/*.test.{ts,tsx}"],
  },
});

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
      // Pure zod claims leaf (@cinatra-ai/objects/claims) — the artifact
      // handler imports the objectTypes-claim entry schema + schema-source
      // validator from it (cinatra#1432). Aliased as a leaf subpath BEFORE any
      // barrel so vitest resolves the source without the objects barrel (which
      // the handler tests mock).
      "@cinatra-ai/objects/claims": path.join(
        __dirname,
        "../../packages/objects/src/claims.ts",
      ),
      // Leaf subpath for the byte-mirror lock test. Drops the agents
      // barrel, which would drag drizzle + pacote + better-auth init
      // into vitest.
      "@cinatra-ai/agents/package-contract": path.join(
        __dirname,
        "../../packages/agents/src/verdaccio/package-contract.ts",
      ),
      // Leaf subpath BEFORE the barrel (vite picks the more-specific alias
      // first): marketplace-card-model.ts imports the pure semver helper via
      // `@cinatra-ai/registries/src/version-compare` to avoid the barrel.
      "@cinatra-ai/registries/src/version-compare": path.join(
        __dirname,
        "../../packages/registries/src/version-compare.ts",
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
      // destination credential store (split out of drizzle-store, cinatra#104)
      // + its postgres-config leaf dependency
      "@/lib/extension-destinations-store": path.join(
        __dirname,
        "../../src/lib/extension-destinations-store.ts",
      ),
      "@/lib/postgres-config": path.join(
        __dirname,
        "../../src/lib/postgres-config.ts",
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
      // @/lib/instance-identity-cas — pure, IO-free row-level CAS retry engine
      // imported by instance-identity-store.ts (cinatra#850). Self-contained (no
      // further @/ deps), but the specifier must resolve for the store module —
      // pulled in transitively via mcp/handlers.ts — to load in this sandbox.
      "@/lib/instance-identity-cas": path.join(
        __dirname,
        "../../src/lib/instance-identity-cas.ts",
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
      // Light zod-only leaf of the auth-policy barrel (the server barrel drags
      // @/lib/authz + enforceResourceAccess + DB init, out of this sandbox's
      // reach). Every extensions consumer imports auth-policy TYPE-ONLY except
      // permissions-actions.ts, which value-imports AgentAuthPolicySchema +
      // isExactlyOwner — both live in auth-policy-types.ts — so this alias is a
      // safe, suite-wide substitution (mirrors the package-contract leaf alias).
      "@cinatra-ai/agents/auth-policy": path.join(__dirname, "../../packages/agents/src/auth-policy-types.ts"),
      // permissions-actions.ts value-imports { betterAuthDb, betterAuthUsers };
      // the containment request-level test mocks the module, so it only needs to
      // RESOLVE (aliasing to real source keeps the specifier resolvable without
      // pulling the pg pool — vi.mock replaces it before it executes).
      "@/lib/better-auth-db": path.join(__dirname, "../../src/lib/better-auth-db.ts"),
      "@cinatra-ai/agents/store": path.join(__dirname, "../../packages/agents/src/store.ts"),
      "@cinatra-ai/agents/schema": path.join(__dirname, "../../packages/agents/src/schema.ts"),
      // Skill-kind hooks dynamically import @cinatra-ai/skills/store.
      // Aliased so vite can resolve the (lazy) specifier when the uniform-access
      // modules are in the test module graph; the foundation test never executes
      // the skill hook, so the heavy store deps are resolved but not run.
      "@cinatra-ai/skills/store": path.join(__dirname, "../../packages/skills/src/skills-store.ts"),
      // aliases for promotion-action.test.ts
      "@cinatra-ai/agents/verdaccio/client": path.join(__dirname, "../../packages/agents/src/verdaccio/client.ts"),
      // cinatra#2494: marketplace-card-model.test.ts value-imports the pure
      // carryManifestDisplayName/carryManifestVendor helpers from the REAL
      // module (not a vi.mock like promotion-action.test.ts above) to prove
      // the card renders the EXACT value the fixed publisher rebuild carries.
      // That drags in verdaccio/client.ts's oas-compiler → agent-runtime-mount
      // transitive chain, which needs @/lib/extension-data-root to resolve.
      // Real source (pure path-resolution logic); its own @/lib/database
      // dependency already resolves to the stub aliased below.
      "@/lib/extension-data-root": path.join(
        __dirname,
        "../../src/lib/extension-data-root.ts",
      ),
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
      // cinatra#1927: the declaration-driven protection gate consults a host
      // reader that walks the materialized extension store — out of reach in
      // this sandbox. Stub answers "declares nothing"; the refusal tests
      // vi.mock this same specifier.
      "@/lib/extension-protection-host": path.join(
        __dirname,
        "src/__tests__/__mocks__/extension-protection-host.ts",
      ),
      // aliases for marketplace-listing-card.test.tsx (cinatra#1003 — the §IV
      // ListingCard's CompatMeta plain-row + RatingRow rating-star-token
      // fixes). All real source (no stubs needed): every one of these is a
      // pure/presentational module, none pull in server-only/DB code.
      "@/components/extension-card": path.join(__dirname, "../../src/components/extension-card.tsx"),
      "@/components/extension-card-icon-image": path.join(
        __dirname,
        "../../src/components/extension-card-icon-image.tsx",
      ),
      // cinatra#1325: MarketplaceCardIcon (in extension-card-icon-image.tsx)
      // resolves the pure icon-chain model via its client-safe subpath and the
      // shared connector brand-icon leaf. All pure/presentational (no
      // server-only/DB) — real source, no stubs.
      "@cinatra-ai/extensions/screens/marketplace-card-model": path.join(
        __dirname,
        "src/screens/marketplace-card-model.ts",
      ),
      "@/components/connector-brand-icons": path.join(
        __dirname,
        "../../src/components/connector-brand-icons.tsx",
      ),
      "@/components/domain-icons": path.join(__dirname, "../../src/components/domain-icons.tsx"),
      "@/components/tailscale-logo": path.join(__dirname, "../../src/components/tailscale-logo.tsx"),
      "@/components/extension-kind-emblem": path.join(
        __dirname,
        "../../src/components/extension-kind-emblem.tsx",
      ),
      "@/components/ui/button": path.join(__dirname, "../../src/components/ui/button.tsx"),
      "@/lib/extension-accent": path.join(__dirname, "../../src/lib/extension-accent.ts"),
      "@/lib/extension-compat-badge": path.join(__dirname, "../../src/lib/extension-compat-badge.ts"),
      "@/lib/marketplace-detail-view": path.join(__dirname, "../../src/lib/marketplace-detail-view.ts"),
      // Pure vendor-byline resolver (cinatra#1528) — a leaf module (no heavy
      // deps), mapped to real source so the §I/§II byline tests exercise it.
      "@/lib/vendor-presentation": path.join(__dirname, "../../src/lib/vendor-presentation.ts"),
      "@/lib/utils": path.join(__dirname, "../../src/lib/utils.ts"),
      // §VI installed-extensions card (cinatra#2539 payload-weight suite): a
      // pure presentational server component — mapped to real source so the
      // measurement counts the card the screen actually renders.
      "@/components/extensions/installed-extension-card": path.join(
        __dirname,
        "../../src/components/extensions/installed-extension-card.tsx",
      ),
    },
  },
  test: {
    environment: "node",
    // The UNIT tier — and, since cinatra#2439, the set the CI runner actually
    // executes. The `extension-invariants` job used to run `pnpm
    // test:invariants`, a HAND-MAINTAINED list of 40 of these 113 files: a new
    // test file joined the unrun 73 by default, because joining the gate needed
    // someone to remember to edit a package.json script. The job now runs the
    // whole package (`pnpm test`) and that script is gone, so discovery is the
    // default and every carve-out below is a written decision instead.
    include: ["src/**/__tests__/**/*.test.{ts,tsx}"],
    exclude: [
      "**/node_modules/**",
      // The cinatra#2455 quarantine (blog-text-parity.test.ts,
      // contextslots-require-explicit-context-selection-agent.test.ts,
      // email-outreach-agent-explicit-context-selection-agent.test.ts) is
      // RETIRED: all three suites are repaired and run wholesale again, and
      // their entries are gone from
      // scripts/audit/package-suite-runner-exceptions.json. The quarantine
      // record's "fleet drift" diagnosis was inverted — every one of the 11
      // failures came from the SUITES asserting shapes the companions had
      // legitimately migrated away from (the cinatra#2086/#2090 S3 skill fold,
      // the cinatra#922/#923 output flattening, and the deprecated
      // `cinatra.agentDependencies` vocabulary). Each suite's docblock records
      // which assertion moved and why.
    ],
  },
});

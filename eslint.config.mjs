import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// ─────────────────────────────────────────────────────────────────────────
// Dashboards Platform — import boundary (ADR 0044 + 0045).
//
// FOUR layered `no-restricted-imports` blocks. ESLint flat config does NOT
// merge rule options across matching blocks — the LAST matching block wins
// for a given file. We therefore re-state full pattern sets per scope.
//
// Layer 1 (everywhere): bans drizzle-cube/mcp + the drizzle-cube root.
//   - drizzle-cube/client is NO LONGER repo-wide-banned (ADR 0045): it's
//     allowed inside packages/dashboards/src/components/ ONLY (Layer 4).
//   - The drizzle-cube root + any non-client subpath remain banned outside
//     the adapter directory (Layer 3).
//
// Layer 2 (inside sdk-dashboard, EXCLUDING the adapter): adds the
// sdk-dashboard-specific bans (@/*, @cinatra-ai/*, better-auth, bullmq).
//
// Layer 3 (inside the adapter only): re-allows drizzle-cube/* (the
// server-side adapter directory) AND drizzle-cube/mcp. The adapter wraps
// `getCubeTools` into the Cinatra-typed MCP surface; drizzle-cube/mcp remains
// forbidden elsewhere.
//
// Layer 4 (inside packages/dashboards/src/components/): re-allows
// drizzle-cube/client/* per ADR 0045 — the dashboards platform mounts
// drizzle-cube/client components themed to shadcn tokens.
// ─────────────────────────────────────────────────────────────────────────
const CLIENT_BAN = [
  {
    regex: "^drizzle-cube/client(/|$)",
    message:
      "drizzle-cube/client is allowed ONLY inside packages/dashboards/src/components/ (ADR 0045). Elsewhere, route through the shared dashboards client shell.",
  },
];

const MCP_BAN = [
  {
    regex: "^drizzle-cube/mcp$",
    message:
      "Cinatra MCP is the canonical MCP surface — drizzle-cube/mcp would bypass actor context (ADR 0044).",
  },
];

const DRIZZLE_CUBE_BAN = [
  {
    regex: "^drizzle-cube(/|$)",
    message:
      "drizzle-cube server imports must live in packages/sdk-dashboard/src/adapters/drizzle-cube/; drizzle-cube/client may also be used inside packages/dashboards/src/components/ (ADR 0044 + 0045).",
  },
];

const SDK_DASHBOARD_BAN = [
  {
    group: ["@/*"],
    message:
      "sdk-dashboard must not import Cinatra app source (use provider injection — ADR 0044).",
  },
  {
    group: ["@cinatra-ai/*"],
    message:
      "sdk-dashboard must not import Cinatra packages (use provider injection — ADR 0044).",
  },
  {
    group: ["better-auth", "better-auth/*"],
    message:
      "sdk-dashboard must not import better-auth (auth is host-provided — ADR 0044).",
  },
  {
    group: ["bullmq"],
    message:
      "sdk-dashboard must not import bullmq (job orchestration is host-provided — ADR 0044).",
  },
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Pin react version explicitly: eslint-plugin-react@7.37.5 (bundled by
  // eslint-config-next) calls the removed ESLint 9 `context.getFilename()`
  // API inside `detectReactVersion` when version is left as "detect",
  // crashing under ESLint 10. Providing an explicit version skips detection.
  // Remove once eslint-plugin-react publishes an ESLint-10-compatible release.
  {
    settings: {
      react: {
        version: "19.2.5",
      },
    },
  },

  // ───── Dashboards Platform boundary (ADR 0044 + 0045) ─────
  // Layer 1: repo-wide bans for drizzle-cube root + /client + /mcp.
  // The /client portion is lifted by Layer 4 inside the components carve-out.
  {
    files: ["**/*.{ts,tsx,mts,mjs}"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [...MCP_BAN, ...CLIENT_BAN, ...DRIZZLE_CUBE_BAN] },
      ],
    },
  },
  // Layer 2: inside sdk-dashboard (excluding adapter), additionally ban
  // Cinatra-app / Cinatra-package imports + auth/job-system deps.
  {
    files: ["packages/sdk-dashboard/src/**/*.{ts,tsx}"],
    ignores: [
      "packages/sdk-dashboard/src/adapters/drizzle-cube/**/*.{ts,tsx}",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            ...MCP_BAN,
            ...CLIENT_BAN,
            ...DRIZZLE_CUBE_BAN,
            ...SDK_DASHBOARD_BAN,
          ],
        },
      ],
    },
  },
  // Layer 3: inside the sdk-dashboard adapter directory — re-allow
  // drizzle-cube server-side imports AND drizzle-cube/mcp.
  // drizzle-cube/client is still banned (rendering belongs to packages/dashboards).
  {
    files: ["packages/sdk-dashboard/src/adapters/drizzle-cube/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [...CLIENT_BAN, ...SDK_DASHBOARD_BAN] },
      ],
    },
  },
  // Layer 4: inside packages/dashboards/src/components/ — ADR 0045
  // carve-out: drizzle-cube/client is ALLOWED here. /mcp still banned.
  {
    files: ["packages/dashboards/src/components/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [...MCP_BAN] },
      ],
    },
  },

  // Every transport connector package MUST use `import type` for the
  // EmailConnector contract types from @cinatra-ai/email-connector.
  // Runtime `import { EmailConnector }` would pull the (future) facade
  // registry into the provider's bundle, defeating the pluggability
  // arrow. Defense-in-depth on top of the import-boundary regression test
  // inside extensions/cinatra-ai/email-connector/src/__tests__/.
  {
    files: [
      // The LLM-provider packages live in packages/connector-*.
      "packages/connector-*/src/**/*.{ts,tsx}",
      // The transport connectors live in extensions/cinatra-ai/*-connector.
      "extensions/cinatra-ai/*-connector/src/**/*.{ts,tsx}",
    ],
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
    },
  },

  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Fixture files intentionally violate the boundary rules above so the
    // regression test (eslint-boundary.test.ts) can assert each rule fires.
    // The fixtures are linted by the test via direct `--no-ignore` invocation;
    // default `pnpm lint` skips them.
    "packages/sdk-dashboard/src/__tests__/fixtures/**",
  ]),
]);

export default eslintConfig;

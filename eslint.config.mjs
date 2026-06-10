import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// ─────────────────────────────────────────────────────────────────────────
// Dashboards Platform import boundary + shadcn design-system boundary.
//
// Layered `no-restricted-imports` blocks. ESLint flat config does NOT
// merge rule options across matching blocks — the LAST matching block wins
// for a given file. We therefore re-state full pattern sets per scope.
//
// Layer 1 (everywhere): bans drizzle-cube/mcp + the drizzle-cube root,
// plus the design-system bans (Radix, non-shadcn UI libraries,
// react-grid-layout).
//   - drizzle-cube/client is NO LONGER repo-wide-banned: it's
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
// drizzle-cube/client/* AND react-grid-layout — the dashboards platform
// mounts drizzle-cube/client components themed to shadcn tokens. Radix and
// the non-shadcn UI-library bans still apply here (the dir also contains
// real shadcn code); dc-modal-a11y-scope.tsx alone re-allows Radix (Layer
// 4b) — its FocusScope wrapper repairs drizzle-cube's hand-rolled modals.
//
// Layer 5 (inside the vendored shadcn primitives, **/components/ui/** and
// **/src/ui/**): re-allows Radix — shadcn primitives are built on Radix.
//
// Layers 1, 4, 4b and 5 spread the org ui-design-system preset
// (cinatra-ai/ci config/ui-design-system.flat.mjs) into this boundary: the
// preset's import blocks are integrated INTO the layers' restated pattern
// sets (the drizzle-cube/client carve-out was already encoded here) rather
// than appended as competing blocks. Exemptions stay files-glob carve-outs;
// never inline eslint-disable. recharts is the allowed shadcn chart
// primitive (used across metric-usage-api, metric-cost-api, chat): NOT
// banned, NOT drizzle-scoped.
// ─────────────────────────────────────────────────────────────────────────
const CLIENT_BAN = [
  {
    regex: "^drizzle-cube/client(/|$)",
    message:
      "drizzle-cube/client is allowed ONLY inside packages/dashboards/src/components/. Elsewhere, route through the shared dashboards client shell.",
  },
];

const MCP_BAN = [
  {
    regex: "^drizzle-cube/mcp$",
    message:
      "Cinatra MCP is the canonical MCP surface — drizzle-cube/mcp would bypass actor context.",
  },
];

const DRIZZLE_CUBE_BAN = [
  {
    regex: "^drizzle-cube(/|$)",
    message:
      "drizzle-cube server imports must live in packages/sdk-dashboard/src/adapters/drizzle-cube/; drizzle-cube/client may also be used inside packages/dashboards/src/components/.",
  },
];

// Non-client drizzle-cube surface (the root and every subpath EXCEPT
// /client*). Restated inside the Layer 4 carve-outs: re-allowing /client
// there must not silently re-open the server/mcp surface (rule options
// replace, not merge — DRIZZLE_CUBE_BAN cannot be restated as-is because it
// would re-ban /client).
const DRIZZLE_CUBE_NON_CLIENT_BAN = [
  {
    regex: "^drizzle-cube(?!/client(/|$))(/|$)",
    message:
      "drizzle-cube server imports must live in packages/sdk-dashboard/src/adapters/drizzle-cube/; only drizzle-cube/client is allowed inside packages/dashboards/src/components/.",
  },
];

const RADIX_BAN = [
  {
    group: ["@radix-ui/*", "radix-ui", "radix-ui/*"],
    message:
      "Radix belongs inside the vendored shadcn primitives (components/ui or src/ui) — import the shadcn wrapper instead.",
  },
];

const UI_LIB_BAN = [
  {
    group: [
      "@mui/*",
      "@material-ui/*",
      "@chakra-ui/*",
      "antd",
      "antd/*",
      "@ant-design/*",
      "@mantine/*",
      "@emotion/*",
      "styled-components",
      "styled-components/*",
      "@headlessui/*",
    ],
    message:
      "shadcn/ui is the design system — non-shadcn UI libraries are banned everywhere.",
  },
];

const GRID_LAYOUT_BAN = [
  {
    group: ["react-grid-layout", "react-grid-layout/*"],
    message:
      "react-grid-layout is allowed ONLY inside packages/dashboards/src/components/ (the drizzle-cube grid).",
  },
];

// Raw control JSX is flagged in favor of the shadcn wrappers. WARN for now —
// the import bans above are the high-signal rule; the raw-JSX ban is noisier
// and is ramped to error once the tree is clean. The vendored primitives
// themselves render the raw elements, so the ui dirs are exempt below.
const RAW_JSX_RESTRICTIONS = [
  ["button", "<Button> (components/ui/button)"],
  ["input", "<Input> (components/ui/input)"],
  ["select", "<Select> (components/ui/select)"],
  ["textarea", "<Textarea> (components/ui/textarea)"],
  ["a", "the shadcn link pattern (e.g. <Button asChild><Link/></Button>)"],
].map(([element, replacement]) => ({
  selector: `JSXOpeningElement[name.name='${element}']`,
  message: `Raw <${element}> — use the shadcn wrapper ${replacement} instead.`,
}));

const SDK_DASHBOARD_BAN = [
  {
    group: ["@/*"],
    message:
      "sdk-dashboard must not import Cinatra app source (use provider injection).",
  },
  {
    group: ["@cinatra-ai/*"],
    message:
      "sdk-dashboard must not import Cinatra packages (use provider injection).",
  },
  {
    group: ["better-auth", "better-auth/*"],
    message:
      "sdk-dashboard must not import better-auth (auth is host-provided).",
  },
  {
    group: ["bullmq"],
    message:
      "sdk-dashboard must not import bullmq (job orchestration is host-provided).",
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

  // ───── Dashboards Platform + design-system boundary ─────
  // Layer 1: repo-wide bans for drizzle-cube root + /client + /mcp, plus
  // Radix, non-shadcn UI libraries and react-grid-layout.
  // The /client + grid portions are lifted by Layer 4 inside the components
  // carve-out; the Radix portion by Layer 5 inside the shadcn primitives.
  // Full JS-family coverage (not just ts/tsx/mts/mjs) so a stray .js/.jsx
  // UI file cannot slip a banned import past the gate.
  {
    files: ["**/*.{js,jsx,cjs,mjs,ts,tsx,cts,mts}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            ...MCP_BAN,
            ...CLIENT_BAN,
            ...DRIZZLE_CUBE_BAN,
            ...RADIX_BAN,
            ...UI_LIB_BAN,
            ...GRID_LAYOUT_BAN,
          ],
        },
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
            ...RADIX_BAN,
            ...UI_LIB_BAN,
            ...GRID_LAYOUT_BAN,
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
        {
          patterns: [
            ...CLIENT_BAN,
            ...RADIX_BAN,
            ...UI_LIB_BAN,
            ...GRID_LAYOUT_BAN,
            ...SDK_DASHBOARD_BAN,
          ],
        },
      ],
    },
  },
  // Layer 4: inside packages/dashboards/src/components/ —
  // carve-out: drizzle-cube/client AND react-grid-layout are ALLOWED here.
  // /mcp + the non-client drizzle-cube surface, Radix and the non-shadcn UI
  // libraries stay banned (this dir also contains real shadcn code).
  {
    files: ["packages/dashboards/src/components/**/*.{js,jsx,ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            ...MCP_BAN,
            ...DRIZZLE_CUBE_NON_CLIENT_BAN,
            ...RADIX_BAN,
            ...UI_LIB_BAN,
          ],
        },
      ],
    },
  },
  // Layer 4b: dc-modal-a11y-scope.tsx alone also gets Radix — its
  // `<FocusScope>` wrapper is the documented a11y repair for drizzle-cube's
  // hand-rolled modals (see the file's docblock). Single-file carve-out so
  // the rest of the dir keeps the Radix ban; Layer 4's drizzle-cube/client
  // + react-grid-layout allowances are preserved (only RADIX_BAN is lifted).
  {
    files: ["packages/dashboards/src/components/dc-modal-a11y-scope.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            ...MCP_BAN,
            ...DRIZZLE_CUBE_NON_CLIENT_BAN,
            ...UI_LIB_BAN,
          ],
        },
      ],
    },
  },
  // Layer 5: inside the vendored shadcn primitives — Radix is ALLOWED
  // (shadcn primitives are built on Radix). Everything else stays banned.
  {
    files: [
      "**/components/ui/**/*.{js,jsx,ts,tsx}",
      "**/src/ui/**/*.{js,jsx,ts,tsx}",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            ...MCP_BAN,
            ...CLIENT_BAN,
            ...DRIZZLE_CUBE_BAN,
            ...UI_LIB_BAN,
            ...GRID_LAYOUT_BAN,
          ],
        },
      ],
    },
  },
  // Layer 5b: shadcn primitive dirs INSIDE sdk-dashboard (none exist today,
  // but Layer 5 alone would clobber Layer 2 there — last matching block
  // wins). Same Radix allowance as Layer 5, with the sdk-dashboard-specific
  // bans restated so the package boundary survives a future ui/ dir.
  {
    files: [
      "packages/sdk-dashboard/src/**/components/ui/**/*.{js,jsx,ts,tsx}",
      "packages/sdk-dashboard/src/ui/**/*.{js,jsx,ts,tsx}",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            ...MCP_BAN,
            ...CLIENT_BAN,
            ...DRIZZLE_CUBE_BAN,
            ...UI_LIB_BAN,
            ...GRID_LAYOUT_BAN,
            ...SDK_DASHBOARD_BAN,
          ],
        },
      ],
    },
  },

  // ───── Design system: raw control JSX (warn) ─────
  // Outside the vendored shadcn primitives, raw control elements should go
  // through the shadcn wrappers. WARN until the tree is clean.
  {
    files: ["**/*.{jsx,tsx}"],
    ignores: ["**/components/ui/**", "**/src/ui/**"],
    rules: {
      "no-restricted-syntax": ["warn", ...RAW_JSX_RESTRICTIONS],
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

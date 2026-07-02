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

// Raw control JSX is flagged in favor of the shadcn wrappers. ERROR — the
// tree is now clean of raw restricted elements (the last carve-outs went
// through the wrappers / the NativeSelect seam), so this is ramped from warn
// to error to keep main green only while the design-system boundary holds.
// The vendored primitives themselves render the raw elements, so the ui dirs
// are exempt below.
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

// ─────────────────────────────────────────────────────────────────────────
// Block C — dynamic-loader coverage (mirrors the org ui-design-system preset).
//
// `no-restricted-imports` matches ONLY static `import ... from "x"`. It does
// not see `await import("x")` (an `ImportExpression`) or `require("x")`. A
// dynamic loader would otherwise slip every banned module — the same UI-lib
// groups (Radix, MUI, …), the drizzle-cube surface, drizzle-cube/mcp and the
// sdk-dashboard package boundary — straight past the Layer-1…5b import bans.
//
// Block C re-bans the SAME pattern groups each import layer bans, on the two
// dynamic forms, using `no-restricted-syntax` AST selectors. The selectors are
// GENERATED from the very same pattern-group consts the import layers spread
// (RADIX_BAN, UI_LIB_BAN, CLIENT_BAN, GRID_LAYOUT_BAN, MCP_BAN,
// DRIZZLE_CUBE_BAN, DRIZZLE_CUBE_NON_CLIENT_BAN, SDK_DASHBOARD_BAN), so the
// dynamic ban cannot drift from the static one — there is no second source of
// truth. Each Block-C zone below mirrors its same-named import layer's pattern
// set (and therefore its carve-outs).
//
// The selectors target only the RUNTIME forms — `ImportExpression` (the
// `import()` call) and a `require(...)` `CallExpression`. A TypeScript type
// query `typeof import("drizzle-cube/client")` is a `TSImportType` node, NOT
// an `ImportExpression`, so it is never matched (the two `typeof import(...)`
// type-queries + the JSDoc mention in packages/dashboards/src/components are
// unaffected — and that dir is the drizzle-cube carve-out anyway).
//
// Severity / file-set discipline: `no-restricted-syntax` carries ONE severity
// per rule, and ESLint flat config does NOT merge a rule's options across
// matching configs (last match wins). The raw-JSX block (Block B) and these
// dynamic-loader blocks both use `no-restricted-syntax`, so they are kept on
// DISJOINT file sets: the non-JSX dynamic blocks own `no-restricted-syntax` on
// non-JSX sources; on JSX sources the raw-JSX block carries BOTH the raw-JSX
// selectors AND the dynamic-loader selectors. cinatra's raw-JSX severity is
// already `error`, so both halves run at `error` (mirroring the preset, whose
// JSX half tracks `strictness` — here `strictness: error`). The disjoint split
// is preserved regardless so a future severity change cannot silently drop a
// selector set.
// ─────────────────────────────────────────────────────────────────────────

// A literal "/" inside an ESLint `no-restricted-syntax` selector regex closes
// the regex literal, so it must be emitted as the `/` escape.
const SELECTOR_SEP = "\\u002F";

// Escape a literal module name for use inside a selector regex, emitting "/"
// as the `/` escape. Specifiers are plain package names, but `@scope`,
// `.` and `-` are still regex metacharacters worth escaping defensively.
function escapeModuleForSelector(name) {
  return name
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\//g, SELECTOR_SEP);
}

// Turn one `no-restricted-imports` pattern entry into selector-regex
// alternatives with the SAME match surface `no-restricted-imports` gives it,
// so the dynamic ban neither over- nor under-matches the static one:
//   - `@mui/*`            → `^@mui/.*$`            (a subpath is REQUIRED)
//   - `radix-ui`          → `^radix-ui$`           (exactly the bare name)
//   - `react-grid-layout` → `^react-grid-layout$`  (bare name only)
// An entry authored as a `regex` (the drizzle-cube bans) is already written
// against import specifiers; it is re-emitted with "/" escaped for selectors.
function patternEntryToRegexAlternatives(entry) {
  if (entry.regex) {
    return [entry.regex.replace(/\//g, SELECTOR_SEP)];
  }
  return entry.group.map((glob) => {
    if (glob.endsWith("/*")) {
      const base = escapeModuleForSelector(glob.slice(0, -2));
      return `^${base}${SELECTOR_SEP}.*$`; // subpath required
    }
    if (glob.endsWith("*")) {
      const base = escapeModuleForSelector(glob.slice(0, -1));
      return `^${base}.*$`; // prefix match (no bare `*` globs ship today)
    }
    return `^${escapeModuleForSelector(glob)}$`; // exact bare name
  });
}

// Build the `no-restricted-syntax` restriction objects (ImportExpression +
// require() CallExpression) for a set of import pattern groups, reusing each
// entry's own `message` so the dynamic and static diagnostics agree.
function dynamicBansFor(...patternGroups) {
  const restrictions = [];
  for (const entry of patternGroups.flat()) {
    const alternatives = [...new Set(patternEntryToRegexAlternatives(entry))];
    const regex = alternatives.join("|");
    restrictions.push(
      {
        selector: `ImportExpression[source.value=/${regex}/]`,
        message: `Dynamic import() of a banned module — ${entry.message}`,
      },
      {
        selector: `CallExpression[callee.name='require'][arguments.0.value=/${regex}/]`,
        message: `require() of a banned module — ${entry.message}`,
      },
    );
  }
  return restrictions;
}

// First-party extension boundary (cinatra#803): extensions under
// extensions/** share the app's `@/*` tsconfig alias while they live in the
// monorepo, so a stray `@/components/...` import silently couples an
// extension to APP-PRIVATE modules. Extensions must consume the portable
// sdk-ui primitives (`@cinatra-ai/sdk-ui/marketplace`, PageHeader / Button /
// SectionHeader / ConnectorSettingsDialog) or their OWN vendored copies
// (scripts/extensions/vendor-extension-primitives.mjs) — never the app tree.
// STATIC-import ban only (documented): the dynamic-loader mirror would need
// per-zone no-restricted-syntax restatements across the extension surface;
// the realpath/package-boundary build gates already cover the dynamic path.
// NOTE: the ui-design-system-gate CI job lints WITHOUT extensions/ checked
// out (clone-extensions is not part of that job), so this layer enforces in
// local / full lints; it still rides the same GATED rule id.
const APP_ALIAS_BAN = [
  {
    group: ["@/*"],
    message:
      "extensions must not import app-private modules via the `@/*` alias — use @cinatra-ai/sdk-ui (marketplace subpath) or the extension's own vendored primitives.",
  },
];

// Arbitrary-value className bans (cinatra#803). The design system expresses
// color through semantic tokens (text-foreground / bg-surface /
// text-muted-foreground / …) and the type ramp through named @theme tokens
// (text-page-title-* / text-badge-* / tracking-kicker / …), so arbitrary
// bracket values for COLOR and TYPE are banned outside the carve-outs:
//   - the vendored shadcn primitives (**/components/ui/**, **/src/ui/** —
//     already outside the RAW_JSX layers),
//   - packages/sdk-ui (the shared components own the raw values BEHIND the
//     named tokens),
//   - test files (they assert class strings),
//   - the shrink-only TYPE_ARBITRARY_MIGRATION_ALLOWLIST below.
// LAYOUT arbitraries (w-[…], gap-[…], calc()) stay legitimate and ungated:
// a warn lane cannot ride no-restricted-syntax next to these error selectors
// (one severity per file-set) and a custom rule id would not be counted by
// the ui-design-system-gate's GATED set.
// Each ban matches bare string Literals (cva()/cn() module-level class lists
// included) AND TemplateElement chunks, so template-literal classNames and
// .ts HTML-string builders (e.g. the chat markdown renderer) are covered
// too. Only interpolated VALUES escape (`text-[${size}px]` still trips on
// the `text-[` chunk).
const TYPE_BAN_SPECS = [
  {
    // `(color:)?` — Tailwind's type-hint prefix must not become a bypass
    // (`bg-[color:#fff]` is as arbitrary as `bg-[#fff]`).
    pattern:
      "(^|[^a-zA-Z0-9_-])(text|bg|border|ring|outline|fill|stroke|caret|divide|decoration|accent|from|via|to)-\\[(color:)?(#|(rgb|rgba|hsl|hsla|oklch|oklab|hwb|lab|lch|color)\\()",
    message:
      "Arbitrary color value in a class string — use the semantic color tokens (text-foreground, bg-surface, text-muted-foreground, border-line, …) from @cinatra-ai/design.",
  },
  {
    // `([a-zA-Z0-9-]*(\[[^\]]*\])?:)*` — any chain of further variants
    // (hover:, focus-visible:, data-[state=open]:, [&>svg]:) between
    // `dark:` and the color utility, so variant stacking is not a bypass.
    pattern:
      "(^|[^a-zA-Z0-9_-])dark:([a-zA-Z0-9-]*(\\[[^\\]]*\\])?:)*(text|bg|border|ring|fill|stroke|divide|outline|decoration|accent)-",
    message:
      "Manual dark: color override — the semantic tokens adapt to dark mode through the cascade; style with the token utilities instead of per-theme colors.",
  },
  {
    // `text-[length:inherit]` stays allowed (inherit is not an arbitrary
    // value — it defers to the cascade); every OTHER `text-[…]`, including
    // an explicit `text-[length:12px]`, is banned so `length:` cannot be
    // used as a bypass prefix.
    pattern: "(^|[^a-zA-Z0-9_-])text-\\[(?!length:inherit\\])",
    message:
      "Arbitrary text-[…] font size — use the named type-scale tokens (text-page-title-{sm,md,lg}, text-listing-title, text-badge-xs, text-badge-2xs) or the standard Tailwind sizes. See cinatra#886 for the migration of pre-existing sites.",
  },
  {
    pattern: "(^|[^a-zA-Z0-9_-])tracking-\\[",
    message:
      "Arbitrary tracking-[…] letter-spacing — use the named tracking tokens (tracking-title-tight, tracking-kicker, tracking-kicker-wide, tracking-page-label). See cinatra#886 for the migration of pre-existing sites.",
  },
];
const TYPE_BANS = TYPE_BAN_SPECS.flatMap(({ pattern, message }) => [
  { selector: `Literal[value=/${pattern}/]`, message },
  { selector: `TemplateElement[value.raw=/${pattern}/]`, message },
]);

// Shrink-only allowlist (cinatra#886): files that still carry PRE-EXISTING
// arbitrary type values. They keep every other JSX-layer ban but skip
// TYPE_BANS until migrated — migration is tracked in cinatra#886 (it needs
// the app-cn tailwind-merge extension, which needs the vendored-primitive
// re-vendor cascade, plus per-site normalization decisions). NEVER add a
// file here for new code — migrate to the named tokens instead.
const TYPE_ARBITRARY_MIGRATION_ALLOWLIST = [
  "src/app/configuration/workspace/page.tsx",
  "src/app/configuration/workspace/members/page.tsx",
  "src/app/configuration/permissions/page.tsx",
  "src/app/configuration/approvals/page.tsx",
  "src/app/design-fixtures/primitive-row.tsx",
  "src/app/design-fixtures/token-swatches.tsx",
  "src/app/design-fixtures/sidebar-fixture.tsx",
  "src/app/notifications/notifications-archive-body.tsx",
  "src/components/marketplace-readme-section.tsx",
  "src/components/list-controls.tsx",
  "src/components/scope-badge.tsx",
  "src/components/app-sidebar.tsx",
  "src/components/extension-card.tsx",
  "src/components/marketplace-detail-header.tsx",
  "src/components/visibility-badge.tsx",
  "src/components/workflows/workflow-task-detail.tsx",
  "src/components/workflows/workflow-editable-title.tsx",
  "src/components/workflows/workflow-task-list.tsx",
  "src/components/workflows/workflow-target-date-control.tsx",
  "src/components/workflows/workflow-audit-log.tsx",
  "src/components/extensions/extensions-tab-select.tsx",
  "src/components/extensions/install-batch-panel.tsx",
  "packages/chat/src/chat-page.tsx",
  "packages/mcp-server/src/index.tsx",
  "packages/agents/src/campaign-recipients-review-renderer.tsx",
  "packages/agents/src/import-skill-from-github-form.tsx",
  "packages/permissions/src/user-impersonation-panel.tsx",
  "packages/permissions/src/impersonation-banner.tsx",
  "packages/extensions/src/screens/extension-resolution-panel.tsx",
  "packages/permissions/src/pages.tsx",
  "packages/metric-cost-api/src/components/legacy-cost-list.tsx",
  "packages/notifications/src/notifications-flyout.tsx",
  // .ts template-literal HTML builder (chat markdown renderer): text-[0.8rem]
  // code blocks + tracking-[0.1em] table headers — normalization decisions
  // tracked in cinatra#886 like the JSX sites above.
  "packages/chat/src/markdown-render.ts",
];

// AND a path-zone glob with an extension glob. ESLint flat config treats a
// nested array inside `files` as a logical AND (every pattern must match), so
// `[zoneGlob, extGlob]` matches files in the zone with that extension only —
// keeping the non-JSX dynamic blocks and the JSX raw-JSX blocks on disjoint
// file sets (one `no-restricted-syntax` severity per file).
//
// Each carve-out zone is split into its non-JSX and JSX halves whose UNION is
// EXACTLY the extension surface of that zone's same-named static import layer
// — so a dynamic carve-out never re-allows a banned module on an extension the
// static layer still bans (and vice-versa). The everywhere (Layer 1) blocks
// keep the full non-JSX/JSX split (its static twin spans the whole JS family).
const andExt = (globs, ext) => globs.map((glob) => [glob, ext]);
// Layer 1 (everywhere) — full JS family, matching static Layer 1
// (`**/*.{js,jsx,cjs,mjs,ts,tsx,cts,mts}`).
const L1_NON_JSX_EXT = "**/*.{js,cjs,mjs,ts,cts,mts}";
const JSX_EXT = "**/*.{jsx,tsx}";
const andNonJsx = (globs) => andExt(globs, L1_NON_JSX_EXT);
const andJsx = (globs) => andExt(globs, JSX_EXT);
// Carve-out static twins use narrower extension lists — mirror them exactly:
//   Layer 2 / Layer 3 static: `{ts,tsx}`            → non-JSX `{ts}`
//   Layer 4 / Layer 5 / 5b static: `{js,jsx,ts,tsx}` → non-JSX `{js,ts}`
const TS_NON_JSX_EXT = "**/*.ts";
const JS_TS_NON_JSX_EXT = "**/*.{js,ts}";

// Per-zone dynamic-ban sets — each mirrors the same-named import layer's
// pattern set (so the carve-outs line up exactly).
// Layer 1 (everywhere) / Layer 5b shares Layer-2's set.
const DYNAMIC_BANS_L1 = dynamicBansFor(
  MCP_BAN,
  CLIENT_BAN,
  DRIZZLE_CUBE_BAN,
  RADIX_BAN,
  UI_LIB_BAN,
  GRID_LAYOUT_BAN,
);
// Layer 2 (sdk-dashboard, excluding adapter): + sdk-dashboard boundary.
const DYNAMIC_BANS_L2 = dynamicBansFor(
  MCP_BAN,
  CLIENT_BAN,
  DRIZZLE_CUBE_BAN,
  RADIX_BAN,
  UI_LIB_BAN,
  GRID_LAYOUT_BAN,
  SDK_DASHBOARD_BAN,
);
// Layer 3 (sdk-dashboard adapter): re-allow drizzle server + /mcp dynamically.
const DYNAMIC_BANS_L3 = dynamicBansFor(
  CLIENT_BAN,
  RADIX_BAN,
  UI_LIB_BAN,
  GRID_LAYOUT_BAN,
  SDK_DASHBOARD_BAN,
);
// Layer 4 (packages/dashboards/src/components): re-allow drizzle-cube/client +
// react-grid-layout dynamically; Radix + UI-lib bans stay.
const DYNAMIC_BANS_L4 = dynamicBansFor(
  MCP_BAN,
  DRIZZLE_CUBE_NON_CLIENT_BAN,
  RADIX_BAN,
  UI_LIB_BAN,
);
// Layer 4b (dc-modal-a11y-scope.tsx): also re-allow Radix dynamically.
const DYNAMIC_BANS_L4B = dynamicBansFor(
  MCP_BAN,
  DRIZZLE_CUBE_NON_CLIENT_BAN,
  UI_LIB_BAN,
);
// Layer 5 (vendored shadcn primitives): re-allow Radix dynamically.
const DYNAMIC_BANS_L5 = dynamicBansFor(
  MCP_BAN,
  CLIENT_BAN,
  DRIZZLE_CUBE_BAN,
  UI_LIB_BAN,
  GRID_LAYOUT_BAN,
);
// Layer 5b (shadcn primitives inside sdk-dashboard): + sdk-dashboard boundary.
const DYNAMIC_BANS_L5B = dynamicBansFor(
  MCP_BAN,
  CLIENT_BAN,
  DRIZZLE_CUBE_BAN,
  UI_LIB_BAN,
  GRID_LAYOUT_BAN,
  SDK_DASHBOARD_BAN,
);

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

  // ───── Block C: dynamic-loader bans on NON-JSX sources (error) ─────
  // Mirrors the import layers above (everywhere → sdk-dashboard → adapter →
  // dashboards-components → dc-modal → shadcn-primitives → sdk-dashboard
  // primitives, last match wins) for `import()` / `require()` of the same
  // banned groups. Scoped to NON-JSX extensions so these never collide with
  // the JSX raw-JSX+dynamic blocks below on a single `no-restricted-syntax`
  // severity. Extension scope of each block matches its import-layer twin.
  //
  // Non-JSX Layer 1 (everywhere). TYPE_BANS ride here too (cinatra#803):
  // class strings are also built in .ts (template-literal HTML builders,
  // shared cva()/cn() modules), and those must not become the bypass lane
  // around the JSX-layer bans. Carve-outs (sdk-ui, tests, extensions, the
  // migration allowlist, this config file) are restated after the JSX
  // layers below.
  {
    files: ["**/*.{js,cjs,mjs,ts,cts,mts}"],
    rules: {
      "no-restricted-syntax": ["error", ...TYPE_BANS, ...DYNAMIC_BANS_L1],
    },
  },
  // Non-JSX Layer 2 (sdk-dashboard, excluding the adapter). Static twin is
  // `{ts,tsx}`, so the non-JSX half is `.ts` only (not .cts/.mts) — the
  // carve-out must not re-scope an extension the static layer never reached.
  {
    files: andExt(["packages/sdk-dashboard/src/**"], TS_NON_JSX_EXT),
    ignores: ["packages/sdk-dashboard/src/adapters/drizzle-cube/**/*.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...TYPE_BANS, ...DYNAMIC_BANS_L2],
    },
  },
  // Non-JSX Layer 3 (sdk-dashboard adapter): drizzle server + /mcp re-allowed.
  // Static twin `{ts,tsx}` → non-JSX `.ts`.
  {
    files: andExt(
      ["packages/sdk-dashboard/src/adapters/drizzle-cube/**"],
      TS_NON_JSX_EXT,
    ),
    rules: {
      "no-restricted-syntax": ["error", ...TYPE_BANS, ...DYNAMIC_BANS_L3],
    },
  },
  // Non-JSX Layer 4 (packages/dashboards/src/components):
  // drizzle-cube/client + react-grid-layout re-allowed. Static twin
  // `{js,jsx,ts,tsx}` → non-JSX `{js,ts}`.
  {
    files: andExt(["packages/dashboards/src/components/**"], JS_TS_NON_JSX_EXT),
    rules: {
      "no-restricted-syntax": ["error", ...TYPE_BANS, ...DYNAMIC_BANS_L4],
    },
  },
  // Non-JSX Layer 5 (vendored shadcn primitives): Radix re-allowed. Static
  // twin `{js,jsx,ts,tsx}` → non-JSX `{js,ts}`.
  // (Layer 4b and the single-file dc-modal carve-out are .tsx-only, so they
  // have no non-JSX twin; their dynamic coverage lives in the JSX blocks.)
  {
    files: andExt(
      ["**/components/ui/**", "**/src/ui/**"],
      JS_TS_NON_JSX_EXT,
    ),
    rules: {
      "no-restricted-syntax": ["error", ...DYNAMIC_BANS_L5],
    },
  },
  // Non-JSX Layer 5b (shadcn primitives inside sdk-dashboard): +sdk-dashboard.
  // Static twin `{js,jsx,ts,tsx}` → non-JSX `{js,ts}`.
  {
    files: andExt(
      [
        "packages/sdk-dashboard/src/**/components/ui/**",
        "packages/sdk-dashboard/src/ui/**",
      ],
      JS_TS_NON_JSX_EXT,
    ),
    rules: {
      "no-restricted-syntax": ["error", ...DYNAMIC_BANS_L5B],
    },
  },

  // ───── Block B + Block C on JSX sources (error) ─────
  // Raw control elements must go through the shadcn wrappers AND dynamic
  // `import()` / `require()` of a banned module is forbidden. Both share the
  // single `no-restricted-syntax` rule, so on JSX files the raw-JSX selectors
  // and the dynamic-loader selectors are combined per zone. Layered to mirror
  // the import layers (last match wins). The ui carve-outs (Layer 5 / 5b) omit
  // the raw-JSX selectors — the vendored primitives render the raw elements.
  //
  // JSX Layer 1 (everywhere, outside the shadcn primitives). ERROR now that
  // the tree is clean — any net-new raw restricted element OR dynamic banned
  // import fails the ui-design-system-gate.
  {
    files: ["**/*.{jsx,tsx}"],
    ignores: ["**/components/ui/**", "**/src/ui/**"],
    rules: {
      "no-restricted-syntax": ["error", ...RAW_JSX_RESTRICTIONS, ...TYPE_BANS, ...DYNAMIC_BANS_L1],
    },
  },
  // JSX Layer 2 (sdk-dashboard, excluding the adapter): +sdk-dashboard bans.
  {
    files: ["packages/sdk-dashboard/src/**/*.tsx"],
    ignores: [
      "packages/sdk-dashboard/src/adapters/drizzle-cube/**/*.tsx",
      "**/components/ui/**",
      "**/src/ui/**",
    ],
    rules: {
      "no-restricted-syntax": ["error", ...RAW_JSX_RESTRICTIONS, ...TYPE_BANS, ...DYNAMIC_BANS_L2],
    },
  },
  // JSX Layer 3 (sdk-dashboard adapter): drizzle server + /mcp re-allowed.
  {
    files: ["packages/sdk-dashboard/src/adapters/drizzle-cube/**/*.tsx"],
    ignores: ["**/components/ui/**", "**/src/ui/**"],
    rules: {
      "no-restricted-syntax": ["error", ...RAW_JSX_RESTRICTIONS, ...TYPE_BANS, ...DYNAMIC_BANS_L3],
    },
  },
  // JSX Layer 4 (packages/dashboards/src/components):
  // drizzle-cube/client + react-grid-layout re-allowed.
  {
    files: andJsx(["packages/dashboards/src/components/**"]),
    ignores: ["**/components/ui/**", "**/src/ui/**"],
    rules: {
      "no-restricted-syntax": ["error", ...RAW_JSX_RESTRICTIONS, ...TYPE_BANS, ...DYNAMIC_BANS_L4],
    },
  },
  // JSX Layer 4b (dc-modal-a11y-scope.tsx): also re-allow Radix dynamically.
  {
    files: ["packages/dashboards/src/components/dc-modal-a11y-scope.tsx"],
    rules: {
      "no-restricted-syntax": ["error", ...RAW_JSX_RESTRICTIONS, ...TYPE_BANS, ...DYNAMIC_BANS_L4B],
    },
  },
  // JSX Layer 5 (vendored shadcn primitives): dynamic-loader bans only — no
  // raw-JSX selectors (the wrappers render the raw elements); Radix re-allowed.
  // Declared after the everywhere/dashboards JSX layers so a ui/ dir wins.
  {
    files: andJsx(["**/components/ui/**", "**/src/ui/**"]),
    rules: {
      "no-restricted-syntax": ["error", ...DYNAMIC_BANS_L5],
    },
  },
  // JSX Layer 5b (shadcn primitives inside sdk-dashboard): +sdk-dashboard.
  {
    files: andJsx([
      "packages/sdk-dashboard/src/**/components/ui/**",
      "packages/sdk-dashboard/src/ui/**",
    ]),
    rules: {
      "no-restricted-syntax": ["error", ...DYNAMIC_BANS_L5B],
    },
  },

  // ───── TYPE_BANS carve-outs (cinatra#803) — declared AFTER the JSX layers
  // so they win for their file sets; each restates its zone's full selector
  // set MINUS TYPE_BANS (one `no-restricted-syntax` severity per file-set).
  //
  // packages/sdk-ui: the issue-mandated allowlist — the shared components
  // own the raw values BEHIND the named tokens. The vendored-primitive dirs
  // (src/ui) stay on JSX Layer 5 (raw elements allowed there), so they are
  // excluded here exactly like in the base JSX layers.
  {
    files: ["packages/sdk-ui/src/**/*.{jsx,tsx}"],
    ignores: ["**/components/ui/**", "**/src/ui/**"],
    rules: {
      "no-restricted-syntax": ["error", ...RAW_JSX_RESTRICTIONS, ...DYNAMIC_BANS_L1],
    },
  },
  // Test files assert class strings (including regex literals that stringify
  // into the banned shapes). L1-zone tests:
  {
    files: [["**/__tests__/**", JSX_EXT], "**/*.test.{jsx,tsx}"],
    ignores: [
      "**/components/ui/**",
      "**/src/ui/**",
      "packages/dashboards/src/components/**",
    ],
    rules: {
      "no-restricted-syntax": ["error", ...RAW_JSX_RESTRICTIONS, ...DYNAMIC_BANS_L1],
    },
  },
  // …and the dashboards-components zone keeps its L4 dynamic set:
  {
    files: [["packages/dashboards/src/components/**", "**/*.test.tsx"]],
    rules: {
      "no-restricted-syntax": ["error", ...RAW_JSX_RESTRICTIONS, ...DYNAMIC_BANS_L4],
    },
  },
  // extensions/**: first-party extension INTERNALS are not gated on the
  // arbitrary-type ramp (the issue gates repo-owned code; extension
  // normalization lands with their sdk-ui adoption). The ui-glob ignores
  // keep the vendored-primitive dirs on JSX Layer 5.
  {
    files: [["extensions/**", JSX_EXT]],
    ignores: ["**/components/ui/**", "**/src/ui/**"],
    rules: {
      "no-restricted-syntax": ["error", ...RAW_JSX_RESTRICTIONS, ...DYNAMIC_BANS_L1],
    },
  },
  // Shrink-only migration allowlist — see TYPE_ARBITRARY_MIGRATION_ALLOWLIST
  // above (all entries are L1-zone files — .tsx and the one .ts HTML
  // builder, where the raw-JSX selectors simply never match; tracked in
  // cinatra#886).
  {
    files: TYPE_ARBITRARY_MIGRATION_ALLOWLIST,
    rules: {
      "no-restricted-syntax": ["error", ...RAW_JSX_RESTRICTIONS, ...DYNAMIC_BANS_L1],
    },
  },

  // Non-JSX twins of the carve-outs above (the TYPE_BANS also ride the
  // non-JSX layers): sdk-ui, tests, extensions, and this config file itself
  // (its ban messages and selector sources spell out the banned shapes).
  // Each keeps its zone's dynamic-loader set, exactly like the JSX twins.
  {
    files: andExt(["packages/sdk-ui/src/**"], L1_NON_JSX_EXT),
    ignores: ["**/components/ui/**", "**/src/ui/**"],
    rules: {
      "no-restricted-syntax": ["error", ...DYNAMIC_BANS_L1],
    },
  },
  {
    files: [
      ["**/__tests__/**", L1_NON_JSX_EXT],
      "**/*.test.{js,cjs,mjs,ts,cts,mts}",
    ],
    ignores: [
      "**/components/ui/**",
      "**/src/ui/**",
      "packages/dashboards/src/components/**",
    ],
    rules: {
      "no-restricted-syntax": ["error", ...DYNAMIC_BANS_L1],
    },
  },
  // …and the dashboards-components zone tests keep their L4 dynamic set:
  {
    files: [["packages/dashboards/src/components/**", "**/*.test.{js,ts}"]],
    rules: {
      "no-restricted-syntax": ["error", ...DYNAMIC_BANS_L4],
    },
  },
  {
    files: [["extensions/**", L1_NON_JSX_EXT]],
    ignores: ["**/components/ui/**", "**/src/ui/**"],
    rules: {
      "no-restricted-syntax": ["error", ...DYNAMIC_BANS_L1],
    },
  },
  {
    files: ["eslint.config.mjs"],
    rules: {
      "no-restricted-syntax": ["error", ...DYNAMIC_BANS_L1],
    },
  },

  // ───── First-party extension import boundary (cinatra#803) ─────
  // Restates the zone's import-ban set (flat config: last match WINS the
  // whole rule entry) and adds the `@/*` app-alias ban. Static imports only
  // (see APP_ALIAS_BAN docblock).
  {
    files: ["extensions/**/*.{js,jsx,cjs,mjs,ts,tsx,cts,mts}"],
    ignores: [
      "**/components/ui/**",
      "**/src/ui/**",
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
            ...APP_ALIAS_BAN,
          ],
        },
      ],
    },
  },
  // Vendored-primitive dirs inside extensions keep the Layer-5 Radix
  // allowance, plus the `@/*` ban (their imports must stay relative).
  {
    files: [
      "extensions/**/components/ui/**/*.{js,jsx,ts,tsx}",
      "extensions/**/src/ui/**/*.{js,jsx,ts,tsx}",
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
            ...APP_ALIAS_BAN,
          ],
        },
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

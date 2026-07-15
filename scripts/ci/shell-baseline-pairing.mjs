#!/usr/bin/env node
// Shell-surface / pixel-baseline PAIRING heuristic (#1600).
//
// WHY: a PR that changes the pixel-rendered SHELL chrome without refreshing the
// committed /design-fixtures baselines in the SAME diff opens a SILENT DRIFT
// WINDOW. The render changed, but nothing pixel-diffed it, so the delta only
// surfaces at the next unrelated baseline regeneration as a confusing "new"
// diff. Proven instance: #1284 re-anchored the topbar (owner-directed,
// spec-conformant); the committed baselines were last regenerated pre-#1284;
// nothing diffed them for four days until the #1582-era regeneration (#1595)
// surfaced the delta, costing a full misattribution investigation.
//
// WHAT: this module is the SINGLE SOURCE OF TRUTH for which paths count as a
// pixel-rendered shell surface (Acceptance Criterion 3). The companion warn
// workflow (.github/workflows/shell-baseline-pairing.yml) consumes
// evaluatePairing() and posts a NON-BLOCKING warning comment — it NEVER fails
// the job and is NOT a required check. This is a warn, not a block.
//
// The heuristic is intentionally coarse (path-based, not render-graph-aware):
// it accepts an occasional benign warn on a shell-file change that cannot move
// pixels (pure prop-plumbing) in exchange for closing the drift window at the
// PR that opens it. It never blocks, so a benign warn costs nothing.

import fs from "node:fs";

// The committed pixel baselines live here (design-fixtures-{light,dark}.png).
// A change to a *.png under this dir counts as a paired baseline refresh — the
// .png suffix keeps a stray non-image file (e.g. a README) under the dir from
// silently suppressing a warning. (A png DELETION still reads as "png touched";
// pairing a shell change with a baseline deletion is a deliberate, rare act and
// left as an accepted edge — this is a warn, not a block.)
export const BASELINE_DIR = "tests/e2e/design/__screenshots__/";

// The documented refresh command (mirrors design-visual-verify.yml's header).
export const REFRESH_COMMAND = "pnpm test:e2e:design:update";

const FIXTURES_DIR = "src/app/design-fixtures/";

// SHELL SURFACES — the pixel-rendered app chrome that appears in the committed
// /design-fixtures INDEX baselines (the only route with a committed pixel
// baseline; the /design-fixtures/* SUB-ROUTES are functional-only, no PNG).
//
// MEMBERSHIP RULE: a path belongs here iff a change to it can alter the
// rendered pixels of the /design-fixtures index page. Keep the list minimal and
// precise — every entry that can't actually move those pixels is a latent
// false positive. To add a surface, add a rule here (and only here); the
// workflow re-lists nothing.
export const SHELL_SURFACES = [
  {
    id: "app-shell",
    doc: "src/components/app-shell.tsx — top-level chrome/topbar (the #1284 re-anchor surface)",
    test: (p) => p === "src/components/app-shell.tsx",
  },
  {
    id: "app-sidebar",
    doc: "src/components/app-sidebar.tsx — the app sidebar composed into the shell",
    test: (p) => p === "src/components/app-sidebar.tsx",
  },
  {
    id: "ui-sidebar",
    doc: "src/components/ui/sidebar.tsx — the sidebar primitive both of the above build on",
    test: (p) => p === "src/components/ui/sidebar.tsx",
  },
  {
    id: "globals-css",
    doc: "src/app/globals.css — global tokens/utilities that restyle the chrome",
    test: (p) => p === "src/app/globals.css",
  },
  {
    // Top-level RENDERABLE files directly under src/app/design-fixtures/ ONLY:
    // the baselined index page.tsx plus the fixture modules it composes
    // (primitive-row, token-swatches, sidebar-fixture, fixtures-core, …).
    // GUARDRAILS:
    //  - recursive sub-routes are EXCLUDED — conformance/, header-rule/,
    //    extension-settings/, marketplace-detail-modal/, agents-card/,
    //    access-picker/ render on SEPARATE pages with NO committed pixel
    //    baseline, so matching them would false-fire (the `!includes("/")`).
    //  - only renderable source extensions count (.tsx/.ts/.jsx/.js/.css); a
    //    top-level non-rendering file (a README.md, a .json, a .snap) can't move
    //    the pixels, so it must not warn.
    //  - test/spec files are excluded (they change no render).
    id: "design-fixtures-index",
    doc: "src/app/design-fixtures/<top-level renderable> — the baselined index page + its fixture modules (sub-routes, non-source & tests excluded)",
    test: (p) =>
      p.startsWith(FIXTURES_DIR) &&
      !p.slice(FIXTURES_DIR.length).includes("/") &&
      /\.(tsx|ts|jsx|js|css)$/.test(p) &&
      !/\.(test|spec)\.[jt]sx?$/.test(p),
  },
];

// Normalize a changed-file path to repo-root-relative POSIX form: strip a
// leading "./" or "/", collapse backslashes, trim. Blank/comment lines drop.
export function normalizePath(raw) {
  if (typeof raw !== "string") return "";
  let p = raw.trim();
  if (!p || p.startsWith("#")) return "";
  p = p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  return p;
}

export function isShellSurface(file) {
  return SHELL_SURFACES.some((s) => s.test(file));
}

export function isBaseline(file) {
  return file.startsWith(BASELINE_DIR) && file.endsWith(".png");
}

// Core pairing decision. Pure — the whole heuristic is testable from here.
//
//   warn  ⇔  at least one shell surface changed  AND  no baseline changed.
//
// Neither class changed → not warn (the workflow's path filter usually skips
// these entirely). Both classes changed → not warn (the baseline was refreshed
// in the same diff, exactly as desired).
export function evaluatePairing(changedFiles) {
  const files = [
    ...new Set((changedFiles || []).map(normalizePath).filter(Boolean)),
  ];
  const shellFiles = files.filter(isShellSurface);
  const baselineFiles = files.filter(isBaseline);
  const warn = shellFiles.length > 0 && baselineFiles.length === 0;
  return { warn, shellFiles, baselineFiles };
}

// Sticky-comment marker: the workflow greps PR comments for this to update the
// single warning comment in place (never spam a new one per push) and to flip
// it to "resolved" once a baseline lands.
export const COMMENT_MARKER = "<!-- shell-baseline-pairing:#1600 -->";

export function warningBody(shellFiles) {
  const list = shellFiles.map((f) => `- \`${f}\``).join("\n");
  return `### :warning: Shell-surface change without a paired pixel-baseline refresh

This PR changes pixel-rendered **shell chrome** but does **not** refresh the committed \`/design-fixtures\` baselines in the same diff:

${list}

That opens a *silent drift window*: the rendered chrome changed, but nothing pixel-diffed it, so the delta will only surface at the next unrelated baseline regeneration as a confusing "new" diff (the #1284 → #1595 misattribution class).

**If this change is visually intentional**, refresh the baselines in THIS PR:

\`\`\`
${REFRESH_COMMAND}
\`\`\`

then commit the updated PNGs under \`${BASELINE_DIR}\`.

**If it genuinely can't move those pixels** (pure logic / prop-plumbing), this warning is safe to ignore — it does **not** block merge.

${COMMENT_MARKER}`;
}

export function resolvedBody() {
  return `### :white_check_mark: Shell-surface / pixel-baseline pairing resolved

A \`${BASELINE_DIR}\` refresh is now present in this diff (or the shell-surface change was reverted), so the silent-drift warning no longer applies.

${COMMENT_MARKER}`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function readFilesFrom(pathArg) {
  // Fail-open: a missing/unreadable list (e.g. the upstream `gh api` step
  // could not reach GitHub) is treated as an empty diff → no warning, never a
  // crash. This is an advisory, not a gate.
  let raw;
  try {
    raw = fs.readFileSync(pathArg, "utf8");
  } catch {
    return [];
  }
  return raw.split(/\r?\n/);
}

function ghOutput(key, value) {
  const out = process.env.GITHUB_OUTPUT;
  if (!out) return;
  if (value.includes("\n")) {
    const delim = `__EOF_${key}_${Math.random().toString(36).slice(2)}__`;
    fs.appendFileSync(out, `${key}<<${delim}\n${value}\n${delim}\n`);
  } else {
    fs.appendFileSync(out, `${key}=${value}\n`);
  }
}

function stepSummary(md) {
  const s = process.env.GITHUB_STEP_SUMMARY;
  if (s) fs.appendFileSync(s, md + "\n");
}

// Built-in fixture assertions — the "dry-run" the workflow itself runs on every
// invocation (before touching the live PR), plus the vitest suite. Returns the
// number of failures.
const SELF_TEST_CASES = [
  { name: "shell-only (app-shell) → warn", files: ["src/components/app-shell.tsx"], warn: true },
  { name: "shell + baseline → no warn", files: ["src/components/app-shell.tsx", "tests/e2e/design/__screenshots__/design-fixtures-light.png"], warn: false },
  { name: "baseline only → no warn", files: ["tests/e2e/design/__screenshots__/design-fixtures-dark.png"], warn: false },
  { name: "neither surface class → no warn", files: ["src/lib/foo.ts", "README.md"], warn: false },
  { name: "empty diff → no warn", files: [], warn: false },
  { name: "globals.css alone → warn", files: ["src/app/globals.css"], warn: true },
  { name: "ui/sidebar + baseline → no warn", files: ["src/components/ui/sidebar.tsx", "tests/e2e/design/__screenshots__/design-fixtures-light.png"], warn: false },
  { name: "top-level fixture module alone → warn", files: ["src/app/design-fixtures/sidebar-fixture.tsx"], warn: true },
  { name: "fixtures index page alone → warn", files: ["src/app/design-fixtures/page.tsx"], warn: true },
  { name: "fixtures SUB-ROUTE (conformance) → no warn (excluded)", files: ["src/app/design-fixtures/conformance/page.tsx"], warn: false },
  { name: "fixtures SUB-ROUTE (header-rule) → no warn (excluded)", files: ["src/app/design-fixtures/header-rule/page.tsx"], warn: false },
  { name: "top-level fixture TEST file → no warn (excluded)", files: ["src/app/design-fixtures/thing.test.tsx"], warn: false },
  { name: "top-level fixture NON-RENDER file (.md) → no warn (excluded)", files: ["src/app/design-fixtures/README.md"], warn: false },
  { name: "shell + NON-png under baseline dir → warn (png suffix required)", files: ["src/app/globals.css", "tests/e2e/design/__screenshots__/README.md"], warn: true },
  { name: "shell + real .png baseline → no warn", files: ["src/app/globals.css", "tests/e2e/design/__screenshots__/design-fixtures-dark.png"], warn: false },
  { name: "multiple shell, no baseline → warn (all listed)", files: ["src/components/app-shell.tsx", "src/components/app-sidebar.tsx", "src/app/globals.css"], warn: true, shellCount: 3 },
  { name: "leading ./ is normalized", files: ["./src/components/app-shell.tsx"], warn: true },
  { name: "duplicate path counted once", files: ["src/app/globals.css", "src/app/globals.css"], warn: true, shellCount: 1 },
];

function runSelfTest() {
  let failures = 0;
  for (const c of SELF_TEST_CASES) {
    const r = evaluatePairing(c.files);
    const okWarn = r.warn === c.warn;
    const okCount = c.shellCount === undefined || r.shellFiles.length === c.shellCount;
    if (okWarn && okCount) {
      console.log(`  ok   ${c.name}`);
    } else {
      failures++;
      console.error(
        `  FAIL ${c.name} — expected warn=${c.warn}` +
          (c.shellCount !== undefined ? `, shellCount=${c.shellCount}` : "") +
          `; got warn=${r.warn}, shellCount=${r.shellFiles.length}`,
      );
    }
  }
  console.log(`\nself-test: ${SELF_TEST_CASES.length - failures}/${SELF_TEST_CASES.length} passed`);
  return failures;
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--self-test") args.selfTest = true;
    else if (a === "--files-from") args.filesFrom = argv[++i];
    else if (a === "--body-out") args.bodyOut = argv[++i];
    else if (a === "--resolved-out") args.resolvedOut = argv[++i];
    else args._.push(a);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.selfTest) {
    const failures = runSelfTest();
    process.exit(failures === 0 ? 0 : 1);
  }

  let changed = [];
  if (args.filesFrom) changed = readFilesFrom(args.filesFrom);
  else if (args._.length) changed = args._;

  const { warn, shellFiles } = evaluatePairing(changed);

  // Emit the copy the workflow will publish (warning body always written so the
  // gh step can read it; resolved body written for the "flip to resolved" path).
  if (args.bodyOut) fs.writeFileSync(args.bodyOut, warningBody(shellFiles));
  if (args.resolvedOut) fs.writeFileSync(args.resolvedOut, resolvedBody());

  ghOutput("warn", warn ? "true" : "false");
  ghOutput("shell_count", String(shellFiles.length));
  ghOutput("marker", COMMENT_MARKER);

  if (warn) {
    console.log(
      `::warning::Shell-surface change without a paired pixel-baseline refresh — see the PR comment (run \`${REFRESH_COMMAND}\` if this is a visual change). Non-blocking.`,
    );
    stepSummary(warningBody(shellFiles));
    console.log(`shell surfaces touched (${shellFiles.length}):`);
    for (const f of shellFiles) console.log(`  - ${f}`);
  } else {
    stepSummary(
      `### shell-baseline-pairing\n\nNo unpaired shell-surface change detected in this diff. :white_check_mark:\n`,
    );
    console.log("no unpaired shell-surface change detected — no warning.");
  }

  // Detection is never itself a failure — this is a warn, not a block.
  process.exit(0);
}

// Run only when invoked directly (imported by the vitest suite otherwise).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

#!/usr/bin/env node
// Toolbar design-system gate (design-system.html §Toolbar / §Nested toolbar,
// cinatra#54).
//
// Three checks, all against the working tree:
//
//   1. TOKEN DRIFT — the toolbar ground tokens must carry the spec values in
//      the light theme blocks (`:root` and `.cinatra`) of BOTH token homes
//      (src/app/globals.css and packages/design/src/tokens.css):
//        --toolbar:    #dcddd5   (primary ground)
//        --toolbar-l2: #e3e4dc   (child level 2, ~6L lighter)
//        --toolbar-l3: #e9eae2   (child level 3, ~6L lighter again)
//      The dark blocks intentionally diverge (children step toward the dark
//      page background) and are not value-pinned here.
//
//   2. NON-CANONICAL TOOLBARS — product JSX may not hand-roll a toolbar:
//      `role="toolbar"` belongs to the canonical primitives in
//      src/components/ui/toolbar.tsx. Any other occurrence in src/** or
//      packages/**/src/** fails unless the file is in
//      NONCANONICAL_TOOLBAR_ALLOWLIST (the documented escape hatch for
//      third-party DOM that genuinely cannot mount <Toolbar>). Test files
//      are skipped (test markup is not product DOM).
//
//   3. GROUND-HEX LEAKS — the spec hexes may not be re-hardcoded outside the
//      two token files; consumers must go through var(--toolbar*) /
//      bg-toolbar* so a future retune stays a two-file change. Scope is
//      src/** and packages/**/src/** (committed snapshots/baselines under
//      scripts/ legitimately embed token VALUES and are out of scope).
//
//   4. THE TYPE ALLOW LIST MAY NOT GROW (cinatra#3832) — the lint rule's allow
//      list for arbitrary type values (TYPE_BANS in eslint.config.mjs) lives in
//      scripts/audit/type-arbitrary-allowlist.baseline.json, which
//      eslint.config.mjs reads. Its `files` are compared with the copy on the
//      base branch (scripts/audit/lib/floor-base-guard.mjs): a file on the head
//      that the base does not hold fails the run, naming it; a removal passes.
//      A base from before the list moved out of eslint.config.mjs is read from
//      the array TYPE_ARBITRARY_MIGRATION_ALLOWLIST there. A base that cannot
//      be read fails closed with its reason; a run with no pull request and no
//      TYPE_ALLOWLIST_BASE (a push, a merge group, a local run) is not compared.
//      STATED LIMIT: the check reads only this list, so an exemption written on
//      purpose somewhere else in eslint.config.mjs (another `files` block) is
//      not caught here.
//
// Wired in CI by the step "Toolbar Design-System Gate" of the `gates` job in
// .github/workflows/gates.yml (full history; not paths-scoped: check 2 must see
// every PR).
//
// Exit codes:
//   0 — pass
//   1 — gate failure (findings reported file:line)
//   2 — unexpected internal error (token file missing, etc.)

import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { execFileSync, execSync } from "node:child_process";
import { resolve } from "node:path";
import { compareFloorWithBase, newKeys, reportFloorGuard } from "./lib/floor-base-guard.mjs";

// ---------------------------------------------------------------------------
// Contract

export const SPEC_TOOLBAR_TOKENS = Object.freeze({
  "--toolbar": "#dcddd5",
  "--toolbar-l2": "#e3e4dc",
  "--toolbar-l3": "#e9eae2",
});

// Both token homes; each must declare the spec values in BOTH light blocks.
export const TOKEN_FILES = Object.freeze({
  "src/app/globals.css": [":root", ".cinatra"],
  "packages/design/src/tokens.css": [":root", ".cinatra"],
});

export const CANONICAL_TOOLBAR_REL = "src/components/ui/toolbar.tsx";

// Files allowed to carry `role="toolbar"` outside the canonical component.
// Reserve for THIRD-PARTY DOM that cannot mount <Toolbar> (the dashboards
// drizzle-cube surfaces are currently restyled via scoped CSS-variable
// redefinition — see packages/dashboards/src/components/dashboard-theme.css —
// so no entry is needed today). Every entry needs a reason.
export const NONCANONICAL_TOOLBAR_ALLOWLIST = new Map([
  // ["path/from/repo/root.tsx", "reason"],
]);

// ---------------------------------------------------------------------------
// Shared helpers

// Strip `/* … */` and `// …` comments while preserving line numbers.
export function stripComments(source) {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    if (source[i] === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      for (let j = i; j < stop; j++) out += source[j] === "\n" ? "\n" : " ";
      i = stop;
      continue;
    }
    if (source[i] === "/" && source[i + 1] === "/") {
      while (i < n && source[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }
    out += source[i];
    i += 1;
  }
  return out;
}

// Extract `selector { body }` blocks for the flat top-level selectors used by
// the token files (same approach as scripts/design/snapshot-tokens.mjs: the
// selector must sit directly before `{`, anchored at start-of-rule so
// `.dark .cinatra { … }` never counts as the standalone `.cinatra` block).
export function extractBlocks(cssText, selectors) {
  const stripped = stripComments(cssText);
  const found = new Map();
  for (const selector of selectors) {
    const escaped = selector.replace(/[-[\]/{}()*+?.\\^$|]/g, "\\$&");
    const re = new RegExp(`(?:^|[};])\\s*${escaped}\\s*\\{([^}]*)\\}`, "g");
    let m;
    while ((m = re.exec(stripped)) !== null) {
      const body = found.get(selector) ?? [];
      body.push(m[1]);
      found.set(selector, body);
    }
  }
  return found;
}

// Check one token file's light blocks against the spec values.
export function checkTokenDrift(cssText, fileRel, lightSelectors) {
  const findings = [];
  const blocks = extractBlocks(cssText, lightSelectors);
  for (const selector of lightSelectors) {
    const bodies = blocks.get(selector);
    if (!bodies || bodies.length === 0) {
      findings.push({
        file: fileRel,
        token: "(block)",
        message: `missing \`${selector}\` block`,
      });
      continue;
    }
    const body = bodies.join("\n");
    for (const [token, expected] of Object.entries(SPEC_TOOLBAR_TOKENS)) {
      const re = new RegExp(
        `${token.replace(/[-[\]/{}()*+?.\\^$|]/g, "\\$&")}\\s*:\\s*([^;]+);`,
      );
      const m = re.exec(body);
      if (!m) {
        findings.push({
          file: fileRel,
          token,
          message: `\`${selector}\` does not declare ${token} (expected ${expected})`,
        });
        continue;
      }
      const actual = m[1].trim().toLowerCase();
      if (actual !== expected) {
        findings.push({
          file: fileRel,
          token,
          message: `\`${selector}\` declares ${token}: ${actual} (spec: ${expected})`,
        });
      }
    }
  }
  return findings;
}

// Scan source text for non-canonical `role="toolbar"`.
export function scanRoleToolbar(source, fileRel) {
  const findings = [];
  const stripped = stripComments(source);
  const lines = stripped.split("\n");
  const re = /role\s*=\s*["']toolbar["']/;
  lines.forEach((line, idx) => {
    if (re.test(line)) {
      findings.push({ file: fileRel, line: idx + 1, match: line.trim() });
    }
  });
  return findings;
}

// Scan source text for hardcoded spec ground hexes.
export function scanGroundHexes(source, fileRel) {
  const findings = [];
  const stripped = stripComments(source);
  const lines = stripped.split("\n");
  const hexes = Object.values(SPEC_TOOLBAR_TOKENS);
  lines.forEach((line, idx) => {
    const lower = line.toLowerCase();
    for (const hex of hexes) {
      if (lower.includes(hex)) {
        findings.push({ file: fileRel, line: idx + 1, match: hex });
      }
    }
  });
  return findings;
}

// ---------------------------------------------------------------------------
// The type allow list may not grow against the base (check 4)

export const TYPE_ALLOWLIST_REL = "scripts/audit/type-arbitrary-allowlist.baseline.json";

/** Where the list lived before it moved into its own file (read on an older base). */
export const TYPE_ALLOWLIST_FORMER_HOME = "eslint.config.mjs";

/** The variable a workflow may set to name the base revision. */
export const TYPE_ALLOWLIST_BASE_VAR = "TYPE_ALLOWLIST_BASE";

/**
 * The list's text -> its file paths. The data file (a JSON object): `files`
 * absent or `null` is the empty list; any other shape throws. The former home
 * (eslint.config.mjs): the string literals of the array
 * TYPE_ARBITRARY_MIGRATION_ALLOWLIST, comments skipped; no such array throws.
 */
export function parseTypeAllowlist(text) {
  if (text.trimStart().startsWith("{")) {
    const doc = JSON.parse(text);
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) throw new Error("not a list object");
    const files = doc.files ?? [];
    if (!Array.isArray(files) || files.some((f) => typeof f !== "string")) throw new Error("files is not a list of paths");
    return files;
  }
  const m = /const TYPE_ARBITRARY_MIGRATION_ALLOWLIST = \[([\s\S]*?)\];/.exec(text);
  if (!m) throw new Error(`no array TYPE_ARBITRARY_MIGRATION_ALLOWLIST in ${TYPE_ALLOWLIST_FORMER_HOME}`);
  const body = m[1].replace(/\/\/[^\n]*/g, "");
  return [...body.matchAll(/"([^"\n]+)"/g)].map((x) => x[1]);
}

/** The floor base guard for the type allow list (check 4). */
export function checkTypeAllowlistAgainstBase({ repoRoot, env = process.env }) {
  const gate = "toolbar-tokens";
  let headFloor;
  try {
    headFloor = parseTypeAllowlist(readFileSync(resolve(repoRoot, TYPE_ALLOWLIST_REL), "utf8"));
  } catch (err) {
    return {
      status: "malformed",
      ok: false,
      lines: [`[${gate}] FAIL — the floor ${TYPE_ALLOWLIST_REL} is not a readable list (${err?.message ?? err}). Failing closed.`],
    };
  }
  return compareFloorWithBase({
    gate,
    envVar: TYPE_ALLOWLIST_BASE_VAR,
    floorPath: TYPE_ALLOWLIST_REL,
    baseFallbackPath: TYPE_ALLOWLIST_FORMER_HOME,
    headFloor,
    parse: parseTypeAllowlist,
    grown: (base, head) => newKeys(base, head).map((f) => `files ${f}`),
    repoRoot,
    env,
  });
}

// ---------------------------------------------------------------------------
// CLI

function listTrackedFiles(repoRoot, patterns) {
  // execFileSync (argv, no shell) so pathspecs can never be re-interpreted
  // if this list ever becomes dynamic.
  const out = execFileSync("git", ["ls-files", "-z", "--", ...patterns], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split("\0").filter(Boolean);
}

const SCAN_EXTENSIONS = /\.(tsx|ts|jsx|js|css|scss)$/;
const TEST_PATH = /(^|\/)__tests__\/|\.test\.[tj]sx?$|\.spec\.[tj]sx?$/;

export async function runGate(repoRoot) {
  const findings = { drift: [], role: [], hex: [] };

  for (const [fileRel, lightSelectors] of Object.entries(TOKEN_FILES)) {
    const cssText = await readFile(resolve(repoRoot, fileRel), "utf8");
    findings.drift.push(...checkTokenDrift(cssText, fileRel, lightSelectors));
  }

  const candidates = listTrackedFiles(repoRoot, ["src", "packages"]).filter(
    (f) => SCAN_EXTENSIONS.test(f) && !TEST_PATH.test(f),
  );
  const tokenFiles = new Set(Object.keys(TOKEN_FILES));

  for (const fileRel of candidates) {
    const source = await readFile(resolve(repoRoot, fileRel), "utf8");
    if (
      /\.(tsx|jsx)$/.test(fileRel) &&
      fileRel !== CANONICAL_TOOLBAR_REL &&
      !NONCANONICAL_TOOLBAR_ALLOWLIST.has(fileRel)
    ) {
      findings.role.push(...scanRoleToolbar(source, fileRel));
    }
    if (!tokenFiles.has(fileRel)) {
      findings.hex.push(...scanGroundHexes(source, fileRel));
    }
  }

  return findings;
}

async function main() {
  const repoRoot = execSync("git rev-parse --show-toplevel", {
    encoding: "utf8",
  }).trim();

  // Check 4 reports on its own and fails the run at the end, so its red does
  // not hide the readings of checks 1-3.
  const allowlistHeld = reportFloorGuard(checkTypeAllowlistAgainstBase({ repoRoot }));

  let findings;
  try {
    findings = await runGate(repoRoot);
  } catch (err) {
    console.error("[toolbar-tokens] FAIL — internal error:", err?.message ?? err);
    process.exit(2);
  }

  const total =
    findings.drift.length + findings.role.length + findings.hex.length;
  if (total === 0) {
    console.log(
      `[toolbar-tokens] ${allowlistHeld ? "PASS" : "checks 1-3 pass (check 4 failed above)"} — tokens match the spec; no non-canonical toolbars; no ground-hex leaks`,
    );
    process.exit(allowlistHeld ? 0 : 1);
  }

  if (findings.drift.length > 0) {
    console.error(`[toolbar-tokens] TOKEN DRIFT (${findings.drift.length}):`);
    for (const f of findings.drift) console.error(`  ${f.file}: ${f.message}`);
  }
  if (findings.role.length > 0) {
    console.error(
      `[toolbar-tokens] NON-CANONICAL TOOLBARS (${findings.role.length}) — use <Toolbar> from @/components/ui/toolbar:`,
    );
    for (const f of findings.role)
      console.error(`  ${f.file}:${f.line}  ${f.match}`);
  }
  if (findings.hex.length > 0) {
    console.error(
      `[toolbar-tokens] GROUND-HEX LEAKS (${findings.hex.length}) — use var(--toolbar*) / bg-toolbar*:`,
    );
    for (const f of findings.hex)
      console.error(`  ${f.file}:${f.line}  ${f.match}`);
  }
  console.error(
    "\nSpec: https://docs.cinatra.ai/references/design/design-system.html (§Toolbar / §Nested toolbar).\n" +
      "Third-party DOM that cannot mount <Toolbar> goes in NONCANONICAL_TOOLBAR_ALLOWLIST\n" +
      "(scripts/audit/toolbar-tokens.mjs) with a reason.",
  );
  process.exit(1);
}

// Only run as CLI if invoked directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("[toolbar-tokens] FAIL — uncaught:", err?.message ?? err);
    process.exit(2);
  });
}

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
// Wired in CI by .github/workflows/toolbar-tokens-gate.yml (not paths-scoped:
// check 2 must see every PR).
//
// Exit codes:
//   0 — pass
//   1 — gate failure (findings reported file:line)
//   2 — unexpected internal error (token file missing, etc.)

import { readFile } from "node:fs/promises";
import { execFileSync, execSync } from "node:child_process";
import { resolve } from "node:path";

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
      "[toolbar-tokens] PASS — tokens match the spec; no non-canonical toolbars; no ground-hex leaks",
    );
    process.exit(0);
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

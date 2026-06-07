#!/usr/bin/env node
/**
 * MCP machine-flow route guard.
 *
 * The MCP OAuth handshake pages (auth / account / consent) are driven by
 * external MCP clients during the OAuth handshake. They were moved OUT of the
 * admin namespace into `src/app/api/mcp/{auth,account,consent}/*` so they sit
 * adjacent to the JSON-RPC server endpoint, while the human-facing admin pages
 * (server overview, OAuth client management) stay under `src/app/configuration/mcp/*`.
 *
 * This guard prevents the machine-flow pages from drifting back into the admin
 * namespace and prevents new source references to the old machine-flow URLs.
 *
 * Banned:
 *   - any file under src/app/admin/mcp/{auth,account,consent}/
 *   - any file under src/app/administration/mcp/{auth,account,consent}/
 *   - source references to the historical machine-flow / bare-suffix URLs:
 *       /admin/mcp/auth, /admin/mcp/account, /admin/mcp/consent,
 *       /admin/mcp/sign-in, /admin/mcp/sign-up,
 *       /administration/mcp/{auth,account,consent,sign-in,sign-up}
 *
 * Allowed:
 *   - src/app/configuration/mcp/{page,layout}.tsx, clients/*, and the API routes
 *     (llm-access, self-client, connectivity-check, public-url) — the admin
 *     config surface that legitimately stays.
 *   - this script + its test and the next.config.ts redirect block (sentinel).
 *
 * Usage: node scripts/audit/administration-mcp-machine-flow-banned.mjs
 * Exit:  0 clean · 1 violations
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = process.cwd();
const FOUND = [];

// 1. Banned directories (machine-flow under admin/administration namespace).
const BANNED_DIRS = [
  "src/app/configuration/mcp/auth",
  "src/app/configuration/mcp/account",
  "src/app/configuration/mcp/consent",
  "src/app/admin/mcp/auth",
  "src/app/admin/mcp/account",
  "src/app/admin/mcp/consent",
  "src/app/administration/mcp/auth",
  "src/app/administration/mcp/account",
  "src/app/administration/mcp/consent",
];
for (const d of BANNED_DIRS) {
  const abs = join(REPO_ROOT, d);
  if (existsSync(abs) && statSync(abs).isDirectory()) {
    FOUND.push({ kind: "dir", file: d, text: "machine-flow route must live under src/app/api/mcp/*" });
  }
}

// 2. Banned URL string references in source.
const BANNED_URL_RE =
  /\/(?:configuration|admin|administration)\/mcp\/(?:auth|account|consent|sign-in|sign-up)/;

const SCAN_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts",
  ".md", ".mdx", ".json", ".yml", ".yaml",
]);
const SKIP_DIRS = new Set([
  ".git", ".next", ".turbo", "node_modules", "dist", "build", "coverage",
  ".cache", ".vercel", ".pnpm-store", ".playwright-mcp", "playwright-report",
  "test-results",
]);
const SKIP_REL_PREFIXES = ["packages/mcp-server/vendor/"];

const ALLOWLISTED_FILES = new Set([
  "scripts/audit/administration-mcp-machine-flow-banned.mjs",
]);

const SENTINEL_FILES = new Set(["next.config.ts"]); // redirect block is sentinel-wrapped

function shouldSkipDir(rel, name) {
  if (SKIP_DIRS.has(name)) return true;
  return SKIP_REL_PREFIXES.some((p) => rel.startsWith(p));
}

function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    const rel = relative(REPO_ROOT, p);
    if (e.isDirectory()) {
      if (shouldSkipDir(rel, e.name)) continue;
      walk(p);
      continue;
    }
    if (!SCAN_EXTS.has("." + e.name.split(".").pop())) continue;
    if (ALLOWLISTED_FILES.has(rel)) continue;
    scanFile(p, rel);
  }
}

function scanFile(absPath, relPath) {
  let content;
  try { content = readFileSync(absPath, "utf8"); } catch { return; }
  if (!BANNED_URL_RE.test(content)) return;

  // next.config.ts: skip the sentinel-wrapped redirect block.
  const isSentinel = SENTINEL_FILES.has(relPath);
  const lines = content.split("\n");
  let inMcpAllow = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isSentinel) {
      if (line.includes("mcp-machine-flow-allowlist-start")) { inMcpAllow = true; continue; }
      if (line.includes("mcp-machine-flow-allowlist-end")) { inMcpAllow = false; continue; }
      if (inMcpAllow) continue;
    }
    if (BANNED_URL_RE.test(line)) {
      FOUND.push({ kind: "ref", file: relPath, line: i + 1, text: line.trim().slice(0, 140) });
    }
  }
}

walk(REPO_ROOT);

if (FOUND.length === 0) {
  console.log("✓ no MCP machine-flow routes/references outside src/app/api/mcp/*");
  process.exit(0);
}

console.error(`✗ found ${FOUND.length} MCP machine-flow violation(s):\n`);
for (const f of FOUND) {
  if (f.kind === "dir") console.error(`  [dir] ${f.file}  — ${f.text}`);
  else console.error(`  ${f.file}:${f.line}  ${f.text}`);
}
console.error(`\nMCP OAuth handshake pages (auth/account/consent/sign-in/sign-up) live under`);
console.error(`src/app/api/mcp/*. Update references to /api/mcp/auth/... etc.`);
process.exit(1);

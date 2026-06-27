#!/usr/bin/env node
/**
 * Vendored-import regression guard.
 *
 * Scans the repo for imports from `@cinatra-ai/marketplace-mcp-client` (the
 * vendored copy at `packages/marketplace-mcp-client/`). The plan is to swap
 * every import over to the published `@cinatra-ai/marketplace-mcp-contract`
 * package (published by the Cinatra marketplace service) and delete the vendored copy.
 * That swap is gated on the operator publishing the contract package.
 *
 * Until the publish lands, the current import sites listed in CURRENT_ALLOWLIST
 * are recognised as known-stale (the guard tolerates them). Every OTHER
 * import of the vendored name is rejected — that prevents NEW callers from
 * being added that would also need a swap.
 *
 * **When the operator finishes the swap PR (deletes the vendored directory +
 * updates the listed import sites to use `@cinatra-ai/marketplace-mcp-contract`),
 * THIS FILE'S `CURRENT_ALLOWLIST` MUST be set to `[]`.** That activates the
 * guard's full strictness — any future re-introduction of the vendored name
 * fails CI.
 *
 * Usage:
 *   node scripts/audit/marketplace-mcp-client-banned.mjs
 *
 * Exit codes:
 *   0  no NEW unallowlisted imports introduced by this PR (legacy tolerated
 *      per the touch-ratchet)
 *   1  one or more NEW unallowlisted imports of @cinatra-ai/marketplace-mcp-client
 *      (or paths into packages/marketplace-mcp-client/) introduced by this PR
 *   2  `MARKETPLACE_MCP_CLIENT_DIFF_BASE` was set but does NOT resolve to a
 *      git ref (CI fetch-depth misconfig surfacing)
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolveBaseRef,
  buildRenameMap,
  getAddedLineNumbers,
} from "./_lib/touch-ratchet.mjs";

const REPO_ROOT = (() => {
  // Resolve to the repo root by walking up from this script's location.
  // scripts/audit/<this>.mjs → repo root is two parents up.
  const here = fileURLToPath(import.meta.url);
  return new URL("../../", import.meta.url).pathname.replace(/\/+$/, "");
})();

/**
 * Import sites that EXIST TODAY and are tolerated until the swap PR lands.
 * Every entry is a repo-relative POSIX path. Delete entries from this list
 * as the swap PR migrates each call site to the published contract; when
 * the list is empty, the guard is at full strictness.
 *
 * SOURCE OF TRUTH for tracking the migration: the swap PR's description.
 */
export const CURRENT_ALLOWLIST = Object.freeze([
  // Vendored package itself (the entire subtree is the thing being deleted
  // when the swap PR lands).
  "packages/marketplace-mcp-client/src/client.ts",
  "packages/marketplace-mcp-client/src/index.ts",
  "packages/marketplace-mcp-client/src/types.ts",
  "packages/marketplace-mcp-client/package.json",
  "packages/marketplace-mcp-client/README.md",
  // Call sites that import from the vendored name (the actual swap-PR scope).
  "packages/marketplace-sync/package.json",
  "packages/marketplace-sync/src/package-mapper.ts",
  "packages/marketplace-sync/src/sync-worker.ts",
  "packages/marketplace-sync/tests/sync-worker.test.ts",
  "src/app/configuration/environment/marketplace-publish-actions.ts",
  // Additional marketplace-side call sites — same migration story; the
  // published contract package doesn't ship until Verdaccio is functional,
  // so the vendored package remains the only source of these types/methods.
  "src/lib/marketplace-reconcile.ts",
  "src/app/setup/name/actions.ts",
  // Extension submission moderator surface (vendor view + admin
  // queue + Server Actions). Same swap-PR migration applies once the
  // contract package can ship; until then the vendored package is the
  // only typed surface for the new extension_submission_{withdraw,
  // approve,reject,promotion_retry} methods.
  "src/app/configuration/marketplace/submissions/actions.ts",
  "src/app/configuration/marketplace/submissions/page.tsx",
  "src/app/configuration/marketplace/submissions/admin/page.tsx",
  // Sync-worker production deps factory. Same swap-PR migration
  // applies — the typed surface for the MCP client lives in the
  // vendored package until the contract publishes.
  "src/lib/marketplace-sync-deps.ts",
  // Workspace / build wire-up that declares the package by name.
  "next.config.ts",
  "tsconfig.json",
  // Manifest that is the generated source of truth for the tsconfig path
  // aliases + next.config package lists above — it carries the same
  // `@cinatra-ai/marketplace-mcp-client` path-alias declarations (NOT imports)
  // that tsconfig.json/next.config.ts do. Same swap-PR migration story: when the
  // vendored package is deleted, those alias entries leave the manifest too.
  "config/build-config.manifest.json",
  // Vendor-application lifecycle consumers. Same swap-PR migration story:
  // the vendored package is the only typed surface for the new
  // vendor_application_* wrapper methods + instance_attach_self until the
  // published contract package ships. These call sites move to the contract
  // import alongside the rest of the swap.
  "packages/marketplace-application-reconcile/package.json",
  "packages/marketplace-application-reconcile/src/reconcile-worker.ts",
  "src/lib/marketplace-application-reconcile-deps.ts",
  "src/lib/__tests__/marketplace-application-reconcile-deps.test.ts",
  "src/lib/marketplace-attach.ts",
  "src/app/configuration/environment/marketplace-connection-card.tsx",
  "src/app/configuration/environment/vendor-application-actions.ts",
  "src/app/configuration/instance/actions.ts",
  // Unit test for the instance-rename action above — its vi.mock of
  // `@cinatra-ai/marketplace-mcp-client/http-client` MIRRORS that action's
  // existing (allowlisted) import so the rename gate's vendor-status probe is
  // stubbed. Test-only mock, not new production coupling; moves to the contract
  // import alongside actions.ts when the swap lands.
  "src/lib/__tests__/rename-instance-namespace-action.test.ts",
  // Regression test for cinatra#396 (offline local namespace rename). Mirrors
  // actions.ts's existing (allowlisted) vendored import to exercise the rename
  // gate's MarketplaceMcpError-vs-transport-error discrimination; its vi.mock of
  // `@cinatra-ai/marketplace-mcp-client/http-client` stubs the vendor-status
  // probe. Test-only, not new production coupling; moves to the contract import
  // alongside actions.ts when the swap lands.
  "src/lib/__tests__/namespace-rename-offline-override.test.ts",
  "src/app/configuration/marketplace/vendor-applications/actions.ts",
  "src/app/configuration/marketplace/vendor-applications/admin-action-buttons.tsx",
  "src/app/configuration/marketplace/vendor-applications/page.tsx",
  // Storefront browse parity — new `extension_list` caller + its card
  // mappers/tests. Same swap-PR migration story: the vendored package is the
  // only typed surface for the new `extensionList` method + the
  // MarketplaceCatalogEntry type until the contract package can publish; these
  // move to the contract import alongside the rest of the swap.
  "src/lib/marketplace-browse.ts",
  "src/lib/__tests__/marketplace-browse.test.ts",
  // Gatekept-install consume path. Same vendored-client need as the
  // browse path above — the swap to the published @cinatra-ai/marketplace-mcp-contract
  // is still operator-gated, so these new
  // consume sites stay allowlisted like the existing ones: the grant/proxy resolver
  // (extension_install_authorize), the detail page rendering from extension_get, and
  // their tests + the extensions vitest mock.
  "src/lib/gatekept-install.ts",
  "src/lib/__tests__/gatekept-install.test.ts",
  "src/lib/__tests__/marketplace-attach.test.ts",
  "src/app/configuration/marketplace/[scope]/[name]/page.tsx",
  "packages/extensions/src/__tests__/__mocks__/gatekept-install.ts",
  "packages/extensions/src/screens/marketplace-card-model.ts",
  "packages/extensions/src/__tests__/marketplace-card-model.test.ts",
  // The card mapper's MarketplaceCatalogEntry type import requires the vendored
  // package to be a declared dependency of @cinatra-ai/extensions (the
  // workspace-phantom-deps gate enforces this); the manifest edge moves to the
  // published contract alongside the rest of the swap.
  "packages/extensions/package.json",
]);

/** Files / directories the scanner skips entirely (perf + accuracy).
 *
 * **Do NOT** add `scripts` here — doing so prunes the entire scripts/
 * tree, defeating the guard. Self-references to the banned token (the
 * audit script + its tests + the workflow) are exempted via
 * SELF_REFERENCING_FILES below, NOT here.
 */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".turbo",
  "dist",
  "build",
  "out",
  "coverage",
  "playwright-report",
  "test-results",
  ".pnpm-store",
]);
const SKIP_FILE_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".pdf",
  ".mp4",
  ".webm",
  ".zip",
  ".tar",
  ".gz",
  ".lock", // various lock files
  ".tsbuildinfo", // local-only post-typecheck cache (CI clean checkout never has these)
]);

/** Specific lockfiles to skip — pnpm-lock.yaml is huge + only mirrors package.json. */
const SKIP_FILENAMES = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
]);

// The two distinct shapes a "vendored import" can take:
//   1. import / require of the npm-style package name
//   2. a deep relative path into the vendored source directory
const BANNED_PATTERNS = [
  /@cinatra-ai\/marketplace-mcp-client/g,
  /packages\/marketplace-mcp-client(?:\/|$)/g,
];

// This script itself + its companions intentionally reference the banned
// strings (as regex sources / docs). The scanner skips them by absolute
// path comparison.
const SELF_REFERENCING_FILES = new Set([
  "scripts/audit/marketplace-mcp-client-banned.mjs",
  "scripts/audit/__tests__/marketplace-mcp-client-banned.test.mjs",
  // The workflow file that invokes the script names the banned token in
  // its own doc comments + workflow name.
  ".github/workflows/marketplace-mcp-client-banned.yml",
]);

/**
 * Walk the repo, yielding file paths under SKIP_DIRS-pruned subtrees.
 *
 * @param {string} dir
 * @returns {Generator<string>}
 */
function* walkRepo(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walkRepo(full);
    } else if (entry.isFile()) {
      if (SKIP_FILENAMES.has(entry.name)) continue;
      const ext = entry.name.includes(".")
        ? "." + entry.name.split(".").pop()
        : "";
      if (SKIP_FILE_EXTS.has(ext)) continue;
      yield full;
    }
  }
}

/**
 * Scan a file's bytes for any BANNED_PATTERN match.
 *
 * @param {string} absPath
 * @returns {string[]} line-number markers like "L42" for each hit
 */
function scanFileForBannedImports(absPath) {
  let bytes;
  try {
    bytes = readFileSync(absPath, "utf8");
  } catch {
    return [];
  }
  const hits = [];
  for (const pattern of BANNED_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(bytes)) !== null) {
      // Convert byte offset to a 1-indexed line number.
      const upToMatch = bytes.slice(0, match.index);
      const lineNo = (upToMatch.match(/\n/g)?.length ?? 0) + 1;
      hits.push(`L${lineNo}: ${match[0]}`);
    }
  }
  return hits;
}

/**
 * Main scan — returns { ok, unallowlistedHits } where unallowlistedHits is
 * an array of { path, hits[] } for files NOT in CURRENT_ALLOWLIST.
 *
 * @param {string} repoRoot
 * @returns {{ok:boolean, unallowlistedHits:Array<{path:string, hits:string[]}>}}
 */
export function scan(repoRoot = REPO_ROOT) {
  const allowlist = new Set(CURRENT_ALLOWLIST);
  const unallowlistedHits = [];
  for (const absPath of walkRepo(repoRoot)) {
    const repoRelative = relative(repoRoot, absPath).split(sep).join("/");
    if (SELF_REFERENCING_FILES.has(repoRelative)) continue;
    if (allowlist.has(repoRelative)) continue;
    const hits = scanFileForBannedImports(absPath);
    if (hits.length > 0) {
      unallowlistedHits.push({ path: repoRelative, hits });
    }
  }
  return { ok: unallowlistedHits.length === 0, unallowlistedHits };
}

/**
 * Apply the touch-ratchet to a `scan()` result. Findings on lines a PR
 * DID NOT add are pre-existing legacy and tolerated; findings on lines a
 * PR ADDED block.
 *
 * The base ref comes from `MARKETPLACE_MCP_CLIENT_DIFF_BASE` (set by the
 * CI workflow to the PR base). Locally, the helper falls back to
 * standard candidates and finally null (strict mode — every finding is
 * blocked).
 *
 * Returns the same `{ ok, unallowlistedHits }` shape with hits filtered
 * down to the introduced subset; the `toleratedFileCount` field counts
 * files whose findings were ALL on pre-existing lines.
 *
 * @param {{ok:boolean, unallowlistedHits:Array<{path:string, hits:string[]}>}} scanResult
 * @returns {{ok:boolean, unallowlistedHits:Array<{path:string, hits:string[]}>, toleratedFileCount:number}}
 */
export function applyTouchRatchet(scanResult) {
  const baseRef = resolveBaseRef("MARKETPLACE_MCP_CLIENT_DIFF_BASE");
  const renameMap = buildRenameMap(baseRef);
  let toleratedFileCount = 0;
  const filtered = [];
  for (const entry of scanResult.unallowlistedHits) {
    const addedLines = baseRef
      ? getAddedLineNumbers(entry.path, baseRef, renameMap)
      : null;
    if (addedLines === null) {
      // file genuinely new at base, or strict mode → every hit is introduced
      filtered.push(entry);
      continue;
    }
    const introducedHits = entry.hits.filter((h) => {
      const m = /^L(\d+):/.exec(h);
      if (!m) return true; // unexpected shape — fail-closed
      return addedLines.has(parseInt(m[1], 10));
    });
    if (introducedHits.length > 0) {
      filtered.push({ path: entry.path, hits: introducedHits });
    } else {
      toleratedFileCount += 1;
    }
  }
  return {
    ok: filtered.length === 0,
    unallowlistedHits: filtered,
    toleratedFileCount,
  };
}

// CLI entry — only when run directly.
const isMain =
  typeof process.argv[1] === "string" &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const raw = scan();
  let ratcheted;
  try {
    ratcheted = applyTouchRatchet(raw);
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(2);
  }
  if (ratcheted.ok) {
    if (ratcheted.toleratedFileCount > 0) {
      console.log(
        `ok: no NEW imports of @cinatra-ai/marketplace-mcp-client introduced by this PR ` +
        `(${ratcheted.toleratedFileCount} legacy file(s) still carrying hits — tolerated).`,
      );
    } else {
      console.log(
        "ok: no unallowlisted imports of @cinatra-ai/marketplace-mcp-client found.",
      );
    }
    process.exit(0);
  }
  console.error(
    "ERROR: found NEW unallowlisted imports of @cinatra-ai/marketplace-mcp-client " +
    "introduced by this PR.",
  );
  console.error("");
  console.error("Every new import must use the published @cinatra-ai/marketplace-mcp-contract");
  console.error("(from registry.cinatra.ai) instead.");
  console.error("If you genuinely need to add an import to the vendored copy as part of an");
  console.error("in-flight migration step, add the path to CURRENT_ALLOWLIST in");
  console.error("scripts/audit/marketplace-mcp-client-banned.mjs (and document why).");
  console.error("");
  for (const { path, hits } of ratcheted.unallowlistedHits) {
    console.error(`  ${path}`);
    for (const hit of hits) console.error(`    ${hit}`);
  }
  if (ratcheted.toleratedFileCount > 0) {
    console.error(
      `\n(informational: ${ratcheted.toleratedFileCount} legacy file(s) still carrying hits, ` +
      `untouched by this PR — tolerated.)`,
    );
  }
  process.exit(1);
}

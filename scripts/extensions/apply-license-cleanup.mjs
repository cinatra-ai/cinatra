#!/usr/bin/env node
// One-shot license-field migration across every extension manifest (must precede
// repo creation/extraction).
//
// Policy (owner-locked):
//   - all cinatra-ai/*            → "Apache-2.0"
//     (incl. anthropic-connector AND wordpress-agent / drupal-agent: those agents
//     drive WordPress/Drupal over their HTTP/MCP APIs and are NOT derivative works
//     of GPL code, so they carry the cinatra default. The genuinely-GPL companion
//     WordPress.org plugin / Drupal.org module live in their own separate repos.)
//
// ONE-SHOT + idempotent: re-running is a no-op once every manifest matches policy.
// Minimal-diff: replaces an existing `"license"` value in place, or inserts the
// field right after the `"name"` line. The LICENSE *file* is template-owned at
// repo creation — this migration fixes the FIELD only.
//
// Usage:
//   node scripts/extensions/apply-license-cleanup.mjs           # apply
//   node scripts/extensions/apply-license-cleanup.mjs --check    # report violations (exit 1 if any)

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const EXT_ROOT = join(REPO_ROOT, "extensions");

// Empty: no cinatra-ai extension is GPL-licensed today (the wordpress-agent /
// drupal-agent are Apache-2.0 — see the policy note above). The set + branch stay
// for any future genuinely-GPL-derived extension.
const GPL_AGENTS = new Set([]);

/** Policy license, or null for an unknown scope (fail closed — the gate flags
 * it rather than silently defaulting a new vendor to Apache-2.0).
 *
 * `opts.vendored` (a package carrying `cinatra.vendoredFrom`) keeps its UPSTREAM
 * license: cinatra's per-scope policy never relicenses third-party vendored code,
 * so the policy IS the package's own declared license (the gate then only
 * requires it be present + non-empty). A vendored package with no declared
 * license still fails closed. */
export function targetLicenseFor(packageName, opts = {}) {
  if (opts.vendored) {
    const declared = typeof opts.declaredLicense === "string" ? opts.declaredLicense.trim() : "";
    return declared || null;
  }
  if (GPL_AGENTS.has(packageName)) return "GPL-2.0-or-later";
  if (packageName.startsWith("@cinatra-ai/")) return "Apache-2.0";
  return null;
}

/** Build the targetLicenseFor opts from a parsed manifest (vendored detection). */
export function licenseOptsForManifest(pkg) {
  return {
    vendored: Boolean(pkg?.cinatra?.vendoredFrom),
    declaredLicense: pkg?.license,
  };
}

export function listExtensionManifests() {
  const out = [];
  if (!existsSync(EXT_ROOT)) return out;
  for (const scope of readdirSync(EXT_ROOT, { withFileTypes: true })) {
    if (!scope.isDirectory()) continue;
    for (const ext of readdirSync(join(EXT_ROOT, scope.name), { withFileTypes: true })) {
      if (!ext.isDirectory()) continue;
      const p = join(EXT_ROOT, scope.name, ext.name, "package.json");
      if (existsSync(p)) out.push(p);
    }
  }
  return out.sort();
}

/** Returns the new file text, or null when already compliant. Pure. */
export function applyLicenseToManifest(text, target) {
  // existing "license": "..." → replace value, preserving trailing comma/spacing
  const existing = text.match(/(^[ \t]*"license"\s*:\s*")([^"]*)(")/m);
  if (existing) {
    if (existing[2] === target) return null; // already correct
    return text.replace(existing[0], `${existing[1]}${target}${existing[3]}`);
  }
  // else insert after the "name": "..." line. Capture whether the name line
  // already ends with a comma: if it does (more properties follow), the new
  // license line is comma-terminated; if it does NOT (name is the LAST property),
  // the name line GAINS a comma and the license line becomes the new last
  // property (no trailing comma) — otherwise we'd emit invalid JSON.
  const nameMatch = text.match(/^([ \t]*)("name"\s*:\s*"[^"]*")(,?)[ \t]*$/m);
  if (!nameMatch) throw new Error('no "name" line to anchor license insertion');
  const [whole, indent, nameKV, comma] = nameMatch;
  const replacement = `${indent}${nameKV},\n${indent}"license": "${target}"${comma ? "," : ""}`;
  return text.replace(whole, replacement);
}

function run({ check }) {
  const violations = [];
  const changed = [];
  for (const manifestPath of listExtensionManifests()) {
    const text = readFileSync(manifestPath, "utf8");
    let pkg;
    try {
      pkg = JSON.parse(text);
    } catch {
      violations.push(`${relative(REPO_ROOT, manifestPath)}: invalid JSON`);
      continue;
    }
    const target = targetLicenseFor(pkg.name, licenseOptsForManifest(pkg));
    if (target === null) {
      // unknown scope (or a vendored package with no declared license) → no
      // policy; never auto-fixable, always a violation
      violations.push(`${relative(REPO_ROOT, manifestPath)}: no license policy for scope of "${pkg.name}"`);
      continue;
    }
    if (pkg.license === target) continue; // compliant
    if (check) {
      violations.push(
        `${relative(REPO_ROOT, manifestPath)}: license is ${JSON.stringify(pkg.license ?? null)}, want "${target}"`,
      );
      continue;
    }
    const next = applyLicenseToManifest(text, target);
    if (next && next !== text) {
      // never write invalid JSON — re-parse the rewritten text first (defends
      // against any insertion edge case, e.g. an unusual manifest shape).
      try {
        JSON.parse(next);
      } catch {
        throw new Error(`${relative(REPO_ROOT, manifestPath)}: license rewrite produced invalid JSON — aborting (no file written)`);
      }
      writeFileSync(manifestPath, next);
      changed.push(`${relative(REPO_ROOT, manifestPath)} → "${target}"`);
    }
  }
  if (check) {
    if (violations.length) {
      console.log("[extension-license] VIOLATIONS:");
      for (const v of violations) console.log("  - " + v);
      process.exit(1);
    }
    console.log("[extension-license] OK — every extension manifest has the policy license field.");
    return;
  }
  console.log(`[extension-license] applied ${changed.length} change(s):`);
  for (const c of changed) console.log("  - " + c);
  if (changed.length === 0) console.log("  (all manifests already compliant)");
  if (violations.length) {
    console.log("[extension-license] UNRESOLVED (no policy — fix the scope policy):");
    for (const v of violations) console.log("  - " + v);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  run({ check: process.argv.includes("--check") });
}

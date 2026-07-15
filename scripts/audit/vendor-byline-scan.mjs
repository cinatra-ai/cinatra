#!/usr/bin/env node
// Vendor-byline conformance gate (cinatra#1528).
//
// The extension "{Kind} by {Vendor}" byline must never substitute a MACHINE
// IDENTIFIER (an npm package scope, a vendor slug, a connector host slug) for
// the vendor's human display name. The app resolves every byline through ONE
// resolver — src/lib/vendor-presentation.ts `resolveVendorPresentation` — which
// returns a discriminated `known | missing` state and whose render input has no
// slug/packageName field, so the substitution is unrepresentable through the
// type. This gate is the LINT/AST half of the anti-regression ask (AC8): a
// FOCUSED rule over the known byline rendering + vendor-source paths that
//   1. (positive) requires each path to consume the resolver, and
//   2. (negative) forbids the retired substitution constructs — a
//      `scopeFromPackageName` call and any `vendor.slug` read — inside them.
//
// It is deliberately NOT a repo-wide semantic ban on "anything derived from a
// package name": a slug / package scope is legitimate elsewhere (URLs, package
// text, install identity). The BEHAVIOURAL half (per-surface tests fed raw
// catalog input with distinct sentinels) runs alongside this gate and catches
// an UPSTREAM model/helper regression that never touches these files.
//
// Comment-stripped before matching (the byline files' own doc comments mention
// "slug"/"scope" freely). A guarded file that no longer exists FAILS — the
// byline must not silently move out from under the gate (update GUARDED_FILES).
//
// Wired by .github/workflows/vendor-byline-gate.yml (every PR, not paths-scoped:
// an upstream change can regress the byline without touching these files).
//
// Exit codes: 0 = pass; 1 = gate failure (findings reported file:line); 2 =
// internal error (a guarded file is missing, git failure, …).

import { readFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// Contract

/** The single resolver every byline consumes. */
export const RESOLVER = "resolveVendorPresentation";

// The retired machine-identifier substitution constructs, forbidden inside the
// guarded byline paths (matched on comment-stripped source).
const FORBID_SCOPE_HELPER = { re: /\bscopeFromPackageName\b/, label: "scopeFromPackageName (retired package-scope byline fallback)" };
const FORBID_VENDOR_SLUG = { re: /\bvendor\s*\??\.\s*slug\b/, label: "vendor.slug read (a slug is a machine identifier, never a display name)" };
const FORBID_RAW_SLUG = { re: /\braw\s*\??\.\s*slug\b/, label: "raw.slug read in the vendor normalizer (retired name ?? slug fallback)" };

// Each guarded path carries per-file rules:
//   requireAny: at least ONE of these substrings must appear (positive — the
//               path consumes the resolver, directly or via a wrapper);
//   forbid:     none of these patterns may appear (negative).
export const GUARDED_FILES = Object.freeze([
  {
    file: "packages/extensions/src/screens/marketplace-card-model.ts",
    // Normalization layer: the vendor name must come from `raw.name` only.
    requireAny: [],
    forbid: [FORBID_SCOPE_HELPER, FORBID_VENDOR_SLUG, FORBID_RAW_SLUG],
  },
  {
    file: "packages/extensions/src/screens/marketplace-listing-card.tsx",
    requireAny: [RESOLVER],
    forbid: [FORBID_SCOPE_HELPER, FORBID_VENDOR_SLUG],
  },
  {
    file: "packages/extensions/src/screens/marketplace-modal-byline.tsx",
    requireAny: [RESOLVER],
    forbid: [FORBID_SCOPE_HELPER, FORBID_VENDOR_SLUG],
  },
  {
    file: "packages/extensions/src/screens/registry-catalog-screen.tsx",
    requireAny: [RESOLVER],
    forbid: [FORBID_SCOPE_HELPER, FORBID_VENDOR_SLUG],
  },
  {
    file: "src/components/extensions/installed-extension-card.tsx",
    // Renders the VendorPresentation prop; never builds a label from a slug.
    requireAny: ["VendorPresentation"],
    forbid: [FORBID_SCOPE_HELPER, FORBID_VENDOR_SLUG],
  },
  {
    file: "src/components/extensions/agent-card-vendor.ts",
    requireAny: [RESOLVER],
    forbid: [FORBID_SCOPE_HELPER, FORBID_VENDOR_SLUG],
  },
  {
    file: "src/components/extensions/agent-all-card.tsx",
    // §IV consumes the resolver via resolveAgentCardVendor; the card's `vendor`
    // prop is typed VendorPresentation, so a raw host slug cannot be passed.
    requireAny: ["resolveAgentCardVendor"],
    forbid: [FORBID_SCOPE_HELPER, FORBID_VENDOR_SLUG],
  },
]);

// ---------------------------------------------------------------------------
// Shared helpers

// Strip `/* … */` and `// …` comments while preserving line numbers (so a
// finding's line points at the real offending code, not a comment).
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

/**
 * Evaluate one guarded file's rules against its (raw) source. Returns an array
 * of finding strings; empty means clean.
 */
export function evaluateFile(rule, source) {
  const findings = [];
  const stripped = stripComments(source);

  if (Array.isArray(rule.requireAny) && rule.requireAny.length > 0) {
    const satisfied = rule.requireAny.some((needle) => stripped.includes(needle));
    if (!satisfied) {
      findings.push(
        `${rule.file}: must consume the vendor resolver — none of [${rule.requireAny.join(", ")}] found ` +
          `(the byline label must come from ${RESOLVER}, never a hand-built string)`,
      );
    }
  }

  const lines = stripped.split("\n");
  for (const bad of rule.forbid) {
    lines.forEach((line, idx) => {
      if (bad.re.test(line)) {
        findings.push(`${rule.file}:${idx + 1}: forbidden — ${bad.label}`);
      }
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// CLI

export async function runGate(repoRoot) {
  const findings = [];
  const missing = [];
  for (const rule of GUARDED_FILES) {
    const abs = resolve(repoRoot, rule.file);
    if (!existsSync(abs)) {
      missing.push(rule.file);
      continue;
    }
    const source = await readFile(abs, "utf8");
    findings.push(...evaluateFile(rule, source));
  }
  return { findings, missing };
}

async function main() {
  const repoRoot = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();

  let result;
  try {
    result = await runGate(repoRoot);
  } catch (err) {
    console.error(`::error::vendor-byline-scan: internal error: ${err?.message ?? err}`);
    process.exit(2);
  }

  if (result.missing.length > 0) {
    console.error(
      `::error::vendor-byline-scan: ${result.missing.length} guarded byline path(s) no longer exist — ` +
        `the byline must not move out from under the gate. Update GUARDED_FILES in ` +
        `scripts/audit/vendor-byline-scan.mjs:\n` +
        result.missing.map((f) => `  - ${f}`).join("\n"),
    );
    process.exit(2);
  }

  if (result.findings.length === 0) {
    console.log(
      `[vendor-byline-scan] PASS — all ${GUARDED_FILES.length} byline paths consume ${RESOLVER}; ` +
        "no retired scope/slug substitution.",
    );
    process.exit(0);
  }

  console.error(`::error::vendor-byline conformance gate failed (${result.findings.length} finding(s)):`);
  for (const f of result.findings) console.error(`  ${f}`);
  console.error(
    "\nThe {Kind} by {Vendor} byline must resolve through resolveVendorPresentation " +
      "(src/lib/vendor-presentation.ts) and never substitute a package scope or vendor slug " +
      "for the display name (cinatra#1528).",
  );
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`::error::vendor-byline-scan: uncaught: ${err?.message ?? err}`);
    process.exit(2);
  });
}

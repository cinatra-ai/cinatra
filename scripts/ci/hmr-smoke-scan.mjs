#!/usr/bin/env node
// Dev-server log scanner for the warm-dev HMR smoke (cinatra#1093).
//
// The warm dev-session HMR regression class (cinatra#1068: "Cannot redefine
// property: $$typeof" in the server-reference bridge under Turbopack HMR) only
// manifests AFTER a true recompile over a framework-locked object. When it
// fires, the browser sees an HTTP 500 / dev overlay (the Playwright leg catches
// that) AND the dev server prints a distinctive stack. This scanner is the
// second, log-side detector: it greps the captured dev-server log for the known
// HMR-corruption signatures so the smoke reds even if a surface happens to
// recover a renderable payload while the server logged the corruption.
//
// Report-only by default (exit 0): prints one ::warning:: per hit + a summary.
// `--fail-on-hit` turns any hit into a non-zero exit for a hard-gating caller.
//
// Usage: node scripts/ci/hmr-smoke-scan.mjs <dev-server-log-path> [--fail-on-hit]

import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// Curated signatures for the HMR-re-evaluation-over-framework-locked-objects
// class. Kept TIGHT (specific messages, not a bare /Error/) so a benign dev-log
// line never false-positives a report-only signal into noise.
export const HMR_REGRESSION_SIGNATURES = [
  {
    id: "redefine-$$typeof",
    re: /Cannot redefine property:\s*\$\$typeof/,
    note: "cinatra#1068: HMR re-evaluation redefined a React-locked server-reference ($$typeof).",
  },
  {
    id: "redefine-__esModule",
    re: /Cannot redefine property:\s*__esModule/,
    note: "HMR re-evaluation redefined a framework-locked module marker (__esModule).",
  },
  {
    id: "redefine-server-reference",
    // A `Cannot redefine property` line that also names the server-reference
    // machinery — the general shape of the #1068 class beyond the two exact
    // property names above.
    re: /Cannot redefine property[\s\S]{0,120}?(server[\s-]?reference|registerServerReference|createServerReference)/i,
    note: "HMR re-evaluation redefined a property on a server-reference object.",
  },
  {
    id: "server-reference-redefine-reverse",
    // Same class, tokens in the other order (the reference machinery named
    // first, the redefine failure second within a short window).
    re: /(registerServerReference|createServerReference|server[\s-]?reference)[\s\S]{0,120}?Cannot redefine property/i,
    note: "HMR re-evaluation redefined a property on a server-reference object.",
  },
];

/**
 * Scan dev-server log text for HMR-regression signatures.
 * @param {string} logText
 * @returns {{ id: string, note: string, line: string }[]} one hit per matched line/window
 */
export function scanForHmrSignatures(logText) {
  const text = String(logText ?? "");
  const lines = text.split(/\r?\n/);
  const hits = [];
  const seen = new Set();
  for (const sig of HMR_REGRESSION_SIGNATURES) {
    // Per-line first (precise context line), then whole-text (for signatures
    // whose tokens legitimately span adjacent lines in a stack).
    let matchedLine = null;
    for (const line of lines) {
      if (sig.re.test(line)) {
        matchedLine = line.trim();
        break;
      }
    }
    if (!matchedLine && sig.re.test(text)) {
      const m = text.match(sig.re);
      matchedLine = (m ? m[0] : "").split(/\r?\n/)[0].trim();
    }
    if (matchedLine) {
      const key = `${sig.id}:${matchedLine}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({ id: sig.id, note: sig.note, line: matchedLine.slice(0, 300) });
    }
  }
  return hits;
}

function main() {
  const args = process.argv.slice(2);
  const failOnHit = args.includes("--fail-on-hit");
  const logPath = args.find((a) => !a.startsWith("--"));
  if (!logPath) {
    console.error("[hmr-smoke-scan] usage: node scripts/ci/hmr-smoke-scan.mjs <dev-server-log-path> [--fail-on-hit]");
    process.exit(1);
  }
  let logText = "";
  try {
    logText = readFileSync(logPath, "utf8");
  } catch (err) {
    console.log(`::notice::[hmr-smoke-scan] dev-server log '${logPath}' unreadable (${err.code || err.message}); nothing to scan.`);
    process.exit(0);
  }
  const hits = scanForHmrSignatures(logText);
  for (const h of hits) {
    console.log(`::warning::[hmr-smoke-scan] ${h.note}  (signature=${h.id})  log: ${h.line}`);
  }
  console.log("");
  console.log(`[hmr-smoke-scan] scanned ${logPath}: ${hits.length} HMR-regression signature hit(s).`);
  if (hits.length === 0) {
    console.log("  -> no server-reference / $$typeof redefine stacks in the warm dev-session log.");
  }
  if (failOnHit && hits.length > 0) process.exit(3);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

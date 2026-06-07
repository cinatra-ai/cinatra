#!/usr/bin/env node
// ad-hoc status-rendering scanner — fails if any site outside the canonical
// renderers hand-rolls a status pill / badge with raw color classes for the
// known status words.
// Usage: node scripts/design/scan-status-render.mjs [--quiet] [--json]
// Becomes CI-gating once the migration completes.

import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const ALLOW_FILES = new Set([
  "src/components/ui/status-pill.tsx",
  "src/lib/status-adapter.ts",
  "src/components/lifecycle-badge.tsx",
]);

const STATUS_WORDS = [
  "running",
  "approved",
  "hold",
  "needs-review",
  "scheduled",
  "queued",
  "idle",
  "archived",
  "failed",
  "declined",
];

const RAW_COLOR_CLASS = /\b(?:bg|text|border)-(?:emerald|green|red|amber|yellow|orange|sky|blue|indigo|violet|purple|slate|gray|stone|zinc|neutral|pink|rose|teal|cyan|fuchsia|lime)(?:-\d+)?(?:\/\d+)?\b/;

const EXT = new Set([".tsx", ".ts", ".jsx", ".js"]);
const SKIP = new Set([
  "node_modules",
  ".next",
  ".turbo",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".claude",
  ".planning",
  "docs",
  "packages",
  "extensions",
  "scripts",
  "cinatra-archive",
  "public",
]);

async function* walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (e.isFile()) yield full;
  }
}

const args = new Set(process.argv.slice(2));
const QUIET = args.has("--quiet");
const JSON_OUT = args.has("--json");

const findings = [];

for await (const file of walk(join(ROOT, "src"))) {
  const ext = file.slice(file.lastIndexOf("."));
  if (!EXT.has(ext)) continue;
  const rel = relative(ROOT, file).split(sep).join("/");
  if (ALLOW_FILES.has(rel)) continue;
  const text = await readFile(file, "utf8");
  // Heuristic: lines that contain BOTH a status word (as a string literal or class)
  // AND a raw color class are suspect. Skip if the line uses StatusPill or
  // status-adapter import.
  const usesPill = /StatusPill|status-adapter|statusToPill/i.test(text);
  if (usesPill) continue;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const hasStatus = STATUS_WORDS.some((w) =>
      new RegExp(`['"\`]\\s*${w}\\s*['"\`]`, "i").test(line),
    );
    if (!hasStatus) continue;
    if (!RAW_COLOR_CLASS.test(line)) continue;
    findings.push({ file: rel, line: i + 1, snippet: line.trim().slice(0, 200) });
  }
}

if (JSON_OUT) {
  process.stdout.write(
    JSON.stringify({ findings, count: findings.length }, null, 2) + "\n",
  );
} else if (findings.length === 0) {
  if (!QUIET) {
    console.log("[scan-status-render] OK — 0 ad-hoc status renderings");
  }
} else {
  console.error(
    `[scan-status-render] FAIL — ${findings.length} ad-hoc status rendering site(s):`,
  );
  for (const f of findings.slice(0, 100)) {
    console.error(`  ${f.file}:${f.line}  ${f.snippet}`);
  }
  if (findings.length > 100) {
    console.error(`  … and ${findings.length - 100} more`);
  }
  console.error("");
  console.error(
    "Use <StatusPill status=…> from @/components/ui/status-pill instead, ",
  );
  console.error("or call the central adapter in src/lib/status-adapter.ts.");
}

process.exit(findings.length > 0 ? 1 : 0);

#!/usr/bin/env node
// chart-color scanner — surfaces sites that hard-code recharts series
// colors instead of routing through --chart-1..5 tokens. It records
// evidence; a separate pass executes the palette mapping.
// Usage: node scripts/design/scan-chart-colors.mjs [--json]

import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const args = new Set(process.argv.slice(2));
const JSON_OUT = args.has("--json");

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

const EXT = new Set([".tsx", ".ts", ".jsx", ".js"]);

const CHART_HINT = /\b(?:recharts|<Pie|<Line|<Bar|<Area|<Cell|<Radar|<Scatter|stroke=|fill=)/;
const HEX = /#[0-9a-fA-F]{3,8}\b/g;

async function* walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (e.isFile()) yield full;
  }
}

const findings = [];

for await (const file of walk(join(ROOT, "src"))) {
  const ext = file.slice(file.lastIndexOf("."));
  if (!EXT.has(ext)) continue;
  const text = await readFile(file, "utf8");
  if (!CHART_HINT.test(text)) continue;
  const rel = relative(ROOT, file).split(sep).join("/");
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!CHART_HINT.test(line) && !/stroke=|fill=/.test(line)) continue;
    const matches = line.matchAll(HEX);
    for (const m of matches) {
      const value = m[0];
      if (/^#(?:fff|FFF|ffffff|FFFFFF|000|000000)$/.test(value)) continue;
      findings.push({ file: rel, line: i + 1, value });
    }
  }
}

if (JSON_OUT) {
  process.stdout.write(
    JSON.stringify({ findings, count: findings.length }, null, 2) + "\n",
  );
} else if (findings.length === 0) {
  console.log("[scan-chart-colors] OK — no raw chart color hits");
} else {
  console.error(`[scan-chart-colors] WARN — ${findings.length} raw chart color literal(s):`);
  for (const f of findings.slice(0, 80)) {
    console.error(`  ${f.file}:${f.line}  ${f.value}`);
  }
  if (findings.length > 80) console.error(`  … and ${findings.length - 80} more`);
  console.error("");
  console.error(
    "Chart series colors must use --chart-1..5 tokens (mapped to spec accents).",
  );
}

// This scanner does NOT fail the build — it records evidence for a future
// CI gate.
process.exit(0);

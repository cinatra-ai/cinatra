#!/usr/bin/env node
// raw-color scanner — fails if any raw color literal lands in src/** outside the allowlist.
// Usage: node scripts/design/scan-raw-colors.mjs [--quiet] [--json]
// design-skill validation gate.

import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ALLOWLIST = JSON.parse(
  await readFile(join(ROOT, "scripts/design/allowlist-raw-colors.json"), "utf8"),
);

const args = new Set(process.argv.slice(2));
const QUIET = args.has("--quiet");
const JSON_OUT = args.has("--json");

const HEX = /#[0-9a-fA-F]{3,8}\b/g;
// Tailwind raw-palette utility classes that bypass semantic tokens. The bg-/text-/border-
// prefixes are matched against any color-family name shadcn would not have mapped.
const TW_BANNED = new RegExp(
  String.raw`\b(?:bg|text|border|ring|fill|stroke|from|to|via|caret|decoration|outline|placeholder)-(?:white|black|gray|slate|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(?:-\d+)?(?:\/\d+)?\b`,
  "g",
);
// rgb()/rgba()/hsl()/hsla() / oklch() literals
const FN_COLOR = /\b(?:rgba?|hsla?|oklch|oklab|color)\s*\([^)]+\)/g;

const EXTENSIONS = new Set([".tsx", ".ts", ".jsx", ".js", ".css", ".scss"]);
const SKIP_DIRS = new Set([
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

function isAllowlistedFile(rel) {
  for (const pat of ALLOWLIST.files) {
    if (matchGlob(pat, rel)) return true;
  }
  return false;
}

function matchGlob(pattern, str) {
  // Minimal ** + * glob support — sufficient for the patterns in the allowlist.
  const re = new RegExp(
    "^" +
      pattern
        .replace(/[.+^$()|{}\\]/g, "\\$&")
        .replace(/\*\*/g, "::DSTAR::")
        .replace(/\*/g, "[^/]*")
        .replace(/::DSTAR::/g, ".*") +
      "$",
  );
  return re.test(str);
}

function isAllowedValue(v) {
  return ALLOWLIST.values.includes(v);
}

async function* walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (e.isFile()) yield full;
  }
}

const findings = [];

const startDir = join(ROOT, "src");
try {
  await stat(startDir);
} catch {
  console.error(`[scan-raw-colors] src/ not found at ${startDir}`);
  process.exit(2);
}

for await (const file of walk(startDir)) {
  const ext = file.slice(file.lastIndexOf("."));
  if (!EXTENSIONS.has(ext)) continue;
  const rel = relative(ROOT, file).split(sep).join("/");
  if (isAllowlistedFile(rel)) continue;
  const text = await readFile(file, "utf8");
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (
      line.trimStart().startsWith("//") ||
      line.trimStart().startsWith("*")
    ) {
      continue;
    }
    const collect = (re, kind) => {
      const matches = line.matchAll(re);
      for (const m of matches) {
        const value = m[0];
        if (isAllowedValue(value)) continue;
        findings.push({ file: rel, line: i + 1, kind, match: value });
      }
    };
    collect(HEX, "hex");
    collect(FN_COLOR, "color-fn");
    collect(TW_BANNED, "tailwind-palette");
  }
}

if (JSON_OUT) {
  process.stdout.write(JSON.stringify({ findings, count: findings.length }, null, 2) + "\n");
} else if (findings.length === 0) {
  if (!QUIET) {
    console.log("[scan-raw-colors] OK — 0 unallowlisted raw color hits");
  }
} else {
  console.error(`[scan-raw-colors] FAIL — ${findings.length} unallowlisted hits:`);
  for (const f of findings.slice(0, 200)) {
    console.error(`  ${f.file}:${f.line}  (${f.kind})  ${f.match}`);
  }
  if (findings.length > 200) {
    console.error(`  … and ${findings.length - 200} more`);
  }
  console.error("");
  console.error("Use semantic tokens (text-foreground, bg-surface, border-line, etc.).");
  console.error("To allowlist a file, edit scripts/design/allowlist-raw-colors.json.");
}

process.exit(findings.length > 0 ? 1 : 0);

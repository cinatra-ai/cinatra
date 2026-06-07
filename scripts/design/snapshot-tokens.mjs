#!/usr/bin/env node
// CSS-variable snapshot — emits / diffs a JSON record of every token
// declared in src/app/globals.css. Used to detect token drift and to gate
// dark-mode regressions (R3 / D2).
// Usage:
//   node scripts/design/snapshot-tokens.mjs               # print snapshot to stdout
//   node scripts/design/snapshot-tokens.mjs --write       # write baseline file
//   node scripts/design/snapshot-tokens.mjs --check       # exit 1 on drift vs baseline

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const GLOBALS = join(ROOT, "src/app/globals.css");
const BASELINE = join(
  ROOT,
  "scripts/design/baselines/tokens-snapshot.json",
);

const args = new Set(process.argv.slice(2));
const WRITE = args.has("--write");
const CHECK = args.has("--check");

const css = await readFile(GLOBALS, "utf8");

// Extract every CSS rule body keyed by selector for the three scopes we care
// about: :root, .cinatra, .dark, and @theme inline.
function extractRules(css) {
  const rules = {};
  const re = /(:root|\.cinatra|\.dark|@theme\s+inline)\s*\{([^}]+)\}/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    const key = m[1].replace(/\s+/g, " ").trim();
    const body = m[2];
    const tokens = {};
    for (const line of body.split(/\r?\n/)) {
      const cleaned = line.replace(/\/\*.*?\*\//g, "").trim();
      const declMatch = /^(--[a-z0-9-]+)\s*:\s*([^;]+);?$/i.exec(cleaned);
      if (declMatch) {
        tokens[declMatch[1]] = declMatch[2].trim();
      }
    }
    if (rules[key]) {
      Object.assign(rules[key], tokens);
    } else {
      rules[key] = tokens;
    }
  }
  return rules;
}

const snapshot = {
  generatedAt: new Date().toISOString(),
  source: "src/app/globals.css",
  rules: extractRules(css),
};

if (WRITE) {
  await mkdir(dirname(BASELINE), { recursive: true });
  await writeFile(BASELINE, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
  console.log(`[snapshot-tokens] wrote ${BASELINE}`);
  process.exit(0);
}

if (CHECK) {
  let baseline;
  try {
    baseline = JSON.parse(await readFile(BASELINE, "utf8"));
  } catch (e) {
    console.error(`[snapshot-tokens] baseline missing at ${BASELINE}; run --write first`);
    process.exit(2);
  }
  const drift = diffRules(baseline.rules, snapshot.rules);
  if (drift.length === 0) {
    console.log("[snapshot-tokens] OK — no token drift vs baseline");
    process.exit(0);
  }
  console.error(`[snapshot-tokens] DRIFT — ${drift.length} token change(s):`);
  for (const d of drift) console.error(`  ${d}`);
  console.error("");
  console.error("If this is intentional, run: node scripts/design/snapshot-tokens.mjs --write");
  process.exit(1);
}

process.stdout.write(JSON.stringify(snapshot, null, 2) + "\n");

function diffRules(a, b) {
  const out = [];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const av = a[k] ?? {};
    const bv = b[k] ?? {};
    const tokens = new Set([...Object.keys(av), ...Object.keys(bv)]);
    for (const t of tokens) {
      if (av[t] !== bv[t]) {
        if (av[t] === undefined) {
          out.push(`+ ${k} ${t} = ${bv[t]}`);
        } else if (bv[t] === undefined) {
          out.push(`- ${k} ${t} = ${av[t]}`);
        } else {
          out.push(`~ ${k} ${t} : ${av[t]} → ${bv[t]}`);
        }
      }
    }
  }
  return out.sort();
}

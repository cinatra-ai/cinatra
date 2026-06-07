#!/usr/bin/env node
/**
 * Dev-mode fixture-coverage audit. Walks every cinatra.* table in the live DB
 * and joins against scripts/fixtures/manifest.json. Advisory: always exits 0.
 *
 *   ADD-TO-MANIFEST   table exists in DB but has no manifest entry (new domain
 *                     surfaced without a fixture decision)
 *   GAP               manifest entry is fixture-driven but row count < minRows
 *                     (seeder dropped, broken, or never written)
 *   STALE             manifest entry is retired but table still has rows (drop
 *                     migration didn't run; legacy data lingers)
 *   HINT              boot-registered table has 0 rows (`pnpm dev` not restarted)
 *
 *   pnpm seed:audit
 *
 * Run after `pnpm seed`. Output is for humans; no CI gating. When a Postgres-
 * in-CI smoke job exists, this can flip from advisory to required.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { discoverDeclaredFixtures, validateDevFixtureFile } from "./dev-fixtures-gate.mjs";
import { readFileSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MANIFEST_PATH = path.resolve(__dirname, "..", "fixtures", "manifest.json");

const DB_URL = process.env.SUPABASE_DB_URL;
const SCHEMA = (process.env.SUPABASE_SCHEMA?.trim() || "cinatra").replaceAll('"', '""');

if (!DB_URL) {
  console.error("SUPABASE_DB_URL is required. Run with --env-file=.env.local or set it.");
  process.exit(0);
}

const pool = new pg.Pool({ connectionString: DB_URL });

async function loadManifest() {
  const raw = await fs.readFile(MANIFEST_PATH, "utf8");
  const data = JSON.parse(raw);
  const byName = new Map();
  for (const t of data.tables) byName.set(t.name, t);
  return byName;
}

async function listLiveTables() {
  const r = await pool.query(
    `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 ORDER BY table_name`,
    [SCHEMA.replaceAll('""', '"')],
  );
  return r.rows.map((row) => row.table_name);
}

async function countRows(name) {
  const safeName = name.replaceAll('"', '""');
  const r = await pool.query(`SELECT COUNT(*)::int AS c FROM "${SCHEMA}"."${safeName}"`);
  return r.rows[0].c;
}

async function main() {
  console.log(`[seed-audit] schema=${SCHEMA.replaceAll('""', '"')}\n`);

  const manifest = await loadManifest();
  const live = await listLiveTables();

  const findings = {
    addToManifest: [],
    gap: [],
    stale: [],
    hint: [],
  };

  for (const name of live) {
    let count = 0;
    try {
      count = await countRows(name);
    } catch (e) {
      console.warn(`  [warn] could not COUNT(*) ${SCHEMA}.${name}: ${e.message}`);
      continue;
    }
    const entry = manifest.get(name);
    if (!entry) {
      findings.addToManifest.push({ name, count });
      continue;
    }
    if (entry.category === "fixture-driven") {
      const minRows = entry.minRows ?? 1;
      if (count < minRows) {
        findings.gap.push({ name, count, minRows, seededBy: entry.seededBy ?? "(unspecified)" });
      }
    } else if (entry.category === "retired" && count > 0) {
      findings.stale.push({ name, count });
    } else if (entry.category === "boot-registered" && count === 0) {
      findings.hint.push({ name });
    }
  }

  // Manifest entries that no longer correspond to any live table (after a
  // table is genuinely dropped). Useful for catching manifest drift.
  const liveSet = new Set(live);
  const dropped = [];
  for (const [name, entry] of manifest) {
    if (!liveSet.has(name) && entry.category !== "retired") {
      dropped.push({ name, category: entry.category });
    }
  }

  let issues = 0;
  if (findings.addToManifest.length) {
    console.log(`  ADD-TO-MANIFEST (${findings.addToManifest.length}):`);
    for (const f of findings.addToManifest) {
      console.log(`    - ${f.name} (${f.count} rows) — classify in scripts/fixtures/manifest.json`);
    }
    issues += findings.addToManifest.length;
  }
  if (findings.gap.length) {
    console.log(`  GAP (${findings.gap.length}):`);
    for (const f of findings.gap) {
      console.log(`    - ${f.name}: ${f.count}/${f.minRows} rows (seeded by ${f.seededBy})`);
    }
    issues += findings.gap.length;
  }
  if (findings.stale.length) {
    console.log(`  STALE (${findings.stale.length}):`);
    for (const f of findings.stale) {
      console.log(`    - ${f.name}: still has ${f.count} rows but manifest says retired`);
    }
    issues += findings.stale.length;
  }
  if (findings.hint.length) {
    console.log(`  HINT (${findings.hint.length}, boot-registered tables empty — restart pnpm dev?):`);
    for (const f of findings.hint) {
      console.log(`    - ${f.name}`);
    }
  }
  if (dropped.length) {
    console.log(`  DROPPED (${dropped.length}, manifest entries with no live table):`);
    for (const f of dropped) {
      console.log(`    - ${f.name} [${f.category}]`);
    }
  }

  if (issues === 0 && findings.hint.length === 0 && dropped.length === 0) {
    console.log("  clean — every cinatra.* table is accounted for in the manifest.");
  }

  // Extension-declared dev fixtures are a coverage SOURCE in addition to
  // scripts/seed.mjs: a `setting` fixture lands on the `metadata` (connector_config)
  // table and an `object` fixture on `objects`. Surfaced here so a reader knows a
  // fixture-covered surface need not be flagged GAP/ADD-TO-MANIFEST. (Row-count
  // reconciliation across host seed + extension fixtures waits for the cutover
  // that moves per-extension demo rows out of scripts/seed.mjs.)
  const extFixtures = discoverDeclaredFixtures();
  if (extFixtures.length > 0) {
    console.log(`\n  EXTENSION DEV-FIXTURES (coverage sources, ${extFixtures.length}):`);
    for (const ext of extFixtures) {
      let surfaces = "(unreadable)";
      try {
        const parsed = JSON.parse(readFileSync(ext.filePath, "utf8"));
        if (validateDevFixtureFile(parsed).length === 0) {
          const counts = parsed.fixtures.reduce((acc, f) => ((acc[f.surface] = (acc[f.surface] ?? 0) + 1), acc), {});
          surfaces = Object.entries(counts)
            .map(([s, n]) => `${n} ${s}${n === 1 ? "" : "s"}`)
            .join(", ");
        }
      } catch {
        /* leave as (unreadable); the dev-fixtures-gate is the hard validator */
      }
      console.log(`    - ${ext.packageName}: ${surfaces} → ${ext.declared}`);
    }
  }

  console.log("\n[seed-audit] advisory — exit 0 always.");
  await pool.end();
}

main().catch(async (err) => {
  console.error("[seed-audit] failed:", err);
  await pool.end();
  process.exitCode = 0;
});

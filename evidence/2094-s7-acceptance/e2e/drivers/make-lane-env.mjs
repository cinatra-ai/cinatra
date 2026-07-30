/**
 * Lane env generator (cinatra#2094 S7 item 3a).
 *
 * The SANCTIONED path to a lane `.env.local`: the source env is read
 * PROGRAMMATICALLY and rewritten with the lane's own isolation overrides. No
 * value is ever printed, logged, or copied by hand — the script reports only
 * KEY NAMES and a count, so running it cannot leak a credential into a
 * transcript or into this public repo.
 *
 * It is deliberately NOT `cinatra instance branch setup`: that command
 * ledger-FAKES the core migration chain on a fresh schema and then SEEDS the
 * new schema from the source schema's business data (including `metadata`).
 * This acceptance needs the opposite on both counts — REAL migrations, and a
 * genuinely PRE-SETUP instance whose provider/readiness rows do not exist yet.
 *
 * Overrides (everything else is carried through byte-for-byte, order preserved):
 *   SUPABASE_DB_URL        -> the lane's OWN Postgres (never the shared 5634)
 *   SUPABASE_SCHEMA        -> cinatra (the lane DB is exclusively ours)
 *   REDIS_URL              -> the lane's OWN Redis (never the shared 6579)
 *   BULLMQ_QUEUE_NAME      -> lane-unique, so no sibling lane drains our queue
 *   PORT / *_URL           -> the lane's OWN dev port
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

const SOURCE = process.env.LANE_SOURCE_ENV;
const OUT = process.env.LANE_OUT_ENV;
const PORT = process.env.LANE_PORT ?? "3294";
const PG_PORT = process.env.LANE_PG_PORT ?? "5294";
const REDIS_PORT = process.env.LANE_REDIS_PORT ?? "6294";
const SLUG = process.env.LANE_SLUG ?? "lane2094";

if (!SOURCE || !OUT) {
  console.error("LANE_SOURCE_ENV and LANE_OUT_ENV are required");
  process.exit(1);
}
if (!existsSync(SOURCE)) {
  console.error(`source env not found: ${SOURCE}`);
  process.exit(1);
}

const base = `http://localhost:${PORT}`;
const overrides = {
  SUPABASE_DB_URL: `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/postgres`,
  SUPABASE_SCHEMA: "cinatra",
  REDIS_URL: `redis://127.0.0.1:${REDIS_PORT}`,
  BULLMQ_QUEUE_NAME: `cinatra-bg-${SLUG}`,
  PORT: String(PORT),
  BETTER_AUTH_URL: base,
  NEXT_PUBLIC_BETTER_AUTH_URL: base,
  NEXT_PUBLIC_APP_URL: base,
  NEXT_PUBLIC_SITE_URL: base,
};

const raw = readFileSync(SOURCE, "utf8");
const lines = raw.split(/\r?\n/);
const out = [];
const seen = new Set();
let carried = 0;

for (const line of lines) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    out.push(line);
    continue;
  }
  const eq = trimmed.indexOf("=");
  if (eq === -1) {
    out.push(line);
    continue;
  }
  const key = trimmed.slice(0, eq).trim();
  if (key in overrides) {
    out.push(`${key}=${overrides[key]}`);
    seen.add(key);
  } else {
    out.push(line);
    carried += 1;
  }
}

// Any override the source did not declare still has to be present.
for (const [key, value] of Object.entries(overrides)) {
  if (!seen.has(key)) {
    out.push(`${key}=${value}`);
    seen.add(key);
  }
}

writeFileSync(OUT, out.join("\n"), { mode: 0o600 });

// KEY NAMES ONLY — never a value.
console.log(`[lane-env] wrote ${OUT}`);
console.log(`[lane-env] carried through ${carried} key(s) from the source env unchanged`);
console.log(`[lane-env] overrode: ${[...seen].sort().join(", ")}`);

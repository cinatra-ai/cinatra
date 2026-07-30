/**
 * Seed a provider's stored connection row — the ONE step of this acceptance that
 * is not driven through the UI, and the same deliberate exception S6 recorded
 * (`evidence/2093-s6-setup/drivers/seed-anthropic-connection.mjs`).
 *
 * WHY, stated plainly:
 *   The connector's own key writer (`saveAnthropicAPISettings`) HARD-REQUIRES a
 *   configured connection service (Nango) and, on import, has Nango verify the
 *   credential from inside Nango's OWN container. This lane runs no Nango, which
 *   is the NORMAL pre-setup state — the wizard still shows Connections as
 *   incomplete. S6 already drove that arm to its conclusion and its F1 fix is
 *   merged and proven (the in-page actionable state + the Connections
 *   fix-forward), so re-driving it proves nothing new here.
 *
 *   What this writes is EXACTLY the durable state a successful save leaves
 *   behind: the DB-fallback credential row the connector reads when no Nango
 *   pointer exists (`readAnthropicConnectionFromDatabase` ->
 *   `connector_config:anthropic_connection`). The surfaces actually under proof
 *   — the readiness saga and the assistant run — then execute for real, from the
 *   UI, against the REAL provider API.
 *
 * LEAK GATE: the key is read from a mode-600 file OUTSIDE the repo and is passed
 * to psql over STDIN, never as an argv element (argv is world-readable via `ps`)
 * and never echoed. This script prints only the row key and a boolean.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const CONTAINER = process.env.LANE_PG_CONTAINER ?? "lane2094-pg";
const KEY_FILE = process.env.LANE_KEY_FILE;
const PROVIDER = process.env.LANE_PROVIDER ?? "anthropic";
const MCP_MODE = process.env.LANE_MCP_MODE ?? "";

if (!KEY_FILE) {
  console.error("LANE_KEY_FILE is required");
  process.exit(1);
}
const apiKey = readFileSync(KEY_FILE, "utf8").trim();
if (!apiKey) {
  console.error("key file is empty");
  process.exit(1);
}

/** Run SQL via STDIN so no value ever reaches argv. */
function psql(sql) {
  return execFileSync(
    "docker",
    ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-f", "-"],
    { input: sql, encoding: "utf8" },
  );
}

/** Dollar-quote with a tag that cannot occur in the payload. */
function lit(value) {
  let tag = "v";
  while (value.includes(`$${tag}$`)) tag += "v";
  return `$${tag}$${value}$${tag}$`;
}

function upsert(key, valueJson) {
  psql(
    `insert into cinatra.metadata(key, value) values (${lit(key)}, ${lit(valueJson)})
     on conflict (key) do update set value = excluded.value;`,
  );
  console.log(`upserted ${key}`);
}

if (PROVIDER === "anthropic") {
  upsert(
    "connector_config:anthropic_connection",
    JSON.stringify({ apiKey, lastValidatedAt: new Date().toISOString() }),
  );
  if (MCP_MODE) {
    upsert("connector_config:anthropic", JSON.stringify({ mcpMode: MCP_MODE }));
    console.log(`mcpMode=${MCP_MODE}`);
  }
} else if (PROVIDER === "openai") {
  // OpenAI's stored connection row (the legacy top-level key its reader uses).
  upsert(
    "openai_connection",
    JSON.stringify({ apiKey, lastValidatedAt: new Date().toISOString() }),
  );
} else {
  console.error(`unknown provider ${PROVIDER}`);
  process.exit(1);
}

console.log(`[seed] ${PROVIDER} credential row written (value never printed)`);

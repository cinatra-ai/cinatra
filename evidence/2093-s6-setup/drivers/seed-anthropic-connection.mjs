/**
 * Seed the ANTHROPIC connector's stored connection state directly, and flip its
 * stored `mcpMode`.
 *
 * WHY THIS EXISTS — stated plainly, because it is the one step of this proof
 * that is NOT driven through the UI:
 *
 *   The connector's own key writer (`saveAnthropicAPISettings`) hard-requires a
 *   configured connection service (Nango) and, on import, has Nango VERIFY the
 *   credential against the real Anthropic API from inside Nango's own container
 *   — outside this lane's host-process boundary stub. With no live Anthropic key
 *   available to this lane, that arm cannot be driven honestly, so it is recorded
 *   as NOT DRIVEN rather than simulated. What this script writes is exactly the
 *   DURABLE STATE a successful save would have left behind (the DB-fallback
 *   credential row the connector reads when no Nango pointer exists), so the
 *   surface actually under proof — the readiness saga and its rendered states —
 *   runs for real from the UI.
 *
 *   `mcpMode` has no wizard affordance at all (it is an admin Skills-tab
 *   setting, and every authenticated admin route redirects back into the wizard
 *   while setup is incomplete), so flipping it here is the only way to reach the
 *   saga's success arm during setup.
 *
 * Both keys are ordinary plaintext JSON in `cinatra.metadata`: the connector-config
 * seal allow-map covers `nango.secretKey` ONLY, so no encryption is involved and
 * this write is byte-identical in shape to the app's own.
 */
import { execFileSync } from "node:child_process";

const CONTAINER = process.env.LANE_PG_CONTAINER ?? "s6-2093-pg";
const API_KEY = process.env.LANE_ANTHROPIC_KEY ?? "lane2093-anthropic-not-a-real-key";
const MCP_MODE = process.env.LANE_MCP_MODE ?? "function-tools";

function upsert(key, value) {
  const sql = `insert into cinatra.metadata(key, value) values ($$${key}$$, $$${value}$$)
               on conflict (key) do update set value = excluded.value;`;
  execFileSync("docker", ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", sql], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  console.log(`upserted ${key}`);
}

upsert(
  "connector_config:anthropic_connection",
  JSON.stringify({ apiKey: API_KEY, lastValidatedAt: new Date().toISOString() }),
);
upsert("connector_config:anthropic", JSON.stringify({ mcpMode: MCP_MODE }));
console.log(`mcpMode=${MCP_MODE}`);

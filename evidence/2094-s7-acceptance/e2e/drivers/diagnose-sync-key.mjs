/**
 * Isolate WHY the container delivery resolver reports the assistant's skills
 * unsynced even though the readiness saga wrote non-stale sync rows for two of
 * them (cinatra#2094 S7 item 3a, finding F7b).
 *
 * The resolver's lookup key is `(api_key_fingerprint, environment,
 * catalog_skill_id)`. This recomputes the first two EXACTLY as the shipped code
 * does (src/lib/anthropic-skill-sync-service.ts: deriveApiKeyFingerprint /
 * deriveEnvironmentNamespace) and diffs them against what is actually stored, so
 * the answer is a measured comparison rather than a guess.
 *
 * LEAK GATE: prints only digests, a boolean, and whether each component MATCHES.
 * A digest is a one-way hash and is already stored in the table; the API key and
 * BETTER_AUTH_SECRET themselves are never printed, and only their PRESENCE is
 * reported.
 */
import { createHash, createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import process from "node:process";

const CONTAINER = process.env.LANE_PG_CONTAINER ?? "lane2094-pg";
const sql = (q) =>
  execFileSync("docker", ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-tAc", q], {
    encoding: "utf8",
  }).trim();

// --- the stored credential, read the same way the shipped code reads it -----
const raw = sql("select coalesce(value,'') from cinatra.metadata where key='connector_config:anthropic_connection'");
let apiKey = "";
try {
  apiKey = String(JSON.parse(raw)?.apiKey ?? "").trim();
} catch {
  /* absent */
}
console.log(`stored anthropic credential row present: ${Boolean(apiKey)}`);

const secret = process.env.BETTER_AUTH_SECRET?.trim();
console.log(`BETTER_AUTH_SECRET visible to this process: ${Boolean(secret)}`);

const fp = apiKey
  ? secret
    ? createHmac("sha256", secret).update(apiKey).digest("hex")
    : createHash("sha256").update(apiKey).digest("hex")
  : null;
const fpNoSecret = apiKey ? createHash("sha256").update(apiKey).digest("hex") : null;

// --- environment namespace, recomputed exactly -----------------------------
const dbUrl = process.env.SUPABASE_DB_URL?.trim();
let env = null;
if (dbUrl) {
  const schema = process.env.SUPABASE_SCHEMA?.trim() || "cinatra";
  let dbIdentity = dbUrl;
  try {
    const u = new URL(dbUrl);
    dbIdentity = `${u.hostname}:${u.port || "5432"}${u.pathname}`;
  } catch {
    dbIdentity = dbUrl;
  }
  const dbHash = createHash("sha256").update(dbIdentity).digest("hex").slice(0, 16);
  const dep = process.env.CINATRA_DEPLOYMENT_ENV?.trim() || "";
  env = `schema=${schema};db=${dbHash};dep=${dep}`;
}

const storedFp = sql(
  "select distinct api_key_fingerprint from cinatra.anthropic_skill_sync limit 1",
);
const storedEnv = sql("select distinct environment from cinatra.anthropic_skill_sync limit 1");

console.log(`\ncomputed fingerprint (hmac path) : ${fp ?? "<null>"}`);
console.log(`computed fingerprint (sha path)  : ${fpNoSecret ?? "<null>"}`);
console.log(`stored   fingerprint             : ${storedFp || "<no rows>"}`);
console.log(`fingerprint MATCHES (hmac)       : ${fp === storedFp}`);
console.log(`fingerprint MATCHES (sha)        : ${fpNoSecret === storedFp}`);
console.log(`\ncomputed environment             : ${env ?? "<null>"}`);
console.log(`stored   environment             : ${storedEnv || "<no rows>"}`);
console.log(`environment MATCHES              : ${env === storedEnv}`);

// --- what the resolver would actually find for the assistant's five ---------
const required = [
  "@cinatra-ai/chat:chat-assistant-core",
  "@cinatra-ai/chat:chat-extension-authoring",
  "@cinatra-ai/chat:chat-automation-authoring",
  "@cinatra-ai/chat:company-research",
  "@cinatra-ai/chat:blog-content",
];
console.log(`\nper-skill lookup under the COMPUTED key:`);
for (const id of required) {
  const n = fp && env
    ? Number(
        sql(
          `select count(*) from cinatra.anthropic_skill_sync where api_key_fingerprint='${fp}' and environment='${env.replace(/'/g, "''")}' and catalog_skill_id='${id}' and stale=false`,
        ),
      )
    : 0;
  const anyKey = Number(
    sql(`select count(*) from cinatra.anthropic_skill_sync where catalog_skill_id='${id}'`),
  );
  const flag = sql(
    `select coalesce((payload::json->>'allowAnthropicUpload'),'<absent>') from cinatra.skills where id='${id}'`,
  );
  console.log(
    `  ${id.padEnd(45)} rowUnderComputedKey=${n} rowUnderAnyKey=${anyKey} allowAnthropicUpload=${flag}`,
  );
}

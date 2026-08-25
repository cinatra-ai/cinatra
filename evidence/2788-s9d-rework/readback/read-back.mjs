// THE READBACK, EXECUTABLE. Round 5's answer to "your Markdown asserts database
// values and commits nothing a reader can check."
//
// This script produces `db-readback.json` beside it. It takes the four ids the
// LANE supplies — the pictured run, the never-armed run behind C7, and the two
// threads — and prints back exactly the rows RUN-READBACK.md and TIMELINE.md
// quote, straight out of the tables named there. It writes no row, and it takes
// no value from its caller other than which ids to read.
//
//   SUPABASE_DB_URL=… RUN_ID=… SETUP_RUN_ID=… THREAD_ID=… EXPIRED_THREAD_ID=… \
//     BETTER_AUTH_SECRET=… node evidence/2788-s9d-rework/readback/read-back.mjs
//
// BETTER_AUTH_SECRET is REQUIRED, and required loudly. The proposal ref is
// sealed with a key derived from it, so without the instance's own secret the
// turn-to-run derivation cannot be computed — and a reader who gets a file with
// `proposalRefDecoded` quietly missing would have no way to tell "this lane had
// no proposal" from "whoever ran this had the wrong key". So a ref that is
// present and cannot be opened is a FAILURE here, not an omission.
//
// The committed `db-readback.json` is this script's own output, unedited. It
// carries no credential: the connection string is read from the environment and
// never recorded, and the proposal `ref` is deliberately NOT selected — the
// consume identity derived from it is (a hash of a spent, expired single-use
// nonce), which is what binds the conversation to the run.
import { Client } from "pg";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, createHmac, createDecipheriv } from "node:crypto";

const need = (n) => { const v = process.env[n]; if (!v) throw new Error(`read-back needs ${n}`); return v; };
need("BETTER_AUTH_SECRET");
const RUN = need("RUN_ID"), SETUP = need("SETUP_RUN_ID"), THREAD = need("THREAD_ID"), EXPIRED = need("EXPIRED_THREAD_ID");
const c = new Client({ connectionString: need("SUPABASE_DB_URL") });
await c.connect();
const rows = async (sql, p) => (await c.query(sql, p)).rows;

const out = {
  $comment: [
    "Produced by evidence/2788-s9d-rework/readback/read-back.mjs. Unedited.",
    "Every value RUN-READBACK.md and TIMELINE.md quote for round 5 is in here.",
  ],
  picturedRun: await rows(
    `SELECT id, status, template_id, run_by, created_at, started_at, completed_at, error
       FROM cinatra.agent_runs WHERE id = $1`, [RUN]),
  picturedRunTrigger: await rows(
    `SELECT run_id, trigger_type, scheduled_at, timezone, enabled, cron_expression,
            job_scheduler_id, created_at, released_at
       FROM cinatra.agent_run_triggers WHERE run_id = $1`, [RUN]),
  proposalConsume: await rows(
    `SELECT consume_key, run_id, org_id, template_id, consumed_by, consumed_at
       FROM cinatra.trigger_schedule_proposal_consumes WHERE run_id = $1`, [RUN]),
  neverArmedRunBehindC7: await rows(
    `SELECT id, status, created_at FROM cinatra.agent_runs WHERE id = $1`, [SETUP]),
  neverArmedRunTriggerRowCount: await rows(
    `SELECT count(*)::int AS n FROM cinatra.agent_run_triggers WHERE run_id = $1`, [SETUP]),
  threads: await rows(
    `SELECT thread_id, count(*)::int AS turns, min(created_at) AS first_turn
       FROM cinatra.assistant_turns WHERE thread_id = ANY($1) GROUP BY thread_id`,
    [[THREAD, EXPIRED]]),
  // THE DISPATCH PART ITSELF, which is what says the REAL provider chose the
  // tool. Only the structural fields are emitted — role, the tool call's name,
  // its `serverLabel` and its provider-side id — plus the assistant's own text.
  // The provider-hosted MCP call carries an `mcp_…` id in the PROVIDER's id
  // space; the scripted bridge has no such thing to emit.
  //
  // THE PROPOSAL REF IS DELIBERATELY NOT EMITTED. It is a single-use encrypted
  // token, and a committed token is a habit worth not having even when it is
  // spent and expired. What IS emitted is everything the ref *proves*, derived
  // from it here with the shipped constants: the bindings it carries, its own
  // `iat`/`exp` (the shipped 1800-second window), and the consume identity that
  // is the primary key of the consume row above. That derivation is the
  // turn-to-run binding, and it is computed rather than asserted.
  threadDispatch: await (async () => {
    const turns = await rows(
      `SELECT role, run_id, status, content, created_at
         FROM cinatra.assistant_turns WHERE thread_id = $1 ORDER BY created_at`, [THREAD]);
    const INFO = "cinatra:trigger-schedule-proposal:v1";
    const secret = process.env.BETTER_AUTH_SECRET;
    const out = [];
    for (const t of turns) {
      const raw = typeof t.content === "string" ? t.content : JSON.stringify(t.content);
      let parsed; try { parsed = JSON.parse(raw); } catch { parsed = {}; }
      const parts = Array.isArray(parsed.parts) ? parsed.parts : [];
      out.push({
        role: t.role,
        created_at: t.created_at,
        text: typeof parsed.content === "string" ? parsed.content : null,
        parts: parts.map((x) => ({
          type: x.type ?? x.kind ?? null,
          name: x.name ?? null,
          serverLabel: x.serverLabel ?? null,
          id: x.id ?? null,
          resultLabel: x.resultLabel ?? null,
        })),
      });
      const refs = [...raw.matchAll(/"ref"\s*:\s*"([A-Za-z0-9_-]{40,})"/g)];
      if (refs.length > 0 && !secret) {
        throw new Error(
          "this turn carries a proposal ref and BETTER_AUTH_SECRET is not set — " +
            "refusing to write a readback whose turn-to-run derivation is silently absent",
        );
      }
      for (const m of refs) {
        try {
          const key = createHmac("sha256", secret).update(INFO).digest();
          const buf = Buffer.from(m[1], "base64url");
          const d = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
          d.setAuthTag(buf.subarray(buf.length - 16));
          const [version, templateId, userId, orgId, , nonce, iat, exp] = JSON.parse(
            Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]).toString("utf8"));
          out[out.length - 1].proposalRefDecoded = {
            version, templateId, userId, orgId,
            iat: new Date(iat * 1000).toISOString(),
            exp: new Date(exp * 1000).toISOString(),
            ttlSeconds: exp - iat,
            derivedConsumeKey: createHash("sha256").update(`${INFO}|${nonce}`).digest("hex"),
            note: "derived here from the ref in this turn; the ref itself is not emitted",
          };
        } catch (err) {
          throw new Error(
            `a proposal ref in this thread could not be opened with this instance's key ` +
              `(${err instanceof Error ? err.message : String(err)}) — refusing to write a ` +
              `readback that would look complete while the binding was never derived`,
          );
        }
      }
    }
    return out;
  })(),
  // The provider ledger — which provider and which model actually served the
  // pictured chat turn and the agent's own execution.
  usageEvents: await rows(
    `SELECT source, operation, provider, model, requested_provider, effective_provider,
            input_tokens, output_tokens, created_at
       FROM cinatra.usage_events ORDER BY created_at`),
  // Every armed run this lane produced, so the discarded passes are visible too.
  allRunsAndTriggers: await rows(
    `SELECT r.id, r.status, r.created_at, r.completed_at,
            t.scheduled_at, t.released_at
       FROM cinatra.agent_runs r
       LEFT JOIN cinatra.agent_run_triggers t ON t.run_id = r.id
      ORDER BY r.created_at`),
  readBackAt: new Date().toISOString(),
};
await c.end();
const dest = join(dirname(fileURLToPath(import.meta.url)), "db-readback.json");
writeFileSync(dest, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${dest}`);

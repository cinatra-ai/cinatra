// Same test boundary as tests/e2e/agents-run/review-gate-fixture.ts: only
// creation is seeded. The shipped BullMQ worker and WayFlow execute the run;
// this command never marks a run completed or fabricates its outputs.
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { Client } from "pg";
import { Queue } from "bullmq";
import { assertScreenshotFixtureRuntime } from "./lib/screenshot-capture.ts";

assertScreenshotFixtureRuntime();
const { values } = parseArgs({ options: Object.fromEntries(["org", "user", "url"].map(name => [name, {type:"string" as const}])) });
if (!values.org || !values.user || !values.url) throw new Error("--org, --user and --url are required");
if (!process.env.SUPABASE_DB_URL || !process.env.REDIS_URL || !process.env.BULLMQ_QUEUE_NAME) throw new Error("An isolated database, Redis and explicit queue name are required");
const schema = (process.env.SUPABASE_SCHEMA ?? "cinatra").replaceAll('"', '""');
const db = new Client({ connectionString: process.env.SUPABASE_DB_URL, connectionTimeoutMillis: 5000 });
await db.connect();
let queue: Queue | undefined;
try {
  const template = (await db.query(`SELECT id, package_version FROM "${schema}".agent_templates WHERE package_name=$1`, ["@codex-widget-proof/screenshot-proof"])).rows;
  if (template.length !== 1) throw new Error("Stage the private screenshot fixture into extensions and restart the development app first");
  queue = new Queue(process.env.BULLMQ_QUEUE_NAME, { connection: { url: process.env.REDIS_URL } });
  await queue.waitUntilReady();
  const runId = randomUUID();
  await db.query(`INSERT INTO "${schema}".agent_runs
    (id, template_id, run_by, status, input_params, source_type, package_version, ag_ui_enabled, org_id)
    VALUES ($1,$2,$3,'queued',$4,'agent_builder',$5,true,$6)`,
  [runId, template[0].id, values.user, JSON.stringify({ capture_url: values.url }), template[0].package_version, values.org]);
  await queue.add("agent-builder-execution", {
    runId, __actorContext: {
      principalType: "HumanUser", principalId: values.user, organizationId: values.org,
      platformRole: "platform_admin", orgRole: "member", authSource: "ui", policyVersion: "v2",
    },
  }, { jobId: runId, removeOnComplete: 200, removeOnFail: 500, attempts: 1 });
  console.log(JSON.stringify({ runId, status: "queued" }));
  const deadline = Date.now() + 180_000;
  for (;;) {
    const result = await db.query(`SELECT status FROM "${schema}".agent_runs WHERE id=$1 AND org_id=$2`, [runId, values.org]);
    const status = result.rows[0]?.status;
    if (status === "completed") { console.log(JSON.stringify({ runId, status })); break; }
    if (["failed", "stopped", "cancelled"].includes(status)) throw new Error(`Fixture run ${runId} ended as ${status}; inspect its real run page`);
    if (Date.now() >= deadline) throw new Error(`Fixture run ${runId} did not complete in 180 seconds; inspect its worker and WayFlow runtime`);
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
} finally {
  await queue?.close();
  await db.end();
}

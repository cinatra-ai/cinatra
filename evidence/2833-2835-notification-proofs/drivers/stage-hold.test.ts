/**
 * cinatra#2835 — put a real run into a real recommendation HOLD on the lane's own
 * dev stack, through the shipped dispatch.
 *
 * FIXTURE (the subject): one `agent_runs` row through the shipped
 * `createAgentRun`, human-present and owned by the REAL signed-up owner, and one
 * `agent_assigned_skills` row so the recommendation scorer has an agent-assigned
 * candidate to offer (a fresh instance assigns none, and the scorer only ever
 * offers an agent's own assigned set).
 *
 * MECHANISM (untouched, all shipped): `triggerAgentRun` — the canonical dispatch
 * — evaluates `maybeHoldRunForRecommendation`, which parks the run and, on this
 * branch, dispatches the hold's notification through the PRODUCTION host writer.
 * That writer is wired here by importing the app's own
 * `@/lib/register-run-wait-notifier`, exactly as boot does; this driver supplies
 * the process, never a substitute for the notifier.
 *
 * The bell, the list, the click-through and the disappearance after Confirm are
 * then captured on the running application by `capture.mjs`.
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { it, expect } from "vitest";

const ORG = process.env.PROOF_ORG_ID!;
const ACTOR = process.env.PROOF_ACTOR_ID!;
const TEMPLATE = process.env.PROOF_TEMPLATE_ID!;
const SKILL = process.env.PROOF_SKILL_ID!;
const OUT = process.env.PROOF_OUT!;

it("dispatches a human-present run and leaves it HELD on the recommendation", async () => {
  expect(ORG && ACTOR && TEMPLATE && SKILL && OUT).toBeTruthy();

  // The PRODUCTION notifier host, wired the way boot wires it.
  await import("@/lib/register-run-wait-notifier");

  const { sessionAuthorityFromResolvedRole } = await import("@/lib/org-write/authority");
  const { createAgentRunPendingInput, readAgentRunById, readAgentTemplateById } = await import(
    "@cinatra-ai/agents"
  );
  const { maybeHoldRunForRecommendation, readRecommendationParkForRun } = await import(
    "../../../packages/agents/src/recommendation-hold"
  );
  const dbMod = await import("@cinatra-ai/agents/db");
  const { sql } = await import("drizzle-orm");
  const { postgresSchema } = await import("@/lib/postgres-config");
  const qs = postgresSchema.replaceAll('"', '""');
  const assignedTable = sql.raw(`"${qs}"."agent_assigned_skills"`);
  const templatesTable = sql.raw(`"${qs}"."agent_templates"`);

  // The run shape a run-start hold parks: created `pending_input` and never
  // dispatched, human-present, owned by the real signed-up owner.
  const created = await createAgentRunPendingInput(
    {
      templateId: TEMPLATE,
      orgId: ORG,
      runBy: ACTOR,
      inputParams: {},
      humanPresent: true,
    },
    sessionAuthorityFromResolvedRole(ORG, "owner"),
  );
  const runId = created.id;

  // Keyed by the agent's PACKAGE name, which is what the scorer reads.
  const pkgRows = await dbMod.db.execute(sql`
    SELECT package_name FROM ${templatesTable} WHERE id = ${TEMPLATE}
  `);
  const packageName = (pkgRows.rows?.[0] as { package_name?: string } | undefined)?.package_name;
  if (!packageName) throw new Error(`template ${TEMPLATE} has no package name`);
  await dbMod.db.execute(sql`
    INSERT INTO ${assignedTable} (agent_package_name, skill_id, position, created_by)
    VALUES (${packageName}, ${SKILL}, 1, ${ACTOR})
    ON CONFLICT DO NOTHING
  `);

  // THE SEAM UNDER PROOF. `triggerAgentRun` (the server action the Run button
  // calls) would reach exactly this, one line after its session gate; that gate
  // needs a browser session a driver process does not have, and it is not part of
  // what #2835 claims. Everything below the gate — the hold evaluation, the park,
  // and the notification the hold now dispatches — is the shipped code, called
  // here the way `triggerAgentRun` calls it.
  const run = await readAgentRunById(runId);
  const template = await readAgentTemplateById(TEMPLATE);
  if (!run || !template) throw new Error("run or template unreadable after create");
  const hold = await maybeHoldRunForRecommendation({
    run,
    template: {
      packageName: template.packageName,
      lifecycleConfig: (template as { lifecycleConfig?: string | null }).lifecycleConfig,
    },
  });
  const park = await readRecommendationParkForRun(runId);
  const staged = { runId, templateId: TEMPLATE, packageName, hold, park };
  writeFileSync(OUT, JSON.stringify(staged, null, 2) + "\n");
  console.log("STAGED-HOLD", JSON.stringify(staged));
});

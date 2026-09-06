/**
 * Run-scoped HITL prompt primitives (#1794) — REAL store + REAL seam.
 *
 * Proves against the verify-stack Postgres what a mocked store cannot:
 *   - the store-level (run, agent) predicate on readAllHitlPromptsForRun and
 *     updateHitlPromptsExcludedForRunAgent actually rejects cross-run AND
 *     cross-agent rows (defense-in-depth below the handler's own membership
 *     check), and the scoped update is idempotent;
 *   - the deterministic pre-interrupt seam end-to-end: inside a run-bound
 *     mcpRequestContextStorage frame (exactly what /api/agents/passthrough
 *     establishes), the real primitives list the run's own prompts and exclude
 *     one, with the change reflected on a re-list — outputs a DataFlowEdge wires
 *     into the gate payload.
 *
 * DB-gated: skips when SUPABASE_DB_URL is unset (mirrors the run-token test).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";

const dbUrl = process.env.SUPABASE_DB_URL;
const hasDb =
  typeof dbUrl === "string" &&
  dbUrl.length > 0 &&
  !dbUrl.includes("unused:unused@");

const ORG = "org-hitl-prims";
// cinatra#1939 wave 2 / #1940 P3: createAgentRun now runs under guardOrgMutation
// and REQUIRES a host-minted authority; the guard also reads the org's
// lifecycle from `public."organization"` — this DB-gated suite needs an
// ACTIVE org row for ORG for the guarded writes to pass at runtime (seeded in
// beforeAll / cleaned up in afterAll below).
const AUTH = { orgId: ORG, can: () => true };
// cinatra#2485 C — the run-scope gate re-resolves a run's `run_by` LIVE against
// better-auth (`resolveOrgRoleForUser`), so a synthetic run owner with no
// membership row is refused as cross-org. Every run below carries this human, so
// it is seeded as a REAL member of ORG (the pattern
// `lifecycle-repair-dispatch.integration.test.ts` documents: "the dispatch-time
// principal gate needs a live-resolvable org role"). `public."user"` /
// `public."member"` are better-auth tables and live UNQUALIFIED in `public`.
// Suite-UNIQUE ids: `public."user"` is shared by every suite in this DB, so a
// generic id could adopt (and then delete) a row this suite did not create.
const RUN_OWNER = "user-hitl-prims-owner";
const SEAM_OWNER = "user-hitl-prims-seam";
const MEMBERS = [RUN_OWNER, SEAM_OWNER] as const;

type Store = typeof import("../store");
let store: Store;

beforeAll(async () => {
  if (!hasDb) return;
  store = await import("../store");
  const c = new Client({ connectionString: dbUrl });
  await c.connect();
  await c.query(
    `INSERT INTO public."organization" (id, name, slug, "createdAt") VALUES ($1, $2, $3, now()) ON CONFLICT (id) DO NOTHING`,
    [ORG, ORG, ORG],
  );
  for (const userId of MEMBERS) {
    await c.query(
      `INSERT INTO public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
       VALUES ($1, $1, $2, false, now(), now()) ON CONFLICT (id) DO NOTHING`,
      [userId, `${userId}@hitl-prims.test`],
    );
    await c.query(
      `INSERT INTO public."member" (id, "organizationId", "userId", role, "createdAt")
       VALUES ($1, $2, $3, 'member', now()) ON CONFLICT (id) DO NOTHING`,
      [`m-hitl-prims-${userId}`, ORG, userId],
    );
  }
  await c.end();
});

afterAll(async () => {
  if (!hasDb) return;
  const c = new Client({ connectionString: dbUrl });
  await c.connect();
  await c.query(`DELETE FROM public."member" WHERE "userId" = ANY($1)`, [[...MEMBERS]]);
  await c.query(`DELETE FROM public."user" WHERE id = ANY($1)`, [[...MEMBERS]]);
  await c.query(`DELETE FROM public."organization" WHERE id = $1`, [ORG]);
  await c.end();
});

async function makeTemplate(packageName: string): Promise<string> {
  const templateId = `t_${randomUUID()}`;
  await store.createAgentTemplate({
    id: templateId,
    name: `hitl-prims-${randomUUID().slice(0, 8)}`,
    sourceNl: "test",
    compiledPlan: [],
    inputSchema: {},
    approvalPolicy: { steps: [] },
    packageName,
    // cinatra#2485 C — the template's INSTALL SCOPE is what authorizes a run,
    // so the fixture agent is installed in ORG (`createAgentTemplate` stamps
    // `owner_level='organization'` / `owner_id=orgId` from this anchor). An
    // org-less fixture template has no determinate scope and every run against
    // it is refused.
    orgId: ORG,
  });
  return templateId;
}

async function makeRun(templateId: string, runBy: string): Promise<string> {
  const run = await store.createAgentRun({
    id: `r_${randomUUID()}`,
    templateId,
    inputParams: {},
    orgId: ORG,
    runBy,
  }, AUTH);
  return run.id;
}

async function seedPrompt(runId: string, agentId: string, stepKey: string): Promise<void> {
  await store.writeHitlPrompt({ runId, agentId, stepKey, message: `msg-${stepKey}` });
}

async function idsFor(runId: string, agentId: string): Promise<string[]> {
  const rows = await store.readAllHitlPromptsForRun(runId, agentId);
  return rows.map((r) => r.id);
}

describe.skipIf(!hasDb)("HITL prompt primitives — store-level (run, agent) predicate", () => {
  it("readAllHitlPromptsForRun returns ONLY the (run, declaring-agent) rows", async () => {
    const pkgA = `@cinatra-ai/hitl-a-${randomUUID().slice(0, 6)}`;
    const pkgB = `@cinatra-ai/hitl-b-${randomUUID().slice(0, 6)}`;
    const tplA = await makeTemplate(pkgA);
    const tplB = await makeTemplate(pkgB);
    const runA = await makeRun(tplA, RUN_OWNER);
    const runB = await makeRun(tplB, RUN_OWNER);

    await seedPrompt(runA, pkgA, "own-1");
    await seedPrompt(runA, pkgA, "own-2");
    await seedPrompt(runA, pkgB, "cross-agent"); // same run, other agent
    await seedPrompt(runB, pkgA, "cross-run"); // other run, same agent

    const rows = await store.readAllHitlPromptsForRun(runA, pkgA);
    expect(rows.map((r) => r.stepKey).sort()).toEqual(["own-1", "own-2"]);
  });

  it("updateHitlPromptsExcludedForRunAgent touches ONLY in-scope ids and is idempotent", async () => {
    const pkgA = `@cinatra-ai/hitl-a-${randomUUID().slice(0, 6)}`;
    const pkgB = `@cinatra-ai/hitl-b-${randomUUID().slice(0, 6)}`;
    const tplA = await makeTemplate(pkgA);
    const tplB = await makeTemplate(pkgB);
    const runA = await makeRun(tplA, RUN_OWNER);
    const runB = await makeRun(tplB, RUN_OWNER);

    await seedPrompt(runA, pkgA, "own-1");
    await seedPrompt(runA, pkgB, "cross-agent");
    await seedPrompt(runB, pkgA, "cross-run");

    const [ownId] = await idsFor(runA, pkgA);
    const [crossAgentId] = await idsFor(runA, pkgB);
    const [crossRunId] = await idsFor(runB, pkgA);

    // Ask the scoped update to touch the in-scope id PLUS two out-of-scope ids.
    const affected = await store.updateHitlPromptsExcludedForRunAgent(
      runA,
      pkgA,
      [ownId, crossAgentId, crossRunId],
      true,
    );
    expect(affected).toEqual([ownId]); // only the in-scope row matched

    // The out-of-scope rows are untouched (still excluded=false).
    const crossAgentRow = (await store.readAllHitlPromptsForRun(runA, pkgB))[0];
    const crossRunRow = (await store.readAllHitlPromptsForRun(runB, pkgA))[0];
    expect(crossAgentRow.excluded).toBe(false);
    expect(crossRunRow.excluded).toBe(false);

    // Idempotent: re-applying the same target state re-matches the same id.
    const again = await store.updateHitlPromptsExcludedForRunAgent(runA, pkgA, [ownId], true);
    expect(again).toEqual([ownId]);
    // And the row now reads excluded (readHitlPromptsForRun filters excluded=false).
    const nonExcluded = await store.readHitlPromptsForRun(runA, pkgA);
    expect(nonExcluded.find((r) => r.id === ownId)).toBeUndefined();
  });
});

describe.skipIf(!hasDb)("HITL prompt primitives — deterministic pre-interrupt seam (real handlers)", () => {
  it("lists the run's own prompts and excludes one, inside a run-bound frame", async () => {
    const pkgA = `@cinatra-ai/hitl-seam-${randomUUID().slice(0, 6)}`;
    const pkgB = `@cinatra-ai/hitl-seamx-${randomUUID().slice(0, 6)}`;
    const tplA = await makeTemplate(pkgA);
    const runA = await makeRun(tplA, SEAM_OWNER);

    await seedPrompt(runA, pkgA, "gate-1");
    await seedPrompt(runA, pkgA, "gate-2");
    await seedPrompt(runA, pkgA, "bare-approval");
    await seedPrompt(runA, pkgB, "foreign"); // must never appear

    const { createAgentBuilderPrimitiveHandlers } = await import("../mcp/handlers");
    const handlers = createAgentBuilderPrimitiveHandlers();
    const actor = { userId: SEAM_OWNER, actorType: "model", source: "agent" };

    // Everything runs inside ONE run-bound frame — exactly the passthrough seam,
    // which stamps the VERIFIED run scope (never the forgeable ambient runId).
    const result = await mcpRequestContextStorage.run(
      { verifiedRunScopeId: runA, runId: "run-HEADER-FORGED", userId: SEAM_OWNER, orgId: ORG },
      async () => {
        const listed = (await handlers["agent_run_hitl_prompts_list"]({
          primitiveName: "agent_run_hitl_prompts_list",
          input: { runId: "run-EVIL" }, // ignored — context wins
          actor,
          mode: "deterministic",
        })) as { agentPackageName: string; prompts: Array<{ id: string; stepKey: string }> };

        const bare = listed.prompts.find((p) => p.stepKey === "bare-approval");
        const excluded = (await handlers["agent_run_hitl_prompts_exclude"]({
          primitiveName: "agent_run_hitl_prompts_exclude",
          input: { ids: [bare!.id] },
          actor,
          mode: "deterministic",
        })) as { applied: number; ids: string[] };

        const relisted = (await handlers["agent_run_hitl_prompts_list"]({
          primitiveName: "agent_run_hitl_prompts_list",
          input: {},
          actor,
          mode: "deterministic",
        })) as { prompts: Array<{ id: string; stepKey: string; excluded: boolean }> };

        return { listed, excluded, relisted };
      },
    );

    // Only the run's own (pkgA) prompts — the foreign pkgB row never appears.
    expect(result.listed.agentPackageName).toBe(pkgA);
    expect(result.listed.prompts.map((p) => p.stepKey).sort()).toEqual([
      "bare-approval",
      "gate-1",
      "gate-2",
    ]);
    // The exclude landed…
    expect(result.excluded.applied).toBe(1);
    // …and the re-list reflects it (the wireable gate payload).
    const bareAfter = result.relisted.prompts.find((p) => p.stepKey === "bare-approval");
    expect(bareAfter?.excluded).toBe(true);
  });
});

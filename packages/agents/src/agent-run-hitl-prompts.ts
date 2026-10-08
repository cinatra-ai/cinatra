// ---------------------------------------------------------------------------
// agent_run_hitl_prompts — WayFlow HITL prompt capture
// ---------------------------------------------------------------------------
//
// The agent_run_hitl_prompts persistence seam — capture a WayFlow HITL
// amendment prompt (writeHitlPrompt), the excluded-flag mutators (single-id
// updateHitlPromptExcluded + the run/agent-scoped batch
// updateHitlPromptsExcludedForRunAgent, #1794), and the run-scoped readers the
// autosave path uses (readHitlPromptsForRun / readAllHitlPromptsForRun /
// readNonExcludedAgentIdsForRun). Extracted VERBATIM from
// packages/agents/src/store.ts (file-size ratchet: store.ts is a tracked
// architecture bottleneck that exceeded its ceiling after #1803 added
// updateHitlPromptsExcludedForRunAgent inline). ./store re-exports every symbol
// below, so every existing `from "./store"` / `@cinatra-ai/agents` consumer —
// and every vi.mock("./store") double — is unchanged.
//
// NOTE for the route-graph ratchet: this module is reachable wherever ./store
// is (the re-export edge), but it pulls NO new first-party subtree — its only
// first-party imports (db from ./db, agentRunHitlPrompts from ./schema) are
// already reachable from ./store; drizzle-orm + node:crypto are external
// cut-points. So it adds exactly itself (+1 module) to each route reaching
// ./store, exactly like ./template-snapshot and ./run-status.
// ---------------------------------------------------------------------------

import { and, eq, inArray } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";

import { db, agentBuilderPool } from "./db";
import { agentRunHitlPrompts } from "./schema";

export type WriteHitlPromptInput = {
  runId: string;
  agentId: string;
  stepKey: string;
  message: string;
  submittedValues?: Record<string, unknown> | null;   //
  schemaSnapshot?: Record<string, unknown> | null;
  excluded?: boolean;                                  // Pattern 4(b): bare-approval rows pass true so autosave skips them
};

async function insertHitlPrompt(input: WriteHitlPromptInput): Promise<string> {
  if (input.message.length > 32_768) {
    throw new Error(`[writeHitlPrompt] message too large (${input.message.length} chars)`);
  }
  if (input.schemaSnapshot !== null && input.schemaSnapshot !== undefined) {
    const snap = JSON.stringify(input.schemaSnapshot);
    if (snap.length > 32_768) {
      console.warn(
        `[writeHitlPrompt] schemaSnapshot too large (${snap.length} bytes), storing null`,
      );
      input = { ...input, schemaSnapshot: null };
    }
  }
  const id = randomUUID();
  await db.insert(agentRunHitlPrompts).values({
    id,
    runId: input.runId,
    agentId: input.agentId,
    stepKey: input.stepKey,
    message: input.message,
    submittedValues: input.submittedValues ?? null,   //
    schemaSnapshot: input.schemaSnapshot ?? null,
    excluded: input.excluded ?? false,                //
  });
  return id;
}

/** Existing capture ABI and single pre-dispatch insert remain unchanged. */
export async function writeHitlPrompt(input: WriteHitlPromptInput): Promise<void> {
  await insertHitlPrompt(input);
}

/** Internal approval capture: same insert, with its exact immutable ID. */
export async function captureHitlPromptForContinue(input: WriteHitlPromptInput): Promise<string> {
  return insertHitlPrompt(input);
}

export type HitlPromptRecord = {
  id: string;
  runId: string;
  agentId: string;
  stepKey: string;
  message: string;
  capturedAt: Date;
  excluded: boolean;
  submittedValues: Record<string, unknown> | null;   //
  schemaSnapshot: Record<string, unknown> | null;
};

/**
 * Reads all non-excluded HITL amendment prompts for a run, scoped to a specific agent.
 *
 * @param runId   - The agent_runs.id of the run.
 * @param agentId - The template's `packageName` (e.g. "@cinatra-ai/email-outreach-agent").
 *                  Must match the value stored at write time via writeHitlPrompt.
 */
export async function updateHitlPromptExcluded(id: string, excluded: boolean): Promise<void> {
  await db
    .update(agentRunHitlPrompts)
    .set({ excluded })
    .where(eq(agentRunHitlPrompts.id, id));
}

export async function readHitlPromptsForRun(
  runId: string,
  agentId: string,
): Promise<HitlPromptRecord[]> {
  return db
    .select({id: agentRunHitlPrompts.id, runId: agentRunHitlPrompts.runId,
      agentId: agentRunHitlPrompts.agentId, stepKey: agentRunHitlPrompts.stepKey,
      message: agentRunHitlPrompts.message, capturedAt: agentRunHitlPrompts.capturedAt,
      excluded: agentRunHitlPrompts.excluded, submittedValues: agentRunHitlPrompts.submittedValues,
      schemaSnapshot: agentRunHitlPrompts.schemaSnapshot})
    .from(agentRunHitlPrompts)
    .where(
      and(
        eq(agentRunHitlPrompts.runId, runId),
        eq(agentRunHitlPrompts.agentId, agentId),
        eq(agentRunHitlPrompts.excluded, false),
      ),
    )
    .orderBy(agentRunHitlPrompts.capturedAt);
}

// ---------------------------------------------------------------------------
// sibling read: NO excluded filter. Submission-map builder needs
// every gate row in capture order so row-order alignment with approvalPolicy
// gates survives Pattern 4(b) (bare-approval rows flagged excluded=true).
// readHitlPromptsForRun (excluded=false filter) stays unchanged for autosave.
// ---------------------------------------------------------------------------
export async function readAllHitlPromptsForRun(
  runId: string,
  agentId: string,
): Promise<HitlPromptRecord[]> {
  return db
    .select({id: agentRunHitlPrompts.id, runId: agentRunHitlPrompts.runId,
      agentId: agentRunHitlPrompts.agentId, stepKey: agentRunHitlPrompts.stepKey,
      message: agentRunHitlPrompts.message, capturedAt: agentRunHitlPrompts.capturedAt,
      excluded: agentRunHitlPrompts.excluded, submittedValues: agentRunHitlPrompts.submittedValues,
      schemaSnapshot: agentRunHitlPrompts.schemaSnapshot})
    .from(agentRunHitlPrompts)
    .where(
      and(
        eq(agentRunHitlPrompts.runId, runId),
        eq(agentRunHitlPrompts.agentId, agentId),
      ),
    )
    .orderBy(agentRunHitlPrompts.capturedAt);
}

// ---------------------------------------------------------------------------
// Run + agent-scoped batch exclusion (#1794).
//
// The single-id `updateHitlPromptExcluded` mutates by prompt id ALONE with no
// run/agent predicate — safe for the internal autosave caller (it only ever
// passes ids it just read for a run+agent), but NOT a safe primitive surface.
// This scoped batch variant carries the run + declaring-agent predicate INTO
// the WHERE clause as defense-in-depth: a row is touched only when it belongs
// to BOTH the given run AND the given agent package, so a caller can never
// mutate another run's or another agent's prompt even if a stale/foreign id
// slips past the handler's own membership check. Idempotent by construction
// (`SET excluded = <value>` is a no-op when the row already holds it). Returns
// the ids actually matched (== touched), so the caller can report applied vs
// requested and detect a silent scope miss.
// ---------------------------------------------------------------------------
export async function updateHitlPromptsExcludedForRunAgent(
  runId: string,
  agentId: string,
  ids: string[],
  excluded: boolean,
): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .update(agentRunHitlPrompts)
    .set({ excluded })
    .where(
      and(
        inArray(agentRunHitlPrompts.id, ids),
        eq(agentRunHitlPrompts.runId, runId),
        eq(agentRunHitlPrompts.agentId, agentId),
      ),
    )
    .returning({ id: agentRunHitlPrompts.id });
  return rows.map((r) => r.id);
}

/**
 * returns the distinct set of agent_id values for a run's
 * non-excluded captured HITL prompts. Used by the autosave-on-completion path
 * (`runSkillAutosaveOnRunCompletion` in `./skill-autosave`) to fan out one
 * personal-skill generation per distinct leaf agent.
 *
 * v1 "distinct leaf" semantics: distinct values of `agent_id` as captured
 * by `writeHitlPrompt`. For flat WayFlow runs this is one value (the run's
 * own template.packageName). For composed orchestrator runs the captured
 * agent_id is whatever the paused run's template.packageName was at gate
   * time, preserving distinct child-agent capture.
 *
 * @param runId - The agent_runs.id of the run.
 * @returns      Distinct agent_id values, ordered ascending. Empty array if none.
 */
export async function readNonExcludedAgentIdsForRun(runId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ agentId: agentRunHitlPrompts.agentId })
    .from(agentRunHitlPrompts)
    .where(
      and(
        eq(agentRunHitlPrompts.runId, runId),
        eq(agentRunHitlPrompts.excluded, false),
      ),
    );
  return rows.map((r) => r.agentId).sort();
}

// Server-only continuation receipt. No package barrel/store re-export or public
// capture DTO includes this metadata. A pre-send capture alone is never history.
import type { DurableHitlGateArtifact, HitlGateQuery } from "./store";
export type ContinueReceipt = {
  version: 1; runId: string; orgId: string; agentId: string;
  reviewTaskId: string; contextId: string; returnedTaskId: string;
  returnedState: "completed" | "input-required"; materializedAt: string;
  schemaDigest: string; answerDigest: string; acknowledgedAt: string;
};
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)]));
  return value;
}
export function continueBindingDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
export function continueGateDigest(gate: ContinueGateSnapshot): string {
  return continueBindingDigest({runId:gate.runId, reviewTaskId:gate.reviewTaskId,
    xRenderer:gate.xRenderer,inputSchema:gate.inputSchema,materializedAt:gate.materializedAt});
}
function qualifiedMissingReceiptColumn(error: unknown): boolean {
  const e = error as {code?:unknown;message?:unknown};
  return e?.code === "42703" && typeof e.message === "string" && e.message.includes("dispatch_receipt");
}
function table(name: string): string {
  const schema = (process.env.SUPABASE_SCHEMA?.trim() || "cinatra").replaceAll('"','""');
  return `"${schema}"."${name}"`;
}
const receiptQuery: HitlGateQuery = async <T>(text: string, values: readonly unknown[]) => {
  const result = await agentBuilderPool.query(text, values as unknown[]); return result.rows as T[];
};
export async function recordSuccessfulContinue(input: {
  promptId: string; gate: ContinueGateSnapshot; receipt: ContinueReceipt;
  submittedValues: Record<string,unknown>;
}, query: HitlGateQuery = receiptQuery): Promise<void> {
  const {gate,receipt,submittedValues}=input;
  if (receipt.runId !== gate.runId || receipt.reviewTaskId !== gate.reviewTaskId
    || receipt.schemaDigest !== continueGateDigest(gate)
    || receipt.answerDigest !== continueBindingDigest(submittedValues)) return;
  try {
    await query(`UPDATE ${table("agent_run_hitl_prompts")} AS p SET dispatch_receipt = $1::jsonb
      WHERE p.id = $2 AND p.run_id = $3 AND p.agent_id = $4 AND p.step_key = $5
        AND p.dispatch_receipt IS NULL AND p.submitted_values = $6::jsonb
        AND EXISTS (SELECT 1 FROM ${table("agent_runs")} r WHERE r.id=p.run_id AND r.org_id=$7 AND r.a2a_context_id=$12)
        AND EXISTS (SELECT 1 FROM ${table("agent_run_hitl_gates")} g WHERE g.run_id=p.run_id
          AND g.review_task_id=$8 AND g.x_renderer=$9 AND g.input_schema=$10::jsonb
          AND g.materialized_at=$11::timestamptz)`,
      [JSON.stringify(receipt),input.promptId,gate.runId,receipt.agentId,
        gate.reviewTaskId.slice("wayflow-".length),JSON.stringify(submittedValues),receipt.orgId,
        gate.reviewTaskId,gate.xRenderer,JSON.stringify(gate.inputSchema),gate.materializedAt,receipt.contextId]);
  } catch(error) { if (!qualifiedMissingReceiptColumn(error)) throw error; }
}
export type AnsweredContextGate = {
  reviewTaskId: string; label: string; schema: Record<string,unknown>;
  submittedValues: Record<string,unknown>; acknowledgedAt: string;
};
export async function readConfirmedContextGates(
  runId: string, orgId: string, agentId: string, query: HitlGateQuery = receiptQuery,
): Promise<AnsweredContextGate[]> {
  let rows: Array<{step_key:string;submitted_values:Record<string,unknown>|null;
    dispatch_receipt:ContinueReceipt|null;review_task_id:string;x_renderer:string;
    input_schema:Record<string,unknown>;gate_values:Record<string,unknown>;
    field_name:string|null;materialized_at:Date|string;a2a_context_id:string|null}>;
  try {
    rows = await query(`SELECT p.step_key,p.submitted_values,p.dispatch_receipt,
      g.review_task_id,g.x_renderer,g.input_schema,g.gate_values,g.field_name,g.materialized_at,r.a2a_context_id
      FROM ${table("agent_run_hitl_prompts")} p
      JOIN ${table("agent_runs")} r ON r.id=p.run_id
      JOIN ${table("agent_run_hitl_gates")} g ON g.run_id=p.run_id AND g.review_task_id='wayflow-' || p.step_key
      WHERE p.run_id=$1 AND r.org_id=$2 AND p.agent_id=$3 AND p.dispatch_receipt IS NOT NULL
      ORDER BY p.captured_at ASC,p.id ASC`, [runId,orgId,agentId]);
  } catch(error) { if (qualifiedMissingReceiptColumn(error)) return []; throw error; }
  const result: AnsweredContextGate[]=[]; const seen=new Set<string>();
  for(const row of rows){
    const receipt=row.dispatch_receipt; const answer=row.submitted_values;
    const slot = row.gate_values?.slotMeta as {slotId?:unknown}|undefined;
    if(!receipt || receipt.version!==1 || receipt.runId!==runId || receipt.orgId!==orgId
      || receipt.agentId!==agentId || receipt.reviewTaskId!==row.review_task_id
      || receipt.reviewTaskId!==`wayflow-${row.step_key}` || !receipt.contextId
      || receipt.contextId!==row.a2a_context_id
      || !receipt.returnedTaskId || !(receipt.returnedState==="completed" ||
        (receipt.returnedState==="input-required" && receipt.returnedTaskId!==row.step_key))
      || !answer || typeof slot?.slotId!=="string" || answer.slotId!==slot.slotId
      || (answer.resolutionMode!=="override" && answer.resolutionMode!=="accumulate")
      || !Array.isArray(answer.selectedRefs)
      || !answer.selectedRefs.every(ref=>ref && typeof ref==="object" &&
        ["artifactId","representationRevisionId","semanticAssertionId"].every(key=>
          typeof (ref as Record<string,unknown>)[key]==="string" && (ref as Record<string,string>)[key].length>0))) continue;
    const gate:ContinueGateSnapshot={runId,reviewTaskId:row.review_task_id,xRenderer:row.x_renderer,
      inputSchema:row.input_schema,values:row.gate_values,materializedAt:new Date(row.materialized_at).toISOString()};
    if(receipt.materializedAt!==gate.materializedAt || receipt.schemaDigest!==continueGateDigest(gate)
      || receipt.answerDigest!==continueBindingDigest(answer) || seen.has(row.review_task_id)) continue;
    seen.add(row.review_task_id);
    result.push({reviewTaskId:row.review_task_id,label:slot.slotId,
      schema:row.input_schema,submittedValues:answer,acknowledgedAt:receipt.acknowledgedAt});
  }
  return result;
}

/** Internal exact materialization identity, distinct from the public latest-gate DTO. */
export type ContinueGateSnapshot = DurableHitlGateArtifact & { readonly materializedAt: string };

export async function readDurableHitlGateForContinue(
  runId: string, reviewTaskId: string, deps: {query?: HitlGateQuery} = {},
): Promise<ContinueGateSnapshot | null> {
  const rows = await (deps.query ?? receiptQuery)<{
    run_id: string; review_task_id: string; x_renderer: string;
    input_schema: Record<string, unknown>; gate_values: Record<string, unknown>;
    field_name: string | null; materialized_at: Date | string;
  }>(`SELECT run_id, review_task_id, x_renderer, input_schema, gate_values,
           field_name, materialized_at FROM ${table("agent_run_hitl_gates")}
       WHERE run_id = $1 AND review_task_id = $2`, [runId, reviewTaskId]);
  const row = rows[0];
  if (!row || row.run_id !== runId || row.review_task_id !== reviewTaskId) return null;
  const materializedAt = new Date(row.materialized_at).toISOString();
  return {runId, reviewTaskId, xRenderer: row.x_renderer,
    inputSchema: row.input_schema, values: row.gate_values, materializedAt,
    ...(row.field_name ? {fieldName: row.field_name} : {})};
}

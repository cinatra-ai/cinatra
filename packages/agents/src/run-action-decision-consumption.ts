// ---------------------------------------------------------------------------
// The single-use consumption of a person's decision for a run's outward action
// (cinatra#3745).
//
// A run's step that sends or publishes on a person's behalf is held in front of
// that step by a publish decision (cinatra#4150): one row per (run, step, gate
// task) in agent_run_publish_decisions. The person's affirmative answer is the
// row's `released` status, stamped with the person who decided it. This module
// checks that decision against the run's action and uses it up exactly once:
//
//   - the run still runs under the proof's attempt, context and bound source;
//   - the step of the proof declares the action's tool in the run's bound graph
//     (a step that declares nothing binds no decision to an action: refused);
//   - the decision that covers the step is the one of the step's top-level
//     publishing ancestor in the run's bound graph (a publish decision is
//     recorded only for a top-level node that declares `publishes: true`; a
//     top-level step is its own ancestor). The ancestor is read from the bound
//     graph, never from the caller; no, or more than one, ancestor, or one that
//     does not publish, is refused;
//   - the newest decision of exactly this run and that node, in the run's
//     current attempt, reads `released`, names the person who decided it and belongs to
//     the run's organization;
//   - no consumption of that decision exists; the insert of the consumption row
//     (its primary key is the decision's key) is the fence, so of two concurrent
//     consumptions exactly one commits.
//
// Everything runs in ONE org-write-guarded transaction; the rows read are locked
// in the order run, binding, decision. The run row's FOR UPDATE lock, taken by
// the first statement, is also the fence against a NEW decision of the run: the
// park (insertParkedDecision) takes a KEY SHARE lock on the same run row inside
// its insert, which conflicts with FOR UPDATE and is held until the park
// commits. Under READ COMMITTED each later statement here reads a fresh
// snapshot, so a park that committed before the lock was granted is seen by the
// decision read, and a park still waiting commits only after this transaction.
// The decision chosen stays the newest until the consumption commits. Every refusal is a RunStepToolPolicyRefusal
// with a fixed code; a store failure is refused with a fixed code too and never
// passes its own text on.
//
// It opens no outward call by itself. Its one caller is the host's guarded
// outward run action (`consumeOutwardRunAction` in `@/lib/extension-host-context`),
// which `enforceMcpBoundary` runs last, just before it admits the one call.
// ---------------------------------------------------------------------------
import { and, desc, eq } from "drizzle-orm";
import type { OrgWriteAuthority } from "@cinatra-ai/org-write-kernel";
import { parseVerifiedExecutedRunSource, type VerifiedExecutedRunSource } from "@cinatra-ai/sdk-extensions";

import {
  RunStepToolPolicyRefusal,
  assertRunStepToolAllowed,
  parseRunStepToolPolicy,
  withRunActionPolicyTransaction,
} from "./agent-run-serde";
import {
  agentRunOutwardActionPolicies,
  agentRunPublishDecisions,
  agentRuns,
  artifactReviewActionConsumptions,
} from "./schema";
import { CURRENT_ATTEMPT, decodeStoredPublishDecision, type PublishDecisionRow } from "./publish-decision-store";
import { findPublishingAncestor } from "./validate-oas-runtime-invariants";

/** The tool that would act and the loaded extension version that owns it (the loaded identity's fields). */
export type RunActionToolIdentity = {
  readonly toolName: string;
  readonly packageName: string;
  readonly version: string;
  readonly installId: string;
  readonly digest: string;
};

export type ConsumeRunActionDecisionInput = {
  readonly orgId: string;
  readonly runId: string;
  readonly authority: OrgWriteAuthority;
  readonly proof: VerifiedExecutedRunSource;
  readonly action: RunActionToolIdentity;
};

export type RunActionDecisionConsumption = {
  /** The consumption row's key: the decision's kind and id. */
  readonly consumptionKey: string;
  readonly decisionId: string;
  readonly decidedBy: string;
  /** The step that calls the tool (it declares the tool). */
  readonly stepId: string;
  /** The top-level publishing node whose decision covers the step (the step itself when it is that node). */
  readonly decisionNodeId: string;
  readonly action: RunActionToolIdentity;
};

/** The consumption key of a publish decision. The kind prefix keeps it apart from any other decision kind that the
 *  same table may key later. */
export const PUBLISH_DECISION_CONSUMPTION_PREFIX = "publish_decision:";

const IDENTITY_FIELDS = ["toolName", "packageName", "version", "installId", "digest"] as const;
const MAX_FIELD = 512;
const fieldValid = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= MAX_FIELD && !/[\u0000-\u001f\u007f]/.test(v);
const refuse = (code: string): never => { throw new RunStepToolPolicyRefusal(code); };

/** One frozen plain copy of the action identity, each field read once from an own data property. */
function readActionIdentity(value: unknown): RunActionToolIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return refuse("action_decision_input_invalid");
  const out: Record<string, string> = {};
  for (const key of IDENTITY_FIELDS) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !("value" in d) || !fieldValid(d.value)) return refuse("action_decision_input_invalid");
    out[key] = d.value;
  }
  return Object.freeze(out) as unknown as RunActionToolIdentity;
}

/** The top-level publishing node of the bound graph whose decision covers the step; refused when there is none, more
 *  than one, or it declares no publication. */
function readDecisionNode(source: string, stepId: string): string {
  let document: unknown;
  try { document = JSON.parse(source); } catch { return refuse("action_decision_node_unresolved"); }
  const ancestor = findPublishingAncestor(document, stepId);
  if (ancestor.kind === "ambiguous") return refuse("action_decision_node_ambiguous");
  if (ancestor.kind === "not_publishing") return refuse("action_decision_node_not_publishing");
  if (ancestor.kind !== "resolved" || !fieldValid(ancestor.nodeId)) return refuse("action_decision_node_unresolved");
  return ancestor.nodeId;
}

/**
 * Check the person's recorded, affirmative decision for exactly this run, step and action, and record its single
 * consumption, in one transaction. Returns the consumption; throws a RunStepToolPolicyRefusal otherwise:
 *
 *   - `action_decision_input_invalid`: a missing or malformed run, organization, proof or action;
 *   - `action_run_source_stale`: the run is not running under the proof's attempt, context and bound source;
 *   - `step_tool_not_declared` / `action_decision_step_undeclared`: the step does not declare the action's tool, or
 *     declares no tools at all (so no decision of it can name an action);
 *   - `action_decision_node_unresolved` / `action_decision_node_ambiguous` / `action_decision_node_not_publishing`: no
 *     top-level node of the bound graph holds the step, more than one does, or the one that does declares no publication;
 *   - `action_person_decision_missing`: no decision of that node in the run's current attempt;
 *   - `action_person_decision_open`: the newest such decision still waits for a person;
 *   - `action_person_decision_not_affirmative`: it was declined, expired or ended with the run;
 *   - `action_person_decision_invalid`: the store cannot read the row, or it reads released but names no person, or
 *     another organization;
 *   - `action_person_decision_already_consumed`: it was used before (by this or any other action);
 *   - `action_person_decision_unavailable`: a store failure.
 */
export async function consumeRunActionDecision(input: ConsumeRunActionDecisionInput): Promise<RunActionDecisionConsumption> {
  const orgId = input?.orgId;
  const runId = input?.runId;
  if (!fieldValid(orgId) || !fieldValid(runId) || !input.authority) refuse("action_decision_input_invalid");
  const proof = parseVerifiedExecutedRunSource(input.proof);
  if (!proof) refuse("action_decision_input_invalid");
  const action = readActionIdentity(input.action);
  const p = proof as VerifiedExecutedRunSource;
  try {
    return await withRunActionPolicyTransaction({ orgId, runId, authority: input.authority }, async (tx) => {
      const [run] = await tx.select().from(agentRuns)
        .where(and(eq(agentRuns.id, runId), eq(agentRuns.orgId, orgId))).for("update");
      if (!run || run.id !== runId || run.orgId !== orgId || run.status !== "running" || !run.executionAttemptId ||
          run.executionAttemptId !== p.executionAttemptId || run.a2aContextId !== p.contextId) {
        refuse("action_run_source_stale");
      }
      const [binding] = await tx.select().from(agentRunOutwardActionPolicies)
        .where(and(eq(agentRunOutwardActionPolicies.runId, runId), eq(agentRunOutwardActionPolicies.orgId, orgId)))
        .for("update");
      if (!binding || binding.runId !== runId || binding.orgId !== orgId ||
          binding.executionAttemptId !== run.executionAttemptId) refuse("action_run_source_stale");
      const policy = parseRunStepToolPolicy(binding.policy);
      if (policy.contextId !== p.contextId || policy.sourceSha256 !== p.sourceSha256 ||
          policy.executedSourceSha256 !== p.executedSourceSha256 ||
          policy.declarationSourceSha256 !== p.declarationSourceSha256) refuse("action_run_source_stale");
      const reading = assertRunStepToolAllowed({ policy, contextId: p.contextId,
        executedSourceSha256: p.executedSourceSha256, stepId: p.stepId, toolName: action.toolName });
      if (reading.kind !== "declared") refuse("action_decision_step_undeclared");
      const decisionNodeId = readDecisionNode(policy.source, p.stepId);

      // The newest decision of exactly that node in the run's current attempt, chosen by the database: the store's own
      // current-attempt predicate (a row with no generation, written by an older node, is current until a reset stamps
      // it) and the store's order (created_at, then id, both descending), at the database's full timestamp precision.
      const [stored] = await tx.select().from(agentRunPublishDecisions)
        .where(and(eq(agentRunPublishDecisions.runId, runId), eq(agentRunPublishDecisions.nodeId, decisionNodeId),
          CURRENT_ATTEMPT))
        .orderBy(desc(agentRunPublishDecisions.createdAt), desc(agentRunPublishDecisions.id))
        .limit(1)
        .for("update");
      if (!stored || stored.runId !== runId || stored.nodeId !== decisionNodeId) return refuse("action_person_decision_missing");
      // The locked row is read through the store's own decoder: a row the store cannot read (an unknown status,
      // unreadable surfaced values or declared rows) is refused with a fixed code and none of its stored text.
      let decision: PublishDecisionRow;
      try {
        decision = decodeStoredPublishDecision(stored);
      } catch {
        return refuse("action_person_decision_invalid");
      }
      if (decision.status === "parked") refuse("action_person_decision_open");
      if (decision.status !== "released") refuse("action_person_decision_not_affirmative");
      if (decision.orgId !== orgId || !fieldValid(decision.decidedBy) || !(decision.decidedAt instanceof Date) ||
          !Number.isFinite(decision.decidedAt.getTime()) || !fieldValid(decision.id)) {
        refuse("action_person_decision_invalid");
      }
      const consumptionKey = `${PUBLISH_DECISION_CONSUMPTION_PREFIX}${decision.id}`;
      const used = await tx.select({ gateId: artifactReviewActionConsumptions.gateId })
        .from(artifactReviewActionConsumptions).where(eq(artifactReviewActionConsumptions.gateId, consumptionKey));
      if (used.some((u) => u.gateId === consumptionKey)) refuse("action_person_decision_already_consumed");
      const inserted = await tx.insert(artifactReviewActionConsumptions).values({
        gateId: consumptionKey, runId, orgId, stepId: p.stepId,
        // A plain copy: the frozen identity is stored as its fields, never as the object. The step column holds the
        // tool step; the node whose decision is used up is recorded beside the identity.
        toolIdentity: { ...action, decisionNodeId }, executedSourceSha256: p.executedSourceSha256,
      }).onConflictDoNothing().returning({ gateId: artifactReviewActionConsumptions.gateId });
      if (inserted.length !== 1 || inserted[0]!.gateId !== consumptionKey) refuse("action_person_decision_already_consumed");
      return Object.freeze({ consumptionKey, decisionId: decision.id, decidedBy: decision.decidedBy as string,
        stepId: p.stepId, decisionNodeId, action });
    });
  } catch (err) {
    if (err instanceof RunStepToolPolicyRefusal) throw err;
    // Fail closed with a fixed code: an org-write refusal or a store error never passes its text on.
    throw new RunStepToolPolicyRefusal("action_person_decision_unavailable");
  }
}

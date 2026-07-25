// ---------------------------------------------------------------------------
// Agent-run (de)serialization + OBO scope-ceiling persistence helpers.
//
// Co-located slice extracted VERBATIM from store.ts (no behavior change) to keep
// store.ts under the file-size ratchet ceiling (a thin-facade vertical slice).
// Holds three helpers store.ts re-imports:
//   - parseAuthPolicySafe: defensive AgentAuthPolicy JSON parser (shared by the
//     run + template deserializers).
//   - deserializeRun: agent_runs row -> AgentRunRecord mapper.
//   - deriveRunOboCeilingJson: persist-at-dispatch OBO scope-ceiling derivation.
// The only edge back to store.ts is the TYPE-ONLY `AgentRunRecord` import
// (fully erased at runtime — no runtime import cycle; store.ts imports the three
// values one-directionally).
// ---------------------------------------------------------------------------
import { eq } from "drizzle-orm";
import {
  deriveOboCeilingChain,
  parseOboCeilingChain,
  composeOboCeilingChain,
  OboCeilingCompositionError,
  type OboCeiling,
  type OboCeilingChain,
  type OboOwnerContainment,
} from "@cinatra-ai/mcp-server/obo-ceiling";
import { readOwnerContainmentResolver } from "./owner-containment-port";
import { db } from "./db";
import { agentTemplates, agentRuns } from "./schema";
import { AgentAuthPolicySchema } from "./auth-policy";
import type { AgentAuthPolicy } from "./auth-policy";
import type { AgentRunRecord } from "./store";

// ---------------------------------------------------------------------------
// Defensive AgentAuthPolicy JSON parser.
//
// JSON.parse on an unguarded raw column can throw on malformed input
// (direct SQL writes, partial migrations, dev tools), and a static `as
// AgentAuthPolicy` cast lies about the runtime shape — `JSON.parse("null")`
// returns null, and `{"runListVisibility":"EVIL"}` typechecks but is
// semantically broken. Wrap parse + zod validation with try/catch so a
// bad row degrades gracefully to null (which downstream code treats as
// "no override; inherit from template / use DEFAULT_AGENT_AUTH_POLICY").
//
// This intentionally does NOT touch the existing compiledPlan /
// approvalPolicy / gatedSteps parses — those predate this parser and are
// out of scope unless parser symmetry is needed.
// ---------------------------------------------------------------------------
export function parseAuthPolicySafe(raw: string | null): AgentAuthPolicy | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = AgentAuthPolicySchema.safeParse(parsed);
    if (!result.success) {
      // eslint-disable-next-line no-console
      console.warn(
        "[agent-builder/store] AgentAuthPolicy row failed zod validation; treating as null override",
        { issues: result.error.issues },
      );
      return null;
    }
    return result.data;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[agent-builder/store] AgentAuthPolicy row failed JSON.parse; treating as null override",
      { error: err instanceof Error ? err.message : String(err) },
    );
    return null;
  }
}

export function deserializeRun(row: typeof agentRuns.$inferSelect): AgentRunRecord {
  return {
    id: row.id,
    templateId: row.templateId,
    versionId: row.versionId,
    runBy: row.runBy,
    status: row.status,
    inputParams: JSON.parse(row.inputParams) as Record<string, unknown>,
    stepResults: row.stepResults ? (JSON.parse(row.stepResults) as unknown[]) : null,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    error: row.error,
    title: row.title,
    createdAt: row.createdAt,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    packageVersion: row.packageVersion ?? null,
    a2aTaskId: row.a2aTaskId ?? null,
    a2aContextId: row.a2aContextId ?? null,
    parentRunId: row.parentRunId ?? null,
    agUiEnabled: row.agUiEnabled ?? null,
    lgThreadId: row.lgThreadId ?? null,
    traceId: row.traceId ?? null,
    timeoutSeconds: row.timeoutSeconds ?? null,
    streamedText: row.streamedText ?? null,
    // per-run override; null when not set.
    // Defensive parse — see parseAuthPolicySafe definition above.
    authPolicy: parseAuthPolicySafe(row.authPolicy ?? null),
    // orgId from agent_runs.org_id; column is NOT NULL after the
    // DDL migration.
    orgId: row.orgId,
    // nullable project refinement (
    // DDL). Drizzle returns the typed column directly.
    projectId: row.projectId ?? null,
    // idempotent child-run dispatch key.
    idempotencyKey: row.idempotencyKey ?? null,
    // persisted OBO scope-ceiling chain (JSON-as-text). Defensive parse — a
    // malformed / empty stored value becomes null (fails closed at mint).
    oboCeiling: parseOboCeilingChain(row.oboCeiling ?? null),
    // dependent_install_id surfaced onto the record so buildActorContextFromRun
    // carries it onto the ActorContext for edge-bound serving (cinatra#1392 Gap 2).
    dependentInstallId: row.dependentInstallId ?? null,
    // run-start presence discriminator (cinatra#2067). Drizzle returns the typed
    // boolean column directly; null on pre-backfill / headless rows.
    humanPresent: row.humanPresent ?? null,
  };
}

// ---------------------------------------------------------------------------
// Persist-at-dispatch: derive the agent-run OBO scope-ceiling chain from the
// run's LOCKED template owner anchor + org + (optional) project launch, and
// return it JSON-serialized for the agent_runs.obo_ceiling column. Called by
// EVERY run-creation path (createAgentRun / createAgentRunPendingInput) so all
// origins — interactive, A2A, widget, workflow-child, recurring-trigger clone —
// record the exact chain the mint path re-derives and compares against.
//
// Returns null ONLY for a corrupt partial anchor (a known non-org owner tier
// with a missing id); the run then fails closed at mint. A null / null (pre-
// backfill) anchor derives the organization floor — NOT the fail-closed case.
//
// Child-run composition (epic W5 / #1884 C4): when the caller supplies
// `parentOboCeiling` (a genuine child dispatch — the parent RUN's persisted
// chain, read from the dispatching run's actor frame), the child's OWN anchor is
// STILL freshly derived here — never copied — and the parent chain is folded in
// on top via the shared `composeOboCeilingChain` primitive (satisfy-all → never
// wider than the parent; transitive across grandchildren). A non-satisfiable
// composition — a same-axis id conflict, cross-org, OR a mixed owner-tier chain
// with no verified containment relation — THROWS `OboCeilingCompositionError` so
// the dispatch fails closed and no child run is inserted (a STRUCTURED error, not
// a silently-unsatisfiable persisted chain).
//
// `ownerContainments` carries the VERIFIED owner-axis containment facts (a
// narrower `user` is a member of the wider `team`, etc.) that let a legitimate
// mixed-owner-tier child collapse to its satisfiable narrowest tier. The
// anchor-derivation seam (#1884 C1) resolves live membership and supplies them;
// until then the dispatch seams pass none, so mixed-owner-tier child dispatches
// fail closed (safe). Top-level and recurring-clone paths pass no parent chain
// and derive the un-composed child anchor — the copy-trap-safe behavior (the
// clone re-derives, never carries a stale chain).
// ---------------------------------------------------------------------------
export async function deriveRunOboCeilingJson(input: {
  templateId: string;
  orgId: string;
  projectId: string | null | undefined;
  parentOboCeiling?: OboCeilingChain | null;
  /** Verified owner-axis containment facts (#1884 C1 wiring; default none). */
  ownerContainments?: OboOwnerContainment[];
}): Promise<string | null> {
  const [tmpl] = await db
    .select({
      ownerLevel: agentTemplates.ownerLevel,
      ownerId: agentTemplates.ownerId,
    })
    .from(agentTemplates)
    .where(eq(agentTemplates.id, input.templateId))
    .limit(1);
  const childChain = deriveOboCeilingChain({
    ownerLevel: tmpl?.ownerLevel ?? null,
    ownerId: tmpl?.ownerId ?? null,
    orgId: input.orgId,
    projectId: input.projectId ?? null,
  });
  // Corrupt partial anchor → persist SQL NULL, fail closed at mint (W1 contract).
  // Unchanged even under a child dispatch: nothing to compose onto.
  if (!childChain) return null;
  // Genuine child dispatch → fold the parent chain in on top of the freshly
  // derived child anchor (never copy the parent as the child's own anchor).
  if (input.parentOboCeiling && input.parentOboCeiling.length > 0) {
    // Owner-axis containment facts (#1885 C1; C4 handoff). When the composed
    // chain carries ≥2 DISTINCT owner tiers, resolve LIVE membership so a
    // legitimate mixed-owner-tier child collapses to its verified-narrowest
    // tier; otherwise C4 fails the composition closed. Explicit facts (test
    // seams / future direct callers) win; else the globalThis-published resolver
    // is consulted. No resolver / no facts → C4's structured fail-closed denial.
    const ownerContainments = await resolveOwnerContainmentsForCompose({
      orgId: input.orgId,
      childChain,
      parentChain: input.parentOboCeiling,
      explicit: input.ownerContainments,
    });
    const composed = composeOboCeilingChain(
      input.parentOboCeiling,
      childChain,
      ownerContainments,
    );
    if (!composed.ok) throw new OboCeilingCompositionError(composed);
    return JSON.stringify(composed.chain);
  }
  return JSON.stringify(childChain);
}

const OWNER_AXIS_TIERS: ReadonlySet<OboCeiling["tier"]> = new Set([
  "user",
  "team",
  "workspace",
]);

/**
 * Gather the DISTINCT owner-axis elements the composed chain will carry (child
 * anchor ∪ parent chain) and, only when there are ≥2 distinct owner TIERS,
 * resolve the verified containment facts among them via the published resolver.
 * Returns explicit facts verbatim when supplied. Zero/one owner tier → no facts
 * needed (the composer passes them through untouched, byte-stable).
 */
async function resolveOwnerContainmentsForCompose(input: {
  orgId: string;
  childChain: OboCeilingChain;
  parentChain: OboCeilingChain;
  explicit?: OboOwnerContainment[];
}): Promise<OboOwnerContainment[]> {
  if (input.explicit) return input.explicit;
  const ownerEls: OboCeiling[] = [];
  for (const c of [...input.childChain, ...input.parentChain]) {
    if (!OWNER_AXIS_TIERS.has(c.tier)) continue;
    if (!ownerEls.some((e) => e.tier === c.tier && e.id === c.id)) ownerEls.push(c);
  }
  const distinctTiers = new Set(ownerEls.map((e) => e.tier));
  if (distinctTiers.size < 2) return [];
  const resolver = readOwnerContainmentResolver();
  if (!resolver) return []; // fail closed — C4 denies the mixed composition
  return resolver({ orgId: input.orgId, ownerElements: ownerEls });
}

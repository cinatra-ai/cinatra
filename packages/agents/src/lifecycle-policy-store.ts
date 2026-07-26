import "server-only";

// ---------------------------------------------------------------------------
// lifecycle-policy-store (cinatra#2038, epic #2037 S0)
//
// The persistence half of the policy LATTICE's outermost layer — the org-scoped
// BOUNDS (`required`/`forbidden`). The absence of a row IS `silent`
// (unconstrained) — never stored — so `resolveOrgPolicyRule` returns `silent`
// when no bound matches, which is exactly the input the PURE evaluator
// (`evaluatePolicy`, src/lib/lifecycle/lifecycle-policy.ts) treats as the
// unconstrained region.
//
// The lattice's inner layers are NOT stored here: core defaults are code
// (`coreDefault`), the manifest declarations are compiled onto
// `agent_templates.lifecycle_config`, and per-run elevation is a run input.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

import { db } from "./db";
import { lifecyclePolicyRules } from "./schema";
import type {
  DestinationClass,
  LifecycleCheckpoint,
  LifecycleOriginKind,
  OrgPolicyRule,
  PolicyRuleKey,
} from "@/lib/lifecycle/lifecycle-policy";

/** A wildcard artifact-type match. `artifact_type` is free text, so `*` is a
 * legal stored value (needs no CHECK relaxation) and lets an org express a bound
 * over ALL artifact types for a (checkpoint, destination, origin) tuple. An EXACT
 * type match always beats the wildcard. */
export const POLICY_ARTIFACT_TYPE_WILDCARD = "*";

export interface UpsertPolicyRuleInput {
  orgId: string;
  checkpoint: LifecycleCheckpoint;
  artifactType: string;
  destinationClass: DestinationClass;
  originKind: LifecycleOriginKind;
  bound: "required" | "forbidden";
  selfApprovalOptIn?: boolean;
}

/**
 * Upsert an org bound. Keyed by the full (org, checkpoint, artifactType,
 * destinationClass, originKind) tuple — a re-upsert of the same key updates the
 * bound + opt-in in place (idempotent). `silent` is NOT storable: to remove a
 * bound, call `deleteLifecyclePolicyRule`.
 */
export async function upsertLifecyclePolicyRule(
  input: UpsertPolicyRuleInput,
): Promise<{ id: string }> {
  const [row] = await db
    .insert(lifecyclePolicyRules)
    .values({
      id: randomUUID(),
      orgId: input.orgId,
      checkpoint: input.checkpoint,
      artifactType: input.artifactType,
      destinationClass: input.destinationClass,
      originKind: input.originKind,
      bound: input.bound,
      selfApprovalOptIn: input.selfApprovalOptIn ?? false,
    })
    .onConflictDoUpdate({
      target: [
        lifecyclePolicyRules.orgId,
        lifecyclePolicyRules.checkpoint,
        lifecyclePolicyRules.artifactType,
        lifecyclePolicyRules.destinationClass,
        lifecyclePolicyRules.originKind,
      ],
      set: {
        bound: input.bound,
        selfApprovalOptIn: input.selfApprovalOptIn ?? false,
        updatedAt: new Date(),
      },
    })
    .returning({ id: lifecyclePolicyRules.id });
  return { id: row.id };
}

export async function deleteLifecyclePolicyRule(input: {
  orgId: string;
  checkpoint: LifecycleCheckpoint;
  artifactType: string;
  destinationClass: DestinationClass;
  originKind: LifecycleOriginKind;
}): Promise<void> {
  await db
    .delete(lifecyclePolicyRules)
    .where(
      and(
        eq(lifecyclePolicyRules.orgId, input.orgId),
        eq(lifecyclePolicyRules.checkpoint, input.checkpoint),
        eq(lifecyclePolicyRules.artifactType, input.artifactType),
        eq(lifecyclePolicyRules.destinationClass, input.destinationClass),
        eq(lifecyclePolicyRules.originKind, input.originKind),
      ),
    );
}

/**
 * Resolve the org bound for a policy key — the injected lookup the evaluator
 * consumes. Specificity: an EXACT `artifactType` match beats the `*` wildcard
 * over the same (checkpoint, destinationClass, originKind); no match returns
 * `silent` (the unconstrained signal). Never throws.
 */
export async function resolveOrgPolicyRule(
  orgId: string,
  key: PolicyRuleKey,
): Promise<OrgPolicyRule> {
  const rows = await db
    .select({
      artifactType: lifecyclePolicyRules.artifactType,
      bound: lifecyclePolicyRules.bound,
      selfApprovalOptIn: lifecyclePolicyRules.selfApprovalOptIn,
    })
    .from(lifecyclePolicyRules)
    .where(
      and(
        eq(lifecyclePolicyRules.orgId, orgId),
        eq(lifecyclePolicyRules.checkpoint, key.checkpoint),
        eq(lifecyclePolicyRules.destinationClass, key.destinationClass),
        eq(lifecyclePolicyRules.originKind, key.originKind),
      ),
    );

  // Prefer an exact artifact-type match; fall back to the wildcard.
  const exact = rows.find((r) => r.artifactType === key.artifactType);
  const wildcard = rows.find((r) => r.artifactType === POLICY_ARTIFACT_TYPE_WILDCARD);
  const chosen = exact ?? wildcard;
  if (!chosen) return { bound: "silent" };
  return {
    bound: chosen.bound === "required" ? "required" : "forbidden",
    selfApprovalOptIn: chosen.selfApprovalOptIn,
  };
}

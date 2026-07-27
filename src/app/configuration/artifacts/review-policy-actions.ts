"use server";
/**
 * The PRODUCTION write path for `cinatra.lifecycle_policy_rules`
 * (cinatra#2047 defect D-3; epic #2037 S0, lattice layer 1).
 *
 * Before this, `upsertLifecyclePolicyRule` / `deleteLifecyclePolicyRule` had zero
 * production callers: only the read side (`resolveOrgPolicyRule`) was wired, so
 * "org bounds beat defaults" was true of the resolver and false of the product —
 * an organization had no way to express a bound at all. These two actions are
 * that path.
 *
 * Every write:
 *   - is AUTHORIZED by `resolvePolicyBoundWriteAccess` (`settings.update`;
 *     see `src/lib/artifacts/lifecycle-policy-access.ts` for why that power),
 *   - is ORG-SCOPED to the caller's own active organization — the org id is taken
 *     from the session and the form's org field, if any, is IGNORED,
 *   - carries the lattice's FULL key `(org, checkpoint, artifactType,
 *     destinationClass, originKind)` so the store's exact-beats-`*` specificity is
 *     expressible from the product, not only from a test,
 *   - is validated by the pure `parsePolicyBoundInput` / `parsePolicyKeyInput`
 *     against the evaluator's own vocabulary, so no out-of-lattice value can reach
 *     the table.
 *
 * Refusals are VALUES, not throws (the repo's decide-helper convention): the form
 * renders the message inline instead of blowing up a server component tree.
 */
import { revalidatePath } from "next/cache";

import {
  deleteLifecyclePolicyRule,
  upsertLifecyclePolicyRule,
} from "@cinatra-ai/agents/lifecycle-policy-store";
import {
  parsePolicyBoundInput,
  parsePolicyKeyInput,
  type RawPolicyInput,
} from "@/lib/lifecycle/lifecycle-policy";
import {
  lifecycleAccessMessage,
  resolvePolicyBoundWriteAccess,
} from "@/lib/artifacts/lifecycle-policy-access";

const CONSOLE_PATH = "/configuration/artifacts";

/** `at` is the moment the result was produced. The editor renders ONE message
 * line fed by two independent actions, so it needs a total order over them —
 * without it a single retract would shadow every subsequent save. */
export type ReviewPolicyActionState =
  | { status: "idle"; at?: undefined }
  | { status: "saved"; message: string; at: number }
  | { status: "error"; message: string; at: number };

/** Read the lattice-key fields off a FormData WITHOUT trusting any org field. */
function toRaw(formData: FormData): RawPolicyInput {
  return {
    checkpoint: formData.get("checkpoint"),
    artifactType: formData.get("artifactType"),
    destinationClass: formData.get("destinationClass"),
    originKind: formData.get("originKind"),
    bound: formData.get("bound"),
  };
}

/** Set (or replace) one org bound. Idempotent on the full tuple — re-saving the
 * same key updates the bound in place. */
export async function upsertReviewPolicyRuleAction(
  _prev: ReviewPolicyActionState,
  formData: FormData,
): Promise<ReviewPolicyActionState> {
  const access = await resolvePolicyBoundWriteAccess();
  if (!access.ok) {
    return { status: "error", message: lifecycleAccessMessage(access.reason), at: Date.now() };
  }

  const parsed = parsePolicyBoundInput(toRaw(formData));
  if (!parsed.ok) return { status: "error", message: parsed.error, at: Date.now() };

  await upsertLifecyclePolicyRule({ orgId: access.orgId, ...parsed.value });
  revalidatePath(CONSOLE_PATH);
  return {
    at: Date.now(),
    status: "saved",
    message: `${parsed.value.checkpoint} is now ${parsed.value.bound} for ${parsed.value.artifactType} · ${parsed.value.destinationClass} · ${parsed.value.originKind}.`,
  };
}

/** Retract one org bound — the lattice returns to `silent` (unconstrained) for
 * that key, so the core defaults decide again. */
export async function deleteReviewPolicyRuleAction(
  _prev: ReviewPolicyActionState,
  formData: FormData,
): Promise<ReviewPolicyActionState> {
  const access = await resolvePolicyBoundWriteAccess();
  if (!access.ok) {
    return { status: "error", message: lifecycleAccessMessage(access.reason), at: Date.now() };
  }

  const parsed = parsePolicyKeyInput(toRaw(formData));
  if (!parsed.ok) return { status: "error", message: parsed.error, at: Date.now() };

  await deleteLifecyclePolicyRule({ orgId: access.orgId, ...parsed.value });
  revalidatePath(CONSOLE_PATH);
  return {
    at: Date.now(),
    status: "saved",
    message: `Bound removed — ${parsed.value.checkpoint} for ${parsed.value.artifactType} is unconstrained again.`,
  };
}

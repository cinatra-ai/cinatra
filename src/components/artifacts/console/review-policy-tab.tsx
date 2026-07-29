import "server-only";
/**
 * Review policy tab — the Artifacts console's lifecycle-policy administration
 * (cinatra#2047 defect D-3 + row 9; epic #2037 S0 lattice layer 1).
 *
 * Two halves, deliberately on ONE tab:
 *
 *   1. The org BOUNDS an operator can set (`required` / `forbidden` per
 *      checkpoint · artifact type · destination class · origin kind). Before this
 *      the store's writers had zero production callers, so the lattice's top layer
 *      was unreachable and every org silently ran on core defaults.
 *   2. The open-review-gate VOLUME those bounds produce, rolled up along the very
 *      same axes. Row 9 asks an administrator to confirm the defaults' scoping
 *      "against real volumes" — that judgement is only possible when the volume
 *      sits next to the knob, so it does.
 *
 * Authorization is resolved here, not assumed from the console's admin gate: the
 * bounds READ + the volume read need `settings.read`, the bounds WRITE needs
 * `settings.update`. A caller who can read but not write gets the listing with no
 * form (and the server actions refuse independently).
 */
import {
  listLifecyclePolicyRules,
  readOrgReviewGateVolume,
} from "@cinatra-ai/agents/lifecycle-policy-store";

import {
  lifecycleAccessMessage,
  resolveGateVolumeReadAccess,
  resolvePolicyBoundWriteAccess,
} from "@/lib/artifacts/lifecycle-policy-access";
import {
  deleteReviewPolicyRuleAction,
  upsertReviewPolicyRuleAction,
} from "@/app/configuration/artifacts/review-policy-actions";

import { GateVolumePanel } from "./gate-volume-panel";
import { ReviewPolicyEditor } from "./review-policy-editor";

function SectionHeading({ title, blurb }: { title: string; blurb: string }) {
  return (
    <div className="flex flex-col gap-1">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      <p className="text-xs text-muted-foreground">{blurb}</p>
    </div>
  );
}

export async function ReviewPolicyTab() {
  const readAccess = await resolveGateVolumeReadAccess();
  if (!readAccess.ok) {
    return (
      <div
        className="rounded-lg border border-line bg-surface-strong px-5 py-10 text-center text-sm text-muted-foreground"
        data-testid="review-policy"
        data-conformance-id="review-policy"
        data-state="denied"
      >
        {lifecycleAccessMessage(readAccess.reason)}
      </div>
    );
  }

  const writeAccess = await resolvePolicyBoundWriteAccess();
  const [rules, volume] = await Promise.all([
    listLifecyclePolicyRules(readAccess.orgId),
    readOrgReviewGateVolume({ orgId: readAccess.orgId }),
  ]);

  return (
    <div
      className="flex flex-col gap-6"
      data-testid="review-policy"
      data-conformance-id="review-policy"
      data-can-write={writeAccess.ok ? "true" : "false"}
    >
      <div className="flex flex-col gap-3">
        <SectionHeading
          title="Organization bounds"
          blurb="A bound is absolute: required forces the checkpoint on for every producing agent, forbidden bars it. Where this organization is silent, the core defaults decide and an agent manifest may refine within them — never on an external-effect class."
        />
        <ReviewPolicyEditor
          rules={rules}
          canWrite={writeAccess.ok}
          upsertAction={upsertReviewPolicyRuleAction}
          deleteAction={deleteReviewPolicyRuleAction}
        />
      </div>

      <div className="flex flex-col gap-3">
        <SectionHeading
          title="Open review volume"
          blurb="What the current policy is actually producing, broken down by the same axes a bound is written in — so a default that generates an unsurvivable volume is visible before it becomes review fatigue."
        />
        <GateVolumePanel volume={volume} showListing={false} />
      </div>
    </div>
  );
}

"use client";

// ---------------------------------------------------------------------------
// ModalUpdatePlanFlow — the §II detail-modal footer UPDATE flow
// (cinatra#1041 outcome 2; design spec "Modal footer — Update plan (dry-run)").
//
// "Update now" runs the resolver as a DRY-RUN first (planExtensionUpdateFormAction)
// and renders the concrete Update plan — every affected member grouped by what
// happens to it (Update / Install / Side-by-side / Rebound) — which the admin
// confirms before anything is written. "Confirm update" applies through the
// SAME planner/batch path as install (updateExtensionPackageFormAction →
// rootAction:"update"), so the existing InstallBatchPanel / InstallBatchLive-
// Refresh progress surface tracks each member live after the redirect lands
// back on /configuration/extensions. A dry-run failure surfaces ONLY the
// category-mapped #685 copy (raw reasons stay server-side).
//
// This footer is the ONLY place the update runs (design §II/§III rule): the
// installed card carries at most the Update-available chip, and its actions
// stay exactly Settings + More details.
// ---------------------------------------------------------------------------

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/cinatra-toast";
import { MarketplaceInstallForm, MarketplaceInstallSubmit } from "./marketplace-install-form";
import type {
  MarketplaceFailureCategory,
  MarketplaceInstallActionResult,
} from "./marketplace-failure-copy";
import {
  updatePlanMemberName,
  updatePlanMemberNote,
  updatePlanMemberVersionLabel,
  type PlanExtensionUpdateResult,
  type UpdatePlanMemberAction,
  type UpdatePlanPreviewDto,
} from "./update-plan-model";

type ModalUpdatePlanFlowProps = {
  /** The extension's human-readable name (root displayName fallback + copy). */
  displayName: string;
  /** Bound dry-run action — returns the plan or a #685 category. */
  planAction: () => Promise<PlanExtensionUpdateResult>;
  /** Bound apply action (redirects on success; returns a category on failure). */
  updateAction: () => Promise<MarketplaceInstallActionResult | void>;
  failureCopyByCategory: Record<MarketplaceFailureCategory, string>;
  defaultFailureMessage: string;
};

/** §II plan-member tag colours: Update --blue / Install --green /
 *  Side-by-side --olive (the app's warning mustard) / Rebound --muted. */
const MEMBER_TAG_CLASS: Record<UpdatePlanMemberAction, string> = {
  update: "bg-info text-info-foreground",
  install: "bg-success text-success-foreground",
  "side-by-side": "bg-warning text-warning-foreground",
  rebound: "bg-muted-foreground text-background",
};

const MEMBER_TAG_LABEL: Record<UpdatePlanMemberAction, string> = {
  update: "Update",
  install: "Install",
  "side-by-side": "Side-by-side",
  rebound: "Rebound",
};

export function ModalUpdatePlanFlow({
  displayName,
  planAction,
  updateAction,
  failureCopyByCategory,
  defaultFailureMessage,
}: ModalUpdatePlanFlowProps) {
  const [phase, setPhase] = useState<"idle" | "planning">("idle");
  const [plan, setPlan] = useState<UpdatePlanPreviewDto | null>(null);

  async function runDryRun() {
    setPhase("planning");
    try {
      const result = await planAction();
      if (result.ok) {
        setPlan(result.plan);
      } else {
        // #685: category-mapped, non-technical copy only — never a raw reason.
        toast.error(failureCopyByCategory[result.category] ?? defaultFailureMessage);
      }
    } catch {
      // A thrown server-action failure is masked in production — default copy.
      toast.error(defaultFailureMessage);
    } finally {
      setPhase("idle");
    }
  }

  // Phase 1 — the footer CTA: "Update now" runs the dry-run (never the write).
  if (plan === null) {
    const planning = phase === "planning";
    return (
      <Button
        size="sm"
        onClick={() => void runDryRun()}
        disabled={planning}
        data-slot="modal-update-now"
        data-pending={planning ? "" : undefined}
        className="disabled:opacity-70"
      >
        {planning ? (
          <>
            <Loader2 className="animate-spin" aria-hidden="true" />
            Update now
          </>
        ) : (
          "Update now"
        )}
      </Button>
    );
  }

  // Phase 2 — the Update plan panel (§II drawing): header + count, one row per
  // affected member (tag, displayName, mono version transition, muted note),
  // then Cancel / Confirm update above a hairline.
  const memberCount = plan.members.length;
  return (
    <div
      data-slot="update-plan-panel"
      className="flex w-full flex-col gap-2.75 rounded-[8px] border border-line bg-surface-strong px-4 py-3.5"
    >
      <div className="flex items-center justify-between gap-2.5">
        <span className="text-sm font-bold text-foreground">Update plan</span>
        <span className="font-mono text-badge-2xs font-bold uppercase text-muted-foreground">
          {memberCount} {memberCount === 1 ? "member" : "members"}
        </span>
      </div>

      {plan.members.map((member) => {
        const note = updatePlanMemberNote(member, plan.members, displayName);
        const versionLabel = updatePlanMemberVersionLabel(member);
        return (
          <div
            key={`${member.action}:${member.packageName}`}
            data-slot="update-plan-member"
            data-action={member.action}
            data-package={member.packageName}
            className="flex items-start gap-2"
          >
            <span
              className={cn(
                "mt-0.5 shrink-0 rounded-[4px] px-1.5 py-px font-mono text-badge-2xs font-bold uppercase",
                MEMBER_TAG_CLASS[member.action],
              )}
            >
              {MEMBER_TAG_LABEL[member.action]}
            </span>
            <span className="min-w-0 text-xs leading-relaxed text-foreground">
              {/* data-field: the rendered member name binds the manifest
                  displayName (conformance: names are displayNames). */}
              <span data-field="manifest.displayName">
                {updatePlanMemberName(member, displayName)}
              </span>
              {versionLabel && (
                <span className="ml-1.5 font-mono text-muted-foreground">{versionLabel}</span>
              )}
              {note && <span className="ml-1.5 text-muted-foreground">· {note}</span>}
            </span>
          </div>
        );
      })}

      <div className="mt-0.75 flex items-center justify-end gap-2 border-t border-line pt-2.75">
        <Button size="sm" variant="outline" onClick={() => setPlan(null)}>
          Cancel
        </Button>
        {/* Confirm applies through the planner/batch path; failures toast the
            category-mapped copy (MarketplaceInstallForm, #685); success
            redirects to /configuration/extensions where the install batch
            panel tracks the members live. */}
        <MarketplaceInstallForm
          action={updateAction}
          failureCopyByCategory={failureCopyByCategory}
          defaultFailureMessage={defaultFailureMessage}
        >
          <MarketplaceInstallSubmit pendingLabel="Updating…">
            Confirm update
          </MarketplaceInstallSubmit>
        </MarketplaceInstallForm>
      </div>
    </div>
  );
}

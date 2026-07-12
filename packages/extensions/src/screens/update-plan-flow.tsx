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
// rootAction:"update"). The §II footer states, per the drawing:
//   • Update — the plan panel with Cancel / Confirm update;
//   • Applying — the disabled "Updating…" submit plus the mono "{n} members ·
//     tracked live in the install batch panel" line (the durable ledger drives
//     the page-level InstallBatchPanel / InstallBatchLiveRefresh surface);
//   • Failed — the red Failed pill over the CATEGORY-MAPPED #685 copy (raw
//     reasons stay server-side); the batch has compensated, so Close returns
//     to the idle CTA honestly (prior versions restored).
//
// This footer is the ONLY place the §III installed extension's update runs:
// the installed card carries at most the Update-available chip, and its
// actions stay exactly Settings + More details.
// ---------------------------------------------------------------------------

import { useState } from "react";
import { useFormStatus } from "react-dom";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/cinatra-toast";
import { isRedirectError } from "./is-redirect-error";
import { MarketplaceInstallSubmit } from "./marketplace-install-form";
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
  const [phase, setPhase] = useState<"idle" | "planning" | "plan" | "failed">("idle");
  const [plan, setPlan] = useState<UpdatePlanPreviewDto | null>(null);
  const [failureCopy, setFailureCopy] = useState<string | null>(null);

  async function runDryRun() {
    setPhase("planning");
    try {
      const result = await planAction();
      if (result.ok) {
        setPlan(result.plan);
        setPhase("plan");
      } else {
        // #685: category-mapped, non-technical copy only — never a raw reason.
        // A dry-run failure wrote NOTHING, so a toast + return to the idle CTA
        // is the honest state (the §II Failed tile is the APPLY failure).
        toast.error(failureCopyByCategory[result.category] ?? defaultFailureMessage);
        setPhase("idle");
      }
    } catch (error) {
      // Auth redirect sentinel (the plan action is admin-gated; this page is
      // session-gated) — re-throw so Next.js navigates to /not-authorized
      // instead of masking authorization as a retryable failure (codex r2).
      if (isRedirectError(error)) throw error;
      // A thrown server-action failure is masked in production — default copy.
      toast.error(defaultFailureMessage);
      setPhase("idle");
    }
  }

  // §II Failed state (apply): the batch failed AND compensated (prior versions
  // restored). Surface the category-mapped copy in the footer panel per the
  // drawing — never the raw reason (#685). Success never reaches this: the
  // apply action redirect()s (the sentinel is re-thrown for Next.js).
  async function handleConfirm() {
    try {
      const result = await updateAction();
      if (result && result.ok === false) {
        setFailureCopy(failureCopyByCategory[result.category] ?? defaultFailureMessage);
        setPhase("failed");
      }
    } catch (error) {
      if (isRedirectError(error)) throw error;
      setFailureCopy(defaultFailureMessage);
      setPhase("failed");
    }
  }

  // Phase 1 — the footer CTA: "Update now" runs the dry-run (never the write).
  if (phase === "idle" || phase === "planning") {
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

  // §II Failed tile: the red Failed pill over the category-mapped copy.
  if (phase === "failed") {
    return (
      <div
        data-slot="update-plan-failed"
        className="flex w-full flex-col gap-2.25 rounded-[8px] border border-line bg-surface-strong px-4 py-3.5"
      >
        <span className="self-start rounded-full bg-destructive px-2 py-0.75 font-mono text-badge-2xs font-bold uppercase text-white">
          Failed
        </span>
        <p className="text-xs leading-relaxed text-foreground">{failureCopy}</p>
        <div className="flex items-center justify-end border-t border-line pt-2.75">
          <Button size="sm" variant="outline" onClick={() => {
            setPlan(null);
            setFailureCopy(null);
            setPhase("idle");
          }}>
            Close
          </Button>
        </div>
      </div>
    );
  }

  // Phase 2 — the Update plan panel (§II drawing): header + count, one row per
  // affected member (tag, displayName, mono version transition, muted note),
  // then Cancel / Confirm update above a hairline. Submitting flips the button
  // to the Applying state ("Updating…" + the members-tracked line).
  const members = plan?.members ?? [];
  const memberCount = members.length;
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

      {members.map((member) => {
        const note = updatePlanMemberNote(member, members, displayName);
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

      {/* Confirm applies through the planner/batch path; the pending submit is
          the §II Applying state; a failure flips this panel to the Failed tile
          (category-mapped, batch compensated); success redirects to
          /configuration/extensions where the install batch panel tracks the
          members live. */}
      <form action={handleConfirm} className="mt-0.75 border-t border-line pt-2.75">
        <div className="flex items-center justify-end gap-2">
          <ApplyingMembersNote memberCount={memberCount} />
          <CancelPlanButton
            onCancel={() => {
              setPlan(null);
              setPhase("idle");
            }}
          />
          <MarketplaceInstallSubmit pendingLabel="Updating…">
            Confirm update
          </MarketplaceInstallSubmit>
        </div>
      </form>
    </div>
  );
}

/** §II Applying state: the mono "tracked live in the install batch panel"
 *  line beside the pending "Updating…" submit (the durable ledger drives the
 *  page-level batch panel; this modal never re-implements that surface). */
function ApplyingMembersNote({ memberCount }: { memberCount: number }) {
  const { pending } = useFormStatus();
  if (!pending) return null;
  return (
    <span
      data-slot="update-plan-applying"
      className="mr-auto font-mono text-badge-xs text-muted-foreground"
    >
      {memberCount} {memberCount === 1 ? "member" : "members"} · tracked live in the install
      batch panel
    </span>
  );
}

/** Cancel disables while the apply is in flight (a half-submitted batch must
 *  not be "cancelled" into a stale idle CTA — the ledger owns the outcome). */
function CancelPlanButton({ onCancel }: { onCancel: () => void }) {
  const { pending } = useFormStatus();
  return (
    <Button size="sm" type="button" variant="outline" disabled={pending} onClick={onCancel}>
      Cancel
    </Button>
  );
}

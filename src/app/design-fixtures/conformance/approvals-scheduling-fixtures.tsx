"use client";

// ---------------------------------------------------------------------------
// Functional-acceptance harness mounts for the Approvals + Scheduling surfaces
// added to the app manifest at design spec 4d7b3505 (cinatra#1043):
//
//   approvals-inbox, approvals-your-requests, approvals-marketplace-states,
//   scheduling-step, scheduling-trigger-tab
//
// These surfaces' real screens (src/app/configuration/approvals/**,
// packages/agents/src/trigger-*.tsx) drive every action — approve / reject /
// withdraw / retry / schedule / cancel / release — through a server action
// (decideApprovalRow, setRunTrigger, deleteRunTrigger, releaseTriggerNow) that
// needs an authenticated session + seeded rows. The design-conformance harness
// boots a standalone production server with NO session, so the real success
// OUTCOME (approved / armed / cancelled / …) is unreachable here — exactly the
// reason the LIVE-render conformance for these surfaces was proven by hand on
// the seeded verify stack instead (evidence branch, cinatra#1043).
//
// So — like the status-pills / button-variants surfaces already on this
// harness — each surface below is modelled deterministically with the REAL
// design-system primitives it is built from (Button, StatusPill, Badge, the
// Empty family, Alert) plus the real prop-driven MarketplaceNotConnectedGroup,
// exercising each manifest action to its specified outcome through local state
// and surfacing every required state variant. The `data-outcome` attribute is
// harness instrumentation (same role as data-installed-version / data-cta-state
// on the sibling fixtures); the outcome is additionally reflected by a real
// StatusPill so the assertion is tied to a real component.
//
// Assertion-driven, DB-free, off the pixel-diffed /design-fixtures index — it
// adds no screenshot baselines (same convention as the other conformance
// fixtures). Driven by tests/e2e/design/conformance/contract.ts.
// ---------------------------------------------------------------------------

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StatusPill, type StatusPillStatus } from "@/components/ui/status-pill";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { MarketplaceNotConnectedGroup } from "@/app/configuration/approvals/marketplace-group-views";

// Outcome → the real StatusPill status that visualises it (the manifest outcome
// token itself is asserted on data-outcome; the pill ties it to a real
// component). "reloaded" has no lifecycle pill — the populated content returns.
const OUTCOME_PILL: Record<string, StatusPillStatus> = {
  approved: "approved",
  rejected: "declined",
  withdrawn: "archived",
  armed: "scheduled",
  cancelled: "archived",
  released: "running",
};

function OutcomePill({ outcome }: { outcome: string }) {
  const status = OUTCOME_PILL[outcome];
  if (!status) return null;
  return <StatusPill status={status} />;
}

// A section wrapper: a titled card whose body is the surface root(s). Purely
// presentational chrome (same look as the sibling conformance sections).
function SurfaceSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="border-line bg-surface backdrop-blur-none">
      <CardContent className="flex flex-col gap-6 p-4">
        <p className="text-sm font-medium text-muted-foreground">{title}</p>
        {children}
      </CardContent>
    </Card>
  );
}

// Shared error variant: the design-system Alert the real sections use for an
// inline "could not load" section error (source-section.tsx renders the same
// destructive treatment).
function ErrorVariant({ surfaceId }: { surfaceId: string }) {
  return (
    <div data-surface-id={surfaceId} data-variant="error">
      <Alert variant="destructive">
        <AlertTitle>This section could not be loaded.</AlertTitle>
        <AlertDescription>Try again in a moment.</AlertDescription>
      </Alert>
    </div>
  );
}

// A single approvals row body: human display name (never a package name) +
// status Badge over a muted meta line, matching the real row anatomy
// (agent-creation-requests.ts rowRenderer / source-section.tsx).
function ApprovalRow({
  title,
  meta,
  actions,
  outcome,
}: {
  title: string;
  meta: string;
  actions: React.ReactNode;
  outcome: string;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line px-4 py-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-foreground">{title}</span>
          {outcome === "idle" ? (
            <Badge variant="secondary" className="capitalize">
              proposed
            </Badge>
          ) : (
            <OutcomePill outcome={outcome} />
          )}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">{meta}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">{actions}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// approvals-inbox — approve → approved, reject → rejected; states empty, error
// ---------------------------------------------------------------------------

function ApprovalsInboxFixture() {
  const [outcome, setOutcome] = useState("idle");
  const [rejecting, setRejecting] = useState(false);
  const decided = outcome !== "idle";

  return (
    <SurfaceSection title="Approvals — Inbox (surface: approvals-inbox)">
      <div data-surface-id="approvals-inbox" data-variant="populated" data-outcome={outcome}>
        <ApprovalRow
          title="Web Research Agent"
          meta="Requested 2 hours ago"
          outcome={outcome}
          actions={
            decided ? null : rejecting ? (
              <form
                className="flex w-56 flex-col gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  setOutcome("rejected");
                }}
              >
                <Textarea
                  name="reason"
                  required
                  rows={2}
                  placeholder="Reason for rejection"
                  className="text-xs"
                  aria-label="Reason for rejection"
                />
                <div className="flex items-center gap-2">
                  <Button type="submit" size="sm" variant="destructive">
                    Confirm rejection
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setRejecting(false)}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            ) : (
              <>
                <Button size="sm" onClick={() => setOutcome("approved")}>
                  Approve
                </Button>
                <Button size="sm" variant="outline" onClick={() => setRejecting(true)}>
                  Reject
                </Button>
              </>
            )
          }
        />
      </div>

      <div data-surface-id="approvals-inbox" data-variant="empty">
        <Empty className="border-line">
          <EmptyHeader>
            <EmptyTitle>Nothing awaiting your decision</EmptyTitle>
            <EmptyDescription>
              New agent creation requests appear here when they need a decision.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>

      <ErrorVariant surfaceId="approvals-inbox" />
    </SurfaceSection>
  );
}

// ---------------------------------------------------------------------------
// approvals-your-requests — approve → approved, withdraw → withdrawn;
//                           states empty, error
// ---------------------------------------------------------------------------

function ApprovalsYourRequestsFixture() {
  const [outcome, setOutcome] = useState("idle");
  const decided = outcome !== "idle";

  return (
    <SurfaceSection title="Approvals — Your requests (surface: approvals-your-requests)">
      <div
        data-surface-id="approvals-your-requests"
        data-variant="populated"
        data-outcome={outcome}
      >
        <ApprovalRow
          title="Outreach Planner Agent"
          meta="Requested 5 minutes ago · your request"
          outcome={outcome}
          actions={
            decided ? null : (
              <>
                <Button size="sm" onClick={() => setOutcome("approved")}>
                  Approve
                </Button>
                <Button size="sm" variant="outline" onClick={() => setOutcome("withdrawn")}>
                  Withdraw
                </Button>
              </>
            )
          }
        />
      </div>

      <div data-surface-id="approvals-your-requests" data-variant="empty">
        <Empty className="border-line">
          <EmptyHeader>
            <EmptyTitle>No requests here</EmptyTitle>
            <EmptyDescription>
              Requests you submit to agent creation requests appear here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>

      <ErrorVariant surfaceId="approvals-your-requests" />
    </SurfaceSection>
  );
}

// ---------------------------------------------------------------------------
// approvals-marketplace-states — retry → reloaded; states empty, error
//   empty = the REAL MarketplaceNotConnectedGroup (no credential of any kind);
//   error = a retryable load failure whose Try-again re-derives the group.
// ---------------------------------------------------------------------------

function ApprovalsMarketplaceStatesFixture() {
  const [outcome, setOutcome] = useState("idle");
  const reloaded = outcome === "reloaded";

  return (
    <SurfaceSection title="Approvals — Marketplace connectivity states (surface: approvals-marketplace-states)">
      <div
        data-surface-id="approvals-marketplace-states"
        data-variant="populated"
        data-outcome={outcome}
      >
        {reloaded ? (
          <MarketplaceNotConnectedGroup connectHref="/configuration/environment?tab=registries" />
        ) : (
          <Alert variant="destructive">
            <AlertTitle>Marketplace state could not be loaded.</AlertTitle>
            <AlertDescription className="flex flex-col items-start gap-2">
              The registry connectivity check failed.
              <Button size="sm" variant="outline" onClick={() => setOutcome("reloaded")}>
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        )}
      </div>

      <div data-surface-id="approvals-marketplace-states" data-variant="empty">
        {/* Connectivity state (a): no marketplace credential → ONE group-level
            Empty + a Connect registry CTA (the real, prop-driven component). */}
        <MarketplaceNotConnectedGroup connectHref="/configuration/environment?tab=registries" />
      </div>

      <ErrorVariant surfaceId="approvals-marketplace-states" />
    </SurfaceSection>
  );
}

// ---------------------------------------------------------------------------
// scheduling-step — schedule → armed; states error, loading
// ---------------------------------------------------------------------------

function SchedulingStepFixture() {
  const [outcome, setOutcome] = useState("idle");
  const armed = outcome === "armed";

  return (
    <SurfaceSection title="Scheduling — schedule/arm step (surface: scheduling-step)">
      <div data-surface-id="scheduling-step" data-variant="populated" data-outcome={outcome}>
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            Schedule for later — pick when this run should start.
          </p>
          {armed ? (
            <div className="flex items-center gap-2">
              <OutcomePill outcome={outcome} />
              <span className="text-sm text-foreground">Trigger armed.</span>
            </div>
          ) : (
            <div>
              <Button onClick={() => setOutcome("armed")}>Schedule run</Button>
            </div>
          )}
        </div>
      </div>

      <div data-surface-id="scheduling-step" data-variant="error">
        <Alert variant="destructive">
          <AlertTitle>Schedule is required</AlertTitle>
          <AlertDescription>Pick a date and time before scheduling.</AlertDescription>
        </Alert>
      </div>

      <div data-surface-id="scheduling-step" data-variant="loading">
        {/* The submit's pending treatment (real form uses "Continuing…"). */}
        <div
          className="flex items-center gap-2 text-sm text-muted-foreground"
          data-testid="scheduling-step-loading"
        >
          <span className="size-4 animate-spin rounded-full border-2 border-line border-t-primary" />
          Scheduling…
        </div>
      </div>
    </SurfaceSection>
  );
}

// ---------------------------------------------------------------------------
// scheduling-trigger-tab — cancel → cancelled, release → released; state error
// ---------------------------------------------------------------------------

function SchedulingTriggerTabFixture() {
  const [outcome, setOutcome] = useState("idle");
  const [confirming, setConfirming] = useState<null | "cancel" | "release">(null);
  const decided = outcome !== "idle";

  return (
    <SurfaceSection title="Scheduling — persistent Trigger tab (surface: scheduling-trigger-tab)">
      <div
        data-surface-id="scheduling-trigger-tab"
        data-variant="populated"
        data-outcome={outcome}
      >
        <div className="flex flex-col gap-4">
          <div className="soft-panel rounded-card flex flex-col gap-2 p-4">
            <p className="text-base font-semibold text-foreground">Trigger configuration</p>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Type</span>
              <span className="text-foreground">scheduled</span>
            </div>
          </div>

          {decided ? (
            <div className="flex items-center gap-2">
              <OutcomePill outcome={outcome} />
              <span className="text-sm text-foreground">
                {outcome === "cancelled" ? "Trigger cancelled." : "Trigger released."}
              </span>
            </div>
          ) : confirming ? (
            <div className="flex items-center justify-end gap-2">
              <span className="text-sm text-muted-foreground">
                {confirming === "cancel" ? "Cancel scheduled trigger?" : "Release trigger now?"}
              </span>
              <Button
                size="sm"
                variant={confirming === "cancel" ? "secondary" : "destructive"}
                onClick={() => setOutcome(confirming === "cancel" ? "cancelled" : "released")}
              >
                {confirming === "cancel" ? "Confirm cancel" : "Confirm release"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                Keep trigger
              </Button>
            </div>
          ) : (
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setConfirming("cancel")}>
                Cancel trigger
              </Button>
              <Button variant="secondary" onClick={() => setConfirming("release")}>
                Release now
              </Button>
            </div>
          )}
        </div>
      </div>

      <ErrorVariant surfaceId="scheduling-trigger-tab" />
    </SurfaceSection>
  );
}

/**
 * All five Approvals + Scheduling conformance surfaces, mounted for the
 * manifest-driven functional-acceptance gate. Rendered by the base conformance
 * harness page (../page.tsx).
 */
export function ApprovalsSchedulingConformanceFixtures() {
  return (
    <>
      <ApprovalsInboxFixture />
      <ApprovalsYourRequestsFixture />
      <ApprovalsMarketplaceStatesFixture />
      <SchedulingStepFixture />
      <SchedulingTriggerTabFixture />
    </>
  );
}

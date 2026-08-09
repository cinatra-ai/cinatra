"use client";

// -----------------------------------------------------------------------------
// Agent-creation approval decision panel (the approvals DETAIL surface).
//
// cinatra#1327 made an approve the install-equivalent moment for a chat-created
// agent: the reviewer MUST say who can access the agent once it is published,
// and the server refuses a scope-less approve fail-closed. cinatra#2597: this
// form never offered that choice, so every approve from this page hit the
// server gate and the page was a structural dead end.
//
// The scope step here is the SAME one the inbox row dialog uses — the same
// server-computed install targets (`loadApprovalInstallScopeContext`), the same
// `AccessCombobox` in installMode, the same pure row/committability model
// (`approvalScopePickerModel` + `canSubmitApprovalScope` +
// `resolveFlatAccessOption`) — so the two approval surfaces can never offer
// different scopes. It renders INLINE in the existing Decision panel rather
// than in a dialog: this page IS the decision surface, so the row dialog's
// reason for existing (a compact row) does not apply.
//
// Client component: the picker is interactive, and `AccessCombobox` takes an
// `onValueChange` callback that cannot cross a server/client boundary. The
// decision server actions are imported from ./actions ("use server") and bound
// to plain <form action={…}> submissions, so the codes-only redirect flash
// protocol (./approval-decision-flash) is unchanged. NO new module is
// introduced — every import here is already on this page's reachable graph, so
// the route-graph ratchet is untouched.
// -----------------------------------------------------------------------------

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, FieldGroup, FieldLabel, FieldDescription } from "@/components/ui/field";
import { AccessCombobox, resolveFlatAccessOption } from "@/components/access-combobox";
import {
  approvalScopePickerModel,
  canSubmitApprovalScope,
  pickerValueToTarget,
} from "@cinatra-ai/agents/auth-policy-types";
import {
  loadApprovalInstallScopeContext,
  type ApprovalInstallScopeContext,
} from "@/lib/approvals/actions";

import {
  approveAgentCreationRequest,
  rejectAgentCreationRequest,
  retryPublishAgentCreationRequest,
} from "./actions";

type ScopeLoad = "loading" | "ready" | "failed";

export function ApprovalDecisionForm({
  requestId,
  snapshotHash,
  stuckApproved = false,
}: {
  requestId: string;
  snapshotHash: string;
  stuckApproved?: boolean;
}) {
  // Access-scope picker context — computed on the SERVER with the real session
  // (orgRole-aware enabled/disabled rows), never client-derived. Hooks run
  // before the stuckApproved early return (rules of hooks); the effect itself
  // no-ops on that branch, which has no approve affordance.
  const [scopeCtx, setScopeCtx] = useState<ApprovalInstallScopeContext | null>(null);
  const [scopeLoad, setScopeLoad] = useState<ScopeLoad>("loading");
  const [scopeValue, setScopeValue] = useState<string>("");

  useEffect(() => {
    if (stuckApproved) return;
    let cancelled = false;
    void (async () => {
      try {
        const ctx = await loadApprovalInstallScopeContext();
        if (cancelled) return;
        if (!ctx) {
          setScopeLoad("failed");
          return;
        }
        setScopeCtx(ctx);
        setScopeValue(ctx.defaultValue ?? "");
        setScopeLoad("ready");
      } catch {
        if (!cancelled) setScopeLoad("failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [stuckApproved]);

  if (stuckApproved) {
    return (
      <div className="soft-panel rounded-card px-6 py-4 flex flex-col gap-3">
        <h3 className="text-sm font-semibold">Retry publish</h3>
        <FieldDescription>
          The CAS to approved succeeded but the materialize / publish step errored. The proposal is
          held at <code>approved</code> with no template row created. Retry to re-attempt the
          publish under the same admin actor (the snapshot is unchanged — no re-decide).
        </FieldDescription>
        <form action={retryPublishAgentCreationRequest}>
          <Input type="hidden" name="id" value={requestId} />
          <Button type="submit">Retry publish</Button>
        </form>
      </div>
    );
  }

  const picker = scopeCtx ? approvalScopePickerModel(scopeCtx) : null;
  const approveTarget = scopeCtx ? pickerValueToTarget(scopeValue, scopeCtx.activeOrgId) : null;
  const selectedOption =
    picker && scopeCtx
      ? resolveFlatAccessOption(scopeValue, picker.availableScopes, {
          disabledScopes: picker.disabledScopes,
          ownerOffered: false,
          workspaceOffered: false,
          adminOffered: false,
        })
      : null;
  // Required-ness (cinatra#1327): the submit is disabled until the chosen value
  // resolves to a real, grantable target. The structural adapter alone would
  // leave an unhydrated `team:<ghost>` selection enabled-but-rejected, so the
  // model-layer committability gate (the same one both install dialogs read)
  // is ANDed in — cinatra#2372.
  const canApprove =
    !!scopeCtx &&
    !!picker &&
    !picker.noInstallableScope &&
    canSubmitApprovalScope(scopeValue, scopeCtx.activeOrgId) &&
    (selectedOption?.committable ?? false);

  return (
    <div className="soft-panel rounded-card px-6 py-4 flex flex-col gap-4">
      <h3 className="text-sm font-semibold">Decision</h3>
      <FieldDescription>
        The selected decision is CAS-guarded by the snapshot hash. If the author edits the proposal
        after you opened this page, an approve/reject submission will fail with
        <code className="mx-1">stale_proposal</code>; reload to see the new snapshot.
      </FieldDescription>

      <form action={approveAgentCreationRequest} className="flex flex-col gap-3">
        <Input type="hidden" name="id" value={requestId} />
        <Input type="hidden" name="snapshotHash" value={snapshotHash} />
        {/* The chosen scope rides the approve submission. Absent → the server
            refuses before deciding, so nothing is half-approved. */}
        {approveTarget ? (
          <>
            <Input type="hidden" name="accessTargetLevel" value={approveTarget.level} />
            <Input type="hidden" name="accessTargetId" value={approveTarget.id} />
          </>
        ) : null}

        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="approve-scope-picker">Who can access this agent?</FieldLabel>
            {scopeLoad === "loading" ? (
              <p className="text-sm text-muted-foreground">Loading access options…</p>
            ) : scopeLoad === "failed" || !picker || !scopeCtx ? (
              <p className="text-sm text-destructive">
                Could not load the access options. Reload the page and try again.
              </p>
            ) : picker.noInstallableScope ? (
              <p className="text-sm text-destructive">
                You need org admin, team admin, or project ownership to grant access to this
                agent.
              </p>
            ) : (
              <>
                <AccessCombobox
                  id="approve-scope-picker"
                  value={scopeValue}
                  onValueChange={setScopeValue}
                  availableScopes={picker.availableScopes}
                  isAdmin={false}
                  disabledScopes={picker.disabledScopes}
                  disabledReasons={picker.disabledReasons}
                  // Only org / team:* / project:* are valid access targets —
                  // owner / admin / workspace rows stay hidden.
                  installMode
                />
                <FieldDescription>
                  Approving materializes the snapshot, compiles, publishes the agent, and grants
                  access to the scope you choose. Targets you cannot grant are disabled.
                </FieldDescription>
              </>
            )}
          </Field>
        </FieldGroup>

        <div>
          <Button type="submit" disabled={!canApprove}>
            Approve &amp; publish
          </Button>
        </div>
      </form>

      <form action={rejectAgentCreationRequest} className="flex flex-col gap-3">
        <Input type="hidden" name="id" value={requestId} />
        <Input type="hidden" name="snapshotHash" value={snapshotHash} />
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="reason">Rejection reason (required)</FieldLabel>
            <Textarea
              id="reason"
              name="reason"
              rows={3}
              placeholder="Explain what the author should change before resubmitting…"
              required
            />
            <FieldDescription>
              The author can edit + resubmit a rejected request; the reason is shown to them.
            </FieldDescription>
          </Field>
        </FieldGroup>
        <div>
          <Button type="submit" variant="outline">
            Reject
          </Button>
        </div>
      </form>
    </div>
  );
}

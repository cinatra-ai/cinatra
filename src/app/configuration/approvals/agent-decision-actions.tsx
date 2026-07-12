"use client";

import { useActionState, useState } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AccessCombobox } from "@/components/access-combobox";
import {
  pickerValueToTarget,
  canSubmitApprovalScope,
} from "@cinatra-ai/agents/auth-policy-types";

import {
  decideApprovalRow,
  loadApprovalInstallScopeContext,
  type InlineDecideState,
  type ApprovalInstallScopeContext,
} from "./actions";

const INITIAL: InlineDecideState = { ok: false };

/**
 * Inline Approve / Reject affordance for an agent-creation-request row — used on
 * an Inbox row (a request someone else must decide) and, for a pending own
 * request the viewer may clear themselves, on its "Your requests" row. Submits
 * through the shared `decideApprovalRow` server action (which dispatches to the
 * source's non-redirecting `decide` helper), carrying the CAS token
 * (`expectedVersion`) captured at render so an edit-after-view is still caught.
 *
 * cinatra#1327 — a chat-created agent is never store-installed, so ADMIN
 * APPROVAL is the install-equivalent moment: Approve now surfaces the SAME
 * access-scope step install uses (who can access the agent — organization /
 * team / project), as a REQUIRED step. The rows are the SAME server-computed
 * `InstallTarget`s + the SAME `AccessCombobox` the marketplace install dialog
 * uses (loaded lazily via `loadApprovalInstallScopeContext` so the row list
 * stays light); the confirm submit is disabled until a scope is chosen, and the
 * chosen scope is carried on the approve form so the server persists it through
 * the same access-policy write path (setExtensionInstallAccess). A publish
 * without a scope is refused server-side too (fail-closed).
 *
 * Reject reveals a required reason. A business refusal — including a
 * separation-of-duties refusal — is surfaced in place.
 */
export function AgentDecisionActions({
  sourceId,
  rowId,
  expectedVersion,
  detailsHref,
}: {
  sourceId: string;
  rowId: string;
  expectedVersion: string;
  detailsHref: string;
}) {
  const [state, formAction, pending] = useActionState(decideApprovalRow, INITIAL);
  const [rejecting, setRejecting] = useState(false);
  const [approveOpen, setApproveOpen] = useState(false);

  // Access-scope picker context — server-computed, loaded lazily on first open
  // so the row list is not burdened with a per-row picker build.
  const [scopeCtx, setScopeCtx] = useState<ApprovalInstallScopeContext | null>(null);
  const [scopeLoading, setScopeLoading] = useState(false);
  const [scopeLoadFailed, setScopeLoadFailed] = useState(false);
  const [scopeValue, setScopeValue] = useState<string>("");

  const hidden = (
    <>
      <Input type="hidden" name="sourceId" value={sourceId} />
      <Input type="hidden" name="rowId" value={rowId} />
      <Input type="hidden" name="expectedVersion" value={expectedVersion} />
    </>
  );

  const loadScopeContext = async () => {
    if (scopeCtx || scopeLoading) return;
    setScopeLoading(true);
    setScopeLoadFailed(false);
    try {
      const ctx = await loadApprovalInstallScopeContext();
      if (ctx) {
        setScopeCtx(ctx);
        setScopeValue(ctx.defaultValue ?? "");
      } else {
        setScopeLoadFailed(true);
      }
    } catch {
      setScopeLoadFailed(true);
    } finally {
      setScopeLoading(false);
    }
  };

  const handleApproveOpenChange = (next: boolean) => {
    setApproveOpen(next);
    if (next) void loadScopeContext();
  };

  // null → no installable scope (parity with the install dialog's empty-state:
  // the admin lacks authority to grant access anywhere → cannot approve).
  const noInstallableScope = scopeCtx !== null && scopeCtx.defaultValue === null;
  const approveTarget = scopeCtx
    ? pickerValueToTarget(scopeValue, scopeCtx.activeOrgId)
    : null;
  const canConfirm =
    scopeCtx !== null &&
    !noInstallableScope &&
    canSubmitApprovalScope(scopeValue, scopeCtx.activeOrgId);

  // AccessCombobox props derived from the server-computed installTargets (same
  // shape the install dialog builds). Workspace is gated off via installMode.
  const availableScopes = scopeCtx
    ? {
        teams: scopeCtx.installTargets
          .filter((t) => t.level === "team")
          .map((t) => ({ id: t.id, name: scopeCtx.ownerEntityNames[t.value] ?? t.label })),
        projects: scopeCtx.installTargets
          .filter((t) => t.level === "project")
          .map((t) => ({ id: t.id, name: scopeCtx.ownerEntityNames[t.value] ?? t.label })),
        orgName:
          scopeCtx.ownerEntityNames[`org:${scopeCtx.activeOrgId}`] ?? "Organization",
        workspaceExposed: false,
      }
    : null;
  const disabledScopes = scopeCtx
    ? scopeCtx.installTargets.filter((t) => t.disabled).map((t) => t.value)
    : [];
  const disabledReasons: Record<string, string> = scopeCtx
    ? Object.fromEntries(
        scopeCtx.installTargets
          .filter((t) => t.disabled)
          .map((t) => [t.value, t.reason ?? "Not available"]),
      )
    : {};

  return (
    <div className="flex flex-col items-end gap-1.5">
      {rejecting ? (
        <form action={formAction} className="flex w-56 flex-col gap-2">
          {hidden}
          <Input type="hidden" name="action" value="reject" />
          <Textarea
            name="reason"
            required
            rows={2}
            placeholder="Reason for rejection"
            className="text-xs"
            aria-label="Reason for rejection"
          />
          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" variant="destructive" disabled={pending}>
              {pending ? "Rejecting…" : "Confirm rejection"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => setRejecting(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            disabled={pending}
            onClick={() => handleApproveOpenChange(true)}
          >
            {pending ? "Working…" : "Approve"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => setRejecting(true)}
          >
            Reject
          </Button>
          <Link
            href={detailsHref}
            className="text-xs text-muted-foreground underline hover:text-foreground"
          >
            Details
          </Link>
        </div>
      )}

      {!state.ok && state.error && !approveOpen ? (
        <p className="max-w-56 text-right text-xs text-destructive">{state.error}</p>
      ) : null}

      {/* Derive open from state so a successful decision closes the dialog
          without a setState-in-effect (the revalidated row then updates). */}
      <Dialog open={approveOpen && !state.ok} onOpenChange={handleApproveOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approve &amp; publish agent</DialogTitle>
          </DialogHeader>

          {scopeLoading ? (
            <p className="text-sm text-muted-foreground">Loading access options…</p>
          ) : scopeLoadFailed || !scopeCtx ? (
            <Alert variant="destructive">
              <AlertDescription>
                Could not load the access options. Close and try again.
              </AlertDescription>
            </Alert>
          ) : noInstallableScope ? (
            <Alert variant="destructive">
              <AlertDescription>
                You need org admin, team admin, or project ownership to grant access
                to this agent.
              </AlertDescription>
            </Alert>
          ) : (
            <div className="flex flex-col gap-3">
              <Label htmlFor={`approve-scope-picker-${rowId}`}>
                Who can access this agent?
              </Label>
              <AccessCombobox
                id={`approve-scope-picker-${rowId}`}
                value={scopeValue}
                onValueChange={setScopeValue}
                availableScopes={availableScopes!}
                isAdmin={false}
                disabledScopes={disabledScopes}
                disabledReasons={disabledReasons}
                // Hide owner / admin / workspace rows; only org / team:* /
                // project:* are valid access targets.
                installMode
              />
              <p className="text-sm text-muted-foreground">
                Approval publishes the agent and grants access to the scope you choose.
                Targets you cannot grant are disabled.
              </p>
              {!state.ok && state.error ? (
                <Alert variant="destructive">
                  <AlertDescription>{state.error}</AlertDescription>
                </Alert>
              ) : null}
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              type="button"
              onClick={() => handleApproveOpenChange(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            {scopeCtx && !noInstallableScope ? (
              <form action={formAction}>
                {hidden}
                <Input type="hidden" name="action" value="approve" />
                {approveTarget ? (
                  <>
                    <Input
                      type="hidden"
                      name="accessTargetLevel"
                      value={approveTarget.level}
                    />
                    <Input
                      type="hidden"
                      name="accessTargetId"
                      value={approveTarget.id}
                    />
                  </>
                ) : null}
                <Button
                  type="submit"
                  disabled={!canConfirm || pending}
                  aria-busy={pending || undefined}
                >
                  {pending ? "Approving…" : "Approve & publish"}
                </Button>
              </form>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

"use client";
/**
 * The org review-policy BOUNDS editor (cinatra#2047 defect D-3).
 *
 * The lattice's outermost layer finally has a product affordance: this is where an
 * organization expresses a `required` floor or a `forbidden` ceiling over a
 * checkpoint, keyed by the lattice's FULL tuple — checkpoint · artifact type ·
 * destination class · origin kind — with `*` admitted as the artifact-type
 * wildcard. The store's specificity rule (an EXACT artifact type beats `*` over
 * the same checkpoint/destination/origin) is stated on the surface, because a
 * bound you cannot predict is a bound you cannot safely set.
 *
 * ONE client island for the whole tab: the add/replace form and every row's
 * retract button share a single action state, so a save and a retract can never
 * report over each other. Both actions re-validate authorization server-side —
 * `canWrite` here only decides what is RENDERED, never what is permitted.
 */
import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import type { LifecyclePolicyRuleRow } from "@cinatra-ai/agents/lifecycle-policy-store";
import {
  DESTINATION_CLASSES,
  LIFECYCLE_CHECKPOINTS,
  LIFECYCLE_ORIGIN_KINDS,
} from "@/lib/lifecycle/lifecycle-policy";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import type {
  ReviewPolicyActionState,
} from "@/app/configuration/artifacts/review-policy-actions";

const FIELD =
  "h-9 w-full rounded-md border border-line bg-surface px-2 text-xs text-foreground";

function SubmitButton({ children }: { children: React.ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" disabled={pending}>
      {children}
    </Button>
  );
}

function RetractButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" variant="ghost" disabled={pending}>
      Retract
    </Button>
  );
}

export function ReviewPolicyEditor({
  rules,
  canWrite,
  upsertAction,
  deleteAction,
}: {
  rules: LifecyclePolicyRuleRow[];
  canWrite: boolean;
  upsertAction: (
    prev: ReviewPolicyActionState,
    formData: FormData,
  ) => Promise<ReviewPolicyActionState>;
  deleteAction: (
    prev: ReviewPolicyActionState,
    formData: FormData,
  ) => Promise<ReviewPolicyActionState>;
}) {
  const [upsertState, runUpsert] = useActionState<ReviewPolicyActionState, FormData>(
    upsertAction,
    { status: "idle" },
  );
  const [deleteState, runDelete] = useActionState<ReviewPolicyActionState, FormData>(
    deleteAction,
    { status: "idle" },
  );
  // Both actions feed ONE message line, and the MOST RECENT result must win.
  // Comparing by status alone would let a single retract shadow every later save
  // for the rest of the page's life, so each result carries the moment it was
  // produced and the newer stamp wins.
  const state = (deleteState.at ?? 0) > (upsertState.at ?? 0) ? deleteState : upsertState;

  return (
    <div className="flex flex-col gap-4" data-testid="review-policy-editor">
      <div className="overflow-hidden rounded-lg border border-line bg-surface-strong">
        <div className="overflow-x-auto">
          <table className="w-full border-separate border-spacing-0 text-xs">
            <thead>
              <tr>
                {[
                  "Checkpoint",
                  "Artifact type",
                  "Destination",
                  "Origin",
                  "Bound",
                  "Self-approval",
                  "",
                ].map((h, i) => (
                  <th
                    key={h || `col-${i}`}
                    className="border-b border-line bg-surface px-3.5 py-2.5 text-left font-mono text-badge-2xs font-bold uppercase tracking-kicker text-muted-foreground"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rules.length === 0 ? (
                <tr>
                  <td
                    className="px-3.5 py-6 text-center text-muted-foreground"
                    colSpan={7}
                    data-testid="review-policy-empty"
                  >
                    This organization expresses no bounds — every checkpoint runs on
                    the core defaults.
                  </td>
                </tr>
              ) : (
                rules.map((r, i) => {
                  const last = i === rules.length - 1;
                  const cell = `px-3.5 py-3${last ? "" : " border-b border-line"}`;
                  return (
                    <tr key={r.id} data-testid="review-policy-row">
                      <td className={`${cell} font-semibold text-foreground`}>{r.checkpoint}</td>
                      <td className={`${cell} font-mono text-foreground`}>{r.artifactType}</td>
                      <td className={`${cell} text-muted-foreground`}>{r.destinationClass}</td>
                      <td className={`${cell} text-muted-foreground`}>{r.originKind}</td>
                      <td className={`${cell} font-semibold text-foreground`}>{r.bound}</td>
                      <td className={`${cell} text-muted-foreground`}>
                        {r.bound === "required" ? (r.selfApprovalOptIn ? "allowed" : "blocked") : "—"}
                      </td>
                      <td className={cell}>
                        {canWrite ? (
                          <form action={runDelete}>
                            <Input type="hidden" name="checkpoint" value={r.checkpoint} readOnly />
                            <Input
                              type="hidden"
                              name="artifactType"
                              value={r.artifactType}
                              readOnly
                            />
                            <Input
                              type="hidden"
                              name="destinationClass"
                              value={r.destinationClass}
                              readOnly
                            />
                            <Input type="hidden" name="originKind" value={r.originKind} readOnly />
                            <RetractButton />
                          </form>
                        ) : null}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {canWrite ? (
        <form
          action={runUpsert}
          className="flex flex-col gap-3 rounded-lg border border-line bg-surface-strong p-4"
          data-testid="review-policy-form"
        >
          <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-5">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rp-checkpoint" className="text-xs">
                Checkpoint
              </Label>
              <NativeSelect id="rp-checkpoint" name="checkpoint" className={FIELD} defaultValue="review">
                {LIFECYCLE_CHECKPOINTS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rp-type" className="text-xs">
                Artifact type
              </Label>
              <Input
                id="rp-type"
                name="artifactType"
                defaultValue="*"
                className="h-9 text-xs"
                placeholder="* or a type id"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rp-destination" className="text-xs">
                Destination class
              </Label>
              <NativeSelect
                id="rp-destination"
                name="destinationClass"
                className={FIELD}
                defaultValue="none"
              >
                {DESTINATION_CLASSES.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rp-origin" className="text-xs">
                Origin kind
              </Label>
              <NativeSelect
                id="rp-origin"
                name="originKind"
                className={FIELD}
                defaultValue="agent_produced"
              >
                {LIFECYCLE_ORIGIN_KINDS.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rp-bound" className="text-xs">
                Bound
              </Label>
              <NativeSelect id="rp-bound" name="bound" className={FIELD} defaultValue="required">
                <option value="required">required</option>
                <option value="forbidden">forbidden</option>
              </NativeSelect>
            </div>
          </div>

          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Checkbox name="selfApprovalOptIn" value="on" className="mt-0.5" />
            Allow the producing actor to approve their own required gate
            (separation of duties is the default).
          </label>

          <div className="flex items-center gap-3">
            <SubmitButton>Save bound</SubmitButton>
            <span className="text-xs text-muted-foreground">
              An exact artifact type beats <span className="font-mono">*</span> for the
              same checkpoint, destination and origin. Removing a bound returns that
              key to the core defaults.
            </span>
          </div>
        </form>
      ) : (
        <p className="text-xs text-muted-foreground">
          You can view this organization&apos;s bounds but not change them.
        </p>
      )}

      {state.status !== "idle" ? (
        <p
          className={
            state.status === "error"
              ? "text-xs font-semibold text-destructive"
              : "text-xs text-muted-foreground"
          }
          data-testid="review-policy-message"
          data-status={state.status}
          role="status"
        >
          {state.message}
        </p>
      ) : null}
    </div>
  );
}

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, FieldGroup, FieldLabel, FieldDescription } from "@/components/ui/field";
import {
  approveAgentCreationRequest,
  rejectAgentCreationRequest,
  retryPublishAgentCreationRequest,
} from "./actions";

export function ApprovalDecisionForm({
  requestId,
  snapshotHash,
  stuckApproved = false,
}: {
  requestId: string;
  snapshotHash: string;
  stuckApproved?: boolean;
}) {
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
  return (
    <div className="soft-panel rounded-card px-6 py-4 flex flex-col gap-4">
      <h3 className="text-sm font-semibold">Decision</h3>
      <FieldDescription>
        The selected decision is CAS-guarded by the snapshot hash. If the author edits the proposal
        after you opened this page, an approve/reject submission will fail with
        <code className="mx-1">stale_proposal</code>; reload to see the new snapshot.
      </FieldDescription>

      <form action={approveAgentCreationRequest} className="flex items-center gap-3">
        <Input type="hidden" name="id" value={requestId} />
        <Input type="hidden" name="snapshotHash" value={snapshotHash} />
        <Button type="submit">Approve &amp; publish (private)</Button>
        <span className="text-xs text-muted-foreground">
          Approving materializes the snapshot, compiles, and publishes private-scoped.
        </span>
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

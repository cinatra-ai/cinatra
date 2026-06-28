import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { StatusPill } from "@/components/ui/status-pill";
import type { InstanceIdentity } from "@/lib/instance-identity-store";
import {
  cancelVendorApplicationAction,
  refreshVendorApplicationStatusAction,
} from "./vendor-application-actions";

/**
 * Displays the operator's open vendor application (state, scope, tier,
 * application id) with Refresh + Cancel actions. Rendered when
 * `identity.vendorState === "applied"` (a commercial-tier submission
 * pending moderator review, or a free-tier submission mid-recovery).
 *
 * Closes the UI gap where the
 * "applied" state had no visible status display or cancel/refresh control
 * — `BecomeAVendorCard` only renders for "none" / "rejected", and the
 * publish controls only render for "approved". Without this card the
 * operator had no way to see or interact with an open application.
 */
export function VendorApplicationStatusCard({
  identity,
}: {
  identity: InstanceIdentity;
}) {
  const applicationId = identity.vendorApplicationId ?? null;
  const scope = identity.vendorScope ?? null;

  return (
    <Card className="border-line bg-surface backdrop-blur-none">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-2">
            <CardTitle>Vendor application</CardTitle>
            <CardDescription className="max-w-2xl leading-6">
              Your vendor application is open. Free-tier applications usually
              auto-approve inline; commercial-tier applications wait for a
              marketplace moderator. Use Refresh to re-fetch the current
              decision state from cm.
            </CardDescription>
          </div>
          <StatusPill status="running">Applied</StatusPill>
        </div>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          <Field orientation="horizontal">
            <FieldLabel>Scope</FieldLabel>
            <FieldDescription className="font-mono text-xs">
              {scope ?? "—"}
            </FieldDescription>
          </Field>
          <Field orientation="horizontal">
            <FieldLabel>Application id</FieldLabel>
            <FieldDescription className="font-mono text-xs break-all">
              {applicationId ?? "—"}
            </FieldDescription>
          </Field>
          <Field orientation="horizontal">
            <FieldLabel>State</FieldLabel>
            <FieldDescription>Applied (pending review or recovery)</FieldDescription>
          </Field>
        </FieldGroup>
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        <form action={refreshVendorApplicationStatusAction}>
          <Button type="submit" variant="outline" size="sm">
            Refresh status
          </Button>
        </form>
        <form action={cancelVendorApplicationAction}>
          {applicationId ? (
            <Input type="hidden" name="application_id" value={applicationId} />
          ) : null}
          <Button type="submit" variant="outline" size="sm">
            Cancel application
          </Button>
        </form>
      </CardFooter>
    </Card>
  );
}

// SPDX-License-Identifier: LicenseRef-Cinatra-Proprietary

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
import { StatusPill } from "@/components/ui/status-pill";
import { resolveMarketplaceBaseUrl } from "@cinatra-ai/marketplace-mcp-client/http-client";
import type { InstanceIdentity } from "@/lib/instance-identity-store";
import {
  refreshConsumerAttachmentAction,
  rotateConsumerTokenAction,
} from "./vendor-application-actions";

/**
 * Always-on, read-only consumer attachment summary for the registries tab on
 * `/configuration/environment?tab=registries`.
 *
 * This card surfaces the cinatra instance's *consumer*-side relationship with
 * the Cinatra Marketplace: which marketplace user the boot-time
 * `instance_attach_self` hook bound this instance to, when the attachment
 * happened, and how big the catalog is from this instance's vantage point.
 *
 * No actions are exposed in this iteration — the card is pure display.
 * Vendor lifecycle (apply/cancel/refresh) lives in the sibling
 * "Become a vendor" card; vendor publish controls live in the existing
 * `MarketplacePublishCard` (gated on `vendorState === "approved"`).
 */
export function MarketplaceConnectionCard({
  identity,
  catalogCount,
}: {
  identity: InstanceIdentity;
  catalogCount: number;
}) {
  const attachment = identity.consumerAttachment ?? null;
  const attached = attachment !== null;
  const marketplaceBaseUrl = resolveMarketplaceBaseUrl();

  return (
    <Card className="border-line bg-surface backdrop-blur-none">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-2">
            <CardTitle>Marketplace connection</CardTitle>
            <CardDescription className="max-w-2xl leading-6">
              Read-only consumer attachment to the Cinatra Marketplace. Catalog
              browse + extension install.
            </CardDescription>
          </div>
          <StatusPill status={attached ? "approved" : "idle"}>
            {attached ? "Connected" : "Not attached"}
          </StatusPill>
        </div>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          <Field orientation="horizontal">
            <FieldLabel>Consumer username</FieldLabel>
            <FieldDescription className="font-mono text-xs">
              {attachment?.marketplaceUsername ?? "—"}
            </FieldDescription>
          </Field>
          <Field orientation="horizontal">
            <FieldLabel>Attached at</FieldLabel>
            <FieldDescription>{formatTimestamp(attachment?.attachedAt)}</FieldDescription>
          </Field>
          <Field orientation="horizontal">
            <FieldLabel>Last refreshed</FieldLabel>
            <FieldDescription>
              {formatTimestamp(attachment?.lastRefreshedAt)}
            </FieldDescription>
          </Field>
          <Field orientation="horizontal">
            <FieldLabel>Marketplace base URL</FieldLabel>
            <FieldDescription className="font-mono text-xs break-all">
              {marketplaceBaseUrl}
            </FieldDescription>
          </Field>
          <Field orientation="horizontal">
            <FieldLabel>Catalog packages</FieldLabel>
            <FieldDescription>{catalogCount}</FieldDescription>
          </Field>
        </FieldGroup>
      </CardContent>
      {attached ? (
        <CardFooter className="flex flex-wrap gap-2">
          <form action={refreshConsumerAttachmentAction}>
            <Button type="submit" variant="outline" size="sm">
              Refresh
            </Button>
          </form>
          <form action={rotateConsumerTokenAction}>
            <Button type="submit" variant="outline" size="sm">
              Rotate consumer token
            </Button>
          </form>
        </CardFooter>
      ) : null}
    </Card>
  );
}

function formatTimestamp(value: string | undefined | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleString();
}

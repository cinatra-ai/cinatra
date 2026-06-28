import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { readRegistryPolicy } from "@cinatra-ai/extensions/registry-policy";

import { MarketplaceTermsCheckbox } from "./marketplace-terms-checkbox";
import {
  readMarketplaceVendorStatus,
  requestMarketplacePublishAction,
  rotateMarketplaceRegistryTokenAction,
  setMarketplaceProfileVisibilityAction,
  type MarketplaceVendorStatusView,
} from "./marketplace-publish-actions";

/**
 * Marketplace registration + self-service controls on
 * `/configuration/environment?tab=registries`.
 *
 * Post-P6a-2b the card uses the live self-service abilities only — the
 * namespace IS the instance namespace (no input), the status pane reflects
 * the calling instance's own `vendor_get_self` record, and the operator gets
 * controls for profile visibility + registry-token rotation.
 *
 * Marketplace-unavailable case (no MARKETPLACE_INSTANCE_TOKEN set): the card
 * stays visible but the controls are disabled and the empty status explains
 * what an operator needs to provision.
 */
export async function MarketplacePublishCard() {
  const status = await readMarketplaceVendorStatus();
  // Registry temp-policy declaration (config-driven; default off → no banner).
  const registryPolicy = readRegistryPolicy();

  return (
    <Card className="border-line bg-surface backdrop-blur-none">
      <CardHeader>
        <CardTitle>Cinatra Marketplace</CardTitle>
        <CardDescription>
          Register this Cinatra instance as a vendor on the Cinatra Marketplace so it can publish
          extensions to the shared registry. Free vendors are auto-approved; every extension version
          is reviewed by Cinatra staff before it becomes installable.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {registryPolicy.temporary && (
          <Alert variant="warning">
            <AlertTitle>Temporary registry policy</AlertTitle>
            <AlertDescription>{registryPolicy.notice}</AlertDescription>
          </Alert>
        )}
        {status === null ? (
          <UnavailablePane />
        ) : (
          <>
            <StatusPane status={status} />
            {status.namespace ? (
              <SelfServiceControls status={status} />
            ) : (
              <RegisterForm />
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function UnavailablePane() {
  return (
    <div className="rounded-panel border border-line bg-surface-strong px-4 py-3 text-sm text-muted-foreground">
      The marketplace is not yet wired on this instance. An operator must set
      <code className="font-mono mx-1">MARKETPLACE_INSTANCE_TOKEN</code>
      (the bearer issued for this instance&rsquo;s marketplace account) before registration is
      available.
    </div>
  );
}

function StatusPane({ status }: { status: MarketplaceVendorStatusView }) {
  return (
    <div className="rounded-panel border border-line bg-surface-strong px-4 py-3">
      <p className="text-sm font-semibold text-foreground mb-2">
        Vendor status
        {status.namespace ? (
          <> &mdash; <span className="font-mono text-xs">{status.namespace}</span></>
        ) : null}
      </p>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-3">
        <dt className="text-muted-foreground">State</dt>
        <dd className="col-span-2">{status.state}</dd>
        <dt className="text-muted-foreground">Tier</dt>
        <dd className="col-span-2">{status.tier ?? "—"}</dd>
        <dt className="text-muted-foreground">Profile visibility</dt>
        <dd className="col-span-2">{status.profileVisibility}</dd>
        <dt className="text-muted-foreground">Published extensions</dt>
        <dd className="col-span-2">{status.publishedCount}</dd>
        <dt className="text-muted-foreground">Registry token</dt>
        <dd className="col-span-2">{status.hasRegistryToken ? "present" : "missing"}</dd>
        <dt className="text-muted-foreground">Registry URL</dt>
        <dd className="col-span-2 font-mono text-xs">{status.registryUrl}</dd>
      </dl>
    </div>
  );
}

function RegisterForm() {
  return (
    <form action={requestMarketplacePublishAction} className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        This instance is not yet registered as a marketplace vendor. The vendor namespace will be
        the instance namespace; no further input is required.
      </p>
      <MarketplaceTermsCheckbox />
      <div className="flex justify-end">
        <Button type="submit" variant="default">
          Register as a vendor
        </Button>
      </div>
    </form>
  );
}

function SelfServiceControls({ status }: { status: MarketplaceVendorStatusView }) {
  const isLocked = status.profileVisibility === "locked_public";
  const nextVisibility = status.profileVisibility === "public" ? "private" : "public";

  return (
    <div className="flex flex-col gap-3">
      <form action={setMarketplaceProfileVisibilityAction} className="flex items-center gap-2">
        <Input type="hidden" name="visibility" value={nextVisibility} />
        <Button type="submit" variant="outline" size="sm" disabled={isLocked}>
          {isLocked
            ? "Profile locked public (has published extensions)"
            : `Set profile ${nextVisibility}`}
        </Button>
      </form>
      <form action={rotateMarketplaceRegistryTokenAction}>
        <Button type="submit" variant="outline" size="sm">
          Rotate registry token
        </Button>
      </form>
    </div>
  );
}

import type { Metadata } from "next";
import Link from "next/link";

import { listAgentPackages, listExtensionPackages } from "@cinatra-ai/registries";

import { SettingsTabNav } from "@/components/settings-tab-nav";
import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel } from "@/components/ui/field";
import { requireAdminSession } from "@/lib/auth-session";
import { readInstanceIdentity } from "@/lib/instance-identity-store";
import { getEffectiveViewerScope } from "@/lib/marketplace-credentials";
import { getAppRuntimeMode } from "@/lib/runtime-mode";
import {
  buildTabs,
  resolveEnvTab,
  CONNECTIONS_TAB_VALUE,
} from "./environment-tabs";
import { loadVerdaccioConfigForReads } from "@/lib/verdaccio-config";
import { NangoSettingsSection } from "@/lib/nango-settings-section";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  InstanceNamespaceInput,
  NamespaceValidationProvider,
} from "@/app/setup/name/instance-namespace-input";

import { editVendorAction } from "../instance/actions";
import { ReconciliationMount } from "../instance/reconciliation-mount";
import { MarketplacePublishCard } from "./marketplace-publish-card";
import { MarketplaceConnectionCard } from "./marketplace-connection-card";
import { BecomeAVendorCard } from "./become-a-vendor-card";
import { VendorApplicationStatusCard } from "./vendor-application-status-card";
import { InstanceSaveButton } from "./instance-save-button";
import { getMarketplaceTermsAcceptance } from "@/lib/marketplace-terms";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Environment" };

type SearchParams = Record<string, string | string[] | undefined>;

export default async function EnvironmentSettingsPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const session = await requireAdminSession();

  const tabs = buildTabs();
  const params = await (searchParams ?? Promise.resolve({} as SearchParams));
  const rawTab = (Array.isArray(params.tab) ? params.tab[0] : params.tab) ?? "mode";
  // Dev/prod gating + legacy `?tab=credentials` continuity alias live in
  // ./environment-tabs (pure + unit-tested).
  const { tab, requestedConnections } = resolveEnvTab(rawTab, tabs);
  const activeContent =
    tab === "mode" ? (
      <ModeTabContent
        connectionsRedirectFromTab={requestedConnections ? rawTab : null}
      />
    ) : tab === "instance" ? (
      await InstanceTabContent()
    ) : tab === "registries" ? (
      <RegistriesTabContent params={params} defaultContactEmail={session.user.email ?? null} />
    ) : (
      // tab === CONNECTIONS_TAB_VALUE — only reachable in dev mode (guarded by
      // buildTabs() + the tabs.some() check above).
      <NangoSettingsSection
        searchParams={Promise.resolve(params)}
        redirectTo={`/configuration/environment?tab=${CONNECTIONS_TAB_VALUE}`}
      />
    );

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="Environment"
        description="Runtime mode, instance identity, and registry connections for this workspace."
        divider={false}
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        <SettingsTabNav tabs={tabs} activeTab={tab} basePath="/configuration/environment" />
        {activeContent}
      </PageContent>
    </Main>
  );
}

function ModeTabContent({
  connectionsRedirectFromTab = null,
}: {
  /** Set to "connections" or "credentials" when a prod user arrived with
   *  that tab in the URL and the page redirected them here because the
   *  Connections tab is dev-only. `null` for normal Mode visits. */
  connectionsRedirectFromTab?: string | null;
} = {}) {
  const appRuntimeMode = getAppRuntimeMode();
  const isEnvLocalBacked = process.env.NODE_ENV !== "production";
  const modeLabel = appRuntimeMode === "production" ? "Production" : "Development";
  const modeDescription =
    appRuntimeMode === "production"
      ? "Production setup commands and production-style runtime behavior are active."
      : "Local development behavior is active, including development setup helpers.";

  return (
    <div className="flex max-w-3xl flex-col gap-5">
      {connectionsRedirectFromTab ? (
        // Explicit-redirect notice for prod users who arrive via a stale
        // `?tab=connections|credentials` URL (a bookmark / external link, or
        // a "configure connection service" CTA from an extension pinned to a
        // pre-cinatra#66 sdk-ui — current CTAs point at /setup/connections).
        // The Connections tab is dev-only by design — in prod the connection
        // service is configured on /setup/connections (or via env vars), and
        // credentials live on the per-connector setup pages.
        <Alert variant="default" className="rounded-panel">
          <AlertTitle>Connections tab is dev-only</AlertTitle>
          <AlertDescription>
            You followed a link to <code className="font-mono text-xs">?tab={connectionsRedirectFromTab}</code>,
            but this Cinatra instance is running in production mode where the
            Connections tab is not available. To configure the connection
            service, use{" "}
            <Link href="/setup/connections" className="underline underline-offset-4">
              Setup &gt; Connections
            </Link>{" "}
            (or set the corresponding environment variables). Per-connector
            credentials live on each connector&apos;s setup page.
          </AlertDescription>
        </Alert>
      ) : null}
      <Alert variant={appRuntimeMode === "production" ? "default" : "success"} className="rounded-panel">
        <AlertTitle className="flex items-center gap-2">
          Runtime mode
          <Badge variant={appRuntimeMode === "production" ? "secondary" : "default"}>{modeLabel}</Badge>
        </AlertTitle>
        <AlertDescription>{modeDescription}</AlertDescription>
      </Alert>

      <Card className="border-line bg-surface backdrop-blur-none rounded-card">
        <CardHeader>
          <CardTitle>Configuration source</CardTitle>
          <CardDescription className="leading-6">
            Set <code className="font-mono text-xs">CINATRA_RUNTIME_MODE</code> in{" "}
            <code className="font-mono text-xs">{isEnvLocalBacked ? ".env.local" : "the deployment environment"}</code>.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 text-sm leading-6 text-muted-foreground">
          <p>
            Accepted values are <code className="font-mono text-xs">development</code> and{" "}
            <code className="font-mono text-xs">production</code>. Use{" "}
            <code className="font-mono text-xs">development</code> for local and non-production work, and{" "}
            <code className="font-mono text-xs">production</code> for production-style operation.
          </p>
          <p>
            Local development reads <code className="font-mono">.env.local</code>; production hosts usually inject the same
            variable through their environment settings.
          </p>
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-foreground">Dev tools</h3>
            <p>
            In development mode, the top bar also includes a tools icon with small helpers for local troubleshooting and
            cleanup.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

async function InstanceTabContent() {
  const identity = readInstanceIdentity();

  if (!identity) {
    return (
      <Card className="border-line bg-surface backdrop-blur-none">
        <CardHeader>
          <CardTitle>Not configured</CardTitle>
          <CardDescription>
            This instance has not been provisioned with a vendor name yet. Run the setup wizard to register an identity
            on the Cinatra extension registry.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild>
            <Link href="/setup/name">Set up instance name</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  const isFrozen = identity.firstPublishedAt !== null;
  const frozenAt = identity.firstPublishedAt ? new Date(identity.firstPublishedAt) : null;
  const frozenDateLabel =
    frozenAt && !Number.isNaN(frozenAt.getTime()) ? frozenAt.toLocaleDateString() : "unknown date";

  let publishedPackages: Array<{ packageName: string; packageVersion: string }> = [];
  if (isFrozen) {
    const config = await loadVerdaccioConfigForReads().catch(() => null);
    if (config) {
      // Pass the canonical viewer scope so an approved vendor's same-scope
      // private packages are still listed under "Published under @<scope>".
      const viewerScope = getEffectiveViewerScope(identity);
      publishedPackages = (await listAgentPackages({ limit: 100, viewerScope }, config).catch(() => [])) as Array<{
        packageName: string;
        packageVersion: string;
      }>;
    }
  }

  const scopePrefix = "@" + identity.instanceNamespace + "/";
  const scopedPackages = publishedPackages.filter((p) => p.packageName.startsWith(scopePrefix));

  return (
    <NamespaceValidationProvider initialValue={identity.instanceNamespace}>
      <ReconciliationMount />
      <div className="grid gap-6 md:grid-cols-2">
        <Card className="border-line bg-surface backdrop-blur-none">
          <CardHeader>
            <div>
              <CardTitle>Name your Cinatra instance</CardTitle>
              <CardDescription className="mt-2 max-w-2xl leading-6">
                Define how this Cinatra instance is identified across the Cinatra network. Its display name is shown in
                user-facing places, while its namespace is used in technical references.
              </CardDescription>
            </div>
            <CardAction>
              {isFrozen ? (
                <Badge variant="secondary">Frozen — first published {frozenDateLabel}</Badge>
              ) : (
                <Badge>Editable</Badge>
              )}
            </CardAction>
          </CardHeader>
          <CardContent>
            <form action={editVendorAction} className="grid gap-4">
              <Field>
                <FieldLabel>Instance display name</FieldLabel>
                <Input
                  name="instanceDisplayName"
                  required
                  minLength={1}
                  maxLength={120}
                  autoComplete="off"
                  defaultValue={identity.instanceDisplayName ?? ""}
                  placeholder="e.g. ACME Group"
                />
                <span className="text-xs font-normal text-muted-foreground">
                  Human-readable name shown wherever this Cinatra instance is referenced.
                </span>
              </Field>
              <Field>
                <FieldLabel>Instance namespace</FieldLabel>
                {isFrozen ? (
                  <Input value={identity.instanceNamespace} disabled aria-disabled className="bg-surface-muted" />
                ) : (
                  <InstanceNamespaceInput defaultValue={identity.instanceNamespace} />
                )}
                <span className="text-xs font-normal text-muted-foreground">
                  Machine-readable name used to uniquely identify this instance across the Cinatra network.
                </span>
              </Field>
              <div className="flex justify-end">
                {isFrozen ? (
                  <Button type="submit">Save</Button>
                ) : (
                  <InstanceSaveButton />
                )}
              </div>
            </form>
          </CardContent>
        </Card>
      </div>

      {isFrozen && scopedPackages.length > 0 ? (
        <Card className="border-line bg-surface backdrop-blur-none">
          <CardHeader>
            <CardTitle>Published under @{identity.instanceNamespace}</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="text-sm text-muted-foreground [&>li+li]:mt-2">
              {scopedPackages.map((pkg) => (
                <li key={pkg.packageName}>
                  {pkg.packageName} @ {pkg.packageVersion}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </NamespaceValidationProvider>
  );
}

async function RegistriesTabContent({
  params: _params,
  defaultContactEmail: _defaultContactEmail,
}: {
  params: SearchParams;
  defaultContactEmail: string | null;
}) {
  const identity = readInstanceIdentity();

  if (!identity || !identity.instanceNamespace) {
    return (
      <Card className="border-line bg-surface backdrop-blur-none">
        <CardHeader>
          <CardTitle>Setup required</CardTitle>
          <CardDescription className="max-w-2xl leading-6">
            Complete instance setup before configuring registry connections. The instance namespace is set during initial
            setup and is required for both local and remote registries.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild>
            <Link href="/configuration/environment?tab=instance">Open instance administration</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  // Catalog count surfaced in the connection card — best-effort fetch so a
  // Verdaccio outage degrades to "0" rather than hard-failing the tab.
  const verdaccioConfig = await loadVerdaccioConfigForReads().catch(() => null);
  const catalogPackages = verdaccioConfig
    ? await listExtensionPackages({ limit: 500 }, verdaccioConfig).catch(() => [])
    : [];
  const catalogCount = catalogPackages.length;

  // Canonical ToS for the apply-form. TODO(marketplace-terms-fetch): swap to a
  // server-validated `marketplace_terms_get` MCP wrapper once it lands so the
  // version/digest reflect the marketplace canonical copy, not the operator-
  // supplied env fallback used here.
  const termsAcceptance = getMarketplaceTermsAcceptance();

  const vendorState = identity.vendorState;
  const showBecomeAVendor =
    vendorState === undefined || vendorState === "none" || vendorState === "rejected";

  return (
    <div className="flex flex-col gap-6">
      <MarketplaceConnectionCard identity={identity} catalogCount={catalogCount} />
      {showBecomeAVendor ? (
        <BecomeAVendorCard
          identity={identity}
          termsVersion={termsAcceptance.termsVersion}
          termsDigest={termsAcceptance.termsDigest}
          termsUrl={termsAcceptance.termsUrl}
          priorRejectionReason={null}
        />
      ) : null}
      {vendorState === "applied" ? <VendorApplicationStatusCard identity={identity} /> : null}
      {vendorState === "approved" ? <MarketplacePublishCard /> : null}
    </div>
  );
}


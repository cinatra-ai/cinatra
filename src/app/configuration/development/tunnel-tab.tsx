import "server-only";

import Link from "next/link";
import { getMcpPublicBaseUrl } from "@cinatra-ai/mcp-server/credentials";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getConnectorSetupHref } from "@/lib/connectors-registry.server";
// Dev-tunnel status resolves through the `dev-tunnel-status` capability the
// tailscale connector registers at activation (lazy/guarded host-access
// cutover) — absence degrades to the "connect Tailscale" state below.
import { getDevTunnelStatus } from "@/lib/dev-tunnel-status";
import { PublicBaseUrlForm } from "./public-base-url-form";

// Tunnel tab on /configuration/development.
//
// Extracted from page.tsx (same split as ./extensions-tab) so the tab's
// remediation links and its restart notice are directly renderable in a unit
// test.

// Catalog slug of the connector that provisions the Funnel URL. The tab links
// to the connector's own dispatch route, which is
// `/connectors/<vendor>/<slug>/setup` — RESOLVED through the registry rather
// than hardcoded. The previously hardcoded `/connectors/tailscale` was not a
// route at all and 404'd, leaving the tab's only remediation path unreachable.
const TAILSCALE_CONNECTOR_SLUG = "tailscale-connector";

export function TunnelTabContent({ isDevMode }: { isDevMode: boolean }) {
  const { publicBaseUrl } = getMcpPublicBaseUrl();

  // The dedicated Tailscale Funnel URL is deterministic — derived from
  // this dev instance's schema-based hostname + the resolved tailnet.
  // It's shown in the flyout as a pickable option REGARDLESS of whether
  // a sidecar has been provisioned yet (the provisioning path registers
  // the node under exactly this hostname, so picking + saving it now is
  // safe). `null` only when Tailscale isn't connected (no tailnet) — or
  // when the connector is absent (degraded mode of the capability read).
  const { connected: tailscaleConnected, funnelUrlPreview: tailscaleUrl } = getDevTunnelStatus();

  // `null` only when the slug has left the connector CATALOG (renamed or
  // retired) — the helper resolves from the catalog descriptor, so an
  // installed-or-not connector still yields its route. That one case degrades
  // to plain prose rather than rendering a second link that cannot resolve.
  const tailscaleSetupHref = getConnectorSetupHref(TAILSCALE_CONNECTOR_SLUG);

  return (
    <div className="flex flex-col gap-6">
      <Card className="max-w-3xl border-line bg-surface backdrop-blur-none">
        <CardHeader>
          <CardTitle>Tunnel</CardTitle>
          <CardDescription className="leading-6">
            Externally reachable HTTPS URL that maps onto this
            workspace&apos;s local app server. External MCP and A2A clients
            (hosted ChatGPT connectors, remote Claude Code instances, A2A
            peers) connect through this URL. Leave empty to disable
            external reachability.
            {tailscaleConnected ? (
              <>
                {" "}Tailscale is connected — click the field below to pick
                its Funnel URL
                {tailscaleSetupHref ? (
                  <>
                    , or{" "}
                    <Link
                      href={tailscaleSetupHref}
                      className="underline underline-offset-4 hover:text-foreground"
                    >
                      manage the connector
                    </Link>
                  </>
                ) : null}
                .
              </>
            ) : tailscaleSetupHref ? (
              <>
                {" "}For an auto-managed Funnel URL,{" "}
                <Link
                  href={tailscaleSetupHref}
                  className="underline underline-offset-4 hover:text-foreground"
                >
                  connect Tailscale
                </Link>
                .
              </>
            ) : (
              <>
                {" "}For an auto-managed Funnel URL, install the Tailscale
                connector.
              </>
            )}
            {!isDevMode && (
              <>
                {" "}In production, set the deployed app&apos;s URL via the{" "}
                <code>BETTER_AUTH_URL</code> env var; this is a per-instance
                override.
              </>
            )}
          </CardDescription>
          {/* Honest restart notice (#2173). Saving persists immediately and
              every per-request reader picks the new URL up on the next
              request — but the OAuth audience allowlist is derived ONCE at
              startup. Both directions are stated: a request naming the new URL
              is rejected until restart, AND clearing the field does not
              withdraw the previous audience. Stated here so neither is misread
              (a rejection as a broken tunnel; a clear as a revocation). The
              same contract is documented on ./actions.ts. */}
          <div className="rounded-control border border-line bg-surface-muted p-4 text-sm leading-6 text-muted-foreground">
            Restart the app after changing this URL. The value is saved
            immediately, but the OAuth audience allowlist external MCP clients
            bind their tokens to (the RFC 8707 <code>resource</code>) is
            derived once at startup. Until the app restarts, a token request
            naming the new URL is rejected and no token is issued — and the
            previous URL stays accepted, so clearing this field is not a
            revocation on its own.
          </div>
        </CardHeader>
        <PublicBaseUrlForm
          initialUrl={publicBaseUrl ?? ""}
          tailscaleConnected={tailscaleConnected}
          tailscaleUrl={tailscaleUrl}
        />
      </Card>
    </div>
  );
}

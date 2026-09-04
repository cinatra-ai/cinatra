import { Suspense, type ReactNode } from "react";
import { ConnectorSetupPage } from "@cinatra-ai/sdk-ui/connector-setup-page";
import type { SchemaConfigSurface } from "@/lib/extension-schema-config";
import { SchemaConfigConnectorForm } from "@/components/extensions/schema-config-connector-form";
import {
  ConnectorStatusProbeCard,
  type ConnectorReadinessReading,
} from "@/components/extensions/connector-status-probe-card";
import { InstallActivateCta } from "@/components/extensions/install-activate-cta";
import { SearchParamToast, type SearchParamToastConfig } from "@/components/search-param-toast";

// ---------------------------------------------------------------------------
// The schema-config connector setup shape — ONE shape for EVERY schema-config
// connector (design §II "Connector setup page", cinatra#3214).
//
// §II draws the generated setup page as "a single generic form, never
// per-connector layout … splits into two columns: a wider left column holding
// the configuration fields, and a narrower right column holding the Connection
// status card", the card carrying "the status badge with both icon and label
// plus the Check action beneath it", and the connection actions sitting "side
// by side, never stacked".
//
// The dispatch route used to draw that only for a connector that DECLARES a
// `status-probe` field, and gave every other schema-config connector a bare
// single-column body: no status card, no badge, no Check. The drawing names no
// such exemption, and the owner settled it (cinatra#3214, item 1) the way the
// drawing reads — every schema-config connector's setup page draws this shape.
//
// What differs between connectors is the DATA, never the layout:
//   - the card's reading is the host's own `resolveConnectorBadgeState` signal,
//     the same one that paints the connector's /connectors card. It is the
//     product's truthful answer for every connector — a probe-less connector's
//     included (e.g. the appointment-schedules connector, whose registered
//     readiness road counts its saved schedules), and the registry's fail-soft
//     "not connected" for a connector with no registered road at all;
//   - Check runs the connector's own declared probe when it declares one, and
//     otherwise re-runs that same host readiness road (`recheck`);
//   - the Connect / Disconnect pair is rendered by the form from the
//     connector's OWN `role`-tagged named actions. The host does not invent a
//     connect road for a connector that declares none — an action the host
//     cannot run would be exactly the lie the status card avoids.
//
// Presentational + server-safe (no async work, no server-only imports), so the
// shared shape is asserted directly on THIS component (acceptance item 10)
// instead of on one connector's page.
// ---------------------------------------------------------------------------

/**
 * Host-owned codes-only flash island for the schema-config setup surface. Host
 * actions that redirect back to a connector's setup page carry a stable code —
 * e.g. the external-MCP management actions (campaigns/actions.ts) redirect to
 * the MCP-servers connector page with ?saved=1 / ?deleted=1, and the Twenty
 * connect/disconnect actions with ?error=<code>. The schema-config surface reads
 * no searchParams itself, so nothing rendered these outcomes before; this island
 * maps each code to a STATIC message and toasts it.
 */
export const CONNECTOR_SETUP_FLASH_TOASTS: SearchParamToastConfig[] = [
  { param: "saved", value: "1", message: "Saved.", variant: "success" },
  { param: "deleted", value: "1", message: "Removed.", variant: "success" },
  { param: "error", value: "admin-only", message: "Only an administrator can change this connection.", variant: "error" },
  { param: "error", value: "connect-failed", message: "Could not connect. Check the details and try again.", variant: "error" },
];

export type SchemaConfigConnectorSetupProps = {
  /** Connector display name — the page-title h1. */
  displayName: string;
  /**
   * Render the header's etched rule. A tabbed surface's own tab row carries the
   * rule instead, so the two never stack.
   */
  divider?: boolean;
  /**
   * The addressable install id for action POSTs, or `null` when the connector
   * is not installed/active for this actor (the Install / Activate CTA state).
   */
  installId: string | null;
  packageName: string;
  surface: SchemaConfigSurface;
  isAdmin: boolean;
  initialValues: React.ComponentProps<typeof SchemaConfigConnectorForm>["initialValues"];
  /** The connector's OWN declared status-probe action id, when it declares one. */
  statusProbeActionId?: string;
  /** Host readiness seed — `resolveConnectorBadgeState().connected`. */
  connected: boolean;
  /** Host readiness seed — the richer connected label (e.g. a count). */
  connectedLabel?: string;
  /** The host readiness road Check re-runs for a connector with no declared probe. */
  recheck?: () => Promise<ConnectorReadinessReading>;
  /** Host content belonging to the SETUP surface only (the sharing section). */
  footer?: ReactNode;
};

export function SchemaConfigConnectorSetup({
  displayName,
  divider = true,
  installId,
  packageName,
  surface,
  isAdmin,
  initialValues,
  statusProbeActionId,
  connected,
  connectedLabel,
  recheck,
  footer,
}: SchemaConfigConnectorSetupProps) {
  return (
    <ConnectorSetupPage
      title={displayName}
      description="Connector setup"
      divider={divider}
      className="flex flex-col gap-6 pb-8"
    >
      <Suspense fallback={null}>
        <SearchParamToast toasts={CONNECTOR_SETUP_FLASH_TOASTS} />
      </Suspense>
      {installId ? (
        <SchemaConfigConnectorForm
          installId={installId}
          packageName={packageName}
          surface={surface}
          isAdmin={isAdmin}
          initialValues={initialValues}
          // Only meaningful when the surface actually declares a probe row: the
          // card lifts it out of the fields column so the same probe never
          // renders twice.
          {...(statusProbeActionId ? { omitFieldKinds: ["status-probe" as const] } : {})}
          initialConnected={connected}
          aside={
            <ConnectorStatusProbeCard
              installId={installId}
              actionId={statusProbeActionId}
              initialConnected={connected}
              connectedLabel={connectedLabel}
              recheck={recheck}
            />
          }
          setupFooter={footer}
        />
      ) : (
        <>
          <InstallActivateCta displayName={displayName} canInstall={isAdmin} />
          {footer}
        </>
      )}
    </ConnectorSetupPage>
  );
}

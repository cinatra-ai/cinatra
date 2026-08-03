"use client";

// ---------------------------------------------------------------------------
// Conformance fixtures for the MULTI-connection §II surfaces (cinatra#2354):
// `connector-multi-setup` (the Setup tab of a connector that holds many
// connections) and `connector-connections` (its Connections tab).
//
// WHAT IS REAL: every rendered element is the shipped implementation of the
// surface — the sdk-ui `ConnectorSetupColumns` (which OWNS the
// `connector-multi-setup` conformance id + state), `ConnectionsStatusCard`,
// `ConnectionsList` / `ConnectionRow` / `ConnectionStatusBadge` (which owns the
// `connector-connections` id + state), the sdk-ui `Tabs` primitive the
// multi-connection setup page tabs with, the REAL `SchemaConfigConnectorForm`
// in the fields column, and the REAL `AlertDialog` a destructive connection
// action confirms through.
//
// WHAT IS SUBSTITUTED (and why): `ConnectionsList` is presentational BY DESIGN —
// its own header states that "the status→action mapping + the connection-level
// confirm dialog live in the consumer". No core screen is that consumer yet
// (the multi-connection connector self-chromes its setup page), and the real
// one would need an authenticated session + saved connection rows, which the
// standalone conformance harness has by construction not got. So the harness
// plays the consumer, exactly as the approvals / scheduling / notifications
// fixtures do: it wires the rows' status→action mapping and the confirm
// ceremony out of the REAL primitives and drives them to the manifest's
// specified outcomes. The connector's ACTION ENDPOINT round-trip is the only
// other substitution and it is made test-side (the suite fulfils
// /api/extensions/*/actions/* at the network boundary), so the components
// under test stay byte-identical to production.
// ---------------------------------------------------------------------------

import { useState } from "react";
import { PlugZap, Unplug } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { SchemaConfigConnectorForm } from "@/components/extensions/schema-config-connector-form";
import { parseSchemaConfig } from "@/lib/extension-schema-config";
import { ConnectionsStatusCard } from "@cinatra-ai/sdk-ui/connection-status-card";
import { ConnectionsList, ConnectionRow } from "@cinatra-ai/sdk-ui/connections-list";
import { Tabs, TabsContent, TabsListRow, TabsTrigger } from "@cinatra-ai/sdk-ui/tabs";

import {
  CONNECTOR_CONNECTION_ROWS,
  CONNECTOR_MULTI_SETUP_CONFIG,
  CONNECTOR_SETUP_INSTALL_ID,
} from "./connector-setup-seed";

const MULTI_PACKAGE = "@cinatra-fixtures/multi-connection-connector";

/**
 * The multi-connection Setup tab's own fields (spec §II "Multiple connections"):
 * a server base URL, an optional bearer token, and Connect ONLY — a single
 * connection is disconnected from its own row in the Connections tab, so this
 * surface declares no Disconnect.
 */
const MULTI_SETUP_SURFACE = {
  title: "Fixture A2A Server",
  description: "A multi-connection fixture connector for the conformance harness.",
  fields: [
    {
      kind: "text",
      key: CONNECTOR_MULTI_SETUP_CONFIG.baseUrl.key,
      label: CONNECTOR_MULTI_SETUP_CONFIG.baseUrl.label,
      description: "The root URL of the fixture server — no path.",
    },
    {
      kind: "secret",
      key: CONNECTOR_MULTI_SETUP_CONFIG.bearerToken.key,
      label: CONNECTOR_MULTI_SETUP_CONFIG.bearerToken.label,
      description: "Leave blank for unauthenticated servers.",
    },
    { kind: "named-action", label: "Connect", actionId: "createServer", role: "connect" },
  ],
} as const;

function MultiSetupForm({
  state,
  onViewConnections,
}: {
  state: "ready" | "loading" | "error";
  onViewConnections: () => void;
}) {
  const parsed = parseSchemaConfig(MULTI_SETUP_SURFACE);
  if (!parsed.ok) {
    throw new Error(`connector-multi-setup fixture surface invalid: ${parsed.errors.join("; ")}`);
  }
  const connectedCount = CONNECTOR_CONNECTION_ROWS.filter((r) => r.connected).length;
  const disconnectedCount = CONNECTOR_CONNECTION_ROWS.length - connectedCount;
  return (
    // The FORM owns the §II two-column body (exactly as it does for the
    // single-connection page) — it is handed the multi conformance id and
    // renders ConnectorSetupColumns itself, so the host's id/state forwarding
    // is the code under test rather than something the fixture reimplements.
    <SchemaConfigConnectorForm
      installId={CONNECTOR_SETUP_INSTALL_ID}
      packageName={MULTI_PACKAGE}
      surface={parsed.surface}
      conformanceId="connector-multi-setup"
      conformanceState={state}
      initialValues={{
        [CONNECTOR_MULTI_SETUP_CONFIG.baseUrl.key]: CONNECTOR_MULTI_SETUP_CONFIG.baseUrl.value,
      }}
      aside={
        // The multi-connection roll-up: a count badge per status in play and
        // the "All connections" control that opens the Connections tab. No
        // Check on this card (spec §II).
        <ConnectionsStatusCard
          counts={{ connected: connectedCount, disconnected: disconnectedCount }}
          action={
            // "a link-style button" (ConnectionsStatusCard's own contract) that
            // opens the Connections tab.
            <Button
              type="button"
              variant="ghost"
              data-testid="connector-view-connections"
              className="h-auto p-0 underline underline-offset-2"
              onClick={onViewConnections}
            >
              All connections
            </Button>
          }
        />
      }
    />
  );
}

/** One connection row's status→action mapping (the consumer's job, see header). */
function FixtureConnectionRow({
  name,
  url,
  initialConnected,
}: {
  name: string;
  url: string;
  initialConnected: boolean;
}) {
  const [connected, setConnected] = useState(initialConnected);
  const [confirming, setConfirming] = useState(false);
  return (
    <ConnectionRow
      name={name}
      url={url}
      status={connected ? "connected" : "disconnected"}
      action={
        connected ? (
          // disconnect -> confirming: the destructive row action opens the REAL
          // AlertDialog confirmation (never a bare Remove, never an
          // unconfirmed destructive write).
          <AlertDialog open={confirming} onOpenChange={setConfirming}>
            <AlertDialogTrigger asChild>
              <Button type="button" variant="destructive" data-testid="connection-row-disconnect">
                <Unplug />
                Disconnect
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Disconnect connection?</AlertDialogTitle>
                <AlertDialogDescription>
                  Disconnect {name} and remove its saved configuration? It will stop working
                  until you connect it again.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  data-testid="connection-row-disconnect-confirm"
                  onClick={() => setConnected(false)}
                >
                  <Unplug />
                  Disconnect
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : (
          // connect -> connected: the primary row action reconnects THAT row —
          // the REAL ConnectionRow re-derives its badge from the new status.
          <Button
            type="button"
            data-testid="connection-row-connect"
            onClick={() => setConnected(true)}
          >
            <PlugZap />
            Connect
          </Button>
        )
      }
    />
  );
}

function ConnectionRows() {
  return (
    <>
      {CONNECTOR_CONNECTION_ROWS.map((row) => (
        <FixtureConnectionRow
          key={row.name}
          name={row.name}
          url={row.url}
          initialConnected={row.connected}
        />
      ))}
    </>
  );
}

/**
 * The tabbed multi-connection setup page: Setup (connector-multi-setup) +
 * Connections (connector-connections), tabbed with the sdk-ui primitive the
 * real multi-connection setup page uses. Mounted for the `view-connections`
 * action, whose specified outcome is the Connections tab.
 */
export function ConnectorMultiConnectionFixture({
  variant,
}: {
  variant: "populated" | "loading" | "error";
}) {
  const state = variant === "populated" ? "ready" : variant;
  // Controlled: the roll-up card's "All connections" control lives OUTSIDE the
  // tablist, so it opens the tab by selecting it — it cannot be a TabsTrigger
  // (Radix requires those inside the RovingFocusGroup the TabsList provides).
  const [tab, setTab] = useState("setup");
  return (
    <div data-surface-id="connector-multi" data-variant={variant}>
      <Tabs value={tab} onValueChange={setTab} className="gap-6">
        <TabsListRow>
          <TabsTrigger value="setup">Setup</TabsTrigger>
          <TabsTrigger value="connections">Connections</TabsTrigger>
        </TabsListRow>
        <TabsContent value="setup">
          <MultiSetupForm state={state} onViewConnections={() => setTab("connections")} />
        </TabsContent>
        <TabsContent value="connections">
          <ConnectionsList>
            <ConnectionRows />
          </ConnectionsList>
        </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * Standalone `connector-connections` mounts — the populated list plus the two
 * state variants the manifest requires (empty / loading), each rendered by the
 * REAL ConnectionsList through its own state prop.
 */
export function ConnectorConnectionsFixture({
  variant,
}: {
  variant: "populated" | "empty" | "loading";
}) {
  return (
    <div data-surface-id="connector-connections" data-variant={variant}>
      <ConnectionsList state={variant === "populated" ? "ready" : variant}>
        {variant === "populated" ? <ConnectionRows /> : null}
      </ConnectionsList>
    </div>
  );
}

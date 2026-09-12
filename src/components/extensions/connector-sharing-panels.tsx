// ---------------------------------------------------------------------------
// ConnectorSharingPanels — the SHARING TAB's body (cinatra#3374).
//
// The ratified drawing (design/specs/app-connectors.html §II, "Sharing tab"):
// "The tab is a list of panels, one per connection you own here, each one a
// connection row — the same card the Connections tab stacks, but carrying its
// name and mono line and nothing else: no status badge and no per-row action …
// Beneath each row sits the shared permissions card on the --surface ground".
// And, above the list: "The roll-up card is the Connections status card of the
// Setup tab, with no Check and no All connections link: the list it counts is
// directly beneath it."
//
// PRESENTATIONAL and server-safe (no `server-only`, no DB, no session): the
// permissions card of each panel arrives as a NODE. The product route hands it
// the real `ExtensionPermissionsClient` (server actions bound to the
// connection); the design-conformance harness hands it the same `PermissionsForm`
// with fixture-fulfilled actions. Both mount THIS component, so the three
// manifest surfaces it emits — `connector-sharing`, `connector-sharing-rollup`
// and `connector-sharing-locked` — are the product's own DOM either way.
//
// The roll-up carries NO `action`: `ConnectionsStatusCard` renders its action
// slot only when one is passed, so omitting it IS the drawing's "no Check and
// no All connections link" — no new primitive and no variant flag.
// ---------------------------------------------------------------------------

import * as React from "react";
import { ConnectionsStatusCard } from "@cinatra-ai/sdk-ui/connection-status-card";
import { ConnectionsList, ConnectionRow } from "@cinatra-ai/sdk-ui/connections-list";

/** The drawing's own words beneath the tab's heading (§II, Sharing tab). */
export const CONNECTOR_SHARING_INTRO =
  "Choose who can use each of your saved connections. Shared use always acts through your connected account and is audited.";

/** The loading treatment's visible line (the `loading` state the manifest declares). */
export const CONNECTOR_SHARING_LOADING_LABEL = "Loading connections…";

export type ConnectorSharingPanelView = {
  /** React key — the connection identity row id. */
  key: string;
  /** The connection's display name (manifest field `name` = connection.connectionId). */
  name: string;
  /** The mono secondary line (manifest field `url` = connection.connectorKey). */
  url: string;
  /**
   * How this connector constrains the panel's scope choice, when it constrains
   * it at all (§II: "A connector may declare a ceiling on how far its
   * connections travel … Where the connector only recommends a scope, the line
   * reads instead …"). `null` = an unconstrained connector.
   */
  scopeConstraint: "locked" | "recommended" | null;
  /** The access picker + ownership card for THIS connection. */
  permissions: React.ReactNode;
};

export type ConnectorSharingPanelsProps = {
  panels: ConnectorSharingPanelView[];
  /** `loading` renders the declared loading treatment in the list's place. */
  state?: "ready" | "loading";
  /**
   * When the roll-up card heads the list. `always` is the SHARING TAB's rule
   * (§II: "the list it counts is directly beneath it"), the tab this issue
   * draws. `multiple` is the rule the pages that draw NO tab strip already
   * had — the invalid-schema-config and rebuild treatments and the
   * bundled-react setup pages, which this change leaves exactly as they were:
   * a single connection there heads no roll-up, as before.
   */
  rollup?: "always" | "multiple";
};

export function ConnectorSharingPanels({
  panels,
  state = "ready",
  rollup = "always",
}: ConnectorSharingPanelsProps) {
  if (state === "loading") {
    return (
      <div data-conformance-id="connector-sharing" data-state="loading">
        <p
          data-slot="connector-sharing-loading"
          aria-busy="true"
          className="text-sm text-muted-foreground"
        >
          {CONNECTOR_SHARING_LOADING_LABEL}
        </p>
      </div>
    );
  }
  return (
    <>
      {/* The roll-up card, ABOVE the list it counts. No Check, no "All
          connections" link — the list is directly beneath it. On the Sharing
          tab it heads the list whenever there IS a list; a mount that kept the
          plural-only rule (`rollup="multiple"`) is unchanged by this issue. */}
      {rollup === "always" || panels.length > 1 ? (
        <ConnectionsStatusCard
          data-conformance-id="connector-sharing-rollup"
          counts={{ connected: panels.length }}
        />
      ) : null}
      <ConnectionsList>
        {panels.map((panel) => (
          <div
            key={panel.key}
            data-conformance-id="connector-sharing"
            data-state="ready"
            className="flex flex-col gap-2"
          >
            {/* The connection's identity row: its name and the mono secondary
                line. NO status badge and NO per-row action — a saved identity
                is not a claim that the connection still answers, and connecting
                and disconnecting stay on Setup and on the Connections tab. */}
            <ConnectionRow name={panel.name} url={panel.url} />
            {panel.scopeConstraint ? (
              // The connector constrains this panel's scope: the picker draws
              // every out-of-ceiling option locked with its reason, and the same
              // sentence sits under the picker with a lock (or, for a
              // recommending connector, the recommendation line).
              <div
                data-conformance-id="connector-sharing-locked"
                data-variant={panel.scopeConstraint}
              >
                {panel.permissions}
              </div>
            ) : (
              panel.permissions
            )}
          </div>
        ))}
      </ConnectionsList>
    </>
  );
}

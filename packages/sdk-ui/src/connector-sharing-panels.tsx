// ---------------------------------------------------------------------------
// ConnectorSharingPanels — the SHARING TAB's body (cinatra#3374), offered by
// the SDK as ONE component (cinatra#3385).
//
// The ratified drawing (design/specs/app-connectors.html §II, "Sharing tab"):
// "The tab is a list of panels, one per connection you own here, each one a
// connection row — the same card the Connections tab stacks, but carrying its
// name and mono line and nothing else: no status badge and no per-row action …
// Beneath each row sits the shared permissions card on the --surface ground".
// And, above the list: "the roll-up card heads the list, and only when there is
// more than one connection to roll up" — where it does head the list, "The
// roll-up card is the Connections status card of the Setup tab, with no Check
// and no All connections link: the list it counts is directly beneath it."
//
// WHICH PAGES HEAD THEIR LIST WITH IT (cinatra#3454). The maintainer decided on
// 2026-09-26: the multi-connection roll-up follows the page's shape, not the
// count, and a page whose tab strip has no Connections tab draws no roll-up on
// its Sharing tab. The drawing gives that reading: the roll-up "is the
// Connections status card of the Setup tab", and only a connector that holds
// many connections has one. Such a connector "adds Connections after
// Sharing", and the drawing's own example of a Sharing tab with more than one
// connection is that connector's page. A page with no Connections tab has no
// Setup card to repeat, so it lists its panels alone, however many it lists.
// The caller therefore states its page's SHAPE in `pageShape`, and the card
// draws only where the shape is the many-connections one AND there is more
// than one connection to roll up. The default is `"single"`, because no
// production page carries the many-connections shape today: the generated
// connector page never draws a Connections tab, so a caller that says nothing
// gets the shape its page actually has.
//
// WHY IT LIVES HERE and not in the app (cinatra#3385). The app GENERATES the
// setup page of the connectors whose pack declares the `schema-config` UI
// surface, and #3374 put the Sharing tab on that page. A connector that ships
// its own React setup page draws its header and its tab strip itself, so the
// app has no seam to inject a tab into — the host injects nothing. The tab is
// therefore a shared primitive like `Tabs` / `ConnectorSetupColumns` /
// `ConnectionsList`: shared, not copied, from its own dedicated subpath. The
// app's generated page and a pack's own page draw THIS component — one
// implementation, never two copies — so the functional-acceptance drivers of
// `connector-sharing`, `connector-sharing-rollup` and
// `connector-sharing-locked` grade the same DOM wherever the tab is drawn.
//
// PRESENTATIONAL and server-safe (no `server-only`, no DB, no session): each
// panel's access picker and ownership card are drawn HERE, by this package's
// own `PermissionsPanel`, from DATA and CALLBACKS the caller supplies
// (cinatra#3385). The caller decides and reads; this component decides
// nothing. The product route hands it the connection's stored policy and four
// server actions bound to that connection; the design-conformance harness
// hands it the same data with fixture-fulfilled actions; a pack hands it what
// its own page already read. Every one of them draws the SAME controls, so
// the three manifest surfaces are the product's own DOM either way.
//
// Why the card is not a NODE the caller passes in: a pack cannot build one.
// The recommendation line, the lock glyph and the grant controls would have to
// be copied into the pack, or imported from the app, and a pack can do
// neither. Handing the card in as a node is how the tab stayed app-only.
//
// The roll-up carries NO `action`: `ConnectionsStatusCard` renders its action
// slot only when one is passed, so omitting it IS the drawing's "no Check and
// no All connections link" — no new primitive and no variant flag.
// ---------------------------------------------------------------------------

import { ConnectionsStatusCard } from "./connection-status-card";
import { ConnectionsList, ConnectionRow } from "./connections-list";
import { PermissionsPanel, type PermissionsPanelProps } from "./permissions-panel";

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
  /**
   * The access picker and ownership card for THIS connection, as data and
   * callbacks: the stored policy, the scopes the actor holds, the locked
   * options and their reasons, the scope line, the owner and co-owner views,
   * the helper lines, `canEdit`, `allowSharing`, and the four bindings that
   * save the policy, search people, and add or remove an owner. Authorization,
   * every read, and the binding of those four to server actions stay with the
   * caller.
   */
  permissions: PermissionsPanelProps;
};

export type ConnectorSharingPanelsProps = {
  /**
   * One view per connection the actor owns on THIS connector's page, in the
   * order the tab lists them. The caller resolves them through its own read
   * road — the app's generated page from the canonical connection store, a
   * pack's own page from the road its setup page already reads. It states
   * each panel's permissions data and bindings as `permissions`.
   */
  panels: ConnectorSharingPanelView[];
  /**
   * What SHAPE the page that mounts this tab has (cinatra#3454). `"many"` = a
   * connector that holds many connections, whose tab strip reads Setup ·
   * Sharing · Connections and whose Setup tab carries the Connections status
   * card the roll-up repeats. `"single"` = a page with no Connections tab,
   * which draws no roll-up on Sharing at all. The default is `"single"`: the
   * app's generated connector page draws no Connections tab, so a caller that
   * says nothing gets the shape its page has.
   */
  pageShape?: "single" | "many";
  /** `loading` renders the declared loading treatment in the list's place. */
  state?: "ready" | "loading";
};

export function ConnectorSharingPanels({
  panels,
  pageShape = "single",
  state = "ready",
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
      {/* The roll-up card, ABOVE the list it counts, on a many-connections
          page, and ONLY when there is more than one connection to roll up: a
          single connection heads no roll-up, so the list starts with that
          connection's own panel. A single-shape page heads its list with
          nothing at all, because it has no Connections status card on Setup
          for this one to repeat (cinatra#3454). No Check and no "All
          connections" link: the list is directly beneath it. */}
      {pageShape === "many" && panels.length > 1 ? (
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
                <PermissionsPanel {...panel.permissions} />
              </div>
            ) : (
              <PermissionsPanel {...panel.permissions} />
            )}
          </div>
        ))}
      </ConnectionsList>
    </>
  );
}

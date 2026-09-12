/**
 * Real PRODUCT consumers of the §II connector surfaces (cinatra#2357, epic
 * #2353; design/specs/app-connectors.html pinned at design@3d33cc800).
 *
 * Two closures from the #2382 review live here, and both are about the same
 * failure mode: a shipped surface treatment whose only caller was a test.
 *
 *   1. The connector setup dispatch route's DEGRADED branches (invalid
 *      configSchema, runtime-only fallthrough, unloadable bundled-react
 *      module) each hand-rolled their own Alert. Meanwhile the spec declares
 *      `data-state="loading error"` on `connector-setup`, and the error
 *      treatment #2354 built for it had NO production caller at all — it was
 *      latent, selectable only from the conformance harness. The three
 *      branches now render THAT treatment, so the surface stays mounted with
 *      its conformance id and the state the spec declares is the state
 *      production actually draws.
 *
 *   2. `ConnectionsList` / `ConnectionRow` / `ConnectionsStatusCard` shipped
 *      with no core consumer — #2382 §4 disclosed that the conformance harness
 *      was playing the consumer itself. `ConnectionSharingSection` is the host
 *      surface that has always listed the actor's own saved connections for a
 *      connector, drawing its own bare mono identity line; it now composes the
 *      shipped primitives, so `connector-connections` is emitted by a
 *      production route.
 *
 * These are source-file assertions, matching the other component contracts in
 * this repo: the route is a server component whose module graph (auth, the
 * canonical store, the extension host context) cannot be mounted in a unit
 * test, and the claim being locked is a COMPOSITION claim.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const ROOT = join(__dirname, "..", "..");

const DISPATCH_ROUTE = readFileSync(
  join(ROOT, "app", "connectors", "[vendor]", "[slug]", "[subroute]", "page.tsx"),
  "utf8",
);

const SHARING_SECTION = readFileSync(
  join(ROOT, "components", "extensions", "connection-sharing-section.tsx"),
  "utf8",
);

/**
 * The Sharing TAB's body (cinatra#3374), offered by the SDK as ONE component
 * (cinatra#3385). The composition claim moved with the surface: the section
 * still resolves each panel's data, and this presentational component draws
 * the roll-up, the identity rows and the three conformance ids — so it is the
 * file that composes the sdk-ui primitives. It lives IN sdk-ui because a
 * connector that draws its own setup page has no seam for the app to inject a
 * tab into, so both pages draw this one component; the app page consumes it
 * from its dedicated subpath and keeps no copy of its own.
 */
const SHARING_PANELS = readFileSync(
  join(ROOT, "..", "packages", "sdk-ui", "src", "connector-sharing-panels.tsx"),
  "utf8",
);

describe("connector dispatch route — the §II error treatment has a PRODUCTION caller", () => {
  it("routes every degraded branch through ConnectorSetupColumns in the error state", () => {
    expect(DISPATCH_ROUTE).toContain(
      'import { ConnectorSetupColumns } from "@cinatra-ai/sdk-ui/connector-setup-columns"',
    );
    // Three branches: invalid configSchema, the runtime-only fallthrough, and
    // the unloadable bundled-react module. Each mounts the surface with its
    // conformance id and the spec-declared error state.
    const errorMounts = DISPATCH_ROUTE.match(
      /<ConnectorSetupColumns\s+conformanceId="connector-setup"\s+state="error"/g,
    );
    expect(errorMounts).toHaveLength(3);
  });

  it("keeps each branch's own message — the treatment is re-used, not the copy", () => {
    expect(DISPATCH_ROUTE).toMatch(
      /errorLabel=\{`This connector's setup schema is invalid\./,
    );
    const rebuildLabels = DISPATCH_ROUTE.match(
      /errorLabel=\{`This connector requires a rebuild\. \$\{rebuild\.message\}`\}/g,
    );
    expect(rebuildLabels).toHaveLength(2);
  });

  it("no longer hand-rolls an Alert for any of them", () => {
    // The bespoke Alert chrome was the reason the spec-declared error state had
    // no production caller. It is gone from this route entirely — including its
    // import, so a re-introduction cannot be a one-line edit.
    expect(DISPATCH_ROUTE).not.toMatch(/from "@\/components\/ui\/alert"/);
    expect(DISPATCH_ROUTE).not.toMatch(/<AlertTitle\b/);
    expect(DISPATCH_ROUTE).not.toMatch(/<AlertDescription\b/);
  });
});

describe("ConnectionSharingSection — the REAL consumer of the §II connection primitives", () => {
  it("composes the shipped primitives, as their own sibling in sdk-ui", () => {
    expect(SHARING_PANELS).toContain(
      'import { ConnectionsStatusCard } from "./connection-status-card"',
    );
    expect(SHARING_PANELS).toContain(
      'import { ConnectionsList, ConnectionRow } from "./connections-list"',
    );
    // …and the section still mounts them, through the panels component —
    // imported from the SDK's dedicated subpath (cinatra#3385): the app page
    // CONSUMES the one implementation and holds no second copy of it.
    expect(SHARING_SECTION).toContain(
      'from "@cinatra-ai/sdk-ui/connector-sharing-panels"',
    );
    expect(SHARING_SECTION).toContain("<ConnectorSharingPanels");
    expect(SHARING_SECTION).toContain("panels={panelViews}");
  });

  it("wraps its panels in the real ConnectionsList — the surface emitter", () => {
    // ConnectionsList owns `data-conformance-id="connector-connections"`, so
    // mounting it here is what gives that surface a production emitter.
    expect(SHARING_PANELS).toMatch(/<ConnectionsList>[\s\S]*<\/ConnectionsList>/);
    const listStart = SHARING_PANELS.indexOf("<ConnectionsList>");
    const listEnd = SHARING_PANELS.indexOf("</ConnectionsList>");
    expect(listStart).toBeGreaterThan(-1);
    expect(SHARING_PANELS.slice(listStart, listEnd)).toContain("panels.map(");
  });

  it("draws each connection's identity through the real ConnectionRow, not a hand-rolled line", () => {
    expect(SHARING_PANELS).toMatch(
      /<ConnectionRow\s+name=\{panel\.name\}\s+url=\{panel\.url\}\s*\/>/,
    );
    // …and the row's two bindings are the connection's own identity, resolved
    // by the section and handed down verbatim.
    expect(SHARING_SECTION).toContain("name: identity.connectionId");
    expect(SHARING_SECTION).toContain("url: identity.connectorKey");
    // The bare mono <p> the section used to draw instead — and its
    // `panels.length > 1` gate, which hid the identity entirely on a
    // single-connection page — is gone.
    expect(SHARING_SECTION).not.toMatch(
      /<p className="text-xs text-muted-foreground font-mono truncate">/,
    );
  });

  it("heads the tab's list with the roll-up card, unconditionally, and gives it NO action", () => {
    // §II, the Sharing tab: "The roll-up card is the Connections status card of
    // the Setup tab, with no Check and no All connections link: the list it
    // counts is directly beneath it." The Setup tab's plural-only rule is its
    // own; this card heads the list whenever there is a list (cinatra#3374).
    // The tab mount asks for the unconditional card; the mounts that draw no
    // tab strip (bundled-react, the error treatments) keep the plural-only rule
    // they had before this issue — the section chooses by its variant.
    expect(SHARING_PANELS).toContain('rollup === "always" || panels.length > 1');
    expect(SHARING_SECTION).toContain('rollup={variant === "tab" ? "always" : "multiple"}');
    const cardStart = SHARING_PANELS.indexOf("<ConnectionsStatusCard");
    expect(cardStart).toBeGreaterThan(-1);
    const card = SHARING_PANELS.slice(cardStart, SHARING_PANELS.indexOf("/>", cardStart));
    expect(card).toContain("counts={{ connected: panels.length }}");
    // No action slot at all: that is what drops the Check and the link.
    expect(card).not.toContain("action=");
  });

  it("claims NO per-row status — the host holds no per-connection signal", () => {
    // A listed identity is STORED and not soft-deleted. Readiness probes answer
    // for the CONNECTOR, not per connection, so a credential revoked at the
    // provider leaves a row that looks untouched. `status="connected"` would
    // paint a green joined-plug chip and `data-status="connected"`: the colour
    // and the glyph are the claim as much as any label, so relabelling it would
    // not soften it. The prop is optional precisely for this case.
    const rowStart = SHARING_PANELS.indexOf("<ConnectionRow");
    const row = SHARING_PANELS.slice(rowStart, SHARING_PANELS.indexOf("/>", rowStart));
    expect(row).not.toContain("status=");
    // …and the primitive genuinely admits the omission, rather than the
    // consumer relying on a required prop being elided.
    const listSrc = readFileSync(
      join(ROOT, "..", "packages", "sdk-ui", "src", "connections-list.tsx"),
      "utf8",
    );
    expect(listSrc).toMatch(/status\?: ConnectionStatus;/);
    expect(listSrc).toContain("{status ? <ConnectionStatusBadge status={status} /> : null}");
  });

  it("passes NO row action — the other thing still without a host path", () => {
    // A per-connection Disconnect would be a destructive write addressed by
    // connection-row id, and no host-level path for it exists (each connector
    // owns its own `role:"disconnect"` action on its setup form). The rows
    // therefore render actionless, and the header says so. Locking the absence
    // keeps a future `action={…}` from quietly inventing that authz.
    const rowStart = SHARING_PANELS.indexOf("<ConnectionRow");
    const rowEnd = SHARING_PANELS.indexOf("/>", rowStart);
    expect(SHARING_PANELS.slice(rowStart, rowEnd)).not.toContain("action=");
  });
});

// ---------------------------------------------------------------------------
// The MOVE itself (cinatra#3374). Two claims the move must not quietly break,
// neither of which any assertion above covers:
//
//   • the sharing MODEL is unchanged — only its place and its drawing. Shared
//     use still acts through the owner's connected account and is still
//     audited, because the panels still mount the app's OWN permissions client
//     bound to the connection, never a connector-specific copy of it.
//   • the tab is drawn on the GENERATED setup page only. A bundled-react
//     connector draws its own page whole, so this change does not reach it:
//     those branches keep the standalone section they already mounted.
// ---------------------------------------------------------------------------

const UI_RENDER = readFileSync(join(ROOT, "lib", "connector-ui-render.ts"), "utf8");

describe("the Sharing tab move — what it must NOT change", () => {
  it("keeps the audited road: the app's own permissions client, bound to the connection", () => {
    // Each panel view carries the permissions node the SECTION builds…
    expect(SHARING_SECTION).toMatch(/permissions: \(\s*<ExtensionPermissionsClient/);
    // …and it is the shared client, kind-discriminated to the CONNECTION and
    // addressed by that connection's own id — the same binding as before the
    // move, so the grant it writes is still audited through the owner's
    // connected account.
    expect(SHARING_SECTION).toContain('kind="connection"');
    expect(SHARING_SECTION).toContain("resourceId={identity.id}");
    expect(SHARING_SECTION).toContain("owner={owner}");
    expect(SHARING_SECTION).toContain("currentUserId={userId}");
    // The presentational tab body takes that node and mounts NO client of its
    // own: a connector-specific copy of the two controls is exactly what §II
    // forbids ("never a connector-specific copy of them").
    expect(SHARING_PANELS).not.toContain("<ExtensionPermissionsClient");
    expect(SHARING_PANELS).toContain("{panel.permissions}");
  });

  it("hands the Sharing TAB to the generated setup page only", () => {
    // Exactly one mount of the tab-variant node, and it is the schema-config
    // setup shape's `sharing` prop.
    expect(DISPATCH_ROUTE.match(/sharing=\{sharingTab\}/g)).toHaveLength(1);
    expect(DISPATCH_ROUTE).toMatch(
      /<ConnectionSharingSection packageId=\{packageId\} variant="tab" \/>/,
    );
    // …and the SAME generated page's Install/Activate state — which draws no
    // form and so no tab strip — is handed the standalone section it already
    // had, not the tab's node (cinatra#3374).
    expect(DISPATCH_ROUTE).toContain("sharingStandalone={sharingSection}");
  });

  it("leaves every self-drawn branch on the standalone section it already had", () => {
    // The invalid-schema, rebuild, unloadable-module and bundled-react branches
    // draw no tab strip of the app's, so they keep mounting the section
    // directly — unchanged by this issue.
    const standaloneMounts = DISPATCH_ROUTE.match(/\{sharingSection\}/g) ?? [];
    expect(standaloneMounts.length).toBeGreaterThanOrEqual(4);
    expect(DISPATCH_ROUTE).toContain(
      "const sharingSection = <ConnectionSharingSection packageId={packageId} />",
    );
    // …and the render CHOICE itself is untouched: a manifest without the
    // schema-config surface still resolves to bundled-react, with no sharing
    // branch of any kind added to that decision.
    expect(UI_RENDER).toContain('return { kind: "bundled-react" };');
    expect(UI_RENDER.toLowerCase()).not.toContain("sharing");
  });
});

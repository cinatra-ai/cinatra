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
  it("imports the shipped primitives from sdk-ui", () => {
    expect(SHARING_SECTION).toContain(
      'import { ConnectionsStatusCard } from "@cinatra-ai/sdk-ui/connection-status-card"',
    );
    expect(SHARING_SECTION).toContain(
      'import { ConnectionsList, ConnectionRow } from "@cinatra-ai/sdk-ui/connections-list"',
    );
  });

  it("wraps its panels in the real ConnectionsList — the surface emitter", () => {
    // ConnectionsList owns `data-conformance-id="connector-connections"`, so
    // mounting it here is what gives that surface a production emitter.
    expect(SHARING_SECTION).toMatch(/<ConnectionsList>[\s\S]*<\/ConnectionsList>/);
    const listStart = SHARING_SECTION.indexOf("<ConnectionsList>");
    const listEnd = SHARING_SECTION.indexOf("</ConnectionsList>");
    expect(listStart).toBeGreaterThan(-1);
    expect(SHARING_SECTION.slice(listStart, listEnd)).toContain("panels.map(");
  });

  it("draws each connection's identity through the real ConnectionRow, not a hand-rolled line", () => {
    expect(SHARING_SECTION).toMatch(
      /<ConnectionRow\s+name=\{identity\.connectionId\}\s+url=\{identity\.connectorKey\}\s*\/>/,
    );
    // The bare mono <p> the section used to draw instead — and its
    // `panels.length > 1` gate, which hid the identity entirely on a
    // single-connection page — is gone.
    expect(SHARING_SECTION).not.toMatch(
      /<p className="text-xs text-muted-foreground font-mono truncate">/,
    );
  });

  it("heads a multi-connection page with the roll-up card, and only then", () => {
    expect(SHARING_SECTION).toMatch(
      /panels\.length > 1 \? \(\s*<ConnectionsStatusCard counts=\{\{ connected: panels\.length \}\} \/>\s*\) : null/,
    );
  });

  it("claims NO per-row status — the host holds no per-connection signal", () => {
    // A listed identity is STORED and not soft-deleted. Readiness probes answer
    // for the CONNECTOR, not per connection, so a credential revoked at the
    // provider leaves a row that looks untouched. `status="connected"` would
    // paint a green joined-plug chip and `data-status="connected"`: the colour
    // and the glyph are the claim as much as any label, so relabelling it would
    // not soften it. The prop is optional precisely for this case.
    const rowStart = SHARING_SECTION.indexOf("<ConnectionRow");
    const row = SHARING_SECTION.slice(rowStart, SHARING_SECTION.indexOf("/>", rowStart));
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
    const rowStart = SHARING_SECTION.indexOf("<ConnectionRow");
    const rowEnd = SHARING_SECTION.indexOf("/>", rowStart);
    expect(SHARING_SECTION.slice(rowStart, rowEnd)).not.toContain("action=");
  });
});

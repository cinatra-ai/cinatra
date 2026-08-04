/**
 * ConnectorsClient — design-system contract test.
 *
 * Like the other component tests in this repo, this is a source-file assertion
 * suite (@testing-library/react isn't available; the root vitest env is "node").
 * It locks the design-system decisions for the connectors grid.
 *
 * SPEC PIN. Every §I claim below is held against
 * `design/specs/app-connectors.html` v0.7.0 at design@3d33cc800 — the exact
 * spec bytes this repo adopted in cinatra#2355 (epic #2353). The adoption is
 * mechanical, never transcribed: the conformance artifact under
 * `tests/e2e/design/conformance/manifests/app-connectors.json` is the
 * generator's VERBATIM output for that commit (sha256 b0aada80a8…,
 * contentHash sha256:9f28d508…), both hashes pinned in
 * `tests/e2e/design/conformance-pins.json`, and the live render is checked
 * against the spec by the design-conformance functional-acceptance suite. What
 * THIS file adds is the source-level half — the decisions a rendered check
 * cannot see (which module a glyph comes from, which predicate a filter uses,
 * what a class name means) — so a regression names itself at the line that
 * caused it rather than as a failed pixel somewhere downstream.
 *
 * A lock re-specified by an epic keeps its ORIGINAL issue number as its
 * heading and records the supersession underneath; the history of a decision
 * is part of the decision. The locks the v0.7.0 adoption re-specified are
 * #605/#683 (the connected glyph), #1092 (its DEFAULT half only) and the
 * empty-state block; #1014's selected-primary prohibition was deliberately NOT
 * re-specified — see #2357 below.
 *
 *   Locked decisions, in the order they were made:
 *
 *   #604  the Connected/Disconnected toggle uses the design-system toggle-group
 *         spec — single outer hairline border + hairline dividers, no gaps,
 *         7px radius — NOT the generic shadcn `outline` variant (grey accent
 *         fill on a grey ground).
 *   #605  connection state renders as a plug icon (green joined plug when
 *         connected, red Unplug when not) instead of a text StatusPill, keeping
 *         the connectedLabel count alongside the green plug when one is
 *         provided. (The connected glyph was `PlugZap` until #2356 below.)
 *   #606  the Cinatra mark in connector cards renders in brand mustard
 *         (text-brand-mustard) rather than the default ink foreground.
 *   #681  the toolbar carries a "+ Connector" button linking to the
 *         marketplace pre-filtered to connectors (?tab=connector).
 *   #682  the per-card connection-state indicator is a state-coloured BACKGROUND
 *         badge (design-system Badge `success`/`destructive` variants) wrapping
 *         the #605 plug icon (+ count).
 *   #683  the toggle items lead with the card plug glyphs and the second item
 *         reads "Disconnected" (its internal `available` value is unchanged).
 *   #1014 (design system §VII "Connectors") the toolbar reorders to filter →
 *         search → scope → +Connector (hairline dividers on both sides) →
 *         spacer → sort (far right); the search placeholder renames to
 *         "Search connectors" and gains a ✕ clear button; each segmented-toggle
 *         item carries its OWN semantic status colour at all times (soft tint
 *         idle, solid + white text/icon selected) instead of the previous grey
 *         idle / indigo-primary selected treatment.
 *   #2356 (epic #2353; design/specs/app-connectors.html v0.7.0, pinned at
 *         design@3d33cc800) the CONNECTED glyph is re-specified: lucide's
 *         `PlugZap` (a half plug + a lightning bolt) is replaced everywhere the
 *         connected state is drawn by the first-party `PlugConnected` mark —
 *         literally the two halves of the Disconnected `Unplug` glyph with the
 *         gap closed, so the pair reads as one drawing. lucide carries no such
 *         icon, so it is defined ONCE in `@cinatra-ai/sdk-ui/icons` and
 *         imported by every render site (toggle segment, card badge, the setup
 *         page's status badge, the setup form's Connect action). Disconnected
 *         stays `Unplug`; the identity fallback tile
 *         (src/components/connector-brand-icons.tsx) and the extension-kind
 *         emblem are NOT swapped — they are identity/kind glyphs, not status
 *         glyphs (negative locks live in
 *         src/components/__tests__/status-glyph-scope.test.ts).
 *   #2357 (epic #2353; same pinned spec) the filter becomes THREE-state and the
 *         page gains a closing install CTA:
 *           · `FilterType` widens to "all" | "connected" | "available" and the
 *             default becomes "all" — an explicit owner-directed supersession
 *             of #1092's "every visit starts on Connected". #1092's
 *             NON-persistence half is retained verbatim (plain state, no URL,
 *             no storage) and is still locked below.
 *           · The All segment leads the group. It names no connection status,
 *             so it takes neither status colour nor a plug: the page's own
 *             `--ink` navy (`bg-foreground`, solid when selected with a white
 *             icon + label; a soft navy tint idle) and lucide `LayoutGrid` —
 *             the whole grid, every card. It is deliberately NOT the indigo
 *             `--primary`, so the §VII selected-primary prohibition below is
 *             satisfied unchanged rather than re-specified.
 *           · Empty states become a MATRIX with scope-neutral copy (cards are
 *             actor- AND scope-filtered server-side, so zero visible cards is
 *             not evidence that nothing is installed): All+0 → the
 *             "No connectors to show" panel carrying the SINGLE install CTA
 *             (and no button at all without marketplace access); Connected+0 →
 *             the #1092 panel with re-specified scope-neutral copy and its
 *             unchanged "Connect a service" action; Disconnected+0 → no panel.
 *           · A centred `outline`/`sm` "Install more connectors" button closes
 *             the page in every state except All+0 (whose panel already
 *             carries it — one screen never shows the same CTA twice).
 *           · Both install affordances — the toolbar's "+ Connector" and this
 *             CTA — render ONLY for an actor who can reach the marketplace;
 *             the destination is admin-gated, so "+ Connector" was a dead
 *             action for every non-admin and the pair is fixed together.
 *           · The `.faded-bottom` overlay is CONTAINED to the list (the <ul>
 *             becomes the positioned block) and the CTA sits outside it, so
 *             the fade can never wash over the button.
 *   #2355 (epic #2353) adopts that spec version into the checking machinery
 *         and owns the rationale of every lock the epic re-specified. Nothing
 *         in this file asserts the artifact — that is the conformance suite's
 *         job (see SPEC PIN above) — but the two must agree, so where a lock
 *         below duplicates a manifest fact it says which side owns it:
 *           · #1092's block records the supersession of its DEFAULT and stops
 *             asserting the old one; the positive default lives in #2357.
 *           · The Connected+0 panel's COPY moved to the #2357 matrix block;
 *             #1092 keeps only the panel's existence and wiring.
 *           · #1014's selected-primary prohibition was examined and left
 *             UNCHANGED — the navy All segment satisfies it (see that lock).
 *           · The four connector-setup surfaces the artifact carries are §II
 *             and belong to sdk-ui's own suites, not this file.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const SRC = readFileSync(
  join(__dirname, "..", "connectors-client.tsx"),
  "utf8",
);

// The connection-status badge was EXTRACTED into the shared
// `connector-badge.tsx` (consumed by both the card grid here and the
// host-injected setup-page header). The #605/#682 badge-shape assertions now
// read the shared component source; the toggle / +Connector / mustard
// assertions stay on `connectors-client.tsx` (`SRC`).
const BADGE_SRC = readFileSync(
  join(__dirname, "..", "connector-badge.tsx"),
  "utf8",
);

// The app stylesheet, read for the ONE cross-file invariant this suite owns:
// the `.faded-bottom` overlay's height and the list's trailing gutter are a
// single decision split across two files (cinatra#2357 scope 3).
const GLOBALS = readFileSync(
  join(__dirname, "..", "..", "..", "..", "src", "app", "globals.css"),
  "utf8",
);

describe("ConnectorsClient design-system contract", () => {
  it("is a client component", () => {
    expect(SRC.startsWith('"use client"')).toBe(true);
  });

  describe("#604 Connected/Available toggle matches the toggle-group spec", () => {
    it("does not apply the generic shadcn outline toggle variant", () => {
      // The <ToggleGroup …> opening tag must not carry variant="outline" (the
      // grey-accent-on-grey treatment the spec replaces). Scope the check to
      // the ToggleGroup element so the unrelated sort <Button variant="outline">
      // is not mistaken for it.
      const openTag = SRC.match(/<ToggleGroup\b[\s\S]*?>/);
      expect(openTag).not.toBeNull();
      expect(openTag![0]).not.toMatch(/variant\s*=\s*"outline"/);
    });

    it("composes a single outer hairline border with 7px radius and no gaps", () => {
      expect(SRC).toContain("rounded-[7px]");
      expect(SRC).toContain("border border-line");
      // hairline dividers between segments (every item after the first)
      expect(SRC).toContain("[&>*:not(:first-child)]:border-l");
    });

    it("cinatra#1014: no longer renders rest (idle) segments in slate — each keeps its own status colour", () => {
      const groupStart = SRC.indexOf("<ToggleGroup");
      const groupEnd = SRC.indexOf("</ToggleGroup>") + "</ToggleGroup>".length;
      const toggleBlock = SRC.slice(groupStart, groupEnd);
      expect(toggleBlock).not.toContain("text-muted-foreground");
    });
  });

  describe("#605 connection state is a plug icon, not a StatusPill", () => {
    it("no longer imports or renders the StatusPill component", () => {
      // No import of the status-pill module and no <StatusPill …> element.
      expect(SRC).not.toMatch(/from\s+"@\/components\/ui\/status-pill"/);
      expect(SRC).not.toMatch(/<StatusPill\b/);
    });

    it("pairs the first-party joined plug with the lucide Unplug (cinatra#2356)", () => {
      // RE-SPECIFIED by cinatra#2356: the connected mark is no longer lucide's
      // `PlugZap` (a half plug + a lightning bolt, which never paired with
      // `Unplug`) but the first-party `PlugConnected` glyph — literally the two
      // halves of `Unplug` with the gap closed. lucide carries no such icon, so
      // it is defined ONCE in `@cinatra-ai/sdk-ui/icons` (sdk-ui sits BELOW this
      // package in the dependency graph) and imported here — never re-drawn
      // locally, which is what a per-package twin would be.
      expect(SRC).toContain("PlugConnected");
      expect(SRC).toContain("Unplug");
      expect(SRC).toMatch(
        /import \{ PlugConnected \} from "@cinatra-ai\/sdk-ui\/icons"/,
      );
      expect(SRC).not.toContain("PlugZap");
    });

    it("renders the connected plug in a SOLID success-variant badge (cinatra#1014, glyph re-specified by #2356)", () => {
      // The connected branch is a <Badge variant="success"> wrapping
      // <PlugConnected>, with a className override
      // (bg-success/text-success-foreground) making it a filled solid chip
      // rather than the variant's default soft tint (see #682 / #1014). The
      // badge now lives in the shared connector-badge.tsx. Only the GLYPH
      // changed in #2356 — the solid-chip treatment is untouched.
      expect(BADGE_SRC).toMatch(/variant="success"[\s\S]*?<PlugConnected\b/);
      expect(BADGE_SRC).toContain("bg-success text-success-foreground");
    });

    it("renders the disconnected plug in a SOLID destructive-variant badge (cinatra#1014)", () => {
      // The disconnected branch is a <Badge variant="destructive"> wrapping
      // <Unplug>, overridden to a filled bg-destructive + white text chip.
      // #2356 leaves the DISCONNECTED mark exactly as it was — `Unplug` is the
      // glyph the new connected mark was derived from.
      expect(BADGE_SRC).toMatch(/variant="destructive"[\s\S]*?<Unplug\b/);
      expect(BADGE_SRC).toContain("bg-destructive text-destructive-foreground");
    });

    it("keeps the connectedLabel count alongside the connected plug", () => {
      // label is rendered inside the connected branch (after the plug icon)
      expect(BADGE_SRC).toMatch(/<PlugConnected[\s\S]*?\{label \? <span/);
    });
  });

  describe("#606 Cinatra mark renders in brand mustard", () => {
    it("applies the text-brand-mustard token to CinatraLogo in the card", () => {
      expect(SRC).toMatch(/<CinatraLogo[^>]*text-brand-mustard/);
    });
  });

  describe("#682 per-card connection state is a coloured-background badge", () => {
    // The badge component is shared (connector-badge.tsx); the card grid
    // imports it rather than defining the Badge inline.
    it("the card grid consumes the shared ConnectorBadge component", () => {
      expect(SRC).toContain('from "./connector-badge"');
      expect(SRC).toMatch(/<ConnectorBadge\b/);
    });

    it("threads each card's live connection state + count into the badge", () => {
      // Lock the per-card wiring, not just the element: a regression that
      // hardcoded `connected={true}` (or dropped the count) would still import
      // and render <ConnectorBadge> but break the card's real status.
      expect(SRC).toMatch(
        /<ConnectorBadge\s+connected=\{connector\.connected\}\s+label=\{connector\.connectedLabel\}\s*\/>/,
      );
    });

    it("uses the design-system Badge component", () => {
      expect(BADGE_SRC).toContain('from "@/components/ui/badge"');
      expect(BADGE_SRC).toMatch(/<Badge\b/);
    });

    it("renders the connected state as a SOLID green/success-background badge (cinatra#1014)", () => {
      // The className override resolves to a FILLED bg-success + white
      // text-success-foreground — not the variant's default soft bg-success/10
      // tint (the shared badge.tsx primitive itself is untouched — it is
      // vendored into 5 extension repos).
      expect(BADGE_SRC).toMatch(/<Badge[^>]*variant="success"[^>]*bg-success text-success-foreground/);
    });

    it("renders the disconnected state as a SOLID red/destructive-background badge (cinatra#1014)", () => {
      expect(BADGE_SRC).toMatch(/<Badge[^>]*variant="destructive"[^>]*bg-destructive text-destructive-foreground/);
    });
  });

  describe("#683 toggle items carry plug glyphs and the Disconnected label", () => {
    it("renames the second toggle option from Available to Disconnected", () => {
      expect(SRC).not.toContain(">\n              Available\n");
      expect(SRC).toContain("Disconnected");
    });

    it("keeps the internal filter value 'available' for the Disconnected segment", () => {
      // The visible label is "Disconnected" but the toggle's internal `value`
      // (and the `connected` vs `!connected` filter semantics) stay "available".
      expect(SRC).toMatch(/value="available"/);
    });

    it("leads each toggle item with the matching card plug glyph", () => {
      // connected item → PlugConnected before the label; disconnected → Unplug.
      // RE-SPECIFIED by cinatra#2356: the segment draws the same first-party
      // joined plug the card badge draws (it was `PlugZap`), so the toggle and
      // the cards keep speaking ONE glyph language.
      expect(SRC).toMatch(
        /value="connected"[\s\S]*?<PlugConnected[\s\S]*?Connected/,
      );
      expect(SRC).toMatch(/value="available"[\s\S]*?<Unplug[\s\S]*?Disconnected/);
    });
  });

  // -------------------------------------------------------------------------
  // cinatra#1092 — the connection filter is EPHEMERAL, and the Connected view
  // answers for itself when it has nothing to show.
  //
  // RE-SPECIFIED IN PART by epic cinatra#2353 (issue #2357, adopted here by
  // #2355 at design@3d33cc800 specs/app-connectors.html v0.7.0). #1092 made two
  // decisions and this epic touches exactly one of them:
  //
  //   SUPERSEDED — the DEFAULT. "Every visit starts on Connected" is now
  //     "every visit starts on All", an explicit owner-directed supersession
  //     (the spec: "All first and selected on arrival"). This block therefore
  //     asserts the old default is GONE; the positive lock on the new one
  //     lives in the #2357 block, so exactly one place states what the default
  //     is.
  //   RETAINED, verbatim — NON-PERSISTENCE. The filter is plain component
  //     state: never written to the URL, never to storage, so a returning
  //     reader always lands on the default rather than on a stale selection.
  //     A three-state filter does not weaken that reasoning, so nothing here
  //     changes.
  //   EVOLVED — the Connected+0 panel. #1092's panel stands, and its ACTION is
  //     untouched ("Connect a service" → the Disconnected list). What v0.7.0
  //     re-specified is its COPY: the old title asserted the reader had
  //     connected nothing, which stopped being true once zero visible cards
  //     became reachable through scope and visibility filtering as well. The
  //     copy lock lives with the rest of the matrix in the #2357 block; what
  //     this block keeps is the panel's EXISTENCE and its wiring, which are
  //     #1092's decisions and are still in force.
  // -------------------------------------------------------------------------
  describe("cinatra#1092 filter is ephemeral; Connected+0 answers for itself (DEFAULT half superseded by epic #2353)", () => {
    it("no longer defaults filterType to \"connected\" — epic #2353 lands on \"all\"", () => {
      // Negative by design: this block's job is to record that the #1092
      // default is gone. Asserting the NEW default here too would put the same
      // decision in two places, and the next supersession would have to find
      // both.
      expect(SRC).not.toMatch(/useState<FilterType>\("connected"\)/);
    });

    it("no longer persists the connection filter to localStorage", () => {
      // The RETAINED half of #1092, untouched by the epic.
      expect(SRC).not.toContain("window.localStorage");
      expect(SRC).not.toContain('"cinatra:connectors:filter"');
      expect(SRC).not.toContain("FILTER_STORAGE_KEY");
    });

    it("keeps the Connected+0 panel and its \"Connect a service\" action (copy re-specified by epic #2353)", () => {
      // The panel's EXISTENCE and its wiring are #1092's decisions and survive
      // the epic intact: it keys off the SERVER-resolved cards (never the
      // search-narrowed list — see the #2357 matrix block), and its action
      // switches the filter to the Disconnected list rather than silently
      // falling back to it. Only the panel's title and body text were
      // re-specified; those are asserted in the #2357 block, so this lock does
      // not restate copy it no longer owns.
      expect(SRC).toMatch(/showConnectedEmptyState/);
      expect(SRC).toMatch(/const hasConnectedConnectors = cards\.some/);
      expect(SRC).toContain("Connect a service");
      expect(SRC).toMatch(/onClick=\{\(\) => setFilterType\("available"\)\}/);
    });
  });

  describe("#681 toolbar carries a + Connector action", () => {
    it("renders a Button-as-Link to the connector-filtered marketplace", () => {
      expect(SRC).toContain('from "next/link"');
      expect(SRC).toMatch(/<Link href="\/configuration\/marketplace\?tab=connector"/);
    });

    it("labels the action 'Connector' with a leading Plus icon", () => {
      expect(SRC).toMatch(/<Plus[\s\S]*?Connector/);
    });
  });

  describe("cinatra#1014 — toolbar reorder + search rename/clear + segmented-toggle colours (design system §VII)", () => {
    it("orders the toolbar: filter leads → search → scope → +Connector → spacer → sort (far right)", () => {
      const toggleIdx = SRC.indexOf("<ToggleGroup");
      const searchIdx = SRC.indexOf('placeholder="Search connectors"');
      const scopeIdx = SRC.indexOf("<ScopeFilterCombobox");
      const connectorIdx = SRC.indexOf('href="/configuration/marketplace?tab=connector"');
      const spacerIdx = SRC.indexOf('<div aria-hidden className="flex-1" />');
      const sortIdx = SRC.indexOf("<SlidersHorizontal");

      for (const idx of [toggleIdx, searchIdx, scopeIdx, connectorIdx, spacerIdx, sortIdx]) {
        expect(idx).toBeGreaterThan(-1);
      }
      expect(toggleIdx).toBeLessThan(searchIdx);
      expect(searchIdx).toBeLessThan(scopeIdx);
      expect(scopeIdx).toBeLessThan(connectorIdx);
      expect(connectorIdx).toBeLessThan(spacerIdx);
      expect(spacerIdx).toBeLessThan(sortIdx);
    });

    it("flanks the + Connector action with a hairline ToolbarSeparator on both sides", () => {
      const scopeIdx = SRC.indexOf("<ScopeFilterCombobox");
      const sepBeforeIdx = SRC.indexOf("<ToolbarSeparator />", scopeIdx);
      const connectorIdx = SRC.indexOf('href="/configuration/marketplace?tab=connector"');
      const sepAfterIdx = SRC.indexOf("<ToolbarSeparator />", connectorIdx);
      const spacerIdx = SRC.indexOf('<div aria-hidden className="flex-1" />');

      expect(sepBeforeIdx).toBeGreaterThan(scopeIdx);
      expect(sepBeforeIdx).toBeLessThan(connectorIdx);
      expect(sepAfterIdx).toBeGreaterThan(connectorIdx);
      expect(sepAfterIdx).toBeLessThan(spacerIdx);
    });

    it("also flanks the flex-1 spacer with a hairline ToolbarSeparator before the sort control (§VII)", () => {
      // §VII divides EVERY toolbar gap, including both sides of the spacer —
      // not just around +Connector.
      const spacerIdx = SRC.indexOf('<div aria-hidden className="flex-1" />');
      const sortIdx = SRC.indexOf("<SlidersHorizontal");
      const sepAfterSpacerIdx = SRC.indexOf("<ToolbarSeparator />", spacerIdx);

      expect(sepAfterSpacerIdx).toBeGreaterThan(spacerIdx);
      expect(sepAfterSpacerIdx).toBeLessThan(sortIdx);
    });

    it("renames the search placeholder to 'Search connectors'", () => {
      expect(SRC).toContain('placeholder="Search connectors"');
      expect(SRC).not.toContain("Filter connectors...");
    });

    it("shows a ✕ clear button on the toolbar search only while it holds a query", () => {
      expect(SRC).toMatch(/searchTerm \? \(/);
      expect(SRC).toMatch(/onClick=\{\(\) => setSearchTerm\(""\)\}/);
      expect(SRC).toContain('aria-label="Clear search"');
    });

    it("gives each segmented-toggle item its own semantic status colour at idle (soft tint), never grey", () => {
      const groupStart = SRC.indexOf("<ToggleGroup");
      const groupEnd = SRC.indexOf("</ToggleGroup>") + "</ToggleGroup>".length;
      const toggleBlock = SRC.slice(groupStart, groupEnd);
      // `(?!-)` after the token guards against a regression that dropped the
      // idle `text-success`/`text-destructive` class and left only the
      // selected `-foreground` variant — `-` alone satisfies a bare `\b`.
      expect(toggleBlock).toMatch(/value="connected"[\s\S]*?bg-success\/10[\s\S]*?text-success(?!-)\b/);
      expect(toggleBlock).toMatch(/value="available"[\s\S]*?bg-destructive\/10[\s\S]*?text-destructive(?!-)\b/);
    });

    it("uses the SOLID status colour + white text/icon on the selected segment, not primary/indigo", () => {
      // DELIBERATELY NOT RE-SPECIFIED by epic cinatra#2353 (#2355 scope 3
      // scoped this lock "re-specified only if the spec's All-segment styling
      // requires it"). It does not: the prohibition below is file-WIDE, and
      // the v0.7.0 All segment answers it by taking the page's own `--ink`
      // navy (`bg-foreground`) rather than the indigo `--primary` — the spec
      // is explicit that the primary "stays reserved for the action of record
      // on a page and a filter segment is never that". So the third segment
      // SATISFIES this lock as written instead of relaxing it, which is why
      // the assertions are untouched. The narrower per-segment form is
      // asserted again in the #2357 block so a local regression names itself.
      expect(SRC).toContain("data-[state=on]:bg-success");
      expect(SRC).toContain("data-[state=on]:text-success-foreground");
      expect(SRC).toContain("data-[state=on]:bg-destructive");
      expect(SRC).toContain("data-[state=on]:text-destructive-foreground");
      expect(SRC).not.toMatch(/data-\[state=on\]:bg-primary\b/);
      expect(SRC).not.toMatch(/data-\[state=on\]:text-primary\b/);
    });
  });

  // -------------------------------------------------------------------------
  // cinatra#2357 — three-state All-default filter · empty-state matrix ·
  // closing install CTA · shared marketplace-access gating · fade containment.
  // -------------------------------------------------------------------------

  describe("cinatra#2357 three-state filter, All first and default", () => {
    it("widens FilterType to all | connected | available", () => {
      expect(SRC).toMatch(
        /type FilterType = "all" \| "connected" \| "available";/,
      );
    });

    it("lands on \"all\" on every mount", () => {
      expect(SRC).toMatch(/useState<FilterType>\("all"\)/);
    });

    it("gives \"all\" a PASS-ALL predicate — it narrows nothing", () => {
      // The status branches must stay `c.connected` / `!c.connected`; only the
      // "all" arm is unconditional. A regression that made "all" fall through
      // to one of the status arms would drop cards silently.
      expect(SRC).toMatch(
        /filterType === "all" \? true : filterType === "connected" \? c\.connected : !c\.connected/,
      );
    });

    it("orders the segments All → Connected → Disconnected, All FIRST", () => {
      const allIdx = SRC.indexOf('value="all"');
      const connectedIdx = SRC.indexOf('value="connected"');
      const availableIdx = SRC.indexOf('value="available"');
      for (const idx of [allIdx, connectedIdx, availableIdx]) {
        expect(idx).toBeGreaterThan(-1);
      }
      expect(allIdx).toBeLessThan(connectedIdx);
      expect(connectedIdx).toBeLessThan(availableIdx);
      // …and all three live inside the ONE ToggleGroup (not a stray literal
      // elsewhere in the file).
      const groupStart = SRC.indexOf("<ToggleGroup");
      const groupEnd = SRC.indexOf("</ToggleGroup>");
      expect(allIdx).toBeGreaterThan(groupStart);
      expect(availableIdx).toBeLessThan(groupEnd);
    });

    it("leads the All segment with the four-square LayoutGrid, never a plug", () => {
      // The plug family stays exclusive to STATUS: All draws the whole grid.
      expect(SRC).toMatch(/import \{[^}]*\bLayoutGrid\b[^}]*\} from "lucide-react"/);
      expect(SRC).toMatch(/value="all"[\s\S]*?<LayoutGrid[\s\S]*?All\n/);
      // Between the All item and the Connected item there is no plug glyph.
      const allIdx = SRC.indexOf('value="all"');
      const connectedIdx = SRC.indexOf('value="connected"');
      const allSegment = SRC.slice(allIdx, connectedIdx);
      expect(allSegment).not.toContain("<PlugConnected");
      expect(allSegment).not.toContain("<Unplug");
    });

    it("dresses All in the page's own navy — solid selected, soft tint idle", () => {
      const allIdx = SRC.indexOf('value="all"');
      const connectedIdx = SRC.indexOf('value="connected"');
      const allSegment = SRC.slice(allIdx, connectedIdx);
      // idle: soft navy tint + navy ink (never grey — #604/#1014 forbid
      // text-muted-foreground anywhere in the group, asserted above).
      expect(allSegment).toContain("bg-foreground/10");
      expect(allSegment).toMatch(/text-foreground(?!-)\b/);
      // selected: SOLID navy with a white icon + label.
      expect(allSegment).toContain("data-[state=on]:bg-foreground");
      expect(allSegment).toContain("data-[state=on]:text-surface-strong");
      // and NOT the indigo primary — the §VII prohibition above holds for the
      // whole file, so the All segment must satisfy it rather than re-specify
      // it. Assert the narrower fact here too so a local regression names
      // itself.
      expect(allSegment).not.toContain("bg-primary");
      expect(allSegment).not.toContain("text-primary");
    });
  });

  describe("cinatra#2357 empty-state matrix (scope-neutral copy)", () => {
    it("keys BOTH panels off the server-resolved cards, never the search-narrowed list", () => {
      // A client-side search miss is not a scope/visibility/nothing-installed
      // cause, so it must leave a bare list rather than a panel asserting one.
      expect(SRC).toMatch(
        /const showAllEmptyState = filterType === "all" && cards\.length === 0/,
      );
      expect(SRC).toMatch(
        /const showConnectedEmptyState = filterType === "connected" && !hasConnectedConnectors/,
      );
    });

    it("All+0 renders the scope-neutral panel, never asserting nothing is installed", () => {
      expect(SRC).toContain("No connectors to show");
      // All three causes are named and each gets its remedy.
      expect(SRC).toContain(
        "installed here yet, that what is installed sits outside the scope",
      );
      expect(SRC).toContain("outside what you are allowed");
      expect(SRC).toContain(
        "Try a wider scope, ask for access to what you cannot see,",
      );
      // and it never claims the flat negative the old Connected copy did.
      expect(SRC).not.toContain("You have not connected any services yet");
    });

    it("All+0 WITHOUT marketplace access keeps the panel, swaps the last clause, and renders NO button", () => {
      expect(SRC).toContain(
        "Try a wider scope, or ask an administrator for access —",
      );
      expect(SRC).toContain("or for an install.");
      // The panel's own button is inside a canReachMarketplace branch, so the
      // no-access variant has no action at all.
      const panelStart = SRC.indexOf('data-testid="connectors-empty-panel"');
      const panelEnd = SRC.indexOf("showConnectedEmptyState ?", panelStart);
      const panel = SRC.slice(panelStart, panelEnd);
      expect(panel).toMatch(
        /canReachMarketplace \? \([\s\S]*?Install more connectors[\s\S]*?\) : null/,
      );
    });

    it("Connected+0 adopts the spec's re-specified scope-neutral copy", () => {
      expect(SRC).toContain("No connected services in this view");
      expect(SRC).toContain(
        "Nothing here is connected. Either nothing is installed in this scope",
      );
      expect(SRC).not.toContain("No connected services yet");
    });

    it("Disconnected+0 has NO panel branch — the grid area is simply bare", () => {
      // Exactly two empty panels exist, and neither is reachable from the
      // disconnected segment: the only `filterType ===` guards on the panels
      // are "all" and "connected".
      const panelGuards = SRC.match(
        /const show(?:All|Connected)EmptyState = filterType === "(\w+)"/g,
      );
      expect(panelGuards).toHaveLength(2);
      expect(SRC).not.toMatch(/filterType === "available" &&[\s\S]{0,80}Empty/);
    });
  });

  describe("cinatra#2357 closing install CTA", () => {
    it("is a centred outline/sm Button-as-Link to the marketplace connector tab", () => {
      expect(SRC).toMatch(
        /<div className="mt-6 flex justify-center[^"]*">[\s\S]*?variant="outline"[\s\S]*?size="sm"[\s\S]*?href="\/configuration\/marketplace\?tab=connector"[\s\S]*?Install more connectors/,
      );
    });

    it("carries NO leading glyph — the plug family belongs to status", () => {
      const ctaIdx = SRC.indexOf('data-testid="connectors-install-cta"');
      expect(ctaIdx).toBeGreaterThan(-1);
      const cta = SRC.slice(ctaIdx, SRC.indexOf("</div>", ctaIdx));
      expect(cta).not.toMatch(/<(Plus|PlugConnected|Unplug|LayoutGrid)\b/);
    });

    it("renders in every state EXCEPT All+0, where the panel already carries it", () => {
      // Read the WHOLE declaration and pin it exactly: All+0 is the only
      // suppression case. Connected+0 is NOT one — that panel's action is a
      // different one, so the bottom button keeps rendering beneath it — and a
      // regression that added it here would change this statement.
      const decl = SRC.match(/const showInstallCta = [^;]+;/);
      expect(decl).not.toBeNull();
      expect(decl![0]).toBe(
        "const showInstallCta = canReachMarketplace && !showAllEmptyState;",
      );
    });
  });

  describe("cinatra#2357 shared marketplace-access gating", () => {
    it("takes the access decision as a REQUIRED prop (no permissive default)", () => {
      expect(SRC).toMatch(/canReachMarketplace: boolean;/);
      expect(SRC).not.toMatch(/canReachMarketplace\s*=\s*true/);
      expect(SRC).toMatch(/canReachMarketplace,\n\}: ConnectorsClientProps/);
    });

    it("gates the toolbar's + Connector action AND its leading divider", () => {
      // Both live inside the same branch, so hiding the action never leaves a
      // doubled hairline behind it.
      expect(SRC).toMatch(
        /\{canReachMarketplace \? \(\s*<>\s*<ToolbarSeparator \/>\s*<ToolbarGroup>[\s\S]*?href="\/configuration\/marketplace\?tab=connector"/,
      );
    });

    it("gates the closing CTA on the SAME fact, so the pair is never split", () => {
      expect(SRC).toMatch(/showInstallCta = canReachMarketplace &&/);
    });
  });

  describe("cinatra#2357 fade containment", () => {
    // The live overlap proof is the Playwright viewport check on the running
    // page; these are the STRUCTURAL facts that make the overlap impossible,
    // each of which a refactor could silently undo.
    // The fade, its positioning and its gutter are ONE conditional class
    // group — they must never be separable, which is what these read.
    const fadeGroup = () => {
      const m = SRC.match(/"(faded-bottom[^"]*)"/);
      expect(m).not.toBeNull();
      return m![1];
    };

    it("makes the faded list its OWN positioned containing block", () => {
      // `after:absolute` resolves against the nearest positioned ancestor —
      // without `relative` on the same element the band escapes the list.
      expect(fadeGroup()).toContain("relative");
    });

    it("gives the fade a trailing gutter AT LEAST as tall as the band itself", () => {
      // The rework that matters: a contained band is anchored to this
      // element's bottom, so anything shorter than the band's own height gets
      // washed. Read the utility's height out of globals.css rather than
      // restating it — the two are ONE decision, and a future change to either
      // side alone is exactly the regression this guards.
      const utility = GLOBALS.match(/@utility faded-bottom \{[\s\S]*?\n\}/);
      expect(utility).not.toBeNull();
      const bandHeight = Number(utility![0].match(/after:h-(\d+)\b/)![1]);
      // The band is `md:after:block` — hidden below `md` — so the 128px gutter
      // must be `md:`-scoped too, or it is dead space on a phone.
      expect(utility![0]).toContain("md:after:block");
      const gutter = fadeGroup().match(/\bmd:pb-(\d+)\b/);
      expect(gutter).not.toBeNull();
      expect(Number(gutter![1])).toBeGreaterThanOrEqual(bandHeight);
      // …and it is genuinely a rework of the old value, not the old value.
      expect(fadeGroup()).not.toContain("pb-16");
    });

    it("reserves the fade and its gutter ONLY when there are cards to fade", () => {
      // An empty grid (Disconnected+0, or a search that matches nothing) has
      // nothing to fade, so it must not reserve the band's gutter above the
      // CTA either.
      expect(SRC).toMatch(
        /filteredConnectors\.length > 0 && "faded-bottom relative pb-\d+ md:pb-\d+"/,
      );
    });

    it("places the CTA OUTSIDE that block, and wraps neither in a positioned parent", () => {
      const ulClose = SRC.indexOf("</ul>");
      const ctaIdx = SRC.indexOf('data-testid="connectors-install-cta"');
      expect(ulClose).toBeGreaterThan(-1);
      expect(ctaIdx).toBeGreaterThan(ulClose);
      // Between the list's close and the CTA there is no positioned wrapper —
      // the two are siblings under the component's bare fragment, so nothing
      // can establish a shared containing block for the overlay.
      const between = SRC.slice(ulClose, ctaIdx);
      expect(between).not.toMatch(/className="[^"]*\b(relative|absolute|fixed|sticky)\b/);
      expect(SRC).not.toMatch(/<div className="[^"]*relative[^"]*">\s*<ul className="[^"]*faded-bottom/);
    });
  });
});

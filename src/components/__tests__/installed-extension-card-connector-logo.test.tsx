/**
 * InstalledExtensionCard — connector-logo icon resolution (cinatra#1325).
 *
 * The installed-extension card's icon tile must resolve the extension's OWN
 * logo (`cinatra.logo`/`manifest.logo`, surfaced by the row loader as `iconUrl`
 * — the same source `/connectors` uses) so a connector-kind card shows the
 * connector's logo instead of the generic kind emblem. `iconUrl` wins over the
 * emblem in `ExtensionCardListingBanner`; a null/absent logo falls back to the
 * kind emblem. (The present-but-unloadable tail — an `<img>` load error
 * degrading to the emblem — is covered by the ExtensionCardIconImage jsdom
 * test; here we assert URL *presence* drives the tile, via renderToStaticMarkup
 * — node env, matching the sibling extension-card.test.tsx pattern.)
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { InstalledExtensionCard } from "../extensions/installed-extension-card";

// A recognizable generic kind emblem so the test can assert whether the card
// fell back to it (absent/malformed logo) or rendered the connector logo image.
const KindEmblem = () => <svg data-testid="connector-kind-emblem" />;

const LOGO_DATA_URI =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=";

function renderCard(iconUrl: string | null, extra: { archived?: boolean } = {}) {
  return renderToStaticMarkup(
    <InstalledExtensionCard
      name="YouTube"
      accentColor="rust"
      emblem={<KindEmblem />}
      iconUrl={iconUrl}
      kindLabel="Connector"
      vendor="Cinatra"
      archived={extra.archived}
    />,
  );
}

describe("InstalledExtensionCard — connector logo present", () => {
  it("renders the connector's own logo in the icon tile, not the generic kind emblem", () => {
    const html = renderCard(LOGO_DATA_URI);
    // The extension's logo renders as the tile image…
    expect(html).toContain("<img");
    expect(html).toContain(LOGO_DATA_URI);
    // …and the generic kind emblem is NOT the tile mark (iconUrl wins).
    expect(html).not.toContain('data-testid="connector-kind-emblem"');
  });
});

describe("InstalledExtensionCard — connector logo absent (generic fallback)", () => {
  it("falls back to the generic kind emblem when no logo is supplied", () => {
    const html = renderCard(null);
    expect(html).toContain('data-testid="connector-kind-emblem"');
    expect(html).not.toContain("<img");
  });
});

describe("InstalledExtensionCard — greyed archived card keeps the muted emblem (cinatra#957)", () => {
  it("shows the muted kind emblem, not a full-colour logo image, when the screen gates the logo to null on a greyed card", () => {
    // The screen resolves iconUrl via installedCardIconUrl(logo, {greyed}),
    // which returns null on an archived/needs-review card so the fully-greyed
    // treatment is not defeated by a full-colour logo (codex-caught, #1325).
    const html = renderCard(null, { archived: true });
    expect(html).toContain('data-archived=""');
    expect(html).toContain('data-testid="connector-kind-emblem"');
    expect(html).not.toContain("<img");
  });
});

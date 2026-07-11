// ---------------------------------------------------------------------------
// Installed-extension card icon source (cinatra#1325).
//
// The installed-extension card (and, per this fix, the connector-kind card in
// particular) must resolve its icon tile from the extension's OWN self-
// describing logo — the same source `/connectors` uses — instead of always
// falling back to the generic kind emblem.
//
// `/connectors` (packages/connectors/src/pages.tsx) resolves each connector's
// card logo as `logo: manifest?.logo ?? null` from the materialized
// `STATIC_EXTENSION_MANIFEST` — `manifest.logo` is the sanitized inline-SVG
// data URI built from the package's `cinatra.logo` asset at manifest-generation
// time. When it is null the connectors client degrades to its host icon map
// and finally a neutral glyph. This module mirrors that FIRST tier for the
// installed-extension card: the manifest logo becomes the card's `iconUrl`
// (which wins over the emblem in `ExtensionCardListingBanner`), so an installed
// connector card and its `/connectors` row resolve to the SAME connector
// identity. Absent/blank/malformed → null, and the card falls back to the kind
// emblem exactly as before (`ExtensionCardIconImage` additionally degrades a
// present-but-unloadable value to the emblem at render — cinatra#1003).
// ---------------------------------------------------------------------------

/**
 * Normalize an extension manifest logo value into a card icon source, or null.
 *
 * Mirrors `/connectors`' `manifest?.logo ?? null` resolution, hardened for the
 * card surface: a missing field, a non-string value, or an empty/whitespace
 * string all collapse to null (the generic-emblem fallback), so a malformed
 * generated record never binds a broken `<img src>`. A non-empty string passes
 * through verbatim — the manifest logo is already a sanitized inline-SVG data
 * URI produced at manifest-generation time, so no scheme guard applies (a
 * present-but-unloadable value still degrades to the emblem at render).
 */
export function normalizeManifestLogo(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Resolve the installed-extension card's icon-tile source from the (already
 * normalized) manifest logo — EXCEPT on a GREYED card (archived or post-install
 * needs-review), which must keep its muted kind emblem so the card reads
 * inactive at a glance (the fully-greyed card contract, cinatra#957).
 *
 * A raster/inline-SVG logo image is drawn by `ExtensionCardIconImage` and is
 * NOT affected by the banner's `muted` text colour, so surfacing it on a greyed
 * card would paint a full-colour mark on an otherwise-desaturated card and
 * defeat the greying (codex-caught, cinatra#1325). Gating the source to null on
 * a greyed card falls the tile back to the muted emblem, byte-identical to the
 * pre-#1325 archived/needs-review card. An active card surfaces its own logo.
 */
export function installedCardIconUrl(
  logo: string | null,
  opts: { greyed: boolean },
): string | null {
  return opts.greyed ? null : logo;
}

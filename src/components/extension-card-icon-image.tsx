"use client";

import * as React from "react";

// Deep subpath import ON PURPOSE (client-safe): the pure card-icon model, NOT
// the `screens` barrel (which re-exports the server-only marketplace screens).
// Same seam the design fixtures use — keeps server-only code out of this
// "use client" bundle.
import type { MarketplaceCardData } from "@cinatra-ai/extensions/screens/marketplace-card-model";
import { resolveCardIconChain } from "@cinatra-ai/extensions/screens/marketplace-card-model";
import { connectorBrandIcon } from "@/components/connector-brand-icons";

/**
 * The ExtensionCardListingBanner icon tile's hosted-image link of the fallback
 * chain (spec §IV): renders the resolved hosted image, but degrades to the
 * emblem the moment the browser fails to LOAD it (a dead/expired asset, a
 * network hiccup) — cinatra#1003. The tile must never show a blank/broken
 * square: presence of a URL string is necessary but not sufficient, the image
 * must actually decode.
 *
 * cinatra#1325: the tile now walks an ORDERED chain of image srcs (`srcs`) —
 * `manifest.logo` → catalog `icon_url` → vendor logo — advancing to the next on
 * each load failure, and only then rendering the terminal `emblem` node (the
 * client-icon-map brand mark or the kind emblem). The single-`src` form is
 * kept for the existing installed-extension / §V callers (byte-identical).
 */
export function ExtensionCardIconImage({
  src,
  srcs,
  emblem,
}: {
  /** Single hosted URL (legacy callers). Ignored when `srcs` is provided. */
  src?: string;
  /**
   * Ordered hosted-image candidates (cinatra#1325). Tried first→last, advancing
   * on each `<img>` load failure; once exhausted the `emblem` renders. Assumed
   * already de-duplicated + guarded by the caller (`resolveCardIconChain`).
   */
  srcs?: string[];
  emblem: React.ReactNode;
}) {
  const chain = srcs ?? (src != null ? [src] : []);
  // Reset to the first candidate whenever the chain CONTENTS change (a different
  // card, or a re-resolved chain) — keyed on the full joined chain, not array
  // identity or only the first URL (codex round-0). A NUL join keeps distinct
  // chains from colliding on a shared prefix.
  const chainKey = chain.join("\u0000");
  const [state, setState] = React.useState({ key: chainKey, index: 0 });
  const index = state.key === chainKey ? state.index : 0;
  if (state.key !== chainKey) {
    // Render-phase reset (no effect needed): a changed chain restarts at 0.
    setState({ key: chainKey, index: 0 });
  }

  const current = chain[index];
  if (current == null) {
    return <>{emblem}</>;
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- sanitized hosted raster URL / inline-SVG data URI from the marketplace card model; no build-time-known loader/allowlist applies.
    <img
      key={current}
      src={current}
      alt=""
      className="h-full w-full object-cover"
      loading="lazy"
      decoding="async"
      onError={() => setState({ key: chainKey, index: index + 1 })}
    />
  );
}

/**
 * Resolve + render the marketplace extension card's icon (cinatra#1325), in the
 * explicit order `/connectors` shares:
 *
 *   manifest.logo → client icon map → catalog icon_url → vendor logo → kind emblem
 *
 * The pure `resolveCardIconChain` (client-safe model) owns the ORDER; this
 * client component owns the two NODE tiers, which cannot live in the model:
 *   - the client-icon-map brand mark — resolved HERE from the shared
 *     `connectorBrandIcon` leaf (the SAME map `/connectors` reads), gated to
 *     `kind === "connector"` so a non-connector package that happens to share a
 *     slug basename can never borrow a brand mark (codex round-0);
 *   - the generic kind emblem — supplied by the caller as `kindEmblem`.
 *
 * A connector with a mapped brand mark drops the catalog/vendor `<img>` tiers
 * (the brand node always renders and sits above them in the order), so the card
 * resolves the identical connector identity `/connectors` does — never the
 * generic kind emblem.
 */
export function MarketplaceCardIcon({
  card,
  kindEmblem,
}: {
  card: Pick<
    MarketplaceCardData,
    "manifestLogoUrl" | "iconUrl" | "vendorLogoUrl" | "iconSlug" | "kindSlug"
  >;
  kindEmblem: React.ReactNode;
}) {
  const brand =
    card.kindSlug === "connector" && card.iconSlug
      ? connectorBrandIcon(card.iconSlug)
      : null;
  const chain = resolveCardIconChain(card, { hasClientIcon: brand !== null });
  const emblem = chain.emblem === "client-icon" ? brand : kindEmblem;
  return <ExtensionCardIconImage srcs={chain.imageSrcs} emblem={emblem} />;
}

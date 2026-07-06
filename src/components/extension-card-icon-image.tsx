"use client";

import * as React from "react";

/**
 * The ExtensionCardListingBanner icon tile's hosted-image link of the fallback
 * chain (icon → vendor logo → kind emblem, spec §IV): renders the resolved
 * hosted image, but degrades to the kind-emblem glyph the moment the browser
 * fails to LOAD it (a dead/expired asset, a network hiccup) — cinatra#1003.
 * The tile must never show a blank/broken square: presence of a URL string is
 * necessary but not sufficient, the image must actually decode. `key={src}`
 * on the call site resets the failed state when the resolved URL changes
 * (a different card / a different fallback link).
 */
export function ExtensionCardIconImage({
  src,
  emblem,
}: {
  src: string;
  emblem: React.ReactNode;
}) {
  const [failed, setFailed] = React.useState(false);

  if (failed) {
    return <>{emblem}</>;
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- sanitized hosted raster URL from the marketplace card model; no build-time-known loader/allowlist applies.
    <img
      src={src}
      alt=""
      className="h-full w-full object-cover"
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

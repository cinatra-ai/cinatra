/**
 * Client-safe view model + pure helpers for the in-app extension-detail modal.
 *
 * The modal embeds the marketplace listing detail (README, specs, rating
 * summary, reviews, vendor) that the public REST detail payload now carries.
 * The marketplace MCP client is a SERVER-ONLY dependency (and is barred from the
 * client bundle by the marketplace-mcp-client-banned guard), so the modal never
 * imports it: the server action fetches the {@link ExtensionDetail} and projects
 * it into this plain, serialisable {@link MarketplaceDetailView} the client
 * component renders. This module is pure (no IO, no server-only import), so the
 * projection + the presentational helpers are unit-testable.
 */

import type { ExtensionCompatState } from "@/lib/extension-compat-badge";

export interface MarketplaceDetailReview {
  author: string;
  verifiedOwner: boolean;
  /** ISO-8601 UTC, or null when the listing carried no valid date. */
  date: string | null;
  /** 1–5. */
  rating: number;
  /** Tag-stripped review text — render ESCAPED (never as HTML). */
  text: string;
}

export interface MarketplaceDetailRatingSummary {
  average: number;
  total: number;
  /** Per-star tally, always a full 5→1 map. */
  counts: Record<"1" | "2" | "3" | "4" | "5", number>;
}

export interface MarketplaceDetailVendor {
  name: string;
  slug: string;
  /** Sanitised http(s) store URL, or null. */
  storeUrl: string | null;
}

/**
 * The client-safe projection of the marketplace detail the modal renders. Every
 * field is a primitive / plain object so it crosses the server-action boundary
 * cleanly and carries no marketplace-client type into the browser bundle.
 */
export interface MarketplaceDetailView {
  packageName: string;
  displayName: string;
  kindLabel: string;
  /** Commerce label ("Open source" / "Free" / a price), or null. */
  cost: string | null;
  /** SPDX id when open-source, else null. */
  license: string | null;
  latestVersion: string | null;
  freshnessAt: string | null;
  installCount: number | null;
  permalink: string | null;
  sdkAbiRange: string | null;
  readmeMarkdown: string | null;
  longDescription: string | null;
  description: string | null;
  iconUrl: string | null;
  ratingSummary: MarketplaceDetailRatingSummary;
  reviews: MarketplaceDetailReview[];
  vendor: MarketplaceDetailVendor | null;
}

/** The result of the on-demand detail load, as a discriminated union so the
 * modal renders loading / content / not-found / error without a thrown crash. */
export type MarketplaceDetailLoadResult =
  | { ok: true; detail: MarketplaceDetailView }
  | { ok: false; reason: "not_found" | "error" };

const ZERO_COUNTS: MarketplaceDetailRatingSummary["counts"] = {
  "1": 0,
  "2": 0,
  "3": 0,
  "4": 0,
  "5": 0,
};

/** A well-formed zeroed rating summary (never a missing field). */
export function emptyRatingSummary(): MarketplaceDetailRatingSummary {
  return { average: 0, total: 0, counts: { ...ZERO_COUNTS } };
}

/**
 * Return `value` iff it is an http(s) URL, else null — the single scheme guard
 * for every URL the modal RENDERS as an `src`/`href`. It covers the hero-icon
 * fallback chain in particular: `ExtensionDetail.iconAssetUrl` and the browse
 * card's `iconUrl`/`vendorLogoUrl` are NOT themselves scheme-checked, so a
 * non-http(s) value (`javascript:`, `data:`, a relative string, …) from the
 * marketplace payload or a card fallback is dropped to null here before it can
 * reach the DOM. Mirrors the permalink scheme check in {@link buildShareLinks}.
 */
export function safeHttpUrl(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

/**
 * The six visual footer states of the install CTA (design spec §IV), resolved
 * from the card's existing 4-state CTA plus the local ABI compat verdict. The
 * "incompatible" state ONLY overrides a not-installed listing whose declared ABI
 * this host does not satisfy — an already-installed / updatable / archived
 * listing keeps its normal state (installing it is not the current action).
 * "installing" is not modelled here: it is the pending label of the install
 * form's submit button (useFormStatus), layered on the "install"/"update"/
 * "restore" states at render time.
 */
export type ModalInstallState =
  | { kind: "install"; disabled: boolean }
  | { kind: "update"; disabled: boolean }
  | { kind: "installed" }
  | { kind: "restore" }
  | { kind: "incompatible" };

export type ModalCardCta =
  | { state: "restore" }
  | { state: "install"; disabled: boolean }
  | { state: "update"; disabled: boolean }
  | { state: "installed" }
  | { state: "incompatible" };

export function resolveModalInstallState(
  cta: ModalCardCta,
  compat: ExtensionCompatState,
): ModalInstallState {
  // The card CTA resolver (resolveMarketplaceCardCta) is now six-state and
  // already folds the ABI verdict in — pass its "incompatible" through.
  if (cta.state === "incompatible") {
    return { kind: "incompatible" };
  }
  // Defence in depth for a caller still passing a 4-state CTA: a not-installed
  // listing whose DECLARED ABI this host cannot satisfy would be refused at
  // activation, so surface the disabled "Incompatible" state instead of an
  // Install that cannot succeed. (This is a UX affordance; the authoritative
  // refusal remains the host activation gate.)
  if (cta.state === "install" && compat === "incompatible") {
    return { kind: "incompatible" };
  }
  switch (cta.state) {
    case "install":
      return { kind: "install", disabled: cta.disabled };
    case "update":
      return { kind: "update", disabled: cta.disabled };
    case "restore":
      return { kind: "restore" };
    case "installed":
      return { kind: "installed" };
  }
}

export type ShareNetwork = "facebook" | "x" | "pinterest" | "linkedin" | "telegram";

export interface ShareLink {
  network: ShareNetwork;
  label: string;
  href: string;
}

const SHARE_LABEL: Record<ShareNetwork, string> = {
  facebook: "Share on Facebook",
  x: "Share on X",
  pinterest: "Share on Pinterest",
  linkedin: "Share on LinkedIn",
  telegram: "Share on Telegram",
};

/**
 * Build the icon-only share row hrefs from the listing permalink. Returns [] for
 * a null / non-http(s) permalink (the share row then renders nothing). The
 * permalink is URL-encoded into each network's canonical share intent.
 */
export function buildShareLinks(permalink: string | null): ShareLink[] {
  if (typeof permalink !== "string" || permalink.trim() === "") {
    return [];
  }
  let scheme = "";
  try {
    scheme = new URL(permalink).protocol;
  } catch {
    return [];
  }
  if (scheme !== "http:" && scheme !== "https:") {
    return [];
  }
  const u = encodeURIComponent(permalink);
  const hrefs: Record<ShareNetwork, string> = {
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${u}`,
    x: `https://twitter.com/intent/tweet?url=${u}`,
    pinterest: `https://pinterest.com/pin/create/button/?url=${u}`,
    linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${u}`,
    telegram: `https://t.me/share/url?url=${u}`,
  };
  return (Object.keys(hrefs) as ShareNetwork[]).map((network) => ({
    network,
    label: SHARE_LABEL[network],
    href: hrefs[network],
  }));
}

export interface RatingBar {
  star: 5 | 4 | 3 | 2 | 1;
  count: number;
  /** 0–100 width of the per-level bar (0 when there are no reviews). */
  pct: number;
}

/** The 5→1 rating-summary bars (each level's count + its share of the total). */
export function ratingBars(summary: MarketplaceDetailRatingSummary): RatingBar[] {
  const total = summary.total > 0 ? summary.total : 0;
  return ([5, 4, 3, 2, 1] as const).map((star) => {
    const count = Math.max(0, Math.trunc(summary.counts[String(star) as "1"] ?? 0));
    const pct = total > 0 ? Math.min(100, Math.round((count / total) * 100)) : 0;
    return { star, count, pct };
  });
}

/**
 * Compact install-count label ("2.1k installations"). Null count → null (no
 * line). Mirrors the browse card's install-count formatting so the modal and
 * the card agree.
 */
export function formatInstallations(count: number | null): string | null {
  if (count === null || !Number.isFinite(count) || count < 0) {
    return null;
  }
  const n = Math.floor(count);
  if (n < 1000) {
    return `${n} ${n === 1 ? "installation" : "installations"}`;
  }
  const thousands = n / 1000;
  const rounded = Math.round(thousands * 10) / 10;
  const text = Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(1);
  return `${text}k installations`;
}

/** Up-to-two-letter initials for a review author's avatar. "" → "?". */
export function reviewInitials(author: string): string {
  const parts = author.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return "?";
  }
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

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

/** One per-version entry of the §V Changelog tab (newest first). */
export interface MarketplaceDetailChangelogEntry {
  /** Released version, undecorated (e.g. "0.4.2") — the mono chip text. */
  version: string;
  /** ISO-8601 release date, or null (the date column is then omitted). */
  date: string | null;
  /** Plain-text release-note lines — rendered ESCAPED, one list item each. */
  notes: string[];
}

/**
 * One row of the §V Dependencies list — another Cinatra extension declared in
 * the manifest `cinatra.dependencies` (kind emblem + name + version range).
 * Never an npm package dependency.
 */
export interface MarketplaceDetailDependency {
  packageName: string;
  /** Display label; equals `packageName` when the catalog knows no better. */
  name: string;
  /** Kind slug for the emblem ("agent" | "skill" | …), or null → generic. */
  kind: string | null;
  /** Declared semver range verbatim; "" renders no range line. */
  versionRange: string;
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
  /**
   * The storefront-computed "Compatible up to" Cinatra version (bare, no "v"
   * prefix — e.g. "0.2.0"), or null while the storefront detail endpoint does
   * not serve the field yet (marketplace#190 workstream C). Rendered as the
   * §V plain specs row "Compatible up to · Cinatra v{version}"; null → "—".
   * NOTE: deliberately NOT derived from `sdkAbiRange` — that is the SDK ABI
   * version space (e.g. "^2"), not the Cinatra product version the spec row
   * names.
   */
  compatibleUpTo: string | null;
  /**
   * §V Changelog-tab entries (newest first). [] renders the spec's
   * "No changelog available" empty state — the storefront detail endpoint
   * does not serve the field yet (marketplace#190 workstream C).
   */
  changelog: MarketplaceDetailChangelogEntry[];
  /**
   * §V Dependencies rows (`cinatra.dependencies`, never npm deps). [] omits
   * the section — both for a none-declared listing and while the storefront
   * detail endpoint does not serve the field (marketplace#190 workstream C).
   */
  dependencies: MarketplaceDetailDependency[];
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
 * Normalize the wire "Compatible up to" Cinatra version to a bare version
 * string: trims, strips a single leading "v"/"V", and degrades anything
 * non-string/empty to null (the row renders "—"). Presentation (the
 * "Cinatra v" prefix) is applied at the render, never stored.
 */
export function normalizeCompatibleUpTo(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/^[vV]/, "");
  return trimmed === "" ? null : trimmed;
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
  | { state: "installed" };

export function resolveModalInstallState(
  cta: ModalCardCta,
  compat: ExtensionCompatState,
): ModalInstallState {
  // A not-installed listing whose DECLARED ABI this host cannot satisfy: the
  // install would be refused at activation, so surface the disabled
  // "Incompatible" state instead of an Install that cannot succeed. (This is a
  // UX affordance; the authoritative refusal remains the host activation gate.)
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
 * Compact install-count VALUE ("950", "2.1k") for the §V specs column — the
 * drawing renders the bare figure under the "Installations" row label, so the
 * label is never repeated inside the value. Null count → null (no line).
 */
export function formatInstallations(count: number | null): string | null {
  if (count === null || !Number.isFinite(count) || count < 0) {
    return null;
  }
  const n = Math.floor(count);
  if (n < 1000) {
    return `${n}`;
  }
  const thousands = n / 1000;
  const rounded = Math.round(thousands * 10) / 10;
  const text = Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(1);
  return `${text}k`;
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

// --- §V Changelog + Dependencies normalizers (marketplace#190 wire) ----------
// Structurally typed over `unknown` (no marketplace-client import — this module
// must stay client-safe/pure) and fully defensive: the storefront endpoint does
// not serve these fields yet, so the projection must degrade any absent,
// partial, or malformed value to the spec's empty states, never crash.

/** A CHANGELOG heading line, e.g. "## [0.4.2] - 2026-06-28" / "## 0.4.2". */
const CHANGELOG_HEADING_RE = /^#{1,4}\s+(.*)$/;
/** The version token inside a heading (optionally bracketed / v-prefixed). */
const CHANGELOG_VERSION_RE = /\[?\bv?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)\]?/;
/** An ISO-ish date token inside a heading, e.g. "2026-06-28". */
const CHANGELOG_DATE_RE = /(\d{4}-\d{2}-\d{2})/;

/**
 * Parse a raw root-CHANGELOG text into §V per-version entries. Recognizes the
 * common heading shapes ("## [0.4.2] - 2026-06-28", "## 0.4.2 (2026-06-28)",
 * "# 0.4.2", keep-a-changelog). Note lines are the bullet/paragraph lines
 * under each heading (markdown list markers stripped; deeper "###" section
 * headings like "Added"/"Fixed" become their own note line). Returns [] when
 * no version heading is found — the tab then renders the spec empty state.
 */
export function parseChangelogText(raw: string): MarketplaceDetailChangelogEntry[] {
  const entries: MarketplaceDetailChangelogEntry[] = [];
  let current: MarketplaceDetailChangelogEntry | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const heading = CHANGELOG_HEADING_RE.exec(line.trim());
    if (heading) {
      const version = CHANGELOG_VERSION_RE.exec(heading[1])?.[1] ?? null;
      if (version) {
        current = { version, date: CHANGELOG_DATE_RE.exec(heading[1])?.[1] ?? null, notes: [] };
        entries.push(current);
        continue;
      }
      // A non-version heading ("# Changelog", "### Fixed"): before any version
      // entry it is preamble (skip); inside one it becomes a note line.
      if (current) {
        const text = heading[1].trim();
        if (text !== "") current.notes.push(text);
      }
      continue;
    }
    if (!current) continue; // preamble before the first version heading
    const note = line.trim().replace(/^[-*+]\s+/, "").trim();
    if (note !== "") current.notes.push(note);
  }
  return entries;
}

/**
 * Project the wire `changelog` field into view entries: a pre-parsed entry
 * array is sanitized entry-by-entry (a version is required; `notes` accepts a
 * string[] or a single string), a raw CHANGELOG string is parsed via
 * {@link parseChangelogText}, anything else → [] (the spec empty state).
 */
export function normalizeDetailChangelog(raw: unknown): MarketplaceDetailChangelogEntry[] {
  if (typeof raw === "string") {
    return parseChangelogText(raw);
  }
  if (!Array.isArray(raw)) return [];
  const out: MarketplaceDetailChangelogEntry[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const entry = e as { version?: unknown; date?: unknown; released_at?: unknown; notes?: unknown };
    const version = typeof entry.version === "string" ? entry.version.trim() : "";
    if (version === "") continue;
    const dateRaw =
      typeof entry.date === "string" && entry.date.trim() !== ""
        ? entry.date
        : typeof entry.released_at === "string" && entry.released_at.trim() !== ""
          ? entry.released_at
          : null;
    const notes = (
      Array.isArray(entry.notes)
        ? entry.notes
        : typeof entry.notes === "string"
          ? [entry.notes]
          : []
    ).filter((n): n is string => typeof n === "string" && n.trim() !== "");
    out.push({ version, date: dateRaw, notes });
  }
  return out;
}

const DETAIL_DEPENDENCY_KIND_SLUGS = new Set(["agent", "skill", "connector", "artifact", "workflow"]);

/**
 * Project the wire `dependencies` field (`cinatra.dependencies` — NEVER the
 * npm deps) into §V view rows. Accepts the enriched entry array or the raw
 * manifest name→range map; anything else → [] (section omitted).
 */
export function normalizeDetailDependencies(raw: unknown): MarketplaceDetailDependency[] {
  if (!raw || typeof raw !== "object") return [];
  const out: MarketplaceDetailDependency[] = [];
  if (Array.isArray(raw)) {
    for (const d of raw) {
      if (!d || typeof d !== "object") continue;
      const dep = d as {
        packageName?: unknown;
        package_name?: unknown;
        name?: unknown;
        display_name?: unknown;
        kind?: unknown;
        versionRange?: unknown;
        version_range?: unknown;
        versionConstraint?: unknown;
        version_constraint?: unknown;
      };
      const packageName = firstNonEmptyString(dep.packageName, dep.package_name);
      if (packageName === null) continue;
      const kind = firstNonEmptyString(dep.kind);
      out.push({
        packageName,
        name: firstNonEmptyString(dep.display_name, dep.name) ?? packageName,
        kind: kind !== null && DETAIL_DEPENDENCY_KIND_SLUGS.has(kind) ? kind : null,
        versionRange:
          firstNonEmptyString(dep.versionRange, dep.version_range) ??
          dependencyConstraintString(dep.versionConstraint ?? dep.version_constraint) ??
          "",
      });
    }
    return out;
  }
  for (const [packageName, range] of Object.entries(raw as Record<string, unknown>)) {
    if (packageName.trim() === "") continue;
    out.push({
      packageName: packageName.trim(),
      name: packageName.trim(),
      kind: null,
      versionRange: typeof range === "string" ? range.trim() : "",
    });
  }
  return out;
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return null;
}

/**
 * Render a canonical `cinatra.dependencies` version constraint as a display
 * string. The canonical edge (sdk-extensions ExtensionDependency) carries a
 * discriminated `versionConstraint` OBJECT ({range} | {version} | {ref}); a
 * plain string passes through. Anything else → null.
 */
function dependencyConstraintString(v: unknown): string | null {
  if (typeof v === "string") return firstNonEmptyString(v);
  if (v && typeof v === "object") {
    const c = v as { range?: unknown; version?: unknown; ref?: unknown };
    return firstNonEmptyString(c.range, c.version, c.ref);
  }
  return null;
}

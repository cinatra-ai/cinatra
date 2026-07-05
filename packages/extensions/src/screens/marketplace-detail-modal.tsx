"use client";

// ---------------------------------------------------------------------------
// MarketplaceDetailModal — the in-app extension-detail modal.
//
// Clicking "More details" on a browse card opens this dialog instead of
// navigating. Its body embeds the marketplace listing detail (banner-capable
// hero + Details / Reviews / Changelog tabs + share row, per design spec §V)
// stripped of storefront chrome; the footer carries the per-instance install
// CTA (the six visual states of the design spec §IV, assembled from the
// existing pieces). The marketplace detail is fetched on-demand via an
// admin-gated server action (the marketplace MCP client stays server-only),
// projected into the client-safe MarketplaceDetailView.
//
// The full-page detail route is intentionally KEPT — it remains the deep-link
// target of the agent/instance page header and the registry catalog. This modal
// is the browse-card "More details" experience only.
// ---------------------------------------------------------------------------

import { useCallback, useState } from "react";
import Link from "next/link";
import { XIcon, Star, BadgeCheck, FileX, Loader2 } from "lucide-react";

import {
  Dialog,
  DialogTrigger,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogClose,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  extensionKindEmblem,
  type ExtensionEmblemKind,
} from "@/components/extension-kind-emblem";
import { ACCENT_PALETTE, deriveExtensionAccent } from "@/lib/extension-accent";
import { ExtensionCompatBadge } from "@/components/extension-compat-badge";
import { deriveExtensionCompatState } from "@/lib/extension-compat-badge";
import {
  MarketplaceReadmeMarkdownSection,
  hasRenderableReadmeMarkdown,
} from "@/components/marketplace-readme-section";
import {
  buildShareLinks,
  ratingBars,
  reviewInitials,
  formatInstallations,
  resolveModalInstallState,
  safeHttpUrl,
  type MarketplaceDetailChangelogEntry,
  type MarketplaceDetailDependency,
  type MarketplaceDetailLoadResult,
  type MarketplaceDetailView,
  type MarketplaceDetailReview,
  type ShareNetwork,
} from "@/lib/marketplace-detail-view";
import { getPublicMarketplaceDetailAction } from "@/lib/marketplace-detail-actions";
import { MarketplaceInstallForm, MarketplaceInstallSubmit } from "./marketplace-install-form";
import {
  buildMarketplaceFailureCopy,
  marketplaceFailureCopy,
} from "./marketplace-failure-copy";
import type { MarketplaceCardData, MarketplaceCardCta } from "./marketplace-card-model";
import type { MarketplaceInstallActionResult } from "./marketplace-failure-copy";

type BoundLifecycleAction = () => Promise<MarketplaceInstallActionResult | void>;

type LoadStatus = "idle" | "loading" | "loaded" | "notfound" | "error";

export interface MarketplaceDetailModalProps {
  card: MarketplaceCardData;
  /** The card's 4-state CTA — its `disabled` already encodes registry state. */
  cta: MarketplaceCardCta;
  installAction: BoundLifecycleAction;
  updateAction: BoundLifecycleAction;
  restoreAction: BoundLifecycleAction;
  /**
   * Detail loader override — defaults to the admin-gated marketplace server
   * action. Injectable so the /design-fixtures harness can seed a
   * deterministic MarketplaceDetailView without a storefront round-trip;
   * production callers never pass it.
   */
  loadDetail?: (packageName: string) => Promise<MarketplaceDetailLoadResult>;
}

export function MarketplaceDetailModal({
  card,
  cta,
  installAction,
  updateAction,
  restoreAction,
  loadDetail = getPublicMarketplaceDetailAction,
}: MarketplaceDetailModalProps) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<LoadStatus>("idle");
  const [detail, setDetail] = useState<MarketplaceDetailView | null>(null);

  const load = useCallback(async () => {
    setStatus("loading");
    try {
      const result = await loadDetail(card.packageName);
      if (result.ok) {
        setDetail(result.detail);
        setStatus("loaded");
      } else {
        setStatus(result.reason === "not_found" ? "notfound" : "error");
      }
    } catch {
      // A server-action rejection is masked in production — never crash the
      // browse route; render the retryable error state instead.
      setStatus("error");
    }
  }, [card.packageName, loadDetail]);

  const onOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      // Fetch on first open (and never again once loaded — reviews/specs are a
      // point-in-time read). Retry re-drives load() from the error state.
      if (next && status !== "loaded" && status !== "loading") {
        void load();
      }
    },
    [status, load],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="flex-1">
          More details
        </Button>
      </DialogTrigger>
      {/* Overlay stops below the navbar (top-16). Portalled so it escapes any
          transformed card ancestor and dims the whole viewport below the nav. */}
      <DialogPortal>
        <DialogOverlay />
      </DialogPortal>
      <DialogContent
        showCloseButton={false}
        // The hero renders the visible title; a screen-reader title is always
        // present for the dialog label. No description → suppress the Radix
        // missing-description warning explicitly. The className reshapes the
        // centered dialog into a below-navbar, internally-scrolling panel.
        aria-describedby={undefined}
        className={cn(
          // §V chrome: 720px wide on the page surface (`--paper`/background),
          // not the white `surface-strong` card level.
          "top-20 flex max-h-[calc(100vh-6rem)] w-[calc(100%-2rem)] max-w-[720px] translate-y-0 flex-col gap-0 overflow-hidden p-0 sm:max-w-[720px]",
          "bg-background",
        )}
      >
        <DialogTitle className="sr-only">{card.displayName}</DialogTitle>

        {/* Slim header — close only. */}
        <div className="flex shrink-0 items-center justify-end border-b border-line px-3 py-2">
          <DialogClose
            className="rounded-xs p-1 text-muted-foreground opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-ring focus:outline-hidden"
            aria-label="Close"
          >
            <XIcon className="size-4" />
          </DialogClose>
        </div>

        {/* Body — vertical scroll only. */}
        <div className="flex-1 overflow-x-hidden overflow-y-auto px-6 py-5">
          {status === "loading" || status === "idle" ? (
            <ModalLoading />
          ) : status === "notfound" ? (
            <ModalMessage
              title="Extension unavailable"
              body="This extension is no longer publicly listed."
            />
          ) : status === "error" ? (
            <ModalMessage
              title="Couldn't load details"
              body="Something went wrong loading this extension. Please try again."
              onRetry={() => void load()}
            />
          ) : detail ? (
            <ModalBody card={card} detail={detail} />
          ) : null}
        </div>

        {/* Footer — the six-state install CTA (hairline separator). */}
        <div className="shrink-0 border-t border-line px-6 py-3">
          <ModalFooterCta
            card={card}
            cta={cta}
            installAction={installAction}
            updateAction={updateAction}
            restoreAction={restoreAction}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ModalLoading() {
  return (
    <div className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
      <span>Loading extension details…</span>
    </div>
  );
}

function ModalMessage({
  title,
  body,
  onRetry,
}: {
  title: string;
  body: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex min-h-40 flex-col items-center justify-center gap-3 text-center">
      <div>
        <p className="text-sm font-semibold text-foreground">{title}</p>
        <p className="mt-1 text-sm text-muted-foreground">{body}</p>
      </div>
      {onRetry && (
        <Button size="sm" variant="outline" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

function ModalBody({ card, detail }: { card: MarketplaceCardData; detail: MarketplaceDetailView }) {
  // detail.iconUrl is scheme-guarded at the projection, but the card fallbacks
  // (iconUrl / vendorLogoUrl) come from the browse card model and are NOT
  // scheme-checked — guard the resolved URL so only an http(s) src reaches <img>.
  const iconUrl = safeHttpUrl(detail.iconUrl ?? card.iconUrl ?? card.vendorLogoUrl);
  const reviewCount = detail.reviews.length;
  const shareLinks = buildShareLinks(detail.permalink);

  return (
    <div className="flex flex-col gap-6">
      <ModalHero card={card} detail={detail} iconUrl={iconUrl} />

      <Tabs defaultValue="details" className="gap-4">
        <TabsList>
          <TabsTrigger value="details">Details</TabsTrigger>
          <TabsTrigger value="reviews">
            Reviews{reviewCount > 0 ? ` (${reviewCount})` : ""}
          </TabsTrigger>
          <TabsTrigger value="changelog">Changelog</TabsTrigger>
        </TabsList>

        <TabsContent value="details">
          <DetailsTab detail={detail} />
        </TabsContent>
        <TabsContent value="reviews">
          <ReviewsTab detail={detail} />
        </TabsContent>
        <TabsContent value="changelog">
          <ChangelogTab entries={detail.changelog} />
        </TabsContent>
      </Tabs>

      {shareLinks.length > 0 && (
        <div className="flex items-center justify-center gap-3 border-t border-line pt-4">
          {shareLinks.map((link) => (
            <Link
              key={link.network}
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={link.label}
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              <ShareGlyph network={link.network} />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The modal hero: icon tile + title + "{Type} by {Vendor}" + right-aligned
 * price (§V header tokens). When the listing carries a hosted `bannerUrl`, the
 * hero row renders over the banner image with the MarketplaceDetailHeader
 * treatment — the accent colour stays the ground (graceful while the image
 * loads), a `foreground`-token scrim keeps the name legible, and the text
 * flips to the contrasting `background` token (#739). Absent/blank banner →
 * the plain §V hero, nothing extra.
 */
function ModalHero({
  card,
  detail,
  iconUrl,
}: {
  card: MarketplaceCardData;
  detail: MarketplaceDetailView;
  iconUrl: string | null;
}) {
  // Same trim-guard as MarketplaceDetailHeader; the http(s) scheme guard
  // already ran in the server projection (toDetailView → safeHttpUrl).
  const banner =
    typeof detail.bannerUrl === "string" && detail.bannerUrl.trim() !== ""
      ? detail.bannerUrl.trim()
      : null;
  const accent = deriveExtensionAccent(card.packageName);
  const { bg, fg } = ACCENT_PALETTE[accent];

  return (
    <div
      data-slot="marketplace-modal-hero"
      data-has-banner={banner ? "true" : "false"}
      className={cn(
        "flex items-start gap-4",
        banner && "relative overflow-hidden rounded-card border border-line p-5",
      )}
      // The accent colour is always the ground behind a banner image while it
      // loads (a failed/slow image never leaves a bare panel) — the same
      // fallback contract as MarketplaceDetailHeader.
      style={banner ? { background: bg, color: fg } : undefined}
    >
      {banner && (
        <>
          {/* Hosted banner image — sanitized hosted raster per the marketplace
              contract (never a raw SVG blob). Decorative: the h2 carries the
              accessible name. */}
          {/* eslint-disable-next-line @next/next/no-img-element -- sanitized hosted raster URL from the marketplace detail payload. */}
          <img
            data-slot="marketplace-modal-banner"
            src={banner}
            alt=""
            className="absolute inset-0 h-full w-full object-cover"
            loading="lazy"
            decoding="async"
          />
          {/* Scrim so the tile + name + byline + price stay legible over an
              arbitrary banner image. Semantic `foreground` token — tracks the
              theme, no raw palette. */}
          <div aria-hidden="true" className="absolute inset-0 bg-foreground/55" />
        </>
      )}
      {/* §V logo tile: 64×64, radius 15, white surface, hairline + soft shadow. */}
      <div
        data-slot="marketplace-modal-tile"
        className="relative flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-[15px] border border-line bg-surface-strong shadow-sm"
      >
        {iconUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- sanitized hosted raster URL from the marketplace card model.
          <img src={iconUrl} alt="" className="size-full object-cover" />
        ) : (
          extensionKindEmblem(card.kindSlug, "size-8 text-muted-foreground")
        )}
      </div>
      <div className="relative flex min-w-0 flex-1 flex-col gap-2">
        {/* §V title: Archivo (display) italic 800 23px ink — the named
            `text-modal-title` token (globals.css @theme). Plain string concat,
            NOT cn(): the app tailwind-merge classifies unknown custom `text-*`
            utilities as colors and would strip the size token when the
            banner's `text-background` follows in the same merge. */}
        <h2
          className={
            "font-display text-modal-title font-extrabold italic " +
            (banner ? "text-background" : "text-foreground")
          }
        >
          {detail.displayName}
        </h2>
        <p className={cn("text-sm text-muted-foreground", banner && "text-background/85")}>
          {detail.kindLabel}
          {detail.vendor ? (
            <>
              {" by "}
              {detail.vendor.storeUrl ? (
                <Link
                  href={detail.vendor.storeUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn(
                    "font-medium text-foreground underline underline-offset-2 hover:text-primary",
                    banner && "text-background hover:text-background/80",
                  )}
                >
                  {detail.vendor.name || detail.vendor.slug}
                </Link>
              ) : (
                <span className={cn("font-medium text-foreground", banner && "text-background")}>
                  {detail.vendor.name || detail.vendor.slug}
                </span>
              )}
            </>
          ) : null}
        </p>
      </div>
      {/* §V price: right-aligned in the header, sans 700 15px ink. */}
      {detail.cost && (
        <div
          className={cn(
            "relative shrink-0 pt-1 text-sm font-bold text-foreground",
            banner && "text-background",
          )}
        >
          {detail.cost}
        </div>
      )}
    </div>
  );
}

function DetailsTab({ detail }: { detail: MarketplaceDetailView }) {
  const hasReadme = hasRenderableReadmeMarkdown(detail.readmeMarkdown);
  const fallbackText = detail.longDescription?.trim() || detail.description?.trim() || "";
  const installs = formatInstallations(detail.installCount);
  const lastUpdated = formatDate(detail.freshnessAt);

  return (
    <div className="flex flex-col gap-6 md:flex-row md:items-start">
      <div className="min-w-0 flex-1">
        {hasReadme ? (
          <MarketplaceReadmeMarkdownSection markdown={detail.readmeMarkdown} />
        ) : fallbackText ? (
          <p className="text-sm leading-relaxed whitespace-pre-line text-foreground">{fallbackText}</p>
        ) : (
          <p className="text-sm text-muted-foreground">No description provided.</p>
        )}
      </div>
      <dl className="w-full shrink-0 space-y-3 text-sm md:w-[210px]">
        <SpecRow label="Version" value={detail.latestVersion ?? "—"} />
        <SpecRow label="Last updated" value={lastUpdated ?? "—"} />
        <div className="flex flex-col gap-1">
          <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Compatibility</dt>
          <dd>
            <ExtensionCompatBadge sdkAbiRange={detail.sdkAbiRange} />
          </dd>
        </div>
        <SpecRow label="Installations" value={installs ?? "—"} />
        {detail.dependencies.length > 0 && (
          <DependenciesSection dependencies={detail.dependencies} />
        )}
      </dl>
    </div>
  );
}

/**
 * §V: the specs column closes with the extension's Dependencies — the other
 * Cinatra extensions declared in `cinatra.dependencies` (kind emblem + name +
 * version range), a read-only list in-app, never the npm packages. Rendered
 * only when the listing declares at least one dependency; a none-declared
 * listing's specs column simply ends at Installations.
 */
function DependenciesSection({ dependencies }: { dependencies: MarketplaceDetailDependency[] }) {
  return (
    <div
      data-slot="marketplace-modal-dependencies"
      className="flex flex-col gap-2 border-t border-line pt-3"
    >
      <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        Dependencies
      </dt>
      <dd>
        <ul className="flex flex-col gap-2.5">
          {dependencies.map((dep) => (
            <li key={dep.packageName} className="flex items-start gap-2">
              <span
                aria-hidden="true"
                className="mt-0.5 shrink-0"
                // The dependency's own stable accent colours its emblem —
                // the same accent system the browse cards / detail hero use.
                style={{ color: ACCENT_PALETTE[deriveExtensionAccent(dep.packageName)].bg }}
              >
                {extensionKindEmblem(dependencyEmblemKind(dep.kind), "size-3.5")}
              </span>
              <span className="min-w-0">
                <span className="block text-sm leading-snug text-foreground">{dep.name}</span>
                {dep.versionRange !== "" && (
                  <span className="mt-px block font-mono text-badge-xs text-muted-foreground">
                    {dep.versionRange}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      </dd>
    </div>
  );
}

/** Map a wire kind slug onto the emblem union; anything unknown → generic. */
function dependencyEmblemKind(kind: string | null): ExtensionEmblemKind {
  switch (kind) {
    case "agent":
    case "skill":
    case "connector":
    case "artifact":
    case "workflow":
      return kind;
    default:
      return "unknown";
  }
}

/**
 * §V Changelog tab: the extension's root CHANGELOG as per-version release
 * notes — mono version chip, the release date, a "Latest" badge on the newest
 * entry — or the spec's "No changelog available" empty state when the
 * extension ships no CHANGELOG (which is also the graceful state while the
 * storefront detail endpoint does not serve the field).
 */
function ChangelogTab({ entries }: { entries: MarketplaceDetailChangelogEntry[] }) {
  if (entries.length === 0) {
    return (
      <div
        data-slot="marketplace-modal-changelog-empty"
        className="flex flex-col items-center py-12 text-center"
      >
        <FileX className="size-8 text-muted-foreground opacity-60" aria-hidden="true" />
        <p className="mt-3 text-sm font-bold text-foreground">No changelog available</p>
      </div>
    );
  }
  return (
    <div data-slot="marketplace-modal-changelog">
      {entries.map((entry, i) => (
        <ChangelogEntryRow
          key={`${entry.version}-${i}`}
          entry={entry}
          isLatest={i === 0}
          isLast={i === entries.length - 1}
        />
      ))}
    </div>
  );
}

function ChangelogEntryRow({
  entry,
  isLatest,
  isLast,
}: {
  entry: MarketplaceDetailChangelogEntry;
  isLatest: boolean;
  isLast: boolean;
}) {
  const date = formatChangelogDate(entry.date);
  return (
    // Dividers go BETWEEN entries — the last entry drops its bottom border.
    <section className={cn("py-4", !isLast && "border-b border-line")}>
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="rounded-md bg-surface-muted px-2 py-0.5 font-mono text-sm font-bold text-foreground">
          {entry.version}
        </span>
        {date && <span className="font-mono text-xs text-muted-foreground">{date}</span>}
        {isLatest && (
          <span className="rounded-sm border border-success px-1.5 font-mono text-badge-2xs font-bold text-success uppercase">
            Latest
          </span>
        )}
      </div>
      {entry.notes.length > 0 && (
        <ul className="mt-2 list-disc pl-4.5">
          {entry.notes.map((note, j) => (
            // Tag-stripped plain text — rendered as escaped text, never HTML.
            <li key={j} className="text-sm leading-relaxed text-muted-foreground">
              {note}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SpecRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</dt>
      <dd className="text-foreground">{value}</dd>
    </div>
  );
}

function ReviewsTab({ detail }: { detail: MarketplaceDetailView }) {
  const { reviews, ratingSummary } = detail;
  const bars = ratingBars(ratingSummary);

  return (
    <div className="flex flex-col gap-6 md:flex-row md:items-start">
      <div className="min-w-0 flex-1">
        {reviews.length === 0 ? (
          <p className="text-sm text-muted-foreground">No reviews yet.</p>
        ) : (
          <ul>
            {reviews.map((review, i) => (
              <ReviewItem key={i} review={review} isLast={i === reviews.length - 1} />
            ))}
          </ul>
        )}
      </div>
      <div className="w-full shrink-0 md:w-[210px]">
        <div className="flex items-baseline gap-2">
          <span className="text-3xl font-semibold text-foreground">
            {ratingSummary.average.toFixed(1)}
          </span>
          <StarRow filled={Math.round(ratingSummary.average)} />
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {ratingSummary.total} {ratingSummary.total === 1 ? "review" : "reviews"}
        </p>
        <div className="mt-4 space-y-1.5">
          {bars.map((bar) => (
            <div key={bar.star} className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="w-3 text-right tabular-nums">{bar.star}</span>
              <Star className="size-3 shrink-0 fill-current opacity-70" aria-hidden="true" />
              <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-muted">
                <span className="block h-full rounded-full bg-primary" style={{ width: `${bar.pct}%` }} />
              </span>
              <span className="w-6 text-right tabular-nums">{bar.count}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ReviewItem({ review, isLast }: { review: MarketplaceDetailReview; isLast: boolean }) {
  return (
    <li className={cn("flex gap-3 py-4", !isLast && "border-b border-line")}>
      <span
        aria-hidden="true"
        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-surface-muted text-xs font-semibold text-muted-foreground"
      >
        {reviewInitials(review.author)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-sm font-medium text-foreground">{review.author}</span>
          {review.verifiedOwner && (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <BadgeCheck className="size-3.5 text-primary" aria-hidden="true" />
              Verified owner
            </span>
          )}
          {review.date && (
            <span className="text-xs text-muted-foreground">{formatDate(review.date)}</span>
          )}
        </div>
        <StarRow filled={review.rating} className="mt-1" />
        {/* Tag-stripped review text — rendered as escaped text, never HTML. */}
        {review.text && (
          <p className="mt-1.5 text-sm leading-relaxed whitespace-pre-line text-foreground">{review.text}</p>
        )}
      </div>
    </li>
  );
}

function StarRow({ filled, className }: { filled: number; className?: string }) {
  const n = Math.max(0, Math.min(5, Math.round(filled)));
  return (
    <span
      className={cn("inline-flex items-center gap-0.5", className)}
      aria-label={`Rated ${n} out of 5`}
    >
      {[1, 2, 3, 4, 5].map((i) => (
        <Star key={i} className={cn("size-3.5", i <= n ? "fill-current text-foreground" : "text-muted-foreground opacity-40")} aria-hidden="true" />
      ))}
    </span>
  );
}

function ModalFooterCta({
  card,
  cta,
  installAction,
  updateAction,
  restoreAction,
}: {
  card: MarketplaceCardData;
  cta: MarketplaceCardCta;
  installAction: BoundLifecycleAction;
  updateAction: BoundLifecycleAction;
  restoreAction: BoundLifecycleAction;
}) {
  const compat = deriveExtensionCompatState(card.sdkAbiRange);
  const state = resolveModalInstallState(cta, compat);

  if (state.kind === "incompatible") {
    return (
      <Button
        size="sm"
        disabled
        className="w-full"
        title={`This extension isn't compatible with this instance's SDK ABI — installing it would be refused.`}
      >
        Incompatible
      </Button>
    );
  }

  if (state.kind === "installed") {
    return (
      <Button size="sm" variant="secondary" disabled className="w-full">
        Installed
      </Button>
    );
  }

  if (state.kind === "restore") {
    return (
      <MarketplaceInstallForm
        action={restoreAction}
        failureCopyByCategory={buildMarketplaceFailureCopy("restore", card.displayName)}
        defaultFailureMessage={marketplaceFailureCopy("unrecoverable", "restore", card.displayName)}
        className="w-full"
      >
        <MarketplaceInstallSubmit variant="outline" pendingLabel="Restoring…" className="w-full">
          Restore
        </MarketplaceInstallSubmit>
      </MarketplaceInstallForm>
    );
  }

  // install | update
  const isUpdate = state.kind === "update";
  if (state.disabled) {
    return (
      <Button
        size="sm"
        disabled
        className="w-full"
        title={`Connect the package registry to ${isUpdate ? "update" : "install"}`}
      >
        {isUpdate ? "Update Now" : "Install Now"}
      </Button>
    );
  }
  const op = isUpdate ? "update" : "install";
  return (
    <MarketplaceInstallForm
      action={isUpdate ? updateAction : installAction}
      failureCopyByCategory={buildMarketplaceFailureCopy(op, card.displayName)}
      defaultFailureMessage={marketplaceFailureCopy("unrecoverable", op, card.displayName)}
      className="w-full"
    >
      <MarketplaceInstallSubmit pendingLabel={isUpdate ? "Updating…" : "Installing…"} className="w-full">
        {isUpdate ? "Update Now" : "Install Now"}
      </MarketplaceInstallSubmit>
    </MarketplaceInstallForm>
  );
}

/** Format an ISO date to "MMM d, yyyy"; null/invalid → null. */
function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

/**
 * Format a changelog release date in UTC. CHANGELOG stamps are usually
 * date-only ("YYYY-MM-DD"), which `new Date` parses as UTC midnight — local
 * formatting would render them one day early in timezones west of UTC.
 */
function formatChangelogDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

// Compact brand monograms for the icon-only share row. Deliberately text
// monograms (not vendored brand SVG paths) — self-contained, dependency-free,
// and carrying no coordinate literals. Each link's aria-label names the network
// for assistive tech; the monogram is the compact visual affordance.
const SHARE_MONOGRAM: Record<ShareNetwork, string> = {
  facebook: "f",
  x: "X",
  pinterest: "P",
  linkedin: "in",
  telegram: "TG",
};

function ShareGlyph({ network }: { network: ShareNetwork }) {
  return (
    <span
      aria-hidden="true"
      className="flex size-8 items-center justify-center rounded-full border border-line text-xs font-semibold"
    >
      {SHARE_MONOGRAM[network]}
    </span>
  );
}

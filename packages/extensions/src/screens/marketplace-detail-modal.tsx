"use client";

// ---------------------------------------------------------------------------
// MarketplaceDetailModal — the in-app extension-detail modal.
//
// Clicking "More details" on a browse card opens this dialog instead of
// navigating. Its body embeds the marketplace listing detail (hero + Details /
// Reviews tabs + share row) stripped of storefront chrome; the footer carries
// the per-instance install CTA (the six visual states of the design spec §IV,
// assembled from the existing pieces). The marketplace detail is fetched
// on-demand via an admin-gated server action (the marketplace MCP client stays
// server-only), projected into the client-safe MarketplaceDetailView.
//
// The full-page detail route is intentionally KEPT — it remains the deep-link
// target of the agent/instance page header and the registry catalog. This modal
// is the browse-card "More details" experience only.
// ---------------------------------------------------------------------------

import { useCallback, useState } from "react";
import Link from "next/link";
import { XIcon, Star, BadgeCheck, Loader2 } from "lucide-react";

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
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { extensionKindEmblem } from "@/components/extension-kind-emblem";
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
}

export function MarketplaceDetailModal({
  card,
  cta,
  installAction,
  updateAction,
  restoreAction,
}: MarketplaceDetailModalProps) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<LoadStatus>("idle");
  const [detail, setDetail] = useState<MarketplaceDetailView | null>(null);

  const load = useCallback(async () => {
    setStatus("loading");
    try {
      const result = await getPublicMarketplaceDetailAction(card.packageName);
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
  }, [card.packageName]);

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
          "top-20 flex max-h-[calc(100vh-6rem)] w-[calc(100%-2rem)] max-w-3xl translate-y-0 flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl",
          "bg-surface-strong",
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
  const iconUrl = detail.iconUrl ?? card.iconUrl ?? card.vendorLogoUrl ?? null;
  const reviewCount = detail.reviews.length;
  const shareLinks = buildShareLinks(detail.permalink);

  return (
    <div className="flex flex-col gap-6">
      {/* Hero: icon tile + title + "{Type} by {Vendor}" + cost. */}
      <div className="flex items-start gap-4">
        <div className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-card border border-line bg-surface-muted">
          {iconUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- sanitized hosted raster URL from the marketplace card model.
            <img src={iconUrl} alt="" className="size-full object-cover" />
          ) : (
            extensionKindEmblem(card.kindSlug, "size-7 text-muted-foreground")
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-lg leading-tight font-semibold text-foreground">{detail.displayName}</h2>
          <p className="text-sm text-muted-foreground">
            {detail.kindLabel}
            {detail.vendor ? (
              <>
                {" by "}
                {detail.vendor.storeUrl ? (
                  <Link
                    href={detail.vendor.storeUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-foreground underline underline-offset-2 hover:text-primary"
                  >
                    {detail.vendor.name || detail.vendor.slug}
                  </Link>
                ) : (
                  <span className="font-medium text-foreground">
                    {detail.vendor.name || detail.vendor.slug}
                  </span>
                )}
              </>
            ) : null}
          </p>
          {detail.cost && (
            <span className="mt-0.5 w-fit">
              <Badge variant="outline">{detail.cost}</Badge>
            </span>
          )}
        </div>
      </div>

      <Tabs defaultValue="details" className="gap-4">
        <TabsList>
          <TabsTrigger value="details">Details</TabsTrigger>
          <TabsTrigger value="reviews">
            Reviews{reviewCount > 0 ? ` (${reviewCount})` : ""}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="details">
          <DetailsTab detail={detail} />
        </TabsContent>
        <TabsContent value="reviews">
          <ReviewsTab detail={detail} />
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
      </dl>
    </div>
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

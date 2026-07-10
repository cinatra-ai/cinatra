"use client";

// ---------------------------------------------------------------------------
// MarketplaceDetailModal — the in-app extension-detail modal.
//
// Clicking "More details" on a browse card opens this dialog instead of
// navigating. Its body embeds the marketplace listing detail (the plain §V
// light-panel hero + Details / Reviews / Changelog tabs + share row, per
// design spec §V — the drawing has NO banner or coloured ground anywhere in
// the modal) stripped of storefront chrome; the footer carries the
// per-instance install CTA (the six visual states of the design spec §IV,
// assembled from the existing pieces). The marketplace detail is fetched
// on-demand via an admin-gated server action (the marketplace MCP client
// stays server-only), projected into the client-safe MarketplaceDetailView.
//
// The full-page detail route is intentionally KEPT — it remains the deep-link
// target of the agent/instance page header and the registry catalog. This modal
// is the browse-card "More details" experience only.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { XIcon, Star, Check, FileX, Loader2 } from "lucide-react";

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
import { Button, buttonVariants } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import {
  extensionKindEmblem,
  type ExtensionEmblemKind,
} from "@/components/extension-kind-emblem";
import { ACCENT_PALETTE, deriveExtensionAccent } from "@/lib/extension-accent";
import { deriveExtensionCompatState } from "@/lib/extension-compat-badge";
import {
  MarketplaceReadmeMarkdownBody,
  hasRenderableReadmeMarkdown,
} from "@/components/marketplace-readme-section";
import { shareNetworkGlyph } from "@/components/svg-icons/share-network-icons";
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
} from "@/lib/marketplace-detail-view";
import { getPublicMarketplaceDetailAction } from "@/lib/marketplace-detail-actions";
import { isRedirectError } from "./is-redirect-error";
import { MarketplaceInstallForm, MarketplaceInstallSubmit } from "./marketplace-install-form";
import {
  buildMarketplaceFailureCopy,
  marketplaceFailureCopy,
} from "./marketplace-failure-copy";
import type { MarketplaceCardData, MarketplaceCardCta } from "./marketplace-card-model";
import type { MarketplaceInstallActionResult } from "./marketplace-failure-copy";

type BoundLifecycleAction = () => Promise<MarketplaceInstallActionResult | void>;

type LoadStatus = "idle" | "loading" | "loaded" | "notfound" | "error";

/**
 * Fixture/test seam (cinatra#948): a pinned load state so the static
 * `/design-fixtures` render (no DB, no session) can show the loaded and
 * `notfound` bodies without driving the admin-gated server action. When set,
 * the modal NEVER fetches — the pinned state is the state.
 */
export type MarketplaceDetailModalInitialLoad =
  | { status: "loaded"; detail: MarketplaceDetailView }
  | { status: "notfound" }
  | { status: "error" };

export interface MarketplaceDetailModalProps {
  card: MarketplaceCardData;
  /**
   * The card's install-lifecycle CTA. Optional (cinatra#948 reopen,
   * 2026-07-05): the Marketplace browse card passes it and the footer renders
   * its 6-state install CTA; the §VI Installed-extensions modal is
   * DETAILS-ONLY and passes NONE of the footer props, so the footer bar is not
   * rendered at all (owner ruling: an installed extension's modal shows no
   * install/uninstall/manage buttons and no footer info). The footer renders
   * only when the full CTA + lifecycle actions are all provided. The six-state
   * CTA already encodes registry state in `disabled` and folds the ABI verdict
   * into "incompatible" (#1003).
   */
  cta?: MarketplaceCardCta;
  installAction?: BoundLifecycleAction;
  updateAction?: BoundLifecycleAction;
  restoreAction?: BoundLifecycleAction;
  /**
   * Detail loader override — defaults to the admin-gated marketplace server
   * action. Injectable so the /design-fixtures harness can seed a
   * deterministic MarketplaceDetailView without a storefront round-trip;
   * production callers never pass it.
   */
  loadDetail?: (packageName: string) => Promise<MarketplaceDetailLoadResult>;
  /**
   * Entry-point trigger override (cinatra#948): the Installed extensions page
   * renders the §VI link-style "More details"; the browse card keeps the
   * default §IV centred underlined-link button when this is not passed. Must be
   * a single element (Radix `asChild`).
   */
  trigger?: ReactElement;
  /** See {@link MarketplaceDetailModalInitialLoad}. */
  initialLoad?: MarketplaceDetailModalInitialLoad;
  /**
   * Installed-page (§VI) "More details" affordance: a real `<a>` element (the
   * published §VI drawing renders More details as `<a class="btn link">`, never
   * a button). When set, the modal renders this anchor as its opener instead of
   * the browse card's `<DialogTrigger>` button — `variant:"link"` for an active
   * row (underlined indigo link), `variant:"ghost"` for an archived row (muted
   * ghost text). The `href` is the package's marketplace-detail path, a
   * progressive-enhancement fallback: JS intercepts the click to open the modal
   * IN PLACE (no navigation); without JS the anchor still resolves to a real
   * page. The browse card omits this and keeps its `<DialogTrigger>` button.
   */
  linkTrigger?: { variant: "link" | "ghost"; href: string };
  /**
   * Controlled open state (cinatra#1121). Optional: when provided the modal is
   * externally controlled — the /agents All-Agents card lifts `open` so the SAME
   * modal instance is opened by TWO sibling hit-areas (the coloured accent panel
   * AND the "More details" link) that live in far-apart card subtrees and so
   * cannot share one Radix Dialog context. Omitted by the marketplace browse
   * cards and the §VI installed-extensions cards, which stay uncontrolled with
   * byte-identical behaviour.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function MarketplaceDetailModal({
  card,
  cta,
  installAction,
  updateAction,
  restoreAction,
  loadDetail = getPublicMarketplaceDetailAction,
  trigger,
  initialLoad,
  linkTrigger,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
}: MarketplaceDetailModalProps) {
  // cinatra#1121 — opt-in controlled open. When `controlledOpen` is passed the
  // Dialog is externally controlled and the lifted setter is the single source
  // of truth for both hit-areas; otherwise the modal owns its own open state
  // exactly as before.
  const isControlled = controlledOpen !== undefined;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = isControlled ? controlledOpen : uncontrolledOpen;
  const [status, setStatus] = useState<LoadStatus>(initialLoad?.status ?? "idle");
  const [detail, setDetail] = useState<MarketplaceDetailView | null>(
    initialLoad?.status === "loaded" ? initialLoad.detail : null,
  );

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
    } catch (error) {
      // Auth redirect sentinel (the detail action is admin-gated; the
      // Installed page is session-gated, cinatra#948) — re-throw so Next.js
      // navigates to /not-authorized instead of masking authorization as a
      // retryable "Couldn't load details".
      if (isRedirectError(error)) throw error;
      // A server-action rejection is masked in production — never crash the
      // browse route; render the retryable error state instead.
      setStatus("error");
    }
  }, [card.packageName, loadDetail]);

  // A pinned fixture state never fetches (there is no session/DB behind the
  // static fixtures route; the admin-gated action would redirect).
  const pinned = initialLoad != null;

  const onOpenChange = useCallback(
    (next: boolean) => {
      if (isControlled) {
        controlledOnOpenChange?.(next);
      } else {
        setUncontrolledOpen(next);
      }
      // Uncontrolled callers fetch on first open here (and never again once
      // loaded — reviews/specs are a point-in-time read; retry re-drives load()
      // from the error state). Controlled callers open via a lifted setter that
      // never reaches this Radix handler, so their fetch is driven by the effect
      // below instead.
      if (!isControlled && next && !pinned && status !== "loaded" && status !== "loading") {
        void load();
      }
    },
    [isControlled, controlledOnOpenChange, pinned, status, load],
  );

  // Controlled mode only (cinatra#1121): an external open (the accent panel or
  // the "More details" link, both setting the lifted `open`) bypasses Radix's
  // onOpenChange, so the lazy detail fetch is driven off the open transition
  // here. `prevOpen` fires load exactly once per open — it never re-fires when a
  // notfound/error status change re-runs this effect while the modal stays open.
  const prevOpen = useRef(false);
  useEffect(() => {
    if (!isControlled) return;
    if (open && !prevOpen.current && !pinned && status !== "loaded" && status !== "loading") {
      void load();
    }
    prevOpen.current = open;
  }, [isControlled, open, pinned, status, load]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {linkTrigger ? (
        // §VI Installed-page opener: a real anchor — Next <Link> renders an
        // <a> in the DOM (never a <button>), link-styled via buttonVariants
        // per the §VI drawing (owner ruling 2026-07-05: "More details" is a
        // link, never a button). Rendered OUTSIDE <DialogTrigger> so the
        // controlled Dialog opens via onOpenChange while the click's default
        // navigation is suppressed (the href is only the no-JS fallback).
        <Link
          href={linkTrigger.href}
          data-slot="installed-more-details"
          aria-haspopup="dialog"
          className={cn(
            buttonVariants({ variant: linkTrigger.variant, size: "sm" }),
            linkTrigger.variant === "link"
              ? "underline underline-offset-3"
              : "text-muted-foreground",
          )}
          onClick={(event) => {
            event.preventDefault();
            onOpenChange(true);
          }}
        >
          More details
        </Link>
      ) : (
        <DialogTrigger asChild>
          {trigger ?? (
            // §IV browse-card default: centred underlined link button (design
            // spec §IV "More details") — always underlined in the action
            // colour, not just on hover. Still a real button (modal trigger),
            // only the visual treatment is a link.
            <Button size="sm" variant="link" className="underline">
              More details
            </Button>
          )}
        </DialogTrigger>
      )}
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
          // §V chrome: 720px wide, radius 12, on the page surface
          // (`--paper`/background), not the white `surface-strong` card level.
          "top-20 flex max-h-[calc(100vh-6rem)] w-[calc(100%-2rem)] max-w-[720px] translate-y-0 flex-col gap-0 overflow-hidden rounded-[12px] p-0 sm:max-w-[720px]",
          "bg-background",
        )}
      >
        <DialogTitle className="sr-only">{card.displayName}</DialogTitle>

        {/* Slim header — close only (§V: a 28px muted ✕ hit target). */}
        <div className="flex shrink-0 items-center justify-end border-b border-line px-4 py-3">
          <DialogClose
            // §V close ✕: rests at the full `--muted` tone (the drawing has no
            // dimmed-at-rest treatment); hover lifts to ink. focus-VISIBLE ring
            // only — Radix autofocuses the close on open, and a `focus:` ring
            // would paint chrome the drawing does not have on every open.
            className="grid size-7 place-items-center rounded-[7px] text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus:outline-hidden"
            aria-label="Close"
          >
            <XIcon className="size-4" />
          </DialogClose>
        </div>

        {/* Body — vertical scroll only (§V: 24px/26px padding). */}
        <div className="flex-1 overflow-x-hidden overflow-y-auto px-6.5 py-6">
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
              // A pinned fixture error state has nothing to retry against.
              onRetry={pinned ? undefined : () => void load()}
            />
          ) : detail ? (
            <ModalBody card={card} detail={detail} />
          ) : null}
        </div>

        {/* Footer — the six-state install CTA, right-aligned per the §V
            drawing (hairline separator, 15px/26px padding). Rendered ONLY for
            the Marketplace browse card (all four footer props supplied). The
            §VI Installed-extensions modal supplies none of them, so the footer
            bar is omitted entirely: an installed extension's "More details" is
            details-only, with no install/uninstall/manage buttons and no
            footer info (owner ruling, 2026-07-05). */}
        {cta != null &&
        installAction != null &&
        updateAction != null &&
        restoreAction != null ? (
          <div className="flex shrink-0 items-center justify-end border-t border-line px-6.5 py-3.75">
            <ModalFooterCta
              card={card}
              cta={cta}
              installAction={installAction}
              updateAction={updateAction}
              restoreAction={restoreAction}
            />
          </div>
        ) : null}
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
  // §V: the tab count is the extension's TOTAL review count (the drawing
  // shows "Reviews (128)" over a sample of rows) — the same source as the
  // "{n} reviews for {name}" heading, never the fetched-row count.
  const reviewCount = detail.ratingSummary.total;
  const shareLinks = buildShareLinks(detail.permalink);

  return (
    <div className="flex flex-col gap-5">
      <ModalHero card={card} detail={detail} iconUrl={iconUrl} />

      <Tabs defaultValue="details" className="gap-5.5">
        {/* §V tab row: the three tabs beside the etched paired-line rule that
            fills the remaining width (grid auto/1fr, rule at the baseline). */}
        <div className="grid grid-cols-[auto_1fr] items-end gap-4.5">
          <TabsList className="gap-0 border-0">
            <TabsTrigger value="details" className={MODAL_TAB_CLASS}>
              Details
            </TabsTrigger>
            <TabsTrigger value="reviews" className={MODAL_TAB_CLASS}>
              {`Reviews (${reviewCount})`}
            </TabsTrigger>
            <TabsTrigger value="changelog" className={MODAL_TAB_CLASS}>
              Changelog
            </TabsTrigger>
          </TabsList>
          <Separator major decorative className="mb-2.75" />
        </div>

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
        <div className="mt-1.5 flex items-center justify-center gap-3.5 border-t border-line pt-5.5">
          <span className="text-xs font-semibold text-muted-foreground">Share:</span>
          {shareLinks.map((link) => (
            <Link
              key={link.network}
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={link.label}
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              {shareNetworkGlyph(link.network)}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * §V tab anatomy: 13px labels with 14px horizontal / 9px-11px vertical
 * padding, inactive muted at regular weight, the active tab semibold with the
 * shared 2px primary underline (from the base TabsTrigger).
 */
const MODAL_TAB_CLASS =
  "px-3.5 pt-2.25 pb-2.75 font-normal data-[state=active]:font-semibold";

/**
 * The modal hero: icon tile + title + "{Type} by {Vendor}" + right-aligned
 * price (§V header tokens), rendered directly on the dialog's paper. The §V
 * drawing shows NO banner, scrim, or coloured ground anywhere in the modal —
 * the hero is exactly this light panel (the hosted-banner idea came from a
 * wrong reopen premise on #739 and is not in the spec; `bannerUrl` stays an
 * unused wire field until the design ever specs a banner surface).
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
  const accent = deriveExtensionAccent(card.packageName);
  const { bg } = ACCENT_PALETTE[accent];

  return (
    // 0.5.0 §II hero row: 18px gap, the name + byline block CENTRED vertically
    // against the square logo; the price stays pinned to the top (self-start).
    <div data-slot="marketplace-modal-hero" className="flex items-center gap-4.5">
      {/* §V logo tile: 64×64, radius 15, white surface, hairline + soft
          shadow, the 34px kind emblem in the extension's stable accent. */}
      <div
        data-slot="marketplace-modal-tile"
        className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-[15px] border border-line bg-surface-strong shadow-sm"
        style={iconUrl ? undefined : { color: bg }}
      >
        {iconUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- sanitized hosted raster URL from the marketplace card model.
          <img src={iconUrl} alt="" className="size-full object-cover" />
        ) : (
          extensionKindEmblem(card.kindSlug, "size-8.5")
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {/* §V title: Archivo (display) italic 800 23px ink — the named
            `text-modal-title` token (globals.css @theme). Prefer the
            caller-supplied human-readable name (the Installed page hydrates it
            from the per-kind manifest displayName); the fetched storefront
            title is the fallback. Never the raw package slug (owner ruling:
            the modal shows the human name, not the package name). */}
        {/* data-slot: conformance stable-id contract (cinatra#986) — the name
            field binds the manifest displayName, never the package slug. */}
        <h2
          data-slot="marketplace-modal-name"
          className="font-display text-modal-title font-extrabold italic text-foreground"
        >
          {card.displayName || detail.displayName}
        </h2>
        {/* §V byline: 14px kind emblem in the accent, "{Type}" in ink, the
            vendor as a semibold primary link (no underline at rest) out to
            its marketplace store. */}
        <p className="flex items-center gap-1.25 text-sm text-muted-foreground">
          <span aria-hidden="true" className="shrink-0" style={{ color: bg }}>
            {extensionKindEmblem(card.kindSlug, "size-3.5")}
          </span>
          <span className="min-w-0 truncate">
            {/* data-slot: conformance stable-id contract (cinatra#986) — §V
                byline kind label (per-kind state variant assertions). */}
            <span data-slot="marketplace-modal-kind" className="text-foreground">
              {detail.kindLabel}
            </span>
            {detail.vendor ? (
              <>
                {" by "}
                {detail.vendor.storeUrl ? (
                  <Link
                    href={detail.vendor.storeUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-semibold text-primary hover:underline hover:underline-offset-2"
                  >
                    {detail.vendor.name || detail.vendor.slug}
                  </Link>
                ) : (
                  <span className="font-semibold text-foreground">
                    {detail.vendor.name || detail.vendor.slug}
                  </span>
                )}
              </>
            ) : null}
          </span>
        </p>
      </div>
      {/* 0.5.0 §II price: pinned to the TOP of the centred header (self-start +
          4px top pad) even though the name/byline block centres against the logo. */}
      {detail.cost && (
        <div className="shrink-0 self-start pt-1 text-sm font-bold text-foreground">
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
  const lastUpdated = formatRelativeDate(detail.freshnessAt);

  return (
    <div className="flex flex-col gap-7.5 md:flex-row md:items-start">
      {/* §V README column: the README rendered BARE on the dialog's paper —
          no panel, no "Description" section heading (the README's own
          headings lead). */}
      <div className="min-w-0 flex-1">
        {hasReadme ? (
          <MarketplaceReadmeMarkdownBody markdown={detail.readmeMarkdown} />
        ) : fallbackText ? (
          <p className="text-sm leading-relaxed whitespace-pre-line text-muted-foreground">
            {fallbackText}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">No description provided.</p>
        )}
      </div>
      {/* §V specs column: a bordered `--surface` panel, hairline-divided rows
          of bold ink labels over mono muted values, closing with the
          Dependencies list when the extension declares any. */}
      <dl className="w-full shrink-0 self-start rounded-[8px] border border-line bg-surface px-3.5 py-1 md:w-[210px]">
        <SpecRow label="Version" value={detail.latestVersion ?? "—"} divider />
        <SpecRow label="Last updated" value={lastUpdated ?? "—"} divider />
        {/* §V: "Compatible up to" is a PLAIN specs row — bold ink label over
            a mono muted "Cinatra v{version}" value, identical anatomy to
            every other row. No badge chrome anywhere in the specs column. */}
        <SpecRow
          label="Compatible up to"
          value={detail.compatibleUpTo ? `Cinatra v${detail.compatibleUpTo}` : "—"}
          divider
        />
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
      className="mt-1 border-t border-line pt-3.5 pb-0.5"
    >
      <dt className="text-sm font-bold text-foreground">Dependencies</dt>
      <dd>
        <ul className="mt-2.25 flex flex-col gap-2.25">
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
        <FileX className="size-7.5 text-muted-foreground opacity-60" aria-hidden="true" />
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
  const date = formatRelativeDate(entry.date);
  return (
    // Dividers go BETWEEN entries — the last entry drops its bottom border.
    <section className={cn("py-4", !isLast && "border-b border-line")}>
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="rounded-[6px] bg-surface-muted px-2.25 py-0.5 font-mono text-sm font-bold text-foreground">
          {entry.version}
        </span>
        {date && <span className="font-mono text-badge-xs text-muted-foreground">{date}</span>}
        {isLatest && (
          <span className="rounded-[5px] border border-success px-1.5 py-px font-mono text-badge-2xs font-bold text-success uppercase">
            Latest
          </span>
        )}
      </div>
      {entry.notes.length > 0 && (
        <ul className="mt-2.25 list-disc space-y-1 pl-4.5">
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

/**
 * One §V specs-panel row: bold ink label over a mono muted value, 11px
 * vertical padding, a hairline divider between rows (`divider`) — the last
 * row before Dependencies drops it.
 */
function SpecRow({ label, value, divider }: { label: string; value: string; divider?: boolean }) {
  return (
    <div className={cn("py-2.75", divider && "border-b border-line")}>
      <dt className="text-sm font-bold text-foreground">{label}</dt>
      {/* §V: 3px between label and value. */}
      <dd className="mt-0.75 font-mono text-xs text-muted-foreground">{value}</dd>
    </div>
  );
}

function ReviewsTab({ detail }: { detail: MarketplaceDetailView }) {
  const { reviews, ratingSummary } = detail;
  const bars = ratingBars(ratingSummary);
  const total = ratingSummary.total;

  return (
    <div className="flex flex-col gap-7.5 md:flex-row md:items-start">
      <div className="min-w-0 flex-1">
        {/* §V reviews heading: "{n} reviews for {name}", 16px bold ink, 4px
            below before the first review row. */}
        <h3 className="mb-1 text-base font-bold text-foreground">
          {total} {total === 1 ? "review" : "reviews"} for {detail.displayName}
        </h3>
        {reviews.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">No reviews yet.</p>
        ) : (
          <ul>
            {reviews.map((review, i) => (
              <ReviewItem key={i} review={review} isLast={i === reviews.length - 1} />
            ))}
          </ul>
        )}
      </div>
      {/* §V rating summary: italic-800 average beside the star row, then the
          5→1 histogram (amber fills on the muted track). */}
      <div className="w-full shrink-0 md:w-[210px]">
        <h3 className="mb-3.5 text-base font-bold text-foreground">Rating summary</h3>
        <div className="flex items-center gap-4">
          {/* §V average numeral: Archivo italic 800 40px ink at line-height 1
              — the named `text-rating-average` token (globals.css @theme). */}
          <span className="font-display text-rating-average font-extrabold italic text-foreground">
            {ratingSummary.average.toFixed(1)}
          </span>
          <span>
            <AverageStarRow average={ratingSummary.average} />
            <span className="mt-1.5 block font-mono text-xs text-muted-foreground">
              {total} {total === 1 ? "review" : "reviews"}
            </span>
          </span>
        </div>
        <div className="mt-4">
          {bars.map((bar) => (
            <div key={bar.star} className="flex items-center gap-2.5 py-0.75">
              <StarRow filled={bar.star} size="size-2.5" />
              <span className="h-1.75 flex-1 overflow-hidden rounded-sm bg-surface-muted">
                <span
                  className="block h-full rounded-sm bg-rating-star"
                  style={{ width: `${bar.pct}%` }}
                />
              </span>
              <span className="w-7 shrink-0 text-right font-mono text-badge-xs text-muted-foreground">
                {bar.count}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ReviewItem({ review, isLast }: { review: MarketplaceDetailReview; isLast: boolean }) {
  // The author's stable accent colours the avatar disc — the same accent
  // system the extension tiles use, seeded from the author string.
  const { bg, fg } = ACCENT_PALETTE[deriveExtensionAccent(review.author)];
  return (
    <li className={cn("flex gap-3.25 py-3.75", !isLast && "border-b border-line")}>
      <span
        aria-hidden="true"
        className="flex size-9.5 shrink-0 items-center justify-center rounded-full font-display text-sm font-extrabold italic"
        style={{ background: bg, color: fg }}
      >
        {reviewInitials(review.author)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-sm font-bold text-foreground">{review.author}</span>
          {review.verifiedOwner && (
            <span className="inline-flex items-center gap-1 font-mono text-badge-2xs uppercase text-success">
              <Check className="size-3" aria-hidden="true" strokeWidth={2.6} />
              verified owner
            </span>
          )}
          {review.date && (
            <span className="font-mono text-badge-xs text-muted-foreground">
              {formatRelativeDate(review.date)}
            </span>
          )}
        </div>
        <StarRow filled={review.rating} className="mt-1.25" size="size-3" />
        {/* Tag-stripped review text — rendered as escaped text, never HTML. */}
        {review.text && (
          <p className="mt-1.5 text-sm leading-relaxed whitespace-pre-line text-muted-foreground">
            {review.text}
          </p>
        )}
      </div>
    </li>
  );
}

/**
 * §V rating-summary average stars — a fractional amber fill over the muted
 * base row (the drawing overlays the filled stars clipped to `average/5`,
 * e.g. a 4.7 average fills 94%), never a rounded whole-star count.
 */
function AverageStarRow({ average }: { average: number }) {
  const pct = Math.max(0, Math.min(100, (average / 5) * 100));
  return (
    <span
      className="relative inline-flex"
      aria-label={`Rated ${average.toFixed(1)} out of 5`}
    >
      {/* §V star rows sit at a 1px gap. */}
      <span aria-hidden="true" className="flex w-max items-center gap-px">
        {[1, 2, 3, 4, 5].map((i) => (
          <Star key={i} className="size-3.75 fill-current text-rating-star-muted" />
        ))}
      </span>
      <span
        aria-hidden="true"
        className="absolute top-0 left-0 h-full overflow-hidden"
        style={{ width: `${pct}%` }}
      >
        <span className="flex w-max items-center gap-px">
          {[1, 2, 3, 4, 5].map((i) => (
            <Star key={i} className="size-3.75 fill-current text-rating-star" />
          ))}
        </span>
      </span>
    </span>
  );
}

/** §V star row — amber filled stars on the warm-grey empty tone. */
function StarRow({
  filled,
  className,
  size = "size-3.5",
}: {
  filled: number;
  className?: string;
  size?: string;
}) {
  const n = Math.max(0, Math.min(5, Math.round(filled)));
  return (
    <span
      // §V star rows sit at a 1px gap.
      className={cn("inline-flex items-center gap-px", className)}
      aria-label={`Rated ${n} out of 5`}
    >
      {[1, 2, 3, 4, 5].map((i) => (
        <Star
          key={i}
          // Plain concat, not cn(): `text-rating-star*` are custom color
          // tokens the app tailwind-merge would dedupe unpredictably.
          className={size + " fill-current " + (i <= n ? "text-rating-star" : "text-rating-star-muted")}
          aria-hidden="true"
        />
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

  // §V footer drawing: the CTA sits right-aligned at its natural width; the
  // incompatible state keeps the "Install now" label greyed to 40% with the
  // reason in its tooltip (the button itself never relabels).
  if (state.kind === "incompatible") {
    return (
      <Button size="sm" disabled className="disabled:opacity-40" title="Requires a newer Cinatra version">
        Install now
      </Button>
    );
  }

  if (state.kind === "installed") {
    return (
      // §V "Installed" state: the secondary pill at 90% — a settled state,
      // not the 50% disabled dimming.
      <Button size="sm" variant="secondary" disabled className="disabled:opacity-90">
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
      >
        <MarketplaceInstallSubmit variant="outline" pendingLabel="Restoring…">
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
        title={`Connect the package registry to ${isUpdate ? "update" : "install"}`}
      >
        {isUpdate ? "Update now" : "Install now"}
      </Button>
    );
  }
  const op = isUpdate ? "update" : "install";
  return (
    <MarketplaceInstallForm
      action={isUpdate ? updateAction : installAction}
      failureCopyByCategory={buildMarketplaceFailureCopy(op, card.displayName)}
      defaultFailureMessage={marketplaceFailureCopy("unrecoverable", op, card.displayName)}
    >
      <MarketplaceInstallSubmit pendingLabel={isUpdate ? "Updating…" : "Installing…"}>
        {isUpdate ? "Update now" : "Install now"}
      </MarketplaceInstallSubmit>
    </MarketplaceInstallForm>
  );
}

/**
 * Relative date ("1 week ago") for the §V meta stamps — the drawing renders
 * every date (specs "Last updated", changelog releases, review stamps)
 * relative, matching the browse cards' "Updated N ago" freshness convention.
 * Future/invalid/absent stamps → null (no stamp beats a misleading one).
 */
function formatRelativeDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()) || d.getTime() > Date.now()) return null;
  return formatDistanceToNow(d, { addSuffix: true });
}

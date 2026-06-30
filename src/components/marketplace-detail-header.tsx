import Link from "next/link";
import { format, formatDistanceToNow } from "date-fns";

import { Button } from "@/components/ui/button";
import { PageHeaderRule } from "@/components/page-header-rule";
import { PageHeaderTitleSync } from "@/components/page-header-title-sync";
import {
  ACCENT_PALETTE,
  deriveExtensionAccent,
} from "@/lib/extension-accent";
import {
  extensionKindEmblem,
  type ExtensionEmblemKind,
} from "@/components/extension-kind-emblem";
import { ExtensionCompatBadge } from "@/components/extension-compat-badge";

// ---------------------------------------------------------------------------
// MarketplaceDetailHeader — the in-app mirror of the public marketplace
// single-extension hero: a coloured kind panel carrying the kind emblem (white
// pill), the commerce/license badge, and the extension name as the page <h1>;
// beneath it the freshness ("Updated N ago") + version meta line the public
// page renders in its summary column. Rendered purely from the marketplace
// `ExtensionDetail` payload the detail route already fetches — never from a
// Verdaccio read.
// ---------------------------------------------------------------------------

export interface MarketplaceDetailBadge {
  text: "Open source" | "Free";
  /** SPDX id when the listing is open source, else null. */
  license: string | null;
}

/**
 * Commerce/license badge decision, mirroring the public storefront badge:
 * a non-empty SPDX `license` → "Open source" (license id surfaced via the
 * title attribute), else "Free".
 *
 * The storefront badge has a third "price" variant, but the public detail
 * payload (`ExtensionDetail`) carries no price field today, so a price
 * affordance is never rendered in-app. If the wire model ever grows a price,
 * extend this helper rather than adding commerce UI ad hoc — in-app
 * Install/Uninstall/Update remains the only acquisition flow.
 */
export function resolveMarketplaceDetailBadge(
  license: string | null | undefined,
): MarketplaceDetailBadge {
  const spdx = license?.trim() ?? "";
  if (spdx !== "") {
    return { text: "Open source", license: spdx };
  }
  return { text: "Free", license: null };
}

/**
 * The honest freshness timestamp for the detail meta line — the release date
 * of the CURRENTLY LISTED version, taken from the marketplace
 * `versionHistory`. Mirrors the public page's strictness: no entry for the
 * listed version, an unparseable date, or a future stamp all yield `null`
 * (no freshness line) rather than a misleading "Updated just now".
 */
export function resolveDetailFreshnessAt(detail: {
  latestVersion: string | null;
  versionHistory: Array<{ version: string; releasedAt: string }>;
}): string | null {
  if (!detail.latestVersion) {
    return null;
  }
  const entry = detail.versionHistory.find(
    (v) => v.version === detail.latestVersion,
  );
  const raw = entry?.releasedAt?.trim();
  if (!raw) {
    return null;
  }
  const releasedAt = new Date(raw);
  if (Number.isNaN(releasedAt.getTime()) || releasedAt.getTime() > Date.now()) {
    return null;
  }
  return releasedAt.toISOString();
}

export function MarketplaceDetailHeader({
  packageName,
  name,
  kind,
  license,
  version,
  freshnessAt,
  sdkAbiRange,
}: {
  /** Scoped npm name — seeds the stable accent, like the browse cards. */
  packageName: string;
  /** Display name — the page <h1> and the breadcrumb leaf title. */
  name: string;
  kind: ExtensionEmblemKind;
  /** SPDX id from `ExtensionDetail.license`, or null. */
  license: string | null;
  /** Listed version from `ExtensionDetail.latestVersion`, or null. */
  version: string | null;
  /** Honest ISO-8601 freshness stamp (see resolveDetailFreshnessAt), or null. */
  freshnessAt: string | null;
  /**
   * Declared host/SDK ABI range from the marketplace detail payload, or null.
   * Drives the in-instance 3-state compatibility badge (absent → neutral
   * "Unknown", never green). Optional so legacy callers stay valid.
   */
  sdkAbiRange?: string | null;
}) {
  const accent = deriveExtensionAccent(packageName);
  const { bg, fg } = ACCENT_PALETTE[accent];
  const badge = resolveMarketplaceDetailBadge(license);
  const freshnessDate = freshnessAt ? new Date(freshnessAt) : null;
  const freshness =
    freshnessDate && !Number.isNaN(freshnessDate.getTime())
      ? `Updated ${formatDistanceToNow(freshnessDate, { addSuffix: true })}`
      : null;

  return (
    <header
      data-slot="marketplace-detail-header"
      className="mx-auto mb-6 w-full max-w-7xl px-5 sm:px-8 lg:px-0"
    >
      <div className="flex items-center justify-between gap-4">
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-muted-foreground">
          Marketplace
        </p>
        <Button asChild variant="outline" size="sm">
          <Link href="/configuration/marketplace">Back to marketplace</Link>
        </Button>
      </div>
      <section
        data-slot="marketplace-detail-hero"
        data-accent={accent}
        className="mt-4 flex min-h-[150px] flex-col justify-between gap-6 overflow-hidden rounded-card border border-line p-6"
        style={{ background: bg, color: fg }}
      >
        <div className="flex items-start justify-between gap-3">
          {/* Kind emblem — white pill on the coloured ground, like the cards. */}
          <span
            className="inline-grid h-[42px] w-[42px] shrink-0 place-items-center rounded-full bg-surface-strong shadow-sm"
            style={{ color: bg }}
          >
            {extensionKindEmblem(kind)}
          </span>
          <span
            data-slot="marketplace-detail-badge"
            title={badge.license ?? undefined}
            className="inline-flex shrink-0 items-center rounded-full bg-surface-strong px-2.5 py-0.5 text-[9.5px] font-bold uppercase tracking-[0.14em] text-foreground shadow-sm"
          >
            {badge.text}
          </span>
        </div>
        <h1 className="font-display text-[30px] font-extrabold italic leading-[1.05] tracking-[-0.018em] text-balance">
          {name}
        </h1>
      </section>
      <div
        data-slot="marketplace-detail-meta"
        className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-muted-foreground"
      >
        {/* 3-state in-instance ABI compatibility verdict, derived locally from
            the listing's declared sdkAbiRange (absent → neutral "Unknown",
            never green). Always rendered — "Unknown" is itself informative. */}
        <ExtensionCompatBadge sdkAbiRange={sdkAbiRange} />
        {freshness && freshnessDate && (
          <time
            dateTime={freshnessDate.toISOString()}
            title={format(freshnessDate, "PPP")}
          >
            {freshness}
          </time>
        )}
        {version && <span>Version {version}</span>}
        {badge.license && <span>{badge.license} license</span>}
      </div>
      <PageHeaderRule />
      <PageHeaderTitleSync title={name} />
    </header>
  );
}

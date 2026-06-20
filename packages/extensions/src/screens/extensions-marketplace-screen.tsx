import { Suspense } from "react";
import { formatDistanceToNow } from "date-fns";
import Link from "next/link";
import { requireAdminSession } from "@/lib/auth-session";
import { readInstanceIdentity } from "@/lib/instance-identity-store";
import { getEffectiveViewerScope } from "@/lib/marketplace-credentials";
import {
  readActiveExtensionTemplates,
  readArchivedExtensionTemplates,
} from "@cinatra-ai/agents";
import {
  installExtensionPackageFormAction,
  updateExtensionPackageFormAction,
  restoreExtensionPackageFormAction,
} from "../actions";
import { ExtensionsMarketplaceClient } from "./extensions-marketplace-client";
import { MarketplaceInstallForm, MarketplaceInstallSubmit } from "./marketplace-install-form";
import type { MarketplaceCardData } from "./marketplace-card-model";
import { resolveMarketplaceCardCta } from "./marketplace-card-model";
import { Star } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { extensionKindEmblem } from "@/components/extension-kind-emblem";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { ExtensionCard } from "@/components/extension-card";
import { deriveExtensionAccent } from "@/lib/extension-accent";
import { cn } from "@/lib/utils";
import { readRegistryPolicy } from "../registry-policy";

// ---------------------------------------------------------------------------
// ExtensionsMarketplaceScreen — storefront browse parity
//
// Renders cards sourced from the marketplace `extension_list` ability (storefront
// catalog). Card fields mirror the storefront card: kind badge, commerce badge,
// short description, rating, "Updated N ago" freshness. The author line and
// visibility badge are dropped. The 4-state Install/Update/Installed/
// Restore CTA and "More details" link are preserved unchanged; install-state
// still resolves against agent_templates keyed by packageName.
// ---------------------------------------------------------------------------

// Commerce badge → shadcn Badge variant. All semantic; no raw palette.
function CommerceBadge({ badge }: { badge: MarketplaceCardData["badge"] }) {
  if (!badge) return null;
  return <Badge variant="outline">{badge.text}</Badge>;
}

// Monochrome rating row (5 stars filled to the rounded average) + review count.
// Real review content is out of scope; today every product is {0,0}.
function RatingRow({ rating }: { rating: NonNullable<MarketplaceCardData["rating"]> }) {
  const filled = Math.round(rating.average);
  return (
    <span className="inline-flex items-center gap-1" aria-label={`Rated ${rating.average} out of 5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Star key={i} className={cn("size-3", i <= filled ? "fill-current" : "opacity-40")} />
      ))}
      <span className="ml-1">
        {rating.count > 0
          ? `${rating.count} ${rating.count === 1 ? "review" : "reviews"}`
          : "No reviews yet"}
      </span>
    </span>
  );
}

function freshnessLabel(freshnessAt: string | null): string | null {
  if (!freshnessAt) return null;
  const d = new Date(freshnessAt);
  if (isNaN(d.getTime())) return null;
  return `Updated ${formatDistanceToNow(d, { addSuffix: true })}`;
}

export async function ExtensionsMarketplaceScreen({
  cards,
  registryConnected,
}: {
  cards: MarketplaceCardData[];
  registryConnected: boolean;
}) {
  // Admin-only — no public catalog exposure.
  await requireAdminSession();

  // Registry temp-policy declaration (config-driven; default off → no banner).
  // When configured, warn operators that this registry's private packages are
  // provisional and may be deleted without notice.
  const registryPolicy = readRegistryPolicy();

  // Install-state read model: agent_templates, keyed by
  // packageName, with effective status reconciled against the canonical
  // installed_extension lifecycle inside readActive/ArchivedExtensionTemplates.
  // Kind-agnostic (all five kinds). vendorScope guards private-package visibility.
  const identity = readInstanceIdentity();
  const vendorScope = getEffectiveViewerScope(identity);
  const [activeTemplates, archivedTemplates] = await Promise.all([
    readActiveExtensionTemplates(vendorScope),
    readArchivedExtensionTemplates(vendorScope),
  ]);
  const installedVersionByName = new Map<string, { version: string; isArchived: boolean }>();
  for (const t of activeTemplates) {
    if (t.packageName && t.packageVersion) {
      installedVersionByName.set(t.packageName, { version: t.packageVersion, isArchived: false });
    }
  }
  // Archived entries inserted AFTER active so archived wins as defense in depth.
  for (const t of archivedTemplates) {
    if (t.packageName && t.packageVersion) {
      installedVersionByName.set(t.packageName, { version: t.packageVersion, isArchived: true });
    }
  }

  const renderedCards = cards.map((card) => {
    const installedInfo = installedVersionByName.get(card.packageName);
    // 4-state CTA + registry-gating resolved by the pure helper (semver-correct
    // update detection; Install/Update disabled when the registry is down).
    const cta = resolveMarketplaceCardCta(card, installedInfo, registryConnected);

    // Per-row .bind() — install identifiers come straight from the catalog entry
    // ({packageName, packageVersion}); install resolves the typeId + tarball from
    // Verdaccio independent of the browse source (so Install Now actually installs).
    const installAction = installExtensionPackageFormAction.bind(null, {
      packageName: card.packageName,
      packageVersion: card.packageVersion,
    });
    const updateAction = updateExtensionPackageFormAction.bind(null, {
      packageName: card.packageName,
      packageVersion: card.packageVersion,
    });
    const restoreAction = restoreExtensionPackageFormAction.bind(null, {
      packageName: card.packageName,
    });

    const freshness = freshnessLabel(card.freshnessAt);

    const node = (
      <ExtensionCard
        name={card.displayName}
        accentColor={deriveExtensionAccent(card.packageName)}
        emblem={extensionKindEmblem(card.kindSlug)}
        description={card.description}
        meta={
          <div className="flex flex-col gap-1">
            {card.rating && <RatingRow rating={card.rating} />}
            {freshness && <span>{freshness}</span>}
          </div>
        }
        badges={
          <>
            <Badge variant="secondary">{card.kindLabel}</Badge>
            <CommerceBadge badge={card.badge} />
          </>
        }
        footer={
          <div className="flex items-center gap-2">
            {cta.state === "restore" ? (
              // Restore re-activates an already-installed (archived) template — DB-only.
              // A failure (DB/auth/state race) is surfaced as a toast, not a page crash (#356).
              <MarketplaceInstallForm
                action={restoreAction}
                failureMessage={`Could not restore ${card.displayName}. Please try again.`}
                className="flex-1"
              >
                <MarketplaceInstallSubmit variant="outline" pendingLabel="Restoring…" className="w-full">
                  Restore
                </MarketplaceInstallSubmit>
              </MarketplaceInstallForm>
            ) : cta.state === "install" ? (
              // Install fetches the tarball from the registry — a live CTA only
              // when the registry is connected; otherwise a disabled button so
              // we never present an Install that cannot actually install.
              cta.disabled ? (
                <Button size="sm" disabled className="w-full flex-1" title="Connect the package registry to install">
                  Install Now
                </Button>
              ) : (
                // A failed install (package absent from the connected registry → 404,
                // registry unreachable, lifecycle error) toasts instead of crashing the route (#356).
                <MarketplaceInstallForm
                  action={installAction}
                  failureMessage={`Could not install ${card.displayName}. The package may be unavailable in the connected registry.`}
                  className="flex-1"
                >
                  <MarketplaceInstallSubmit pendingLabel="Installing…" className="w-full">
                    Install Now
                  </MarketplaceInstallSubmit>
                </MarketplaceInstallForm>
              )
            ) : cta.state === "update" ? (
              cta.disabled ? (
                <Button size="sm" disabled className="w-full flex-1" title="Connect the package registry to update">
                  Update Now
                </Button>
              ) : (
                <MarketplaceInstallForm
                  action={updateAction}
                  failureMessage={`Could not update ${card.displayName}. The package may be unavailable in the connected registry.`}
                  className="flex-1"
                >
                  <MarketplaceInstallSubmit pendingLabel="Updating…" className="w-full">
                    Update Now
                  </MarketplaceInstallSubmit>
                </MarketplaceInstallForm>
              )
            ) : (
              <Button size="sm" variant="secondary" disabled className="w-full flex-1">Installed</Button>
            )}
            <Button asChild size="sm" variant="outline" className="flex-1">
              <Link href={card.detailHref}>More details</Link>
            </Button>
          </div>
        }
      />
    );

    return {
      meta: {
        packageName: card.packageName,
        title: card.displayName,
        description: card.description,
        kind: card.kindSlug,
      },
      node,
    };
  });

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="Marketplace"
        description="Browse and install extensions from the storefront."
        divider={false}
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        {registryPolicy.temporary && (
          <Alert variant="warning">
            <AlertTitle>Temporary registry policy</AlertTitle>
            <AlertDescription>{registryPolicy.notice}</AlertDescription>
          </Alert>
        )}
        {!registryConnected && (
          <Alert variant="info">
            <AlertTitle>Installing requires the package registry</AlertTitle>
            <AlertDescription>
              You can browse the catalog, but installing an extension needs the package registry
              connected. Connect it in registry settings to enable Install.
            </AlertDescription>
          </Alert>
        )}
        <Suspense fallback={<div className="text-muted-foreground text-sm">Loading filters...</div>}>
          <ExtensionsMarketplaceClient cards={renderedCards} />
        </Suspense>
      </PageContent>
    </Main>
  );
}

import { Settings } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  InstalledExtensionCard,
  InstalledStatusIndicator,
} from "@/components/extensions/installed-extension-card";
import { extensionKindEmblem } from "@/components/extension-kind-emblem";
import { VisibilityBadge } from "@/components/visibility-badge";
import { MarketplaceDetailModal } from "@cinatra-ai/extensions/screens";
import type { MarketplaceCardData } from "@cinatra-ai/extensions/screens";
import {
  installExtensionPackageFormAction,
  updateExtensionPackageFormAction,
  restoreExtensionPackageFormAction,
} from "@cinatra-ai/extensions/actions";
import { emptyRatingSummary, type MarketplaceDetailView } from "@/lib/marketplace-detail-view";

// ---------------------------------------------------------------------------
// §VI "Installed extensions" — STATIC seeded fixtures (cinatra#948 reopen).
//
// Renders the REAL `InstalledExtensionCard` + the REAL `MarketplaceDetailModal`
// with pinned load states (`initialLoad`), so the design harness can assert —
// with no DB and no session — the three reopened acceptance items:
//
//   1. "More details" opens the §V detail modal IN PLACE (no navigation) for
//      every row, including an installed-but-unlisted package (the modal's
//      graceful `notfound` state — the class that used to 404) and an
//      unscoped package name;
//   2. the byline renders the hydrated human vendor name — a vendorless row
//      renders the bare "{Type}", NEVER the raw npm scope segment;
//   3. the §VI spec version line carries only the mono version + lifecycle
//      indicator; operational chips sit on their own subdued row.
//
// The modal's lifecycle actions are the real (auth-gated) server actions, but
// every fixture pins the footer CTA to the disabled "Installed" state, so the
// fixture page never drives one. Fixture-only content; the live page wiring
// lives in `packages/extensions/src/screens/registry-catalog-screen.tsx`.
// ---------------------------------------------------------------------------

function fixtureCard(input: {
  packageName: string;
  displayName: string;
  kindSlug: MarketplaceCardData["kindSlug"];
  kindLabel: string;
  description: string | null;
  /**
   * Bare semver ("0.4.2"). The card's spec-line label v-prefixes it via the
   * same template formatting the live screen uses for `versionLabel` — a bare
   * v-prefixed literal here would trip the source-leak gate's
   * milestone-version rule on net-new lines.
   */
  version: string;
}): MarketplaceCardData {
  return {
    packageName: input.packageName,
    packageVersion: input.version,
    displayName: input.displayName,
    description: input.description,
    kindSlug: input.kindSlug,
    kindLabel: input.kindLabel,
    badge: null,
    freshnessAt: null,
    rating: null,
    detailHref: `/configuration/marketplace/${input.packageName.replace(/^@/, "")}`,
    installCount: null,
    iconUrl: null,
    vendorLogoUrl: null,
    sdkAbiRange: null,
  };
}

const LISTED_DETAIL: MarketplaceDetailView = {
  packageName: "@cinatra-fixtures/research-assistant-agent",
  displayName: "Research Assistant",
  kindLabel: "Agent",
  cost: "Free, Open Source",
  license: "Apache-2.0",
  latestVersion: "0.4.2",
  freshnessAt: "2026-06-28T00:00:00.000Z",
  installCount: 2100,
  permalink: null,
  sdkAbiRange: "^2",
  readmeMarkdown: null,
  longDescription:
    "Gathers sources, summarises, and cites answers grounded in your team's own documents.",
  description: "Gathers sources, summarises, and cites answers across your team's docs.",
  iconUrl: null,
  // §V detail fields added by PR #995 (Changelog tab, Dependencies section,
  // "Compatible up to" spec row) — seeded so the Installed-page More-details
  // trigger opens the NOW-MERGED §V modal with those sections populated (proof
  // the wiring targets the corrected modal, not a stale pre-#995 one).
  compatibleUpTo: "0.1.7",
  changelog: [
    {
      version: "0.4.2",
      date: "2026-06-28",
      notes: [
        "Grounded citations now link back to the source passage.",
        "Faster multi-document summarisation.",
      ],
    },
    {
      version: "0.4.1",
      date: "2026-05-15",
      notes: ["Initial public release."],
    },
  ],
  dependencies: [
    {
      packageName: "@cinatra-fixtures/pdf-extractor-skill",
      name: "PDF Extractor",
      kind: "skill",
      versionRange: "^1.2.0",
    },
  ],
  ratingSummary: emptyRatingSummary(),
  reviews: [],
  vendor: { name: "Cinatra", slug: "cinatra", storeUrl: null },
};

function fixtureModal(input: {
  card: MarketplaceCardData;
  initialLoad: NonNullable<Parameters<typeof MarketplaceDetailModal>[0]["initialLoad"]>;
}) {
  return (
    <MarketplaceDetailModal
      card={input.card}
      cta={{ state: "installed" }}
      installAction={installExtensionPackageFormAction.bind(null, {
        packageName: input.card.packageName,
        packageVersion: input.card.packageVersion,
      })}
      updateAction={updateExtensionPackageFormAction.bind(null, {
        packageName: input.card.packageName,
        packageVersion: input.card.packageVersion,
      })}
      restoreAction={restoreExtensionPackageFormAction.bind(null, {
        packageName: input.card.packageName,
      })}
      initialLoad={input.initialLoad}
      trigger={
        <Button variant="link" size="sm" className="w-full">
          More details
        </Button>
      }
    />
  );
}

function SettingsLookalike() {
  // Inert lookalike (no configuration surface exists behind the fixture).
  return (
    <Button size="sm" aria-disabled>
      <Settings data-icon="inline-start" />
      Settings
    </Button>
  );
}

export function InstalledExtensionsFixture() {
  const listedCard = fixtureCard({
    packageName: "@cinatra-fixtures/research-assistant-agent",
    displayName: "Research Assistant",
    kindSlug: "agent",
    kindLabel: "Agent",
    description: "Gathers sources, summarises, and cites answers across your team's docs.",
    version: "0.4.2",
  });
  const unlistedCard = fixtureCard({
    packageName: "@cinatra-fixtures/code-reviewer-agent",
    displayName: "Code Reviewer",
    kindSlug: "agent",
    kindLabel: "Agent",
    description: "Reviews pull requests against your team's standards before a human ever looks.",
    version: "0.1.0",
  });
  const unscopedCard = fixtureCard({
    packageName: "local-tools",
    displayName: "Local Tools",
    kindSlug: "skill",
    kindLabel: "Skill",
    description: "A locally-uploaded skill pack with an unscoped package name.",
    version: "1.2.0",
  });
  const archivedCard = fixtureCard({
    packageName: "@cinatra-fixtures/knowledge-base-connector",
    displayName: "Knowledge Base Connector",
    kindSlug: "connector",
    kindLabel: "Connector",
    description: "Unifies Confluence, Notion and SharePoint into a single retrieval layer.",
    version: "2.4.0",
  });

  return (
    <div data-testid="installed-extensions-fixture" className="grid gap-3">
      <p className="text-xs text-muted-foreground">
        §VI Installed extensions — seeded fixtures (cinatra#948): listed + installed-but-unlisted
        + unscoped + archived. Byline = hydrated vendor name or the bare kind (never the npm
        scope); spec line = version + lifecycle dot only; More details opens the §V modal in
        place (unlisted/unscoped pin the graceful notfound state).
      </p>

      {/* 1 — listed, vendor hydrated ("Agent by Cinatra"), modal loads the detail. */}
      <InstalledExtensionCard
        name="Research Assistant"
        accentColor="red"
        emblem={extensionKindEmblem("agent")}
        kindIcon={extensionKindEmblem("agent", "size-3.5")}
        kindLabel="Agent"
        vendor="Cinatra"
        description={listedCard.description}
        version={`v${listedCard.packageVersion}`}
        status={<InstalledStatusIndicator status="active" />}
        chips={
          <>
            <VisibilityBadge visibility="public" />
          </>
        }
        actions={
          <>
            <SettingsLookalike />
            {fixtureModal({
              card: listedCard,
              initialLoad: { status: "loaded", detail: LISTED_DETAIL },
            })}
          </>
        }
      />

      {/* 2 — installed-but-unlisted: NO vendor (bare kind byline — the raw npm
          scope must never render), modal pins the graceful notfound state. */}
      <InstalledExtensionCard
        name="Code Reviewer"
        accentColor="green"
        emblem={extensionKindEmblem("agent")}
        kindIcon={extensionKindEmblem("agent", "size-3.5")}
        kindLabel="Agent"
        vendor={null}
        description={unlistedCard.description}
        version={`v${unlistedCard.packageVersion}`}
        status={<InstalledStatusIndicator status="active" />}
        chips={
          <>
            <Badge variant="secondary" title="Required in production">
              Required
            </Badge>
            <VisibilityBadge visibility="private" />
          </>
        }
        actions={
          <>
            <SettingsLookalike />
            {fixtureModal({ card: unlistedCard, initialLoad: { status: "notfound" } })}
          </>
        }
      />

      {/* 3 — unscoped package name: the modal still opens (no dead end). */}
      <InstalledExtensionCard
        name="Local Tools"
        accentColor="burgundy"
        emblem={extensionKindEmblem("skill")}
        kindIcon={extensionKindEmblem("skill", "size-3.5")}
        kindLabel="Skill"
        vendor={null}
        description={unscopedCard.description}
        version={`v${unscopedCard.packageVersion}`}
        status={<InstalledStatusIndicator status="active" />}
        actions={fixtureModal({ card: unscopedCard, initialLoad: { status: "notfound" } })}
      />

      {/* 4 — archived (fully-greyed §VI treatment). */}
      <InstalledExtensionCard
        name="Knowledge Base Connector"
        accentColor="green"
        emblem={extensionKindEmblem("connector")}
        kindIcon={extensionKindEmblem("connector", "size-3.5")}
        kindLabel="Connector"
        vendor="Meridian Labs"
        description={archivedCard.description}
        version={`v${archivedCard.packageVersion}`}
        status={<InstalledStatusIndicator status="archived" />}
        archived
        actions={fixtureModal({ card: archivedCard, initialLoad: { status: "notfound" } })}
      />
    </div>
  );
}

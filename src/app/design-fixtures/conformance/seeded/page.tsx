import type { Metadata } from "next";
import { Suspense } from "react";

import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MarketplaceGridLoadingFallback } from "@cinatra-ai/extensions/screens/extensions-marketplace-client";

import { resolveInstalledTab } from "@/components/extensions/installed-tab-model";

import { CONFORMANCE_RUN_ID_RE } from "../seed-data";
import { MarketplaceGridFixture, DelayedMarketplaceGridFixture } from "./marketplace-grid-fixture";
import { InstalledExtensionsFixture } from "./installed-extensions-fixture";
import { ConnectorGridFixture } from "./connector-grid-fixture";
import { DetailModalConformanceFixture } from "./detail-modal-fixture";

export const metadata: Metadata = {
  title: "Design Fixtures — Seeded data-contract harness — Cinatra",
  description:
    "Internal route mounting the real grid/list/filter/modal conformance surfaces against the run-namespaced seeded fixture kit (cinatra#986).",
};

// Per-request rendering: the run/tab/variant params select the seeded
// namespace + forced state, and the installed-extensions sections read the
// live canonical store. Never prerendered at build time.
export const dynamic = "force-dynamic";

/**
 * /design-fixtures/conformance/seeded — the SEEDED data-contract harness
 * (cinatra#986, building on the cinatra#985 conformance harness).
 *
 * Internal route, not linked from navigation; reachable under the same
 * contract as its siblings (src/lib/auth-route-guard.ts). Mounts the REAL
 * components of the grid/list/filter/modal conformance surfaces against the
 * deterministic seeded fixture kit (../seed-data.ts):
 *
 *   - extension-listing-grid: the REAL ExtensionsMarketplaceClient with
 *     server-composed real listing-card nodes (populated / empty variants;
 *     ?variant=loading additionally streams the REAL Suspense fallback over a
 *     delayed card source).
 *   - installed-extensions-list / installed-extensions-filter: rendered from
 *     the REAL canonical installed_extension store (rows provisioned by
 *     ../seed/route.ts through the real lifecycle primitive), URL-filtered by
 *     the REAL ExtensionsTabSelect control — a live-DB data path, per the
 *     cinatra#986 mandate (never weakened to static fixtures).
 *   - connector-grid / connector-connection-filter: the REAL ConnectorsClient
 *     over cards resolved through the REAL resolveReadinessFailSoft
 *     containment (one seeded probe THROWS — the error-state card).
 *   - extension-detail-modal: the REAL MarketplaceDetailModal whose footer CTA
 *     re-derives through the REAL resolveMarketplaceCardCta after the harness
 *     install action mutates the installed-state input (cinatra#985 pattern).
 *
 * Query params: ?run=<runId> selects the seeded namespace (defaults to
 * "local"); ?tab=all|active|locked|archived drives the REAL installed-extensions
 * status filter (cinatra#1571); ?variant=loading mounts the delayed grid
 * instance.
 *
 * Kept OFF the pixel-diffed /design-fixtures index page; coverage here is
 * assertion-based (tests/e2e/design/conformance/functional-acceptance.spec.ts).
 */
export default async function SeededConformanceHarnessPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const first = (v: string | string[] | undefined): string | undefined =>
    typeof v === "string" ? v : Array.isArray(v) ? v[0] : undefined;

  const runRaw = (first(params.run) ?? "local").toLowerCase();
  const runId = CONFORMANCE_RUN_ID_RE.test(runRaw) ? runRaw : "local";
  // The REAL `?tab=` contract (cinatra#1571): all|active|locked|archived, with
  // an invalid/absent value falling back to the default "active" view.
  const tab = resolveInstalledTab(params.tab);
  const variant = first(params.variant);

  return (
    <Main className="min-h-screen">
      <PageHeader
        label="Design system"
        title="Seeded data-contract harness"
        description={`Internal — real conformance surfaces over the seeded fixture kit (run namespace: ${runId}).`}
      />
      <PageContent className="flex flex-col gap-8 pb-12">
        <Card className="border-line bg-surface backdrop-blur-none">
          <CardHeader>
            <CardTitle>Marketplace grid (surface: extension-listing-grid)</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            <div data-surface-id="extension-listing-grid" data-variant="populated">
              <MarketplaceGridFixture populated />
            </div>
            <div data-surface-id="extension-listing-grid" data-variant="empty">
              <MarketplaceGridFixture populated={false} />
            </div>
            {variant === "loading" ? (
              // The REAL Suspense machinery + the REAL fallback component the
              // marketplace screen renders — over a deliberately slow card
              // source, so the suite can observe the loading treatment
              // mid-stream on the production standalone boot.
              <div data-surface-id="extension-listing-grid" data-variant="loading">
                <Suspense fallback={<MarketplaceGridLoadingFallback />}>
                  <DelayedMarketplaceGridFixture />
                </Suspense>
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card className="border-line bg-surface backdrop-blur-none">
          <CardHeader>
            <CardTitle>
              Installed extensions (surfaces: installed-extensions-list, installed-extensions-filter)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <InstalledExtensionsFixture runId={runId} tab={tab} />
          </CardContent>
        </Card>

        <Card className="border-line bg-surface backdrop-blur-none">
          <CardHeader>
            <CardTitle>
              Connectors (surfaces: connector-grid, connector-connection-filter)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ConnectorGridFixture />
          </CardContent>
        </Card>

        <Card className="border-line bg-surface backdrop-blur-none">
          <CardHeader>
            <CardTitle>Detail modal (surface: extension-detail-modal)</CardTitle>
          </CardHeader>
          <CardContent>
            <DetailModalConformanceFixture />
          </CardContent>
        </Card>
      </PageContent>
    </Main>
  );
}

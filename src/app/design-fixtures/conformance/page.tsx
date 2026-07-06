import type { Metadata } from "next";

import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/ui/status-pill";

import { ConformanceCardFixtures } from "./card-fixtures";
import {
  CONFORMANCE_BUTTON_VARIANTS,
  CONFORMANCE_STATUS_PILL_STATUSES,
} from "./fixture-data";

export const metadata: Metadata = {
  title: "Design Fixtures — Conformance harness — Cinatra",
  description:
    "Internal route mounting the real conformance-surface components (extension listing cards through the real six-state CTA machinery, status pills, button variants) for the manifest-driven functional-acceptance suite.",
};

/**
 * /design-fixtures/conformance.
 *
 * Internal route. Not linked from navigation. The functional-acceptance
 * harness for the design-conformance manifests (cinatra#985): mounts the REAL
 * covered components with deterministic fixture data so
 * tests/e2e/design/conformance/functional-acceptance.spec.ts can assert, per
 * manifest surface, that required fields render bound to the right data,
 * actions produce their specified outcomes, and required state variants exist
 * — on the production-equivalent standalone boot, no DB/registry round-trip.
 *
 * Kept OFF the pixel-diffed /design-fixtures index page (same convention as
 * the §V detail-modal fixture route) so the committed pixel baselines stay
 * untouched; coverage here is assertion-based.
 *
 * Operational sources: the published conformance manifests (see
 * tests/e2e/design/conformance/spec-pins.json) generated from the annotated
 * design specs at https://docs.cinatra.ai/references/design/.
 */
export default function ConformanceHarnessPage() {
  return (
    <Main className="min-h-screen">
      <PageHeader
        label="Design system"
        title="Conformance harness"
        description="Internal — real conformance-surface components mounted with deterministic fixtures for the manifest-driven functional-acceptance gate."
      />
      <PageContent className="flex flex-col gap-8 pb-12">
        <Card className="border-line bg-surface backdrop-blur-none">
          <CardHeader>
            <CardTitle>Status pills (surface: status-pills)</CardTitle>
          </CardHeader>
          <CardContent>
            <div data-surface-id="status-pills" className="flex flex-wrap gap-2">
              {CONFORMANCE_STATUS_PILL_STATUSES.map((status) => (
                <StatusPill key={status} status={status} />
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="border-line bg-surface backdrop-blur-none">
          <CardHeader>
            <CardTitle>Button variants (surface: button-variants)</CardTitle>
          </CardHeader>
          <CardContent>
            <div data-surface-id="button-variants" className="flex flex-wrap items-center gap-2">
              {CONFORMANCE_BUTTON_VARIANTS.map((variant) => (
                <Button key={variant} variant={variant}>
                  {variant}
                </Button>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="border-line bg-surface backdrop-blur-none">
          <CardHeader>
            <CardTitle>Extension listing cards (surfaces: extension-listing-card-*)</CardTitle>
          </CardHeader>
          <CardContent>
            <ConformanceCardFixtures />
          </CardContent>
        </Card>
      </PageContent>
    </Main>
  );
}

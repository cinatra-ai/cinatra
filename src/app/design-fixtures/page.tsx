import type { Metadata } from "next";

import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { PrimitiveRow } from "./primitive-row";
import { TokenSwatches } from "./token-swatches";
import { NewComponentPlaceholders } from "./new-component-placeholders";
import { CorePrimitives } from "./fixtures-core";
import { ComplexPrimitives } from "./fixtures-complex";
import { SidebarFixture } from "./sidebar-fixture";
import { LinerNotesFixture } from "./liner-notes-fixture";

export const metadata: Metadata = {
  title: "Design Fixtures — Cinatra",
  description:
    "Internal route rendering every shadcn primitive in light + dark, with placeholder contract rows for new design-system components.",
};

/**
 * /design-fixtures.
 *
 * Internal route. Not linked from navigation. Renders the shadcn primitive
 * catalog used to verify design-system coverage, alongside token swatches and
 * placeholder rows for StatusPill, BrandMark, and ExtensionCard.
 *
 * Operational source: the design-system reference at
 * https://docs.cinatra.ai/references/design/.
 */
export default function DesignFixturesPage() {
  return (
    <Main className="min-h-screen">
      <PageHeader
        label="Design system"
        title="Design fixtures"
        description="Internal — primitive catalog + token swatches + new-component placeholders. Compare light vs dark and against the design-system reference."
      />
      <PageContent className="flex flex-col gap-8 pb-12">
        <Card className="border-line bg-surface backdrop-blur-none">
          <CardHeader>
            <CardTitle>Tokens — semantic swatches</CardTitle>
          </CardHeader>
          <CardContent>
            <TokenSwatches />
          </CardContent>
        </Card>

        <Card className="border-line bg-surface backdrop-blur-none">
          <CardHeader>
            <CardTitle>New components (placeholder rows)</CardTitle>
          </CardHeader>
          <CardContent>
            <NewComponentPlaceholders />
          </CardContent>
        </Card>

        <Card className="border-line bg-surface backdrop-blur-none">
          <CardHeader>
            <CardTitle>Core primitives</CardTitle>
          </CardHeader>
          <CardContent>
            <CorePrimitives />
          </CardContent>
        </Card>

        <Card className="border-line bg-surface backdrop-blur-none">
          <CardHeader>
            <CardTitle>Complex / data / feedback primitives</CardTitle>
          </CardHeader>
          <CardContent>
            <ComplexPrimitives />
          </CardContent>
        </Card>

        <Card className="border-line bg-surface backdrop-blur-none">
          <CardHeader>
            <CardTitle>Sidebar primitive</CardTitle>
          </CardHeader>
          <CardContent>
            <SidebarFixture />
          </CardContent>
        </Card>

        <Card className="border-line bg-surface backdrop-blur-none">
          <CardHeader>
            <CardTitle>Liner-notes utility</CardTitle>
          </CardHeader>
          <CardContent>
            <LinerNotesFixture />
          </CardContent>
        </Card>
      </PageContent>
    </Main>
  );
}

// Re-export so child fixture modules can compose against a shared row layout
// without each adding their own.
export { PrimitiveRow };

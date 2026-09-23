import type { Metadata } from "next";

import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { UploadExtensionConformanceFixtures } from "../upload-extension-fixtures";

export const metadata: Metadata = {
  title: "Design Fixtures — Upload Extension conformance harness — Cinatra",
  description:
    "Internal route mounting the three Upload Extension conformance surfaces of the published app-extensions body (cinatra#3546).",
};

/**
 * /design-fixtures/conformance/upload — the §VIII Upload Extension conformance
 * harness (cinatra#3546), a sub-page of the conformance harness directory in the
 * shape its seeded sibling (../seeded/page.tsx) already has.
 *
 * WHY IT IS ITS OWN ROUTE. Two of the three mounts render the §I.1 install panel
 * ALREADY RESOLVED, and that panel takes focus when it mounts
 * (packages/extensions/src/screens/extension-install-scope-panel.tsx). The
 * browser scrolls the focused control into view at hydration, which moves every
 * other mount that shares the page; a geometry expectation comparing two
 * viewport-relative box readings taken in separate round trips then reads a
 * row-break no card's own layout produced. On a route of its own this family
 * keeps every ancestor it had — the fixtures module does not move — and no other
 * surface family is measured through its scroll.
 *
 * Internal route, not linked from navigation; reachable under the same contract
 * as its siblings (src/lib/auth-route-guard.ts). Static and dataless: no
 * session, no database and no request input, so it declares no `dynamic` —
 * unlike the seeded sibling, which reads query parameters and the store. Kept
 * OFF the pixel-diffed /design-fixtures index page; coverage here is
 * assertion-based (tests/e2e/design/conformance/functional-acceptance.spec.ts).
 */
export default function UploadConformanceHarnessPage() {
  return (
    <Main className="min-h-screen">
      <PageHeader
        label="Design system"
        title="Upload Extension conformance harness"
        description="Internal — the three published Upload Extension surfaces on a route of their own."
      />
      <PageContent className="flex flex-col gap-8 pb-12">
        {/* The Upload Extension screen's three surfaces (design spec §VIII,
            published with the app-extensions manifest adopted in cinatra#3546):
            upload-extension-screen, upload-github-form and
            upload-resolved-install-panel. */}
        <Card className="border-line bg-surface backdrop-blur-none">
          <CardHeader>
            <CardTitle>
              Upload Extension screen (surfaces: upload-extension-screen,
              upload-github-form, upload-resolved-install-panel)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <UploadExtensionConformanceFixtures />
          </CardContent>
        </Card>
      </PageContent>
    </Main>
  );
}

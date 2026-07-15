import Link from "next/link";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";

// ---------------------------------------------------------------------------
// Marketplace "not connected" group view.
//
// Relocated here from the retired `src/app/configuration/approvals/
// marketplace-group-views.tsx` in the E8 cutover (cinatra#1558): the
// `/configuration/approvals` page that rendered it is deleted, but the
// `approvals-marketplace-states` conformance surface (app-components manifest)
// still asserts this exact "no marketplace credential" empty state via the
// functional-acceptance harness (`approvals-scheduling-fixtures.tsx`). It lives
// here — next to its sole remaining consumer, the design-fixtures harness — until
// the E11 conformance rewrite (#1561) retires the surface itself. The
// page-only `MarketplaceSourcesFooter` sibling had no surviving consumer and was
// dropped with the page.
//
// Prop-driven + import-light (no server-only / marketplace-client chain) so it
// renders on the sessionless standalone conformance boot.
// ---------------------------------------------------------------------------

// Connectivity model case (a): NO marketplace credential of ANY kind resolves →
// the whole marketplace group collapses to ONE Empty + a Connect CTA and fires
// zero remote calls.
export function MarketplaceNotConnectedGroup({ connectHref }: { connectHref: string }) {
  return (
    <Empty className="border-line">
      <EmptyHeader>
        <EmptyTitle>Marketplace not connected</EmptyTitle>
        <EmptyDescription>
          Connect a marketplace registry credential to review extension submissions and vendor
          applications, and to track this instance&rsquo;s own submissions, from here.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button asChild variant="outline">
          <Link href={connectHref}>Connect registry</Link>
        </Button>
      </EmptyContent>
    </Empty>
  );
}

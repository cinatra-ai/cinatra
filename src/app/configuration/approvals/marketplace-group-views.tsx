import Link from "next/link";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";

import type { ApprovalSource } from "./sources/types";

// ---------------------------------------------------------------------------
// Group-level presentational views for the marketplace connectivity model.
// Kept prop-driven + import-light (no server-only / marketplace-client chain) so
// they render in a DOM test via react-dom/server, complementing the CI
// render-smoke live floor over the whole page.
// ---------------------------------------------------------------------------

// Connectivity model case (a): NO marketplace credential of ANY kind resolves →
// the whole marketplace group collapses to ONE Empty + a Connect CTA and fires
// zero remote calls. Local sections render regardless (they are outside the group).
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

// Connectivity model case (b): a marketplace section whose OWN credential is
// absent (while another marketplace credential IS connected) is hidden — but
// never silently. One discoverable line per hidden section points the operator
// at the registries configuration.
export function MarketplaceSourcesFooter({
  hidden,
  connectHref,
}: {
  hidden: ApprovalSource[];
  connectHref: string;
}) {
  if (hidden.length === 0) return null;
  return (
    <div className="rounded-md border border-line bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
      <p className="font-medium text-foreground">Some marketplace sections are hidden</p>
      <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-4">
        {hidden.map((s) => (
          <li key={s.id}>
            {s.title} &mdash; its marketplace credential isn&rsquo;t configured on this instance.
          </li>
        ))}
      </ul>
      <Link href={connectHref} className="mt-1 inline-block underline hover:text-foreground">
        Configure marketplace registries
      </Link>
    </div>
  );
}

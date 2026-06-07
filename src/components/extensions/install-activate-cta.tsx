// The explicit Install / Activate call-to-action a connector setup surface shows
// when there is NO active installed row for the actor's workspace.
//
// A `schema-config` connector's named actions POST to
// `/api/extensions/{installId}/actions/...`; without an install row there is no
// addressable id. Rather than 404 opaquely (or silently auto-install), the
// dispatch route renders this CTA so the operator can install/activate the
// connector first. shadcn-only (`Empty` + `Button`), semantic tokens, no raw
// colors.

import Link from "next/link";
import { PackagePlusIcon } from "lucide-react";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Button } from "@/components/ui/button";

export type InstallActivateCtaProps = {
  /** The connector's user-facing display name. */
  displayName: string;
  /** Where the operator installs/activates the connector (marketplace). */
  installHref?: string;
};

export function InstallActivateCta({
  displayName,
  installHref = "/configuration/marketplace",
}: InstallActivateCtaProps) {
  return (
    <Empty className="border-line bg-surface-muted" data-testid="install-activate-cta">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <PackagePlusIcon />
        </EmptyMedia>
        <EmptyTitle>{displayName} isn&apos;t installed yet</EmptyTitle>
        <EmptyDescription>
          This connector isn&apos;t installed for your workspace, so there is nothing to
          configure here yet. Install or activate it to set up its connection.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button asChild>
          <Link href={installHref}>Install or activate</Link>
        </Button>
      </EmptyContent>
    </Empty>
  );
}

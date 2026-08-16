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
  /**
   * May this viewer reach the install destination? (cinatra#2701, epic #2699 S2.)
   *
   * The default destination is `/configuration/marketplace`, which answers only
   * to a platform-admin session (S1, #2700). A member reaching a connector
   * setup surface with nothing installed still needs the EXPLANATION — that is
   * the whole point of this empty state — but must not be handed a button that
   * lands on not-authorized. Defaults to `false` so a caller that forgets to
   * pass it withholds the control rather than offering a dead one.
   */
  canInstall?: boolean;
};

export function InstallActivateCta({
  displayName,
  installHref = "/configuration/marketplace",
  canInstall = false,
}: InstallActivateCtaProps) {
  return (
    <Empty className="border-line bg-surface-muted" data-testid="install-activate-cta">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <PackagePlusIcon />
        </EmptyMedia>
        <EmptyTitle>{displayName} isn&apos;t installed yet</EmptyTitle>
        <EmptyDescription>
          {canInstall
            ? "This connector isn't installed for your workspace, so there is nothing to configure here yet. Install or activate it to set up its connection."
            : "This connector isn't installed for your workspace, so there is nothing to configure here yet. Ask an administrator to install or activate it."}
        </EmptyDescription>
      </EmptyHeader>
      {canInstall ? (
      <EmptyContent>
        <Button asChild>
          <Link href={installHref}>Install or activate</Link>
        </Button>
      </EmptyContent>
      ) : null}
    </Empty>
  );
}

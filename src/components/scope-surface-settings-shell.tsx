// The RESOLVING settings shell (cinatra#2809, per-scope surfaces S3).
//
// This epic pins the settings HREF contract — the card's Settings button
// targets `<scope-base>/agents/<vendor>/<packageName>/settings`, and the
// assistants analog — and mounts a route that RESOLVES at that address. The
// pane's CONTENTS and the end-to-end navigation acceptance live with the
// assignment epic, which fills this shell in place rather than moving it.
//
// It is a shell and it SAYS so, rather than drawing an invented pane: a page
// that guessed at what per-scope settings are would be a surface nobody
// ratified, and replacing it later would be a second migration of a thing that
// should never have shipped. The honest reading here is the same one the four
// scoped tabs already carry from #2807 — what this surface will hold, never a
// claim about data it has not read.

import Link from "next/link";

import { CrumbContributions } from "@/components/crumb-contributions";
import { Main } from "@/components/layout/main";
import { PageContent } from "@/components/page-content";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  SCOPE_SURFACE_KIND_LABEL,
  SCOPE_SURFACE_TAB_LABEL,
  scopeSurfaceBase,
  scopeSurfaceCrumbEntries,
  type ScopeSurfaceRef,
} from "@/lib/scope-surfaces";

export type ScopeSurfaceSettingsSubject = {
  /** Which tree this settings surface belongs to. */
  kind: "agent" | "assistant";
  /** The package the settings are FOR, exactly as the address spells it. */
  packageName: string;
};

export function ScopeSurfaceSettingsShell({
  scope,
  scopeTitle,
  subject,
}: {
  scope: ScopeSurfaceRef;
  /**
   * The scope's own name, resolved by the route behind that scope's read gate
   * (cinatra#2809 fix leg 2). `null` where the reader may not be told it, and
   * the crumb then falls back to the id's first eight characters plus an
   * ellipsis — the drawing's genuinely-unavailable arm, which is NOT what this
   * page used to show while the name was sitting resolved one level up.
   */
  scopeTitle?: string | null;
  subject: ScopeSurfaceSettingsSubject;
}) {
  const base = scopeSurfaceBase(scope);
  const tab = subject.kind === "agent" ? "agents" : "assistants";
  const tabHref = `${base}/${tab}`;
  const tabLabel = SCOPE_SURFACE_TAB_LABEL[tab];
  return (
    <Main className="min-h-screen">
      {/* The trail above this page is the SCOPE and its tab — published from
          here, after the route's own gate, exactly as every scope surface
          publishes what it resolved, and through the same road they all use.
          The leaf ("Settings") is named by the route's own last segment; the
          entry this shell used to publish for it targeted `<base>/<tab>/
          settings`, a path no route answers on, so it named nothing. */}
      <CrumbContributions entries={scopeSurfaceCrumbEntries(scope, tab, scopeTitle ?? undefined)} />
      <PageHeader
        label={SCOPE_SURFACE_KIND_LABEL[scope.kind]}
        title="Settings"
        description={`Settings for ${subject.packageName} in this scope.`}
        divider={false}
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        <Empty
          data-testid="scope-surface-settings-shell"
          data-subject={subject.packageName}
        >
          <EmptyHeader>
            <EmptyTitle>This surface is not ready yet</EmptyTitle>
            <EmptyDescription>
              {`The settings ${subject.packageName} carries in this scope appear here.`}
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button asChild>
              <Link href={tabHref}>{`Back to ${tabLabel}`}</Link>
            </Button>
          </EmptyContent>
        </Empty>
      </PageContent>
    </Main>
  );
}

/**
 * `/configuration/artifacts/restore/[changeSetId]` — the targeted single
 * change-set restore surface, nested under the Artifacts console (cinatra#1786,
 * spec design@923fa0d8 §IV). The two entry affordances (the in-chat "Undo last
 * action" chip and the "Saved … · Undo" toast) deep-link here.
 *
 * PLATFORM-ADMIN ONLY since cinatra#2700 (epic #2699): the page stays at this
 * URL and falls under the `/configuration` gate like every other route in the
 * segment. Member self-service restore retires with it — at the ACTION level
 * too (`restoreChangeSetAction`), not merely in the UI — and S2 removes the
 * member-facing affordances that used to mint a path here.
 *
 * The per-object eligibility check REMAINS on top of the admin gate: an admin
 * addressing a missing/foreign change set, or one that is no longer restorable,
 * still sees the graceful denied state rather than a broken confirmation
 * (`loadAuthorizedTargetedRestore` → `canActorRestoreChangeSet`, unchanged).
 */
import type { Metadata } from "next";
import Link from "next/link";
import { Lock } from "lucide-react";

import { Main } from "@/components/layout/main";
import { PageContent } from "@/components/page-content";
import { PageHeader } from "@/components/page-header";
import { requireAdminSession } from "@/lib/auth-session";
import { loadAuthorizedTargetedRestore } from "@/lib/object-history/restore-eligibility";
import { TargetedRestoreMode } from "@/components/artifacts/targeted-restore-mode";

export const metadata: Metadata = { title: "Restore change" };
export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ changeSetId: string }>;
};

export default async function TargetedRestorePage({ params }: PageProps) {
  await requireAdminSession();

  const { changeSetId } = await params;
  const loaded = await loadAuthorizedTargetedRestore(changeSetId);

  return (
    <Main className="min-h-screen">
      <PageHeader title="Restore this change?" />
      <PageContent className="flex flex-col gap-4 pb-8">
        {loaded ? (
          <div
            data-testid="artifacts-restore-route"
            data-conformance-id="artifacts-restore-route"
          >
            <p className="mb-3 max-w-xl text-sm text-muted-foreground">
              You are authorized to restore every affected object.
            </p>
            <TargetedRestoreMode loaded={loaded} />
          </div>
        ) : (
          <RestoreNotAuthorized />
        )}
      </PageContent>
    </Main>
  );
}

function RestoreNotAuthorized() {
  return (
    <div
      className="flex flex-col items-center gap-3 rounded-lg border border-line bg-surface-strong px-5 py-12 text-center"
      data-testid="artifacts-restore-route-denied"
      data-conformance-id="artifacts-restore-route-denied"
      data-state="error"
    >
      <div className="grid size-10 place-items-center rounded-lg bg-surface-muted text-muted-foreground">
        <Lock aria-hidden className="size-5" />
      </div>
      <p className="text-sm font-semibold text-foreground">
        You&apos;re not authorized to restore this change
      </p>
      <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
        Restoring a change set requires authorization for every object it
        touched. This change set may also no longer be restorable.{" "}
        <Link
          href="/configuration/artifacts?tab=restore"
          className="text-primary underline-offset-4 hover:underline"
        >
          Back to Restore objects
        </Link>
      </p>
    </div>
  );
}

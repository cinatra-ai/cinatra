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
 * addressing a change set they may not fully reverse still sees the graceful
 * denied state rather than a broken confirmation
 * (`loadAuthorizedTargetedRestore` → `canActorRestoreChangeSet`, unchanged).
 *
 * THREE states, not two (cinatra#2800). The gate used to answer null for
 * "missing" and for "denied" alike, so a stale link told an administrator they
 * lacked rights they held. It now answers with a kind, and each kind gets its
 * own words in the SAME panel: nothing to restore, may not restore, or the
 * confirmation.
 */
import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { FileQuestionMark, Lock } from "lucide-react";

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
  const resolution = await loadAuthorizedTargetedRestore(changeSetId);

  return (
    <Main className="min-h-screen">
      <PageHeader title="Restore this change?" />
      <PageContent className="flex flex-col gap-4 pb-8">
        {resolution.kind === "authorized" ? (
          <div
            data-testid="artifacts-restore-route"
            data-conformance-id="artifacts-restore-route"
          >
            <p className="mb-3 max-w-xl text-sm text-muted-foreground">
              You are authorized to restore every affected object.
            </p>
            <TargetedRestoreMode loaded={resolution.loaded} />
          </div>
        ) : resolution.kind === "not_authorized" ? (
          <RestoreNotAuthorized />
        ) : (
          <RestoreNotFound />
        )}
      </PageContent>
    </Main>
  );
}

/**
 * The one panel both negative states wear (no new drawing, cinatra#2800): the
 * shape, spacing and colours are fixed here, and each state passes its own icon,
 * headline and sentence.
 */
function RestorePanel({
  testId,
  icon,
  title,
  children,
}: {
  testId: string;
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <div
      className="flex flex-col items-center gap-3 rounded-lg border border-line bg-surface-strong px-5 py-12 text-center"
      data-testid={testId}
      data-conformance-id={testId}
      data-state="error"
    >
      <div className="grid size-10 place-items-center rounded-lg bg-surface-muted text-muted-foreground">
        {icon}
      </div>
      <p className="text-sm font-semibold text-foreground">{title}</p>
      <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
        {children} <BackToRestoreLink />
      </p>
    </div>
  );
}

function BackToRestoreLink() {
  return (
    <Link
      href="/configuration/artifacts?tab=restore"
      className="text-primary underline-offset-4 hover:underline"
    >
      Back to Restore objects
    </Link>
  );
}

/** The change set exists and is restorable — this actor may not reverse it. */
function RestoreNotAuthorized() {
  return (
    <RestorePanel
      testId="artifacts-restore-route-denied"
      icon={<Lock aria-hidden className="size-5" />}
      title={"You're not authorized to restore this change"}
    >
      Restoring a change set requires authorization for every object it touched.
    </RestorePanel>
  );
}

/**
 * There is nothing to restore — no such change set here, or it can no longer be
 * restored. Not a word about authorization: the reader may well hold it.
 */
function RestoreNotFound() {
  return (
    <RestorePanel
      testId="artifacts-restore-route-missing"
      icon={<FileQuestionMark aria-hidden className="size-5" />}
      title="This change set does not exist or can no longer be restored"
    >
      The link may be out of date.
    </RestorePanel>
  );
}

/**
 * `/configuration/artifacts/restore/[changeSetId]` — the targeted single
 * change-set restore surface, nested under the Artifacts console (cinatra#1786,
 * spec design@923fa0d8 §IV). Reversing ONE change set is authorized PER OBJECT,
 * so this route is reachable by any authorized actor of ANY role — NOT
 * admin-gated. The two entry affordances (the in-chat "Undo last action" chip
 * and the "Saved … · Undo" toast) deep-link here.
 *
 * Eligibility holds to the SAME per-object gate the affordances and the confirm
 * path use (`loadAuthorizedTargetedRestore` → `canActorRestoreChangeSet`, no
 * administrator bypass): an authorized actor sees the "Restore this change?"
 * confirmation (the addressed change set, modal auto-opened); anyone else — a
 * signed-in actor not authorized for some affected object, a missing/foreign
 * change set, or a newly-non-restorable one — sees the standard not-authorized
 * state. A rendered control therefore never dead-ends here.
 */
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Lock } from "lucide-react";

import { Main } from "@/components/layout/main";
import { PageContent } from "@/components/page-content";
import { PageHeader } from "@/components/page-header";
import { getAuthSession } from "@/lib/auth-session";
import { loadAuthorizedTargetedRestore } from "@/lib/object-history/restore-eligibility";
import { TargetedRestoreMode } from "@/components/artifacts/targeted-restore-mode";

export const metadata: Metadata = { title: "Restore change" };
export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ changeSetId: string }>;
};

export default async function TargetedRestorePage({ params }: PageProps) {
  const session = await getAuthSession();
  if (!session) redirect("/sign-in");

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
              You are authorized to restore every affected object — no
              administrator role required.
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

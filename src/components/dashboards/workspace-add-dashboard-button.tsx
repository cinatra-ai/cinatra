"use client";
/**
 * The workspace Dashboards tab's Add affordance (cinatra#2811, per-scope
 * surfaces S5; the amended drawing §IX.1 and §IX.3).
 *
 * "The same single Add dashboard popup" the other scopes open, with its
 * sections in the drawn order:
 *
 *   - Create new: offered to EVERY viewer. The workspace tab is a per-user
 *     shell ("each member reads their own list"), and "a dashboard this tab's
 *     popup creates ... homes in the workspace and shows no Remove, exactly as
 *     Overview does". Choosing it hands off to the shared name prompt
 *     (`EntityDashboardNameDialog`, the one prompt Create and Rename share),
 *     whose submit is the create action the page bound server-side to the
 *     viewer's own workspace ref;
 *   - Reference a dashboard from the scopes below: present only when the page
 *     handed down a reference source, which it does only for a curator
 *     (a platform administrator, or an organization admin), §IX.2 suppression
 *     applied at the source;
 *   - Add from the installed catalog: not wired on the workspace yet (the
 *     cross-organization federation is its own leg), so the section is absent,
 *     never a placeholder.
 *
 * It decides nothing: every action re-authorizes server-side.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";

import {
  ENTITY_DASHBOARD_REASON_COPY,
  type MutatedEntityDashboard,
} from "@cinatra-ai/dashboards/entity-dashboards-contract";
import { EntityDashboardNameDialog } from "@cinatra-ai/dashboards/entity-dashboard-toolbar-controls";
import { Button } from "@/components/ui/button";

import { AddDashboardDialog } from "./add-dashboard-dialog";
import type { ScopeReferenceSource } from "./scope-dashboards-contract";

export function WorkspaceAddDashboardButton({
  createDashboard,
  reference,
}: {
  /** Create a workspace dashboard (bound server-side to the viewer's own ref). */
  readonly createDashboard: (name: string) => Promise<MutatedEntityDashboard>;
  /** The reference section's actions, or null for a viewer who curates none. */
  readonly reference: ScopeReferenceSource | null;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [addOpen, setAddOpen] = useState(false);
  const [nameOpen, setNameOpen] = useState(false);

  return (
    <span className="contents">
      <Button
        type="button"
        size="sm"
        className="flex-none"
        data-action="open-add-picker -> add-picker-open"
        onClick={() => setAddOpen(true)}
      >
        <Plus data-icon="inline-start" aria-hidden />
        Add dashboard
      </Button>
      <AddDashboardDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        scopeLabel="Workspace"
        canCreate
        onChooseCreate={() => {
          setAddOpen(false);
          setNameOpen(true);
        }}
        reference={reference}
        catalog={null}
        onReferenceAdded={() => setAddOpen(false)}
        onCatalogAdded={() => {
          setAddOpen(false);
          startTransition(() => router.refresh());
        }}
      />
      <EntityDashboardNameDialog
        open={nameOpen}
        onOpenChange={setNameOpen}
        title="New dashboard"
        description="It homes in the workspace, beside your Overview."
        submitLabel="Create"
        onSubmit={async (name) => {
          const result = await createDashboard(name);
          if (result.ok) {
            startTransition(() => router.refresh());
            return { ok: true };
          }
          return { ok: false, message: ENTITY_DASHBOARD_REASON_COPY[result.reason] };
        }}
      />
    </span>
  );
}

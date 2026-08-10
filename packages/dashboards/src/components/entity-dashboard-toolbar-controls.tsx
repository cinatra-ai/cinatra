"use client";
/**
 * EntityDashboardsToolbarControls — the dashboard-select dropdown and the
 * add-a-dashboard button, rendered INSIDE `<CinatraDashboardToolbar>` for a
 * Dashboards-tab surface. Reads everything from `useEntityDashboards()`; renders
 * nothing when that context is absent (every non-entity dashboard surface), so
 * it is inert outside the entity shell.
 *
 * NO OVERFLOW ("⋯") CONTROL (owner review on cinatra#2474 PR5, PR #2638).
 * This toolbar used to carry a three-dot overflow button between the select and
 * the add button — the per-dashboard manage menu (Rename / Delete), offered for
 * the selected dashboard when `canWrite && !isDefault`. The owner asked for the
 * three dots to be removed from the toolbar, unconditionally, so it is gone.
 *
 * WHAT THAT STRANDS, stated plainly rather than quietly dropped: Rename and
 * Delete for an entity dashboard now have NO user-reachable entry point. The
 * capability itself is untouched — `EntityDashboardsContext.onRename` /
 * `.onDelete` are still wired by `entity-dashboards-shell.tsx` to the real
 * server actions, and those actions still authorize and still work — but nothing
 * in the UI calls them any more. Re-surfacing them is a render change in this
 * file alone; no contract, action or authorization was removed. (Overview was
 * already non-removable server-side, cinatra#700, so nothing there changes.)
 *
 * The remaining controls are capability-gated — the add button appears only when
 * `canCreate` (or when the scope offers an add-to-scope source) — so a member
 * who can read but not write a shared dashboard sees no write affordances.
 *
 * THE ADD BUTTON HAS TWO SHAPES (cinatra#2474 PR3), and the difference is a
 * PERMISSION difference, not decoration:
 *
 *   - **"Add dashboard"** — rendered only when the hosting landing handed down a
 *     §IX.1 add-to-scope `reference` source, which it does only for a principal
 *     who may WRITE the scope's collection (`actorMayWriteScope`, §IX.2). This
 *     opens the unified `<AddDashboardDialog>` (Create · Reference-existing ·
 *     the installed-catalog slot). The scope-management affordance §IX.2 gates
 *     IS this button, so a member without write authority must never see it.
 *   - **"+ New dashboard"** — the pre-existing per-user create, gated on
 *     `canCreate` alone. It is NOT the §IX.2 affordance (it curates nothing in
 *     the scope's collection — it creates the actor's own dashboard), so a
 *     member keeps it, exactly as before #2474.
 *
 * The catalog slot deliberately does NOT promote the button to "Add dashboard":
 * concept B (cinatra#2474 PR4/PR5) must not hand a non-manager the scope-level
 * Add, however actionable its own section becomes. Nor does it, on its own,
 * raise a button at all — see `offersCatalogAdd`.
 */
import { useState } from "react";
import { ChevronsUpDown, Loader2, Plus } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ToolbarButton, ToolbarGroup } from "@/components/ui/toolbar";
import { AddDashboardDialog } from "@/components/dashboards/add-dashboard-dialog";
import { useScopeAddSources } from "@/components/dashboards/scope-add-sources";

import { useEntityDashboards } from "./entity-dashboards-context";
import { EntityDashboardNameDialog } from "./entity-dashboard-name-dialog";

export function EntityDashboardsToolbarControls() {
  const ctx = useEntityDashboards();
  // Read unconditionally, ABOVE the `!ctx` bail — a hook may not be called
  // behind an early return (codex convergence).
  const scopeAdd = useScopeAddSources();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [addDialogOpen, setAddDialogOpen] = useState(false);

  // Rendered by the toolbar only where the shell mounts the provider; the null
  // guard keeps the component safe if it is ever mounted bare.
  if (!ctx) return null;

  const {
    dashboards,
    selectedId,
    pendingId,
    canCreate,
    busy,
    onSelect,
    onCreate,
    onAdopted,
  } = ctx;

  // Prefer the rendered selection; fall back to the pending target when the
  // selected row has just left the list, so the trigger label doesn't blink to a
  // placeholder during the reload.
  const selected =
    dashboards.find((d) => d.id === selectedId) ??
    dashboards.find((d) => d.id === pendingId) ??
    null;
  const activeId = pendingId ?? selectedId ?? undefined;

  // §IX.2 — the scope-level Add affordance exists ONLY where the landing handed
  // down the add-to-scope source, i.e. only for a principal who may write this
  // scope's collection. `catalog` alone never grants it: this predicate, and
  // NOTHING else, decides the "Add dashboard" label, the §IX.2 annotation and
  // the open-add-picker action (codex convergence — deriving them from "any
  // scope source" would hand a non-manager the exact management affordance
  // §IX.2 suppresses the moment cinatra#2474 PR4 supplies a catalog).
  const scopeReference = scopeAdd?.reference ?? null;
  const offersScopeAdd = scopeReference !== null;
  // Whether concept B's section carries a usable operation for THIS principal
  // (cinatra#2474 PR5 — the deliberate re-grounding of PR4's conjunct).
  //
  // PR4 required `canCreate` here for a REASON THAT NO LONGER APPLIES: its
  // catalog was browse-only, so a catalog alone put nothing pressable in the
  // popup. PR5 gives every row an Add — and that Add IS a create, into the
  // ACTING USER'S OWN collection for this entity, authorized by exactly the
  // owner-axis rule `canCreate` reports. So the conjunct stays, and stops being
  // a stand-in: it is now the catalog Add's own authorization precondition, and
  // the SAME value is handed to the section (through the dialog's
  // `CatalogAddOutcomeProvider`) to gate the button itself. The two can never
  // disagree — the popup cannot open on a catalog whose control it would then
  // suppress, and the section cannot offer a control the writer would refuse.
  const offersCatalogAdd = scopeAdd?.catalog != null && canCreate;
  // Whether the popup is worth opening at all — a strictly WIDER predicate that
  // may only decide the popup's existence, never the manager-only labelling.
  const offersUnifiedAdd = offersScopeAdd || offersCatalogAdd;

  return (
    <>
      <ToolbarGroup aria-label="Dashboard selection">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <ToolbarButton
              className="max-w-[16rem] text-foreground"
              aria-label="Select dashboard"
            >
              {pendingId ? (
                <Loader2
                  aria-hidden="true"
                  className="size-3.5 shrink-0 animate-spin"
                />
              ) : null}
              <span className="truncate font-semibold">
                {selected ? selected.name : "Dashboards"}
              </span>
              <ChevronsUpDown
                aria-hidden="true"
                className="size-3.5 shrink-0 opacity-60"
              />
            </ToolbarButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[14rem]">
            <DropdownMenuLabel>Dashboards</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={activeId}
              onValueChange={(id) => onSelect(id)}
            >
              {dashboards.map((d) => (
                <DropdownMenuRadioItem
                  key={d.id}
                  value={d.id}
                  disabled={busy && pendingId !== null}
                >
                  <span className="truncate">{d.name}</span>
                  {pendingId === d.id ? (
                    <Loader2
                      aria-hidden="true"
                      className="ml-auto size-3.5 shrink-0 animate-spin"
                    />
                  ) : null}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* NOTHING between the select and the add button. The three-dot
            overflow (Rename / Delete) that used to sit here is removed — see the
            file header for what that strands and how it is re-surfaced. */}

        {offersScopeAdd ? (
          // §IX.2's manage-control — "Add dashboard", the scope-level affordance.
          // It renders ONLY because the landing supplied the add-to-scope
          // source, which it does only for a scope manager.
          <div
            data-conformance-id="scope-dashboards-write-access"
            data-field="manage-controls=collectionAdd.actorMayWriteScope"
            className="contents"
          >
            <ToolbarButton
              onClick={() => setAddDialogOpen(true)}
              className="text-foreground"
              data-action="open-add-picker -> add-picker-open"
            >
              <Plus aria-hidden="true" className="size-3.5 shrink-0" />
              Add dashboard
            </ToolbarButton>
          </div>
        ) : offersUnifiedAdd || canCreate ? (
          // NOT a §IX.2 manage control: this creates the actor's OWN dashboard
          // for this entity (and, from PR4, copies one out of the installed
          // catalog) — it curates nothing in the scope's collection. It keeps
          // the label and the plain shape it had before #2474, and it opens the
          // popup only when there is more than the name prompt to offer.
          <ToolbarButton
            onClick={() =>
              offersUnifiedAdd
                ? setAddDialogOpen(true)
                : setCreateDialogOpen(true)
            }
            className="text-foreground"
          >
            <Plus aria-hidden="true" className="size-3.5 shrink-0" />
            New dashboard
          </ToolbarButton>
        ) : null}
      </ToolbarGroup>

      {/* The unified Add-dashboard popup (cinatra#2474 PR3). Mounted only where
          the landing offered a scope source, so every surface without one keeps
          exactly the controls it had. */}
      {offersUnifiedAdd && scopeAdd ? (
        <AddDashboardDialog
          open={addDialogOpen}
          onOpenChange={setAddDialogOpen}
          scopeLabel={scopeAdd.scopeLabel}
          canCreate={canCreate}
          onChooseCreate={() => {
            setAddDialogOpen(false);
            setCreateDialogOpen(true);
          }}
          reference={scopeReference}
          catalog={scopeAdd.catalog}
          onReferenceAdded={() => setAddDialogOpen(false)}
          // A catalog copy landed (cinatra#2474 PR5): close the popup and put
          // the new dashboard in the dropdown + on screen, exactly as Create
          // does. The summary came back from the server action already
          // authorized; the shell owns the list, so the shell adopts it.
          onCatalogAdded={(dashboard) => {
            setAddDialogOpen(false);
            onAdopted(dashboard);
          }}
        />
      ) : null}

      <EntityDashboardNameDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        title="New dashboard"
        description="Create an empty dashboard, then add portlets to it."
        submitLabel="Create"
        onSubmit={onCreate}
      />
    </>
  );
}

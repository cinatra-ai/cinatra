"use client";
/**
 * EntityDashboardsToolbarControls — the dashboard-select dropdown, the
 * per-dashboard manage menu (Rename / Delete), and the add-a-dashboard button,
 * rendered INSIDE `<CinatraDashboardToolbar>` for a Dashboards-tab surface.
 * Reads everything from `useEntityDashboards()`; renders nothing when that
 * context is absent (every non-entity dashboard surface), so it is inert outside
 * the entity shell.
 *
 * Overview is reflected as non-removable (cinatra#700 enforces it server-side):
 * the manage menu is offered ONLY for the selected dashboard when it is
 * `canWrite && !isDefault`, so the Overview default never shows Rename/Delete.
 * The controls are also capability-gated — the add button appears only when
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
 * concept B (cinatra#2474 PR4) must not hand a non-manager the scope-level Add.
 */
import { useState } from "react";
import {
  ChevronsUpDown,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ToolbarButton, ToolbarGroup } from "@/components/ui/toolbar";
import { AddDashboardDialog } from "@/components/dashboards/add-dashboard-dialog";
import { useScopeAddSources } from "@/components/dashboards/scope-add-sources";

import { useEntityDashboards } from "./entity-dashboards-context";
import { EntityDashboardNameDialog } from "./entity-dashboard-name-dialog";

type NameDialogState =
  | { readonly mode: "create" }
  | { readonly mode: "rename"; readonly id: string; readonly name: string }
  | null;

export function EntityDashboardsToolbarControls() {
  const ctx = useEntityDashboards();
  // Read unconditionally, ABOVE the `!ctx` bail — a hook may not be called
  // behind an early return (codex convergence).
  const scopeAdd = useScopeAddSources();
  const [nameDialog, setNameDialog] = useState<NameDialogState>(null);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{
    readonly id: string;
    readonly name: string;
  } | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

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
    onRename,
    onDelete,
  } = ctx;

  // Prefer the rendered selection; fall back to the pending target when the
  // selected row has just left the list (delete-of-selected), so the trigger
  // label + manage menu don't blink to a placeholder during the reload.
  const selected =
    dashboards.find((d) => d.id === selectedId) ??
    dashboards.find((d) => d.id === pendingId) ??
    null;
  const activeId = pendingId ?? selectedId ?? undefined;
  const canManageSelected =
    !!selected && selected.canWrite && !selected.isDefault;
  const showManage = canManageSelected && (!!onRename || !!onDelete);

  // §IX.2 — the scope-level Add affordance exists ONLY where the landing handed
  // down the add-to-scope source, i.e. only for a principal who may write this
  // scope's collection. `catalog` alone never grants it: this predicate, and
  // NOTHING else, decides the "Add dashboard" label, the §IX.2 annotation and
  // the open-add-picker action (codex convergence — deriving them from "any
  // scope source" would hand a non-manager the exact management affordance
  // §IX.2 suppresses the moment cinatra#2474 PR4 supplies a catalog).
  const scopeReference = scopeAdd?.reference ?? null;
  const offersScopeAdd = scopeReference !== null;
  // Whether the popup is worth opening at all — a strictly WIDER predicate that
  // may only decide the popup's existence, never the manager-only labelling.
  const offersUnifiedAdd = offersScopeAdd || scopeAdd?.catalog != null;

  async function handleDeleteConfirm() {
    if (!deleteTarget || !onDelete) return;
    setDeleteBusy(true);
    setDeleteError(null);
    const outcome = await onDelete(deleteTarget.id);
    setDeleteBusy(false);
    if (outcome.ok) {
      setDeleteTarget(null);
      return;
    }
    setDeleteError(outcome.message);
  }

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

        {showManage ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <ToolbarButton
                aria-label={`Manage ${selected?.name ?? "dashboard"}`}
                disabled={busy}
              >
                <MoreHorizontal aria-hidden="true" className="size-3.5 shrink-0" />
              </ToolbarButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {onRename ? (
                <DropdownMenuItem
                  onSelect={() =>
                    selected &&
                    setNameDialog({
                      mode: "rename",
                      id: selected.id,
                      name: selected.name,
                    })
                  }
                >
                  <Pencil aria-hidden="true" className="size-3.5 shrink-0" />
                  Rename
                </DropdownMenuItem>
              ) : null}
              {onRename && onDelete ? <DropdownMenuSeparator /> : null}
              {onDelete ? (
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() =>
                    selected &&
                    setDeleteTarget({ id: selected.id, name: selected.name })
                  }
                >
                  <Trash2 aria-hidden="true" className="size-3.5 shrink-0" />
                  Delete
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}

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
                : setNameDialog({ mode: "create" })
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
            setNameDialog({ mode: "create" });
          }}
          reference={scopeReference}
          catalog={scopeAdd.catalog}
          onReferenceAdded={() => setAddDialogOpen(false)}
        />
      ) : null}

      <EntityDashboardNameDialog
        open={nameDialog?.mode === "create"}
        onOpenChange={(open) => {
          if (!open) setNameDialog(null);
        }}
        title="New dashboard"
        description="Create an empty dashboard, then add portlets to it."
        submitLabel="Create"
        onSubmit={onCreate}
      />

      <EntityDashboardNameDialog
        open={nameDialog?.mode === "rename"}
        onOpenChange={(open) => {
          if (!open) setNameDialog(null);
        }}
        title="Rename dashboard"
        submitLabel="Save"
        initialName={nameDialog?.mode === "rename" ? nameDialog.name : ""}
        onSubmit={async (name) => {
          if (nameDialog?.mode !== "rename" || !onRename) {
            return { ok: false, message: "Rename is unavailable." };
          }
          return onRename(nameDialog.id, name);
        }}
      />

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deleteBusy) {
            setDeleteTarget(null);
            setDeleteError(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete “{deleteTarget?.name ?? ""}”?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteError ??
                "This permanently removes the dashboard and its saved layout. This can’t be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                // Keep the dialog open until the server confirms, so a failure
                // can surface inline rather than closing on an unfinished op.
                event.preventDefault();
                void handleDeleteConfirm();
              }}
              disabled={deleteBusy}
            >
              {deleteBusy ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

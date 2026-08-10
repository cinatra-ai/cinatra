"use client";
/**
 * EntityDashboardEditControls — Rename and Delete for the SELECTED entity
 * dashboard, rendered as a group inside the primary dashboard toolbar while it
 * is in EDIT MODE (owner review on cinatra#2474 PR5, PR #2638: "when clicking
 * 'Edit dashboard' … in the first of these toolbars … add a button that allows
 * to rename it and a button that allows to delete it").
 *
 * WHY THIS EXISTS, and what it restores. Rename and Delete used to hang off a
 * three-dot overflow button between the dashboard select and the add button.
 * The owner asked for the three dots to go (573a538fa), which left the two
 * capabilities wired but unreachable: `EntityDashboardsContext.onRename` /
 * `.onDelete` were preserved, and so were the server actions behind them. This
 * component gives them a user-reachable entry point again — in words, in the
 * edit toolbar the owner named, with NO overflow menu of any kind.
 *
 * PLACEMENT. `<CinatraDashboardToolbar>` mounts this inside its edit-controls
 * branch, after "Add text" / "Add portlet", as its own separated group. That is
 * the toolbar's own idiom for a change of subject: "Add text" and "Add portlet"
 * put content ON the dashboard, whereas Rename and Delete act on the dashboard
 * ITSELF. Both buttons are plain `<ToolbarButton>`s with the same 3.5-unit
 * leading icon as every sibling — no colour, size or shape this toolbar does
 * not already use. Delete's destructive weight is carried where it belongs: the
 * confirmation.
 *
 * GATING, unchanged from the removed menu. A control appears only for the
 * SELECTED dashboard when it is `canWrite && !isDefault`, and only when the
 * surface actually wired that handler. Overview (the default) therefore offers
 * neither — it is non-removable server-side too (cinatra#700) — and a read-only
 * dashboard never reaches edit mode in the first place, because the shell hands
 * `editable: selectedSummary.canWrite` to the grid.
 *
 * The dialogs stay mounted independently of the buttons: a delete that succeeds
 * changes the selection out from under this component, and the confirmation must
 * survive its own success long enough to close itself.
 */
import { useState } from "react";
import { Pencil, Trash2 } from "lucide-react";

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
import { ToolbarButton, ToolbarGroup, ToolbarSeparator } from "@/components/ui/toolbar";

import { useEntityDashboards } from "./entity-dashboards-context";
import { EntityDashboardNameDialog } from "./entity-dashboard-name-dialog";

/** The dashboard a dialog is acting on, captured at click time so a list
 *  reload underneath the open dialog cannot retarget it. */
type DashboardTarget = { readonly id: string; readonly name: string } | null;

export function EntityDashboardEditControls() {
  const ctx = useEntityDashboards();
  // Hooks run unconditionally, ABOVE the `!ctx` bail.
  const [renameTarget, setRenameTarget] = useState<DashboardTarget>(null);
  const [deleteTarget, setDeleteTarget] = useState<DashboardTarget>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Inert outside the entity Dashboards-tab shell (every single-dashboard
  // surface), exactly like the select/add controls.
  if (!ctx) return null;

  const { dashboards, selectedId, pendingId, busy, onRename, onDelete } = ctx;

  // Same resolution the select trigger uses, so the two controls can never name
  // a different dashboard than the one written on the picker: prefer the
  // rendered selection, and fall back to the pending target only when the
  // selected row has just left the list (delete-of-selected), so the group does
  // not blink out during the reload.
  const selected =
    dashboards.find((d) => d.id === selectedId) ??
    dashboards.find((d) => d.id === pendingId) ??
    null;
  const canManageSelected =
    !!selected && selected.canWrite && !selected.isDefault;
  const showManage = canManageSelected && (!!onRename || !!onDelete);
  // …and while that fallback is standing in, NOTHING is pressable. A control
  // may act only on the dashboard that is actually SELECTED, never on a
  // pending one it is merely labelled with, and never mid-mutation (codex
  // convergence: the fallback must not become an action target).
  const actionable = !busy && !!selected && selected.id === selectedId;

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
      {showManage && selected ? (
        <>
          <ToolbarSeparator />
          <ToolbarGroup aria-label="Dashboard management">
            {onRename ? (
              <ToolbarButton
                // The accessible name carries the dashboard, and CONTAINS the
                // visible word, so "Rename" is never ambiguous next to the
                // content controls while label-in-name still holds.
                aria-label={`Rename ${selected.name}`}
                disabled={!actionable}
                onClick={() =>
                  setRenameTarget({ id: selected.id, name: selected.name })
                }
              >
                <Pencil aria-hidden="true" className="size-3.5 shrink-0" />
                Rename
              </ToolbarButton>
            ) : null}
            {onDelete ? (
              <ToolbarButton
                aria-label={`Delete ${selected.name}`}
                disabled={!actionable}
                onClick={() => {
                  setDeleteError(null);
                  setDeleteTarget({ id: selected.id, name: selected.name });
                }}
              >
                <Trash2 aria-hidden="true" className="size-3.5 shrink-0" />
                Delete
              </ToolbarButton>
            ) : null}
          </ToolbarGroup>
        </>
      ) : null}

      <EntityDashboardNameDialog
        open={renameTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRenameTarget(null);
        }}
        title="Rename dashboard"
        submitLabel="Save"
        initialName={renameTarget?.name ?? ""}
        onSubmit={async (name) => {
          if (!renameTarget || !onRename) {
            return { ok: false, message: "Rename is unavailable." };
          }
          return onRename(renameTarget.id, name);
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

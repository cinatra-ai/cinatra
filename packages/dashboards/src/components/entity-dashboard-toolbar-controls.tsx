"use client";
/**
 * EntityDashboardsToolbarControls — the dashboard-select dropdown, the
 * per-dashboard manage menu (Rename / Delete), and the "+ New dashboard"
 * button, rendered INSIDE `<CinatraDashboardToolbar>` for a Dashboards-tab
 * surface. Reads everything from `useEntityDashboards()`; renders nothing when
 * that context is absent (every non-entity dashboard surface), so it is inert
 * outside the entity shell.
 *
 * Overview is reflected as non-removable (cinatra#700 enforces it server-side):
 * the manage menu is offered ONLY for the selected dashboard when it is
 * `canWrite && !isDefault`, so the Overview default never shows Rename/Delete.
 * The controls are also capability-gated — the New button appears only when
 * `canCreate` — so a member who can read but not write a shared dashboard sees
 * no write affordances.
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

import { useEntityDashboards } from "./entity-dashboards-context";
import { EntityDashboardNameDialog } from "./entity-dashboard-name-dialog";

type NameDialogState =
  | { readonly mode: "create" }
  | { readonly mode: "rename"; readonly id: string; readonly name: string }
  | null;

export function EntityDashboardsToolbarControls() {
  const ctx = useEntityDashboards();
  const [nameDialog, setNameDialog] = useState<NameDialogState>(null);
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

        {canCreate ? (
          <ToolbarButton
            onClick={() => setNameDialog({ mode: "create" })}
            className="text-foreground"
          >
            <Plus aria-hidden="true" className="size-3.5 shrink-0" />
            New dashboard
          </ToolbarButton>
        ) : null}
      </ToolbarGroup>

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

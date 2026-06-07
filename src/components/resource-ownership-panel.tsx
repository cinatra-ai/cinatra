"use client";

// ---------------------------------------------------------------------------
// ResourceOwnershipPanel.
//
// Generalized from `packages/agent-builder/src/permissions-tab-sharing.tsx`
// so the projects Permissions tab can mount the same UI for
// `cinatra.project_co_owners` without a fork.
//
// Behaviour preserved verbatim from the run flavour:
//   - Owner short-circuit + co-owner list with Avatar + name + email.
//   - cmdk Combobox in a Popover with 300 ms debounce / 0 ms on open,
//     `shouldFilter={false}` (server-side filtering — Pitfall 5).
//   - Optimistic add + remove with sonner Undo toast on remove.
//   - Last-owner guard (cannot remove last remaining owner).
//   - Self-removal AlertDialog confirm → router.push(redirect target).
//
// Per CLAUDE.md: shadcn primitives only, semantic tokens, ScopeBadge palette
// stays grandfathered inside `src/components/scope-badge.tsx` — this file
// uses no ownership-level palette classes.
// ---------------------------------------------------------------------------

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Lock, Trash2, Users } from "lucide-react";

import { toast } from "@/lib/cinatra-toast";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
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

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type OwnerView = {
  userId: string;
  name: string;
  email: string;
  image: string | null;
};

export type SharingCandidateView = {
  id: string;
  name: string;
  email: string;
  image: string | null;
};

export type ResourceMutationResult =
  | { ok: true }
  | { ok: false; error?: "last_owner" | string };

export type SharingSearchResult =
  | { ok: true; results: SharingCandidateView[] }
  | { ok: false };

export type ResourceOwnershipPanelProps = {
  /** "run" | "project" — drives copy + redirect default. */
  resourceType: "run" | "project";
  /** Backing resource id (runId / projectId). Passed back to action callbacks. */
  resourceId: string;
  /** When false, the add UI + remove buttons are hidden, lock icon shown. */
  allowSharing: boolean;
  /** Whether the viewing actor may edit (admin / owner). */
  canEdit: boolean;
  /** Resolved owner ("the run was launched by", "the project was created by"). */
  resourceOwner: OwnerView | null;
  /** Co-owners excluding the resource owner. */
  coOwners: OwnerView[];
  /** Logged-in user — used to detect self-removal flow. */
  currentUserId: string | null;

  // ---- action callbacks (host wires server actions / MCP calls) ----
  onSearch: (resourceId: string, query: string) => Promise<SharingSearchResult>;
  onAddCoOwner: (resourceId: string, userId: string) => Promise<ResourceMutationResult>;
  onRemoveCoOwner: (resourceId: string, userId: string) => Promise<ResourceMutationResult>;
  /** Optional: removing the resource owner. If undefined, owner has no remove button. */
  onRemoveOwner?: (resourceId: string) => Promise<ResourceMutationResult>;

  /** Where to redirect after a self-removal that loses access. */
  selfRemoveRedirect?: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) return "";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  const first = parts[0][0] ?? "";
  const last = parts[parts.length - 1][0] ?? "";
  return (first + last).toUpperCase();
}

function defaultRedirectFor(resourceType: "run" | "project"): string {
  return resourceType === "project" ? "/projects" : "/agents";
}

function copyFor(resourceType: "run" | "project") {
  if (resourceType === "project") {
    return {
      heading: "Ownership",
      description:
        "Owners have full rights to this project — view, edit, delete, and manage who has access.",
      selfRemoveDescription:
        "You will lose access to this project. You will be redirected to the projects page.",
    };
  }
  return {
    heading: "Ownership",
    description:
      "Owners have full rights to this run — view, re-run, edit, cancel, and manage who has access.",
    selfRemoveDescription:
      "You will lose access to this run. You will be redirected to the agents page.",
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ResourceOwnershipPanel({
  resourceType,
  resourceId,
  allowSharing,
  canEdit,
  resourceOwner: initialOwner,
  coOwners: initialCoOwners,
  currentUserId,
  onSearch,
  onAddCoOwner,
  onRemoveCoOwner,
  onRemoveOwner,
  selfRemoveRedirect,
}: ResourceOwnershipPanelProps) {
  const router = useRouter();
  const copy = copyFor(resourceType);
  const redirectTarget = selfRemoveRedirect ?? defaultRedirectFor(resourceType);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const [results, setResults] = useState<SharingCandidateView[]>([]);
  const [searching, setSearching] = useState(false);
  const [coOwners, setCoOwners] = useState<OwnerView[]>(initialCoOwners);
  const [resourceOwner, setResourceOwner] = useState<OwnerView | null>(initialOwner);
  const [pendingRemoveIds, setPendingRemoveIds] = useState<Set<string>>(new Set());
  const [selfRemovalTarget, setSelfRemovalTarget] = useState<{
    userId: string;
    name: string;
    isResourceOwner: boolean;
  } | null>(null);
  const [, startTransition] = useTransition();

  // Reconcile when server-resolved props change after router.refresh().
  useEffect(() => {
    setCoOwners(initialCoOwners);
  }, [initialCoOwners]);
  useEffect(() => {
    setResourceOwner(initialOwner);
  }, [initialOwner]);

  // Build the unified list of all owners (resource owner first, then co-owners).
  const allOwners: OwnerView[] = resourceOwner
    ? [resourceOwner, ...coOwners.filter((c) => c.userId !== resourceOwner.userId)]
    : coOwners;
  const totalOwnerCount = allOwners.length;
  const ownerIdSet = new Set(allOwners.map((o) => o.userId));

  // Immediate-on-open + debounced typeahead. Refetch keys on the owner count
  // so freshly-added users disappear from the list without a page refresh.
  useEffect(() => {
    if (!open) {
      setResults([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    const handle = window.setTimeout(async () => {
      setSearching(true);
      const result = await onSearch(resourceId, query);
      if (cancelled) return;
      setSearching(false);
      if (result.ok) {
        setResults(result.results);
      } else {
        setResults([]);
      }
    }, query.length === 0 ? 0 : 300);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [open, query, resourceId, onSearch]);

  // Belt-and-suspenders: filter results client-side against currently-displayed
  // owners so optimistic updates take effect immediately.
  const visibleResults = results.filter((r) => !ownerIdSet.has(r.id));

  const handleAdd = (candidate: SharingCandidateView) => {
    const optimistic: OwnerView = {
      userId: candidate.id,
      name: candidate.name,
      email: candidate.email,
      image: candidate.image,
    };
    setCoOwners((prev) =>
      prev.some((c) => c.userId === optimistic.userId)
        ? prev
        : [...prev, optimistic],
    );
    setQuery("");
    setOpen(false);
    startTransition(async () => {
      const result = await onAddCoOwner(resourceId, candidate.id);
      if (!result.ok) {
        setCoOwners((prev) => prev.filter((c) => c.userId !== candidate.id));
        toast.error("Could not add owner. Try again.");
        return;
      }
      toast.success(`${candidate.name} added.`);
      const refreshed = await onSearch(resourceId, "");
      if (refreshed.ok) setResults(refreshed.results);
      router.refresh();
    });
  };

  const handleRemove = (userId: string, name: string) => {
    const removed = coOwners.find((c) => c.userId === userId);
    setCoOwners((prev) => prev.filter((c) => c.userId !== userId));
    const state = { undone: false };
    toast.success(`${name} removed.`, {
      action: {
        label: "Undo",
        onClick: () => {
          state.undone = true;
          if (removed) {
            setCoOwners((prev) =>
              prev.some((c) => c.userId === userId) ? prev : [...prev, removed],
            );
          }
        },
      },
      duration: 5000,
    });
    setTimeout(() => {
      if (state.undone) return;
      setPendingRemoveIds((prev) => new Set(prev).add(userId));
      startTransition(async () => {
        const result = await onRemoveCoOwner(resourceId, userId);
        setPendingRemoveIds((prev) => {
          const next = new Set(prev);
          next.delete(userId);
          return next;
        });
        if (!result.ok) {
          if (removed) {
            setCoOwners((prev) =>
              prev.some((c) => c.userId === userId) ? prev : [...prev, removed],
            );
          }
          toast.error("Could not remove owner. Try again.");
        }
      });
    }, 5000);
  };

  const handleRemoveResourceOwner = (name: string) => {
    if (!resourceOwner || !onRemoveOwner) return;
    const removed = resourceOwner;
    setResourceOwner(null);
    setPendingRemoveIds((prev) => new Set(prev).add(removed.userId));
    startTransition(async () => {
      const result = await onRemoveOwner(resourceId);
      setPendingRemoveIds((prev) => {
        const next = new Set(prev);
        next.delete(removed.userId);
        return next;
      });
      if (!result.ok) {
        setResourceOwner(removed);
        if (result.error === "last_owner") {
          toast.error("Cannot remove the last owner.");
        } else {
          toast.error("Could not remove owner. Try again.");
        }
        return;
      }
      toast.success(`${name} removed.`);
      router.refresh();
    });
  };

  const showAdd = allowSharing && canEdit;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold text-foreground">{copy.heading}</h2>
        <p className="text-xs text-muted-foreground">{copy.description}</p>
      </div>

      {showAdd && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverAnchor asChild>
            <Input
              ref={inputRef}
              placeholder="Search by name or email…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                if (!open) setOpen(true);
              }}
              onClick={() => setOpen((prev) => !prev)}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.preventDefault();
              }}
              className="bg-surface-strong"
            />
          </PopoverAnchor>
          {/*
            cmdk specificity note.
            cmdk's <Command>/<CommandList>/<CommandItem> ship internal
            background utilities that win the cascade against PopoverContent's
            semantic tokens; without `bg-surface-strong` overrides
            here and on the inner Command/CommandList/CommandItem nodes, the
            popover renders with cmdk's defaults instead of the surface palette.
            A one-off swap to `!bg-popover` can fight semantic tokens
            differently at other cmdk sites, so cmdk-affected sites need to be
            handled holistically.
          */}
          <PopoverContent
            align="start"
            sideOffset={4}
            onOpenAutoFocus={(e) => e.preventDefault()}
            onInteractOutside={(e) => {
              const target = e.target as HTMLElement;
              if (inputRef.current?.contains(target)) {
                e.preventDefault();
              }
            }}
            className="w-[var(--radix-popover-trigger-width)] p-0 bg-surface-strong"
          >
            <Command shouldFilter={false} className="bg-surface-strong">
              <CommandList className="max-h-64 bg-surface-strong">
                {!searching && visibleResults.length === 0 && (
                  <CommandEmpty>No matches.</CommandEmpty>
                )}
                {searching && (
                  <CommandItem disabled className="italic text-muted-foreground">
                    <Loader2 className="size-4 animate-spin mr-2" /> Searching…
                  </CommandItem>
                )}
                {!searching && visibleResults.length > 0 && (
                  <CommandGroup className="p-0">
                    {visibleResults.map((r) => (
                      <CommandItem
                        key={r.id}
                        value={r.id}
                        onSelect={() => handleAdd(r)}
                        className="text-sm rounded-none px-3 py-2 bg-surface-strong hover:bg-surface-muted data-[selected=true]:bg-surface-muted"
                      >
                        <span className="text-foreground">{r.name}</span>
                        <span className="ml-2 text-xs text-muted-foreground truncate">
                          {r.email}
                        </span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      )}

      {allOwners.length > 0 ? (
        <ScrollArea
          className={allOwners.length > 6 ? "max-h-[280px]" : undefined}
        >
          <ul className="flex flex-col">
            {allOwners.map((c) => {
              const isPending = pendingRemoveIds.has(c.userId);
              const isResourceOwner = resourceOwner?.userId === c.userId;
              const showRemove = canEdit && (!isResourceOwner || onRemoveOwner !== undefined);
              const removeDisabled = isPending || totalOwnerCount <= 1;
              return (
                <li
                  key={c.userId}
                  className="flex items-center gap-3 py-2 border-b border-line last:border-b-0"
                >
                  <Avatar className="h-8 w-8 rounded-full">
                    <AvatarImage src={c.image ?? undefined} alt={c.name} />
                    <AvatarFallback>
                      {getInitials(c.name) || <Users className="size-4" />}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex flex-col flex-1 min-w-0 leading-tight">
                    <span className="text-sm font-medium text-foreground truncate">
                      {c.name}
                    </span>
                    <span className="text-xs text-muted-foreground truncate">
                      {c.email}
                    </span>
                  </div>
                  {showRemove ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove ${c.name}`}
                      onClick={() => {
                        if (currentUserId && c.userId === currentUserId) {
                          setSelfRemovalTarget({
                            userId: c.userId,
                            name: c.name,
                            isResourceOwner,
                          });
                          return;
                        }
                        if (isResourceOwner) {
                          handleRemoveResourceOwner(c.name);
                        } else {
                          handleRemove(c.userId, c.name);
                        }
                      }}
                      disabled={removeDisabled}
                      title={
                        totalOwnerCount <= 1
                          ? "Cannot remove the last owner"
                          : undefined
                      }
                      className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 size-8 rounded-control disabled:opacity-40"
                    >
                      {isPending ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Trash2 className="size-4" />
                      )}
                    </Button>
                  ) : (
                    <Lock
                      className="size-4 text-muted-foreground"
                      aria-hidden="true"
                    />
                  )}
                </li>
              );
            })}
          </ul>
        </ScrollArea>
      ) : null}

      <AlertDialog
        open={selfRemovalTarget !== null}
        onOpenChange={(o) => {
          if (!o) setSelfRemovalTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {resourceType === "project"
                ? "Remove yourself from this project?"
                : "Remove yourself from this run?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {copy.selfRemoveDescription}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const target = selfRemovalTarget;
                if (!target) return;
                setSelfRemovalTarget(null);
                setPendingRemoveIds((prev) => new Set(prev).add(target.userId));
                startTransition(async () => {
                  const result = target.isResourceOwner && onRemoveOwner
                    ? await onRemoveOwner(resourceId)
                    : await onRemoveCoOwner(resourceId, target.userId);
                  setPendingRemoveIds((prev) => {
                    const next = new Set(prev);
                    next.delete(target.userId);
                    return next;
                  });
                  if (!result.ok) {
                    toast.error(
                      result.error === "last_owner"
                        ? "Cannot remove the last owner."
                        : "Could not remove. Try again.",
                    );
                    return;
                  }
                  router.push(redirectTarget);
                });
              }}
            >
              Remove me
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

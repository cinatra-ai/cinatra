"use client";

// ---------------------------------------------------------------------------
// PermissionsPanel: the access picker, the ownership card, the scope line and
// the Save bar, drawn ONCE, in the package a connector pack can import
// (cinatra#3385).
//
// WHY IT LIVES HERE. The connector Sharing tab is offered by this package as
// one component. Until now that component took each panel's picker and
// ownership card as a host-supplied node, so a pack that adopted the tab still
// had no way to draw the controls inside it: the recommendation line, the lock
// glyph and the grant controls stayed in the app. This is that anatomy, moved,
// so the pack draws the same controls the app draws. One implementation,
// never two copies.
//
// WHAT STAYS IN THE HOST. Everything that decides, reads or writes: who may
// edit, which scopes an actor actually holds, what the connector declares, and
// the binding of the four actions to server actions. This panel receives all
// of that as DATA and CALLBACKS and decides nothing. The server re-derives
// every rule for itself. A disabled row here is an affordance, never the
// enforcement.
//
// Behaviour is the app's, unchanged: a 300 ms debounce (0 ms on open) over a
// `shouldFilter={false}` cmdk list, 20 rows a page with a 64 px scroll
// trigger, optimistic add and remove, the last-owner guard, and the
// self-removal confirm that navigates only after the server confirms.
// ---------------------------------------------------------------------------

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Lock, Trash2, Users } from "lucide-react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

import { toast } from "./toast";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar";
import { Button } from "./ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "./ui/command";
import { Input } from "./ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "./ui/popover";
import { ScrollArea } from "./ui/scroll-area";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";

import { AccessCombobox } from "./access-combobox";
import { resolveAccessSummary, type AvailableScopes } from "./access/scope";
import type { AllowedScopes } from "./access/containment";
import {
  normalizeVisibilitySelection,
  type AccessVisibility,
  type AccessVisibilitySelection,
} from "./lib/access-visibility";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type OwnerView = {
  userId: string;
  name: string;
  email: string;
  image: string | null;
};

export type SharingCandidate = {
  id: string;
  name: string;
  email: string;
  image: string | null;
};

export type PermissionsPanelResult = { ok: true } | { ok: false; error?: string };

export type PermissionsPanelSearchResult =
  | { ok: true; results: SharingCandidate[]; hasMore: boolean }
  | { ok: false; error?: string };

/**
 * The stored access policy this panel reads and writes. Structurally the
 * host's own policy shape; declared here so the panel needs no dependency on
 * the package that owns the policy's schema and its authorization rules.
 */
export type PermissionsPanelPolicy = {
  runListVisibility: AccessVisibilitySelection;
  runDataVisibility: AccessVisibilitySelection;
  runExecuteVisibility: AccessVisibilitySelection;
  allowRunSharing: boolean;
};

export type PermissionsPanelActions = {
  /** Persist the access policy. Called when the actor presses Save changes. */
  savePolicy: (policy: PermissionsPanelPolicy) => Promise<PermissionsPanelResult>;
  /**
   * Lazy-paginated people search for the ownership card. The panel passes
   * offset / limit; the caller returns trimmed rows and a hasMore flag.
   */
  searchCandidates: (
    query: string,
    page: { offset: number; limit: number },
  ) => Promise<PermissionsPanelSearchResult>;
  /** Add a co-owner. Called after the actor picks a candidate. */
  addCoOwner: (userId: string) => Promise<PermissionsPanelResult>;
  /** Remove a co-owner. */
  removeCoOwner: (userId: string) => Promise<PermissionsPanelResult>;
  /**
   * Remove the resource's primary owner. Optional: when omitted the owner row
   * carries no Remove button (a resource whose primary owner is intrinsic).
   */
  removeOwner?: () => Promise<PermissionsPanelResult>;
};

export type PermissionsPanelProps = {
  /** Whether the viewing actor may edit. The host decides this. */
  canEdit: boolean;
  /** The stored access policy the panel opens on. */
  initialPolicy: PermissionsPanelPolicy;
  /** The resource's primary owner. */
  owner: OwnerView | null;
  /** Co-owners, excluding the primary owner. */
  coOwners: OwnerView[];
  /** The scopes the actor actually holds. The host resolves them. */
  availableScopes: AvailableScopes;
  /**
   * Narrow the offered scopes to a parent's allowed set. Display input only:
   * the server independently rejects an out-of-scope selection.
   */
  allowedScopes?: AllowedScopes;
  /** The logged-in actor, used to recognise a self-removal. */
  currentUserId: string | null;
  /** When false, the add UI and the remove buttons are hidden. */
  allowSharing: boolean;
  /** Where a self-removal that loses access lands. The host resolves it. */
  selfRemoveRedirect: string;
  /** The line under the access picker. */
  accessHelperText?: string;
  /** The line under the people-search field. */
  ownershipHelperText?: string;
  /**
   * The value the picker OPENS on instead of the stored policy value: a
   * connector's recommended scope while the stored grant is the untouched
   * connect seed, or the canonical value under a ceiling. PRE-SELECTION ONLY:
   * nothing changes until the actor saves.
   */
  accessValueOverride?: string;
  /** Option values the picker draws locked (the ceiling affordance). */
  accessDisabledScopes?: string[];
  /** The reason each locked option carries. */
  accessDisabledReasons?: Record<string, string>;
  /** The ceiling line, or the recommendation line, under the picker. */
  accessScopeNote?: string;
  /** The four (or five) bindings. The host owns what they reach. */
  actions: PermissionsPanelActions;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PAGE_SIZE = 20;

// The access field is a NON-EMPTY array of visibility tokens. The canonical
// validation gate is server-side; this permissive client schema only
// guarantees non-emptiness so the picker always has a floor token.
const AccessFormSchema = z.object({ access: z.array(z.string()).nonempty() });
type AccessFormValues = z.infer<typeof AccessFormSchema>;

function getInitials(name: string): string {
  if (!name) return "";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) return "";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  const first = parts[0][0] ?? "";
  const last = parts[parts.length - 1][0] ?? "";
  return (first + last).toUpperCase();
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PermissionsPanel({
  canEdit,
  initialPolicy,
  owner: initialOwner,
  coOwners: initialCoOwners,
  availableScopes,
  allowedScopes,
  currentUserId,
  allowSharing,
  selfRemoveRedirect,
  accessHelperText = "Choose who can find and view it.",
  ownershipHelperText = "Owners have full rights such as view, edit, delete, manage permissions.",
  accessValueOverride,
  accessDisabledScopes,
  accessDisabledReasons,
  accessScopeNote,
  actions,
}: PermissionsPanelProps) {
  const router = useRouter();

  // -------------------------------------------------------------------------
  // Access form (locksteps the three visibility fields to a single selection)
  // -------------------------------------------------------------------------
  // `accessValueOverride` is a SINGLE-token preselect / lock override. It only
  // overrides when it genuinely DIFFERS from the stored primary token. When it
  // merely echoes the stored primary, the FULL stored selection is shown, so a
  // saved multi-scope policy is never collapsed to one token.
  const effectiveAccessSelection: string[] =
    accessValueOverride != null &&
    accessValueOverride !== initialPolicy.runListVisibility[0]
      ? [accessValueOverride]
      : [...initialPolicy.runListVisibility];
  // Stable dependency key for the reset effect (the array identity changes
  // every render).
  const effectiveAccessKey = effectiveAccessSelection.join(" ");
  const [isSavingPolicy, startSavePolicy] = useTransition();
  const { control, handleSubmit, reset: resetAccessForm } = useForm<AccessFormValues>({
    resolver: zodResolver(AccessFormSchema),
    defaultValues: { access: effectiveAccessSelection as [string, ...string[]] },
  });

  // `useForm.defaultValues` is captured only at mount. If the parent re-renders
  // with a new `initialPolicy` (after a refresh following a save, say), the
  // form keeps showing the stale value. Reset on every effective-value change
  // so the form always reflects the persisted state or the pre-selection.
  useEffect(() => {
    resetAccessForm({ access: effectiveAccessSelection as [string, ...string[]] });
    // effectiveAccessSelection is a fresh array each render; key on its content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveAccessKey, resetAccessForm]);

  const onSubmit = (values: AccessFormValues) => {
    startSavePolicy(async () => {
      // The picker already canonicalises live; normalize again defensively
      // before the write (the write path is the authority, and a double
      // normalize is idempotent).
      const selection = normalizeVisibilitySelection(
        values.access as AccessVisibility[],
      );
      const result = await actions.savePolicy({
        runListVisibility: selection,
        runDataVisibility: selection,
        runExecuteVisibility: selection,
        allowRunSharing: initialPolicy.allowRunSharing,
      });
      if (result.ok) {
        toast.success("Access policy saved.");
        router.refresh();
      } else if (result.error === "scope_locked_by_connector") {
        // The connector's declared ceiling refused the grant. The disabled
        // rows are the affordance, this is the enforcement surfacing.
        toast.error(
          "This connector locks its sharing scope — the selected scope is outside its allowed access.",
        );
      } else if (result.error === "invalid_locus") {
        toast.error(
          "The selected scope is not one of your organizations, teams, or projects.",
        );
      } else {
        toast.error("Could not save access policy. Try again.");
      }
    });
  };

  // -------------------------------------------------------------------------
  // Ownership state
  // -------------------------------------------------------------------------
  const [coOwners, setCoOwners] = useState<OwnerView[]>(initialCoOwners);
  const [owner, setOwner] = useState<OwnerView | null>(initialOwner);
  const [pendingRemoveIds, setPendingRemoveIds] = useState<Set<string>>(new Set());
  const [selfRemovalTarget, setSelfRemovalTarget] = useState<{
    userId: string;
    name: string;
    isOwner: boolean;
  } | null>(null);
  const [, startOwnershipTransition] = useTransition();

  useEffect(() => {
    setCoOwners(initialCoOwners);
  }, [initialCoOwners]);
  useEffect(() => {
    setOwner(initialOwner);
  }, [initialOwner]);

  const allOwners: OwnerView[] = owner
    ? [owner, ...coOwners.filter((c) => c.userId !== owner.userId)]
    : coOwners;
  const totalOwnerCount = allOwners.length;
  const ownerIdSet = new Set(allOwners.map((o) => o.userId));

  // -------------------------------------------------------------------------
  // Search popover state
  // -------------------------------------------------------------------------
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const [results, setResults] = useState<SharingCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    if (!open) {
      setResults([]);
      setSearching(false);
      setHasMore(false);
      return;
    }
    let cancelled = false;
    const handle = window.setTimeout(async () => {
      setSearching(true);
      const result = await actions.searchCandidates(query, { offset: 0, limit: PAGE_SIZE });
      if (cancelled) return;
      setSearching(false);
      if (result.ok) {
        setResults(result.results);
        setHasMore(result.hasMore);
      } else {
        setResults([]);
        setHasMore(false);
      }
    }, query.length === 0 ? 0 : 300);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [open, query, actions]);

  const handleListScroll = (event: React.UIEvent<HTMLDivElement>) => {
    if (!hasMore || loadingMore || searching) return;
    const el = event.currentTarget;
    const distanceFromBottom = el.scrollHeight - (el.scrollTop + el.clientHeight);
    if (distanceFromBottom > 64) return;
    setLoadingMore(true);
    const offset = results.length;
    void actions
      .searchCandidates(query, { offset, limit: PAGE_SIZE })
      .then((result) => {
        setLoadingMore(false);
        if (!result.ok) return;
        setResults((prev) => {
          const seen = new Set(prev.map((r) => r.id));
          const additions = result.results.filter((r) => !seen.has(r.id));
          return additions.length > 0 ? [...prev, ...additions] : prev;
        });
        setHasMore(result.hasMore);
      });
  };

  const visibleResults = results.filter((r) => !ownerIdSet.has(r.id));

  // -------------------------------------------------------------------------
  // Add / remove handlers
  // -------------------------------------------------------------------------
  const handleAdd = (candidate: SharingCandidate) => {
    const optimistic: OwnerView = {
      userId: candidate.id,
      name: candidate.name,
      email: candidate.email,
      image: candidate.image,
    };
    setCoOwners((prev) =>
      prev.some((c) => c.userId === optimistic.userId) ? prev : [...prev, optimistic],
    );
    setQuery("");
    setOpen(false);
    startOwnershipTransition(async () => {
      const result = await actions.addCoOwner(candidate.id);
      if (!result.ok) {
        setCoOwners((prev) => prev.filter((c) => c.userId !== candidate.id));
        toast.error("Could not add owner. Try again.");
        return;
      }
      toast.success(`${candidate.name} added.`);
      const refreshed = await actions.searchCandidates("", { offset: 0, limit: PAGE_SIZE });
      if (refreshed.ok) {
        setResults(refreshed.results);
        setHasMore(refreshed.hasMore);
      }
      router.refresh();
    });
  };

  // Returns Promise<boolean> so the self-removal confirm can await the actual
  // server result before navigating away: a failed removal must not redirect.
  const handleRemoveCoOwner = (userId: string, name: string): Promise<boolean> => {
    setCoOwners((prev) => prev.filter((c) => c.userId !== userId));
    setPendingRemoveIds((prev) => new Set(prev).add(userId));
    return new Promise<boolean>((resolve) => {
      startOwnershipTransition(async () => {
        const result = await actions.removeCoOwner(userId);
        setPendingRemoveIds((prev) => {
          const next = new Set(prev);
          next.delete(userId);
          return next;
        });
        if (!result.ok) {
          router.refresh();
          toast.error("Could not remove owner. Try again.");
          resolve(false);
          return;
        }
        toast.success(`${name} removed.`);
        resolve(true);
      });
    });
  };

  const handleRemoveOwner = (name: string): Promise<boolean> => {
    if (!owner || !actions.removeOwner) return Promise.resolve(false);
    const removedOwner = owner;
    setOwner(null);
    setPendingRemoveIds((prev) => new Set(prev).add(removedOwner.userId));
    return new Promise<boolean>((resolve) => {
      startOwnershipTransition(async () => {
        const result = await actions.removeOwner!();
        setPendingRemoveIds((prev) => {
          const next = new Set(prev);
          next.delete(removedOwner.userId);
          return next;
        });
        if (!result.ok) {
          setOwner(removedOwner);
          if (result.error === "last_owner") {
            toast.error("Cannot remove the last owner.");
          } else {
            toast.error("Could not remove owner. Try again.");
          }
          resolve(false);
          return;
        }
        toast.success(`${name} removed.`);
        router.refresh();
        resolve(true);
      });
    });
  };

  const showAdd = allowSharing && canEdit;
  const redirect = selfRemoveRedirect;

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      className="rounded-card border border-line px-6 py-5 flex flex-col gap-6 bg-surface"
    >
      {/* Access section */}
      <div className="flex flex-col gap-4">
        <h2 className="text-base font-semibold text-foreground">Access</h2>

        {!canEdit && (
          <p className="text-xs text-muted-foreground">
            You can view the access policy but cannot edit it.
          </p>
        )}

        <div className="flex flex-col gap-1.5">
          {canEdit ? (
            <Controller
              control={control}
              name="access"
              render={({ field: f }) => (
                <AccessCombobox
                  selectionMode="multiple"
                  value={f.value}
                  onChange={f.onChange}
                  scopes={availableScopes}
                  allowedScopes={allowedScopes}
                  disabledScopes={accessDisabledScopes}
                  disabledReasons={accessDisabledReasons}
                />
              )}
            />
          ) : (
            <span className="text-sm text-foreground">
              {resolveAccessSummary(
                initialPolicy.runListVisibility,
                availableScopes,
              )}
            </span>
          )}
          {accessScopeNote && (
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <Lock className="size-3 shrink-0" aria-hidden="true" />
              {accessScopeNote}
            </p>
          )}
          <p className="text-xs text-muted-foreground">{accessHelperText}</p>
        </div>
      </div>

      {/* Ownership section */}
      <div className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-foreground">Ownership</h2>

        {showAdd && (
          <div className="flex flex-col gap-1.5">
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
                  <CommandList
                    onScroll={handleListScroll}
                    className="max-h-64 bg-surface-strong"
                  >
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
                    {loadingMore && (
                      <div className="flex items-center justify-center gap-2 px-3 py-2 text-xs italic text-muted-foreground">
                        <Loader2 className="size-3 animate-spin" /> Loading more…
                      </div>
                    )}
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            <p className="text-xs text-muted-foreground">{ownershipHelperText}</p>
          </div>
        )}

        {allOwners.length > 0 ? (
          <ScrollArea className={allOwners.length > 6 ? "max-h-[280px]" : undefined}>
            <ul className="flex flex-col">
              {allOwners.map((c) => {
                const isPending = pendingRemoveIds.has(c.userId);
                const isResourceOwner = owner?.userId === c.userId;
                const showRemove = canEdit && (isResourceOwner ? !!actions.removeOwner : true);
                const removeDisabled = isPending || totalOwnerCount <= 1;
                return (
                  <li
                    key={c.userId}
                    className="flex items-center gap-3 py-2 border-b border-line last:border-b-0"
                  >
                    {/* `size-9` is pinned here because this package's Avatar
                        defaults to `size-8` while the app's defaults to
                        `size-9`. Stating it keeps the merged class SET
                        identical to the one the app produced before the
                        extraction, so the row is unchanged for a person. */}
                    <Avatar className="size-9 h-8 w-8 rounded-full">
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
                              isOwner: isResourceOwner,
                            });
                            return;
                          }
                          if (isResourceOwner) {
                            handleRemoveOwner(c.name);
                          } else {
                            handleRemoveCoOwner(c.userId, c.name);
                          }
                        }}
                        disabled={removeDisabled}
                        title={totalOwnerCount <= 1 ? "Cannot remove the last owner" : undefined}
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
      </div>

      {/* Save bar */}
      {canEdit && (
        <div className="flex justify-end">
          <Button type="submit" disabled={isSavingPolicy}>
            {isSavingPolicy && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
            )}
            {isSavingPolicy ? "Saving…" : "Save changes"}
          </Button>
        </div>
      )}

      {/* Self-removal confirm */}
      <AlertDialog
        open={selfRemovalTarget !== null}
        onOpenChange={(o) => {
          if (!o) setSelfRemovalTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove yourself?</AlertDialogTitle>
            <AlertDialogDescription>
              You will lose access to this resource. You will be redirected to{" "}
              <span className="font-mono text-foreground">{redirect}</span>.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                // Navigate only after the server confirms the removal.
                const target = selfRemovalTarget;
                if (!target) return;
                setSelfRemovalTarget(null);
                const ok = target.isOwner
                  ? await handleRemoveOwner(target.name)
                  : await handleRemoveCoOwner(target.userId, target.name);
                if (ok) {
                  router.push(redirect);
                }
              }}
            >
              Remove me
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </form>
  );
}

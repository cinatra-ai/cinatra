"use client";

// ---------------------------------------------------------------------------
// PermissionsForm.
//
// Generic widget that composes the existing AccessComboboxHierarchical (the
// hierarchical "Only me / Project / Team / Organization / Workspace" picker)
// with an ownership panel (owner + co-owners list, lazy-loaded user search).
// Designed to be reused for every resource that carries an
// AgentAuthPolicy-shaped access policy + a co-owner list:
//
//   • agent runs  — used by packages/agents/src/permissions-tab-client.tsx
//   • skill packages
//   • individual skills
//   • upload-time policy capture (transient mode)
//
// Behaviour preserved verbatim from the agent-run flavour:
//   - cmdk Combobox in a Popover with 300 ms debounce / 0 ms on open,
//     `shouldFilter={false}` (server-side filtering).
//   - Lazy-load pagination: 20 rows per page, fetches next page when the
//     CommandList scrolls within 64 px of bottom.
//   - Optimistic add + remove with sonner undo on remove.
//   - Last-owner guard (cannot remove the last remaining owner).
//   - Self-removal AlertDialog confirm → router.push(redirect target).
// ---------------------------------------------------------------------------

import {
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
import { Loader2, Lock, Trash2, Users } from "lucide-react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

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

import {
  AccessComboboxHierarchical,
  resolveAccessLabel,
  type AvailableScopes,
} from "@/components/access-combobox-hierarchical";
import type {
  AgentAuthPolicy,
  AgentAuthPolicyVisibility,
} from "@cinatra-ai/agents/auth-policy";

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

export type PermissionsFormResourceKind =
  | "agent_run"
  | "agent_template"
  | "skill_package"
  | "skill"
  // The uniform access model covers connector / artifact / workflow too.
  // Kept in lockstep with @cinatra-ai/extensions ExtensionKind (client-safe
  // literal copy — permissions-kind-hooks is server-only, so this union is not
  // imported from it).
  | "connector"
  | "artifact"
  | "workflow";

export type PermissionsFormResult =
  | { ok: true }
  | { ok: false; error?: string };

export type PermissionsFormSearchResult =
  | { ok: true; results: SharingCandidate[]; hasMore: boolean }
  | { ok: false; error?: string };

export type PermissionsFormActions = {
  /** Persist the access policy. Called when the user clicks Save. */
  savePolicy: (policy: AgentAuthPolicy) => Promise<PermissionsFormResult>;
  /**
   * Lazy-paginated user search for the owner picker. The component passes
   * offset / limit; the server returns trimmed rows + a hasMore flag.
   */
  searchCandidates: (
    query: string,
    page: { offset: number; limit: number },
  ) => Promise<PermissionsFormSearchResult>;
  /** Add a co-owner. Called after the user picks a candidate. */
  addCoOwner: (userId: string) => Promise<PermissionsFormResult>;
  /** Remove a co-owner. */
  removeCoOwner: (userId: string) => Promise<PermissionsFormResult>;
  /**
   * Remove the resource's primary owner. Optional — when omitted the owner
   * row has no Remove button (used for resources whose primary owner is
   * intrinsic, e.g. agent runs where runBy is the launching user).
   */
  removeOwner?: () => Promise<PermissionsFormResult>;
};

export type PermissionsFormProps = {
  resourceKind: PermissionsFormResourceKind;
  /** Whether the viewing actor may edit (admin / owner). */
  canEdit: boolean;
  /** Initial access policy (locksteps list/data/execute visibility in v1). */
  initialPolicy: AgentAuthPolicy;
  /** Resource's primary owner (the user who created it). */
  owner: OwnerView | null;
  /** Co-owners (excluding the primary owner). */
  coOwners: OwnerView[];
  /** Available scopes for the access picker. */
  availableScopes: AvailableScopes;
  /** The logged-in user — used to detect self-removal. */
  currentUserId: string | null;
  /** When false, the add UI + remove buttons are hidden, lock icon shown. */
  allowSharing: boolean;
  /** Server-action bindings. */
  actions: PermissionsFormActions;
  /** Where to redirect on a self-removal that loses access. */
  selfRemoveRedirect?: string;
  /**
   * Override the default "Choose who can find and view it." helper text under
   * the access combobox. Optional.
   */
  accessHelperText?: string;
  /**
   * Override the default ownership helper text under the user-search input.
   * Optional.
   */
  ownershipHelperText?: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PAGE_SIZE = 20;

const AccessFormSchema = z.object({ access: z.string() });
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

function defaultRedirectFor(resourceKind: PermissionsFormResourceKind): string {
  if (resourceKind === "skill_package" || resourceKind === "skill") return "/skills";
  if (resourceKind === "agent_template") return "/configuration/extensions";
  return "/agents";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PermissionsForm({
  resourceKind,
  canEdit,
  initialPolicy,
  owner: initialOwner,
  coOwners: initialCoOwners,
  availableScopes,
  currentUserId,
  allowSharing,
  actions,
  selfRemoveRedirect,
  accessHelperText = "Choose who can find and view it.",
  ownershipHelperText = "Owners have full rights such as view, edit, delete, manage permissions.",
}: PermissionsFormProps) {
  const router = useRouter();

  // -------------------------------------------------------------------------
  // Access form (locksteps runListVisibility / runDataVisibility /
  // runExecuteVisibility to a single value)
  // -------------------------------------------------------------------------
  const [isSavingPolicy, startSavePolicy] = useTransition();
  const { control, handleSubmit, reset: resetAccessForm } = useForm<AccessFormValues>({
    resolver: zodResolver(AccessFormSchema),
    defaultValues: { access: initialPolicy.runListVisibility },
  });

  // `useForm.defaultValues` is captured only at mount. If the parent
  // re-renders with a new `initialPolicy` (e.g. after
  // a router.refresh() following a save, or when the same form widget is
  // re-used across resource-kind transitions), the form keeps showing the
  // stale access value. Reset on every `initialPolicy.runListVisibility`
  // change so the form always reflects the persisted state.
  useEffect(() => {
    resetAccessForm({ access: initialPolicy.runListVisibility });
  }, [initialPolicy.runListVisibility, resetAccessForm]);

  const onSubmit = (values: AccessFormValues) => {
    startSavePolicy(async () => {
      const access = values.access as AgentAuthPolicyVisibility;
      const policy: AgentAuthPolicy = {
        runListVisibility: access,
        runDataVisibility: access,
        runExecuteVisibility: access,
        allowRunSharing: initialPolicy.allowRunSharing,
      };
      const result = await actions.savePolicy(policy);
      if (result.ok) {
        toast.success("Access policy saved.");
        router.refresh();
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

  // Return Promise<boolean> so the self-removal AlertDialog can await the
  // actual server-action result before navigating away. This prevents a
  // failed removal from redirecting the user. Background-thread
  // (non-self-removal) callers can still ignore the returned promise; their
  // behavior is unchanged.
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
  const redirect = selfRemoveRedirect ?? defaultRedirectFor(resourceKind);

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
                <AccessComboboxHierarchical
                  value={f.value}
                  onChange={f.onChange}
                  scopes={availableScopes}
                />
              )}
            />
          ) : (
            <span className="text-sm text-foreground">
              {resolveAccessLabel(
                initialPolicy.runListVisibility,
                availableScopes,
              )}
            </span>
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
                // Only push the redirect after the server confirms the
                // removal. This prevents navigation when the removal fails.
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

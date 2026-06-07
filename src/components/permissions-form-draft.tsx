"use client";

// ---------------------------------------------------------------------------
// PermissionsFormDraft.
//
// Controlled (transient) variant of PermissionsForm for upload-time policy
// capture. The bound `<PermissionsForm>` widget saves immediately on every
// action; the draft variant collects policy + co-owner picks into local
// state and lets the parent submit them as part of a larger create action.
//
// Use sites:
//   • /configuration/extensions/upload — GitHub tab.
//   • Future: ZIP tab once agent_template_co_owners + accessPolicy land.
//
// Why a separate component instead of a `mode` prop on PermissionsForm:
//   - The bound form has a Save button + sonner toasts + router.refresh()
//     + AlertDialog self-removal handling. Draft mode needs none of that.
//   - The bound form's add/remove are async transitions with optimistic
//     rollback on server failure. Draft mode is pure local state.
//   - Mixing both would balloon the prop surface and risk forgetting to
//     suppress one mode's behaviour in the other.
// ---------------------------------------------------------------------------

import {
  useEffect,
  useRef,
  useState,
} from "react";
import { Loader2, Trash2, Users } from "lucide-react";

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
  AccessComboboxHierarchical,
  type AvailableScopes,
} from "@/components/access-combobox-hierarchical";
import type { AgentAuthPolicy } from "@cinatra-ai/agents/auth-policy";
import type {
  OwnerView,
  SharingCandidate,
  PermissionsFormSearchResult,
} from "@/components/permissions-form";

const PAGE_SIZE = 20;

export type PermissionsFormDraftValue = {
  policy: AgentAuthPolicy;
  coOwners: OwnerView[];
};

export type PermissionsFormDraftProps = {
  value: PermissionsFormDraftValue;
  onChange: (next: PermissionsFormDraftValue) => void;
  availableScopes: AvailableScopes;
  /**
   * Lazy-paginated user search. Same shape as PermissionsFormActions['searchCandidates'].
   * Bound by the parent to an admin-gated server action that doesn't require
   * an existing resource id (upload-time, the resource doesn't exist yet).
   */
  searchCandidates: (
    query: string,
    page: { offset: number; limit: number },
  ) => Promise<PermissionsFormSearchResult>;
  /** When false, the form renders read-only (rare on the upload path; kept for parity). */
  disabled?: boolean;
};

function getInitials(name: string): string {
  if (!name) return "";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) return "";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  const first = parts[0][0] ?? "";
  const last = parts[parts.length - 1][0] ?? "";
  return (first + last).toUpperCase();
}

export function PermissionsFormDraft({
  value,
  onChange,
  availableScopes,
  searchCandidates,
  disabled = false,
}: PermissionsFormDraftProps) {
  const { policy, coOwners } = value;

  // Access change → locksteps the three visibility fields. Mirrors the bound
  // PermissionsForm's onSubmit projection so the draft + bound paths agree on
  // shape; downstream compatibility projection depends on this.
  const setAccess = (next: string) => {
    const access = next as AgentAuthPolicy["runListVisibility"];
    onChange({
      ...value,
      policy: {
        runListVisibility: access,
        runDataVisibility: access,
        runExecuteVisibility: access,
        allowRunSharing: policy.allowRunSharing,
      },
    });
  };

  const setCoOwners = (next: OwnerView[]) => {
    onChange({ ...value, coOwners: next });
  };

  // -------------------------------------------------------------------------
  // Ownership search popover (mirrors PermissionsForm internals)
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
      const result = await searchCandidates(query, { offset: 0, limit: PAGE_SIZE });
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
  }, [open, query, searchCandidates]);

  const handleListScroll = (event: React.UIEvent<HTMLDivElement>) => {
    if (!hasMore || loadingMore || searching) return;
    const el = event.currentTarget;
    const distanceFromBottom = el.scrollHeight - (el.scrollTop + el.clientHeight);
    if (distanceFromBottom > 64) return;
    setLoadingMore(true);
    const offset = results.length;
    void searchCandidates(query, { offset, limit: PAGE_SIZE })
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

  const coOwnerIds = new Set(coOwners.map((c) => c.userId));
  const visibleResults = results.filter((r) => !coOwnerIds.has(r.id));

  const handleAdd = (candidate: SharingCandidate) => {
    if (coOwnerIds.has(candidate.id)) {
      setQuery("");
      setOpen(false);
      return;
    }
    setCoOwners([
      ...coOwners,
      {
        userId: candidate.id,
        name: candidate.name,
        email: candidate.email,
        image: candidate.image,
      },
    ]);
    setQuery("");
    setOpen(false);
  };

  const handleRemove = (userId: string) => {
    setCoOwners(coOwners.filter((c) => c.userId !== userId));
  };

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div className="rounded-card border border-line px-6 py-5 flex flex-col gap-6 bg-surface">
      {/* Access section */}
      <div className="flex flex-col gap-4">
        <h2 className="text-base font-semibold text-foreground">Access</h2>
        <div className="flex flex-col gap-1.5">
          <AccessComboboxHierarchical
            value={policy.runListVisibility}
            onChange={setAccess}
            scopes={availableScopes}
            disabled={disabled}
          />
          <p className="text-xs text-muted-foreground">
            Choose who can find and view it.
          </p>
        </div>
      </div>

      {/* Ownership section */}
      <div className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-foreground">Ownership</h2>

        {!disabled && (
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
            <p className="text-xs text-muted-foreground">
              Owners have full rights such as view, edit, delete, manage permissions.
            </p>
          </div>
        )}

        {coOwners.length > 0 && (
          <ScrollArea className={coOwners.length > 6 ? "max-h-[280px]" : undefined}>
            <ul className="flex flex-col">
              {coOwners.map((c) => (
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
                  {!disabled && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove ${c.name}`}
                      onClick={() => handleRemove(c.userId)}
                      className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 size-8 rounded-control"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </ScrollArea>
        )}
      </div>
    </div>
  );
}

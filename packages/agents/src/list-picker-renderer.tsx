"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/lib/cinatra-toast";
import { fetchAvailableLists, type AvailableListSummary } from "./list-picker-actions";
import type {
  FieldRendererProps,
} from "./field-renderer-registry";

// ---------------------------------------------------------------------------
// Condition
// ---------------------------------------------------------------------------

// Condition: registered from the manifest binding (kind "list-picker") with
// strict ID + bare-alias matching — see register-default-renderers.ts.

// ---------------------------------------------------------------------------
// Value shape
// ---------------------------------------------------------------------------

type ListPickerValue = {
  scope: "list";
  listId: string;
  listName: string;
  memberCount: number;
};

function toListPickerValue(value: unknown): ListPickerValue {
  // Defensive value normalization for the HITL renderer payload.
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    return {
      scope: "list",
      listId: typeof v.listId === "string" ? v.listId : "",
      listName: typeof v.listName === "string" ? v.listName : "",
      memberCount: typeof v.memberCount === "number" ? v.memberCount : 0,
    };
  }
  return { scope: "list", listId: "", listName: "", memberCount: 0 };
}

function formatLastUpdated(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  try {
    return `${formatDistanceToNow(d, { addSuffix: true })}`;
  } catch {
    return "—";
  }
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export function ListPickerRenderer({
  value,
  onChange,
  disabled,
  required,
  error,
  label,
  description,
}: FieldRendererProps) {
  const [lists, setLists] = useState<AvailableListSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const current = toListPickerValue(value);
  const [selectedId, setSelectedId] = useState<string | null>(
    current.listId ? current.listId : null,
  );

  // Stable ref to onChange so the effect below doesn't re-fire on every
  // parent re-render.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  // Mount-once fetch, guarded with a cancellation flag so React Strict Mode's
  // double-mount in dev does not double-fetch.
  useEffect(() => {
    let cancelled = false;
    fetchAvailableLists()
      .then((items) => {
        if (!cancelled) {
          setLists(items);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoading(false);
          toast.error("Could not load lists.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // v1: client-side search filter only. The crm_list_search facade accepts a
  // server-side query param, but the v1 dataset is small enough that
  // round-tripping per keystroke is wasteful. Switch to server-side when the
  // dataset outgrows ~200 lists.
  const filteredLists = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return lists;
    return lists.filter((l) => l.name.toLowerCase().includes(q));
  }, [lists, search]);

  function handleSelect(list: AvailableListSummary) {
    setSelectedId(list.id);
    onChangeRef.current({
      scope: "list",
      listId: list.id,
      listName: list.name,
      memberCount: list.memberCount,
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <Label className="text-foreground">
        {label}
        {required ? " *" : ""}
      </Label>
      {description ? (
        <p className="text-xs text-muted-foreground">{description}</p>
      ) : (
        <p className="text-xs text-muted-foreground">
          Pick a list to send this campaign to. Lists are reusable saved sets of
          contacts.
        </p>
      )}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input
          type="search"
          placeholder="Search lists by name"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          disabled={disabled || loading}
          className="sm:max-w-sm"
          aria-label="Search lists by name"
        />
        {/*
          "Create new list" affordance retired. CRM lists are scoped to the
          provider (Twenty Views); operators create them via the Twenty UI
          or via the list-curator-agent run dispatched below. Direct CRUD
          on lists from a cinatra route was removed alongside the
          `lists_*` MCP retirement.
        */}
        {/*
          "Build a list with AI" CTA.
          Deep-links to a NEW list-curator-agent run. The operator completes
          the curator's two HITL gates (scrape-schema-review + final-list-review)
          there; on completion they return to this picker with the new listId
          pre-selected via the ?onComplete query param.

          Separate-run UX (not nested HITL): the WayFlow runtime does not yet
          support surfacing child HITL gates in a parent run, so deep-linking
          keeps the child run's review gates visible and actionable.
        */}
        <Button asChild type="button" variant="default" disabled={disabled}>
          <a
            href="/agents/cinatra-ai/list-curator-agent/new?onComplete=list-picker"
            target="_blank"
            rel="noreferrer"
            data-testid="build-list-with-ai-cta"
          >
            Build a list with AI
          </a>
        </Button>
      </div>

      {loading ? (
        <p className="text-xs text-muted-foreground">Loading lists…</p>
      ) : filteredLists.length === 0 ? (
        <Card className="border-line bg-surface">
          <CardContent className="py-6 text-center text-sm text-muted-foreground">
            {lists.length === 0
              ? "No lists yet. Create one to get started."
              : "No lists match your search."}
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-2">
          {filteredLists.map((list) => {
            const isSelected = selectedId === list.id;
            return (
              <Card
                key={list.id}
                role="button"
                tabIndex={disabled ? -1 : 0}
                aria-pressed={isSelected}
                data-selected={isSelected ? "true" : "false"}
                onClick={() => {
                  if (!disabled) handleSelect(list);
                }}
                onKeyDown={(e) => {
                  if (disabled) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    handleSelect(list);
                  }
                }}
                className={[
                  "cursor-pointer transition-colors",
                  isSelected
                    ? "border-primary bg-primary/5"
                    : "border-line bg-surface hover:border-primary/50",
                  disabled ? "opacity-50 cursor-not-allowed" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-sm font-medium text-foreground">
                    <span className="flex-1 truncate">{list.name}</span>
                    <Badge variant="secondary">{list.memberType}</Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                  <span>
                    {list.memberCount} contact{list.memberCount === 1 ? "" : "s"}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>Updated {formatLastUpdated(list.lastUpdated)}</span>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

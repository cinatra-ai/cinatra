"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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

function selectedListIds(value: unknown): string[] {
  let decoded = value;
  if (typeof decoded === "string") {
    try { decoded = JSON.parse(decoded); } catch { return []; }
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return [];
  const source = decoded as Record<string, unknown>;
  const ids = Array.isArray(source.listIds) ? source.listIds : [source.listId];
  return [...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0))];
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
  context,
  schema,
  bindingParams,
  mode,
  onValidityChange,
  registerFlush,
}: FieldRendererProps) {
  const runId = context?.runId;
  const [loaded, setLoaded] = useState<{ runId: string | undefined; lists: AvailableListSummary[] } | null>(null);
  const lists = useMemo(() => loaded !== null && loaded.runId === runId ? loaded.lists : [], [loaded, runId]);
  const loading = loaded?.runId !== runId || loaded === null;
  const [search, setSearch] = useState("");
  const multiple = bindingParams?.selection === "multiple";
  const declaredMinimum = bindingParams?.minSelected;
  const minimum = typeof declaredMinimum === "number" && Number.isSafeInteger(declaredMinimum)
    ? Math.max(1, declaredMinimum) : 1;
  const idsFromValue = selectedListIds(value);
  const selectionSource = JSON.stringify([runId, idsFromValue]);
  const [selection, setSelection] = useState({ source: selectionSource, ids: idsFromValue });
  const selectedIds = selection.source === selectionSource ? selection.ids : idsFromValue;
  function setSelectedIds(ids: string[]) { setSelection({ source: selectionSource, ids }); }
  const checkboxId = useId();
  const readOnly = disabled || mode === "view";
  const valid = !loading && selectedIds.length >= (multiple ? minimum : 1)
    && selectedIds.every((id) => lists.some((list) => list.id === id));
  useEffect(() => { onValidityChange?.(valid); }, [onValidityChange, valid]);

  // Stable ref to onChange so the effect below doesn't re-fire on every
  // parent re-render.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  // The run whose step this renderer is drawing. `context.runId` is the shared
  // field-renderer contract's run identity
  // (packages/sdk-ui/src/field-renderer-props.ts). It is what authorizes the
  // loader (cinatra#3050): the lists are loaded with the RUN's access, not with
  // a platform-administrator session, so the run's own non-administrator owner
  // is no longer redirected to `/not-authorized` at this step.
  // Mount-once fetch, guarded with a cancellation flag so React Strict Mode's
  // double-mount in dev does not double-fetch. Keyed on the run identity so a
  // runId that only arrives after mount re-issues the (now authorized) load.
  useEffect(() => {
    let cancelled = false;
    fetchAvailableLists(runId ?? "")
      .then((items) => {
        if (!cancelled) {
          setLoaded({ runId, lists: items });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoaded({ runId, lists: [] });
          toast.error("Could not load lists.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  // v1: client-side search filter only. The crm_list_search facade accepts a
  // server-side query param, but the v1 dataset is small enough that
  // round-tripping per keystroke is wasteful. Switch to server-side when the
  // dataset outgrows ~200 lists.
  const filteredLists = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return lists;
    return lists.filter((l) => l.name.toLowerCase().includes(q));
  }, [lists, search]);

  const selectedValue = multiple ? {
    type: "list", listIds: selectedIds,
    listNames: selectedIds.map((id) => lists.find((item) => item.id === id)?.name ?? ""),
  } : (() => {
    const list = lists.find((item) => item.id === selectedIds[0]);
    return { scope: "list", listId: list?.id ?? "", listName: list?.name ?? "", memberCount: list?.memberCount ?? null };
  })();
  const serializedSelection = JSON.stringify(selectedValue);
  useEffect(() => {
    registerFlush?.(async () => {
      if (valid) onChangeRef.current(multiple && schema.type === "string"
        ? serializedSelection : JSON.parse(serializedSelection));
    });
  }, [registerFlush, valid, multiple, schema.type, serializedSelection]);

  function handleSelect(list: AvailableListSummary) {
    if (multiple) {
      const liveIds = selectedIds.filter((id) => lists.some((item) => item.id === id));
      const nextIds = liveIds.includes(list.id)
        ? liveIds.filter((id) => id !== list.id) : [...liveIds, list.id];
      setSelectedIds(nextIds);
      const next = {
        type: "list",
        listIds: nextIds,
        listNames: nextIds.map((id) => lists.find((item) => item.id === id)!.name),
      };
      // A declared string input carries JSON, rather than accidentally taking
      // the setup submit's grouped-object road and losing the field name.
      onChangeRef.current(schema.type === "string" ? JSON.stringify(next) : next);
      return;
    }
    setSelectedIds([list.id]);
    onChangeRef.current({
      scope: "list",
      listId: list.id,
      listName: list.name,
      memberCount: list.memberCount,
    });
  }

  // The gate header (cinatra#3720), drawn as the artifact review drawing's
  // list step draws it: ONE row with the question the agent declared for the
  // step and, while the gate waits, the pill "Awaiting your pick". The question
  // is the binding's declared `question`, else the label; a blank or absent one
  // draws no element at all, so no empty band is left. A read-only replay of a
  // settled gate (`mode="view"`) never claims to wait.
  const declaredQuestion =
    typeof bindingParams?.question === "string" &&
    bindingParams.question.trim() !== ""
      ? bindingParams.question
      : typeof label === "string" && label.trim() !== ""
        ? label
        : null;
  const waiting = mode !== "view";

  return (
    <div className="flex flex-col gap-3">
      {declaredQuestion !== null || waiting ? (
        <div
          className="flex flex-wrap items-center gap-2.5"
          data-testid="list-picker-gate-header"
        >
          {declaredQuestion !== null ? (
            <span
              className="font-sans text-sm font-bold text-foreground"
              data-testid="list-picker-gate-question"
            >
              {declaredQuestion}
              {required ? " *" : ""}
            </span>
          ) : null}
          {waiting ? (
            <span
              className="inline-flex items-center gap-1.5 rounded-full border border-brand-mustard/40 bg-brand-mustard/15 px-2.5 py-0.5 text-xs font-semibold text-mustard-ink"
              data-testid="list-picker-gate-waiting"
            >
              <span
                className="size-[7px] rounded-full bg-brand-mustard"
                aria-hidden="true"
              />
              Awaiting your pick
            </span>
          ) : null}
        </div>
      ) : null}
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
          disabled={readOnly || loading}
          className="sm:max-w-sm"
          aria-label="Search lists by name"
        />

      </div>

      {loading ? (
        <p className="text-xs text-muted-foreground">Loading lists…</p>
      ) : filteredLists.length === 0 ? (
        <Card className="border-line bg-surface">
          <CardContent className="py-6 text-center text-sm text-muted-foreground">
            {lists.length === 0
              ? (typeof bindingParams?.emptyState === "string"
                ? bindingParams.emptyState : "No lists yet. Create one to get started.")
              : "No lists match your search."}
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-2">
          {filteredLists.map((list) => {
            const isSelected = selectedIds.includes(list.id);
            return (
              <Card
                key={list.id}
                role={multiple ? undefined : "button"}
                tabIndex={multiple ? undefined : readOnly ? -1 : 0}
                aria-pressed={multiple ? undefined : isSelected}
                data-selected={isSelected ? "true" : "false"}
                onClick={() => {
                  if (!readOnly) handleSelect(list);
                }}
                onKeyDown={(e) => {
                  if (readOnly || multiple) return;
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
                  readOnly ? "opacity-50 cursor-not-allowed" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-sm font-medium text-foreground">
                    {multiple ? (
                      <Checkbox
                        id={`${checkboxId}-${list.id}`}
                        aria-label={list.name}
                        checked={isSelected}
                        disabled={readOnly}
                        onClick={(event) => event.stopPropagation()}
                        onCheckedChange={() => handleSelect(list)}
                      />
                    ) : null}
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

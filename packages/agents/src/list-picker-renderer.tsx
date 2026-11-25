"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
  context,
  mode,
  bindingParams,
  onRequestRefresh,
}: FieldRendererProps) {
  // The list step's readings (design specs/app-artifact-review.html I.1) are
  // declared INSIDE this component, drawn from the card and the badge this
  // renderer already imports: the host display floor
  // (scripts/audit/host-display-floor-gate.baseline.json) takes no new
  // top-level declaration and no new import for this renderer.
  //
  // Whether the step may change: `mode` absent or "edit", `disabled` absent or false.
  const isWritable = (props: Pick<FieldRendererProps, "mode" | "disabled">): boolean =>
    (props.mode === undefined || props.mode === "edit") &&
    (props.disabled === undefined || props.disabled === false);
  // The lists a new read offers, or null for a failed read. The host's
  // `onRequestRefresh` resolves `{ lists: [{ id, name }], listsRead }`
  // (hitl-gate-submit.ts `ListStepReadValue`); only `listsRead: "ok"` offers
  // rows. The read asks for contact lists, as the first load does, so each row
  // is a contact list; the read carries no count and no update time.
  const listsOfRead = (answer: unknown): AvailableListSummary[] | null => {
    if (!answer || typeof answer !== "object") return null;
    const { lists: rows, listsRead } = answer as { lists?: unknown; listsRead?: unknown };
    if (listsRead !== "ok" || !Array.isArray(rows)) return null;
    const seen = new Set<string>();
    const out: AvailableListSummary[] = [];
    for (const entry of rows) {
      if (!entry || typeof entry !== "object") continue;
      const { id, name } = entry as { id?: unknown; name?: unknown };
      if (typeof id !== "string" || id.trim() === "" || seen.has(id)) continue;
      if (typeof name !== "string" || name.trim() === "") continue;
      seen.add(id);
      out.push({ id, name, memberCount: null, lastUpdated: null, memberType: "contact" });
    }
    return out;
  };

  const [lists, setLists] = useState<AvailableListSummary[]>([]);
  const [loading, setLoading] = useState(true);
  // A read that fails is never drawn as an empty list (design I.1): the step
  // keeps whether its last read failed and draws the failed-read alert for it.
  const [readFailed, setReadFailed] = useState(false);
  // True while a Try again read is pending: the step draws the loading reading.
  const [reading, setReading] = useState(false);
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

  // The props and the pick as they are now, for code that runs after an await.
  const latest = useRef({ mode, disabled, selectedId, valueListId: current.listId });
  useEffect(() => {
    latest.current = { mode, disabled, selectedId, valueListId: current.listId };
  });
  // The pick last written TO THIS HOST, so a new read writes only a pick that
  // changed. It starts UNKNOWN (null), not as an empty pick: the step assumes
  // nothing about what the host's buffer holds (the run panel and the stepper
  // start theirs empty, the conversation's card can carry a non-empty one
  // across a move). So the first successful read writes the reconciled pick
  // once: the kept pick, or the empty pick when the pick the value names is no
  // longer offered. The one exception is a read that names no pick for a
  // value that names none either: there is nothing to replace, and writing an
  // empty pick there would stage an empty answer on a setup gate.
  const lastWritten = useRef<{ listId: string; listName: string } | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // The run whose step this renderer is drawing. `context.runId` is the shared
  // field-renderer contract's run identity
  // (packages/sdk-ui/src/field-renderer-props.ts). It is what authorizes the
  // loader (cinatra#3050): the lists are loaded with the RUN's access, not with
  // a platform-administrator session, so the run's own non-administrator owner
  // is no longer redirected to `/not-authorized` at this step.
  const runId = context?.runId;

  // ONE RECONCILIATION FOR EVERY READ THAT SUCCEEDED (cinatra#3562), whether
  // it is the first load, a load the run identity re-issued, or Try again: its
  // lists replace the drawn ones, and, while the step may change, the pick is
  // the chosen list if the read still offers it, with the name the read gives
  // it, else no pick. The first such read writes it once (see `lastWritten`);
  // after that, a pick that differs from the pick last written (the list
  // dropped or renamed) is written once through the current `onChange`, and
  // the same read again writes nothing. A failed, rejected or malformed read
  // never comes here: it draws the failed reading and keeps the pick as it is.
  function acceptRead(read: AvailableListSummary[]) {
    setLists(read);
    setReadFailed(false);
    const now = latest.current;
    if (!isWritable(now)) return;
    const kept = read.find((list) => list.id === now.selectedId) ?? null;
    if (kept === null && now.selectedId !== null) setSelectedId(null);
    const pick = { listId: kept?.id ?? "", listName: kept?.name ?? "" };
    const last = lastWritten.current;
    if (last === null && pick.listId === "" && now.valueListId === "") {
      lastWritten.current = pick;
      return;
    }
    if (last === null || pick.listId !== last.listId || pick.listName !== last.listName) {
      lastWritten.current = pick;
      onChangeRef.current({
        scope: "list",
        listId: pick.listId,
        listName: pick.listName,
        memberCount: kept?.memberCount ?? 0,
      });
    }
  }
  const acceptReadRef = useRef(acceptRead);
  useEffect(() => {
    acceptReadRef.current = acceptRead;
  });

  // Mount-once fetch, guarded with a cancellation flag so React Strict Mode's
  // double-mount in dev does not double-fetch. Keyed on the run identity so a
  // runId that only arrives after mount re-issues the (now authorized) load.
  // A rejected load is the failed reading (design I.1), drawn in place as the
  // step's alert rather than as an empty list; it keeps the pick. A missing CRM
  // capability is asked to reject too, as Try again reads it: it is "could not
  // read", never an empty list to reconcile the pick against.
  useEffect(() => {
    let cancelled = false;
    fetchAvailableLists(runId ?? "", { missingCapability: "failed" })
      .then((items) => {
        if (!cancelled) {
          acceptReadRef.current(items);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setReadFailed(true);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  const writes = isWritable({ mode, disabled });

  // Try again (cinatra#3562): the host reads the lists again for the step the
  // run waits at. The press answers nothing: it sends nothing to the gate and
  // the run does not resume. A second press while a read is pending does
  // nothing. A read that ends after the step is gone sets nothing; one that
  // ends after the step was locked (disabled, or drawn read-only) is dropped.
  // A read that succeeded takes the one reconciliation (`acceptRead`); a
  // failed, rejected or malformed one draws the failed reading and changes
  // nothing else.
  async function refresh() {
    if (!writes || typeof onRequestRefresh !== "function" || inFlight.current) return;
    inFlight.current = true;
    setReading(true);
    let answer: unknown;
    try {
      answer = await onRequestRefresh();
    } catch {
      answer = null;
    }
    inFlight.current = false;
    if (!mounted.current) return;
    const now = latest.current;
    if (!isWritable(now)) {
      setReading(false);
      return;
    }
    const read = listsOfRead(answer);
    setReading(false);
    if (read === null) {
      setReadFailed(true);
      return;
    }
    acceptRead(read);
  }

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
    lastWritten.current = { listId: list.id, listName: list.name };
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
          disabled={disabled || loading || reading}
          className="sm:max-w-sm"
          aria-label="Search lists by name"
        />
        {/*
          No road out of the step (cinatra#3562): the "Create new list"
          affordance and the "Build a list with AI" link to a list-building
          run are gone. The step picks from the lists that fetchAvailableLists
          returns and creates none.
        */}
      </div>

      {loading || reading ? (
        // The loading reading (I.1, run-list-step-loading): a skeleton in each
        // row's place, drawn with the design system Skeleton's own treatment
        // (src/components/ui/skeleton.tsx), which is not imported: this renderer
        // is reached from the server routes the route-graph ratchet locks.
        <div
          className="flex flex-col gap-2"
          aria-busy="true"
          data-testid="list-picker-loading"
          data-conformance-id="run-list-step-loading"
        >
          {[0, 1, 2].map((key) => (
            <Card key={key} className="border-line bg-surface">
              <CardHeader>
                <span
                  data-slot="skeleton"
                  className="block h-4 w-[46%] animate-pulse rounded-[4px] bg-muted"
                />
              </CardHeader>
              <CardContent>
                <span
                  data-slot="skeleton"
                  className="block h-3 w-[62%] animate-pulse rounded-[4px] bg-muted"
                />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : readFailed ? (
        // The failed reading (I.1, run-list-step-error): the host's one message
        // for a failed list read, in the alert's place, with Try again.
        <Card
          role="alert"
          className="flex-row items-start gap-2.5 rounded-lg border border-destructive bg-surface-strong px-4 py-3 text-foreground ring-0"
          data-testid="list-picker-read-failed"
          data-conformance-id="run-list-step-error"
        >
          <p className="m-0 min-w-0 flex-1 text-sm text-foreground">
            This list could not be read.
          </p>
          {writes && typeof onRequestRefresh === "function" ? (
            <button
              type="button"
              className="inline-flex h-7 flex-none items-center justify-center gap-1 rounded-[min(var(--radius-md),12px)] border border-border bg-background px-2.5 font-display text-[0.8rem] font-medium whitespace-nowrap outline-none transition-all select-none hover:bg-muted hover:text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:translate-y-px disabled:pointer-events-none disabled:opacity-50 dark:border-input dark:bg-input-fill/30 dark:hover:bg-input-fill/50"
              data-testid="list-picker-try-again"
              onClick={() => {
                void refresh();
              }}
            >
              Try again
            </button>
          ) : null}
        </Card>
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

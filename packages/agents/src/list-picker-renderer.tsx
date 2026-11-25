"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
// The list step's readings (design specs/app-artifact-review.html I.1)
// ---------------------------------------------------------------------------

/** The host's one message for a failed list read (I.1, run-list-step-error). */
const FAILED_READ_READING = "This list could not be read.";

const TRY_AGAIN_WORDS = "Try again";

/**
 * What the step says with no list to pick when the binding declared no
 * empty-state message. The design draws the agent's declared message; this
 * line only keeps the page from being blank without one.
 */
const NOTHING_TO_PICK_READING = "There is no list to pick on this step yet.";

/** A declared param that is a string and not blank, else null. */
function declaredWords(
  params: FieldRendererProps["bindingParams"],
  key: string,
): string | null {
  const words = params?.[key];
  return typeof words === "string" && words.trim() !== "" ? words : null;
}

/** Whether the step may change: `mode` absent or "edit", `disabled` absent or false. */
function isWritable(props: Pick<FieldRendererProps, "mode" | "disabled">): boolean {
  return (
    (props.mode === undefined || props.mode === "edit") &&
    (props.disabled === undefined || props.disabled === false)
  );
}

/**
 * The lists a new read offers, or null for a failed read. The host's
 * `onRequestRefresh` resolves `{ lists: [{ id, name }], listsRead }`
 * (hitl-gate-submit.ts `ListStepReadValue`); only `listsRead: "ok"` offers
 * rows. The read asks for contact lists, as the first load does, so each row
 * is a contact list; the read carries no count and no update time.
 */
function listsOfRead(answer: unknown): AvailableListSummary[] | null {
  if (!answer || typeof answer !== "object") return null;
  const { lists, listsRead } = answer as { lists?: unknown; listsRead?: unknown };
  if (listsRead !== "ok" || !Array.isArray(lists)) return null;
  const seen = new Set<string>();
  const out: AvailableListSummary[] = [];
  for (const entry of lists) {
    if (!entry || typeof entry !== "object") continue;
    const { id, name } = entry as { id?: unknown; name?: unknown };
    if (typeof id !== "string" || id.trim() === "" || seen.has(id)) continue;
    if (typeof name !== "string" || name.trim() === "") continue;
    seen.add(id);
    out.push({ id, name, memberCount: null, lastUpdated: null, memberType: "contact" });
  }
  return out;
}

/**
 * One skeleton bar, drawn with the design system Skeleton's own treatment
 * (src/components/ui/skeleton.tsx). The primitive is not imported: this
 * renderer is reached from the server routes the route-graph ratchet locks,
 * and the bar needs none of the primitive's code.
 */
function SkeletonBar({ className }: { className: string }) {
  return (
    <span
      data-slot="skeleton"
      className={`block animate-pulse rounded-[4px] bg-muted ${className}`}
    />
  );
}

/** The loading reading (I.1, run-list-step-loading): a skeleton in each row's place. */
function LoadingRows() {
  return (
    <div
      className="flex flex-col gap-2"
      aria-busy="true"
      data-testid="list-picker-loading"
      data-conformance-id="run-list-step-loading"
    >
      {[0, 1, 2].map((key) => (
        <Card key={key} className="border-line bg-surface">
          <CardHeader>
            <SkeletonBar className="h-4 w-[46%]" />
          </CardHeader>
          <CardContent>
            <SkeletonBar className="h-3 w-[62%]" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
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
  onValidityChange,
}: FieldRendererProps) {
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
  const latest = useRef({ mode, disabled, selectedId });
  useEffect(() => {
    latest.current = { mode, disabled, selectedId };
  });
  // The pick last written, so a new read writes only a pick that changed.
  const lastWritten = useRef({ listId: current.listId, listName: current.listName });
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

  // Mount-once fetch, guarded with a cancellation flag so React Strict Mode's
  // double-mount in dev does not double-fetch. Keyed on the run identity so a
  // runId that only arrives after mount re-issues the (now authorized) load.
  // A rejected load is the failed reading (design I.1), drawn in place as the
  // step's alert rather than as an empty list.
  useEffect(() => {
    let cancelled = false;
    fetchAvailableLists(runId ?? "")
      .then((items) => {
        if (!cancelled) {
          setLists(items);
          setReadFailed(false);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLists([]);
          setReadFailed(true);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  const writes = isWritable({ mode, disabled });

  // Continue stays unavailable until a row is picked (design I.1: "the
  // Continue stays unavailable until a row is picked"; while the list is read
  // or cannot be read "the Continue stays unavailable"). The step reports
  // through `onValidityChange` (props contract 1): `false` while no drawn list
  // is picked, `true` once one is. It reports when the step opens and again
  // only when the answer changes, and only while the step may change.
  const valid =
    !loading &&
    !reading &&
    !readFailed &&
    selectedId !== null &&
    lists.some((list) => list.id === selectedId);
  const reportValidity = useRef(onValidityChange);
  useEffect(() => {
    reportValidity.current = onValidityChange;
  });
  useEffect(() => {
    if (writes) reportValidity.current?.(valid);
  }, [writes, valid]);

  // Try again (cinatra#3562): the host reads the lists again for the step the
  // run waits at. The press answers nothing: it sends nothing to the gate and
  // the run does not resume. A second press while a read is pending does
  // nothing. A read that ends after the step is gone sets nothing; one that
  // ends after the step was locked (disabled, or drawn read-only) is dropped.
  // After a read the step accepts, its lists replace the first load's. The
  // pick is the chosen list if the read still offers it, with the name the
  // read gives it, else no pick; when that differs from the pick last written
  // (the list dropped or renamed), it is written once through the current
  // `onChange`, else nothing is written.
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
      setLists([]);
      setReadFailed(true);
    } else {
      setLists(read);
      setReadFailed(false);
    }
    const kept = (read ?? []).find((list) => list.id === now.selectedId) ?? null;
    if (kept === null && now.selectedId !== null) setSelectedId(null);
    const pick = { listId: kept?.id ?? "", listName: kept?.name ?? "" };
    const last = lastWritten.current;
    if (pick.listId !== last.listId || pick.listName !== last.listName) {
      lastWritten.current = pick;
      onChangeRef.current({
        scope: "list",
        listId: pick.listId,
        listName: pick.listName,
        memberCount: kept?.memberCount ?? 0,
      });
    }
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
        <LoadingRows />
      ) : readFailed ? (
        <Alert
          variant="destructive"
          className="flex items-start gap-2.5 border-destructive bg-surface-strong text-foreground"
          data-testid="list-picker-read-failed"
          data-conformance-id="run-list-step-error"
        >
          <p className="m-0 min-w-0 flex-1 text-sm text-foreground">
            {FAILED_READ_READING}
          </p>
          {writes && typeof onRequestRefresh === "function" ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="flex-none"
              data-testid="list-picker-try-again"
              onClick={() => {
                void refresh();
              }}
            >
              {TRY_AGAIN_WORDS}
            </Button>
          ) : null}
        </Alert>
      ) : lists.length === 0 ? (
        <p
          role="status"
          className="text-sm text-foreground"
          data-testid="list-picker-empty"
          data-conformance-id="run-list-step-empty-source"
        >
          {declaredWords(bindingParams, "emptyState") ?? NOTHING_TO_PICK_READING}
        </p>
      ) : filteredLists.length === 0 ? (
        <Card className="border-line bg-surface">
          <CardContent className="py-6 text-center text-sm text-muted-foreground">
            No lists match your search.
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

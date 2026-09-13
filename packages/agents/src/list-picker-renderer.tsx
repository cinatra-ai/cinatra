"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { List } from "lucide-react";
import { toast } from "@/lib/cinatra-toast";
import { fetchAvailableLists, type AvailableListSummary } from "./list-picker-actions";
import {
  newRunHrefWithCompletionReturn,
  readCompletionProduced,
} from "@/lib/agent-url";
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
}: FieldRendererProps) {
  const [lists, setLists] = useState<AvailableListSummary[]>([]);
  const [loading, setLoading] = useState(true);
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
  useEffect(() => {
    let cancelled = false;
    fetchAvailableLists(runId ?? "")
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
  }, [runId]);

  function handleSelect(list: AvailableListSummary) {
    setSelectedId(list.id);
    onChangeRef.current({
      scope: "list",
      listId: list.id,
      listName: list.name,
      memberCount: list.memberCount,
    });
  }

  // THE LIST A FINISHED RUN MADE FOR THIS STEP IS OFFERED (cinatra#3358).
  //
  // The road this step offers carries the parked run's identity forward; the
  // return carries back, on the parked run's own address, the id of what the
  // finished run produced (`@/lib/agent-url`). When that id names one of the
  // rows this step just loaded, the step opens with it CHOSEN — the reader who
  // has just made a list is not asked to find it again — and the gate is
  // answerable at once.
  //
  // IT NEVER OVERRIDES A READER. A step re-opened on an answer it already holds
  // keeps that answer: the offer seeds only a step that holds none.
  const offered = useMemo(
    () =>
      readCompletionProduced(
        typeof window === "undefined" ? "" : window.location.search,
      ),
    [],
  );
  // The offered row, DERIVED rather than stored: a reader's own pick always
  // wins, and the offer needs no state of its own to be shown as chosen.
  const offeredRow = useMemo(
    () => (offered ? (lists.find((l) => l.id === offered) ?? null) : null),
    [offered, lists],
  );
  // THE ANSWER THE STEP ALREADY HOLDS, whenever it arrived. `selectedId` reads
  // the step's answer as it stood AT MOUNT and afterwards only what this reader
  // pressed, so an answer arriving through a later render — a step re-hydrated
  // while the rows were still loading — was invisible to the offer below and
  // could be overwritten by it. The held answer is therefore read from the
  // CURRENT value on every render, and the offer defers to it.
  const heldAnswer = selectedId ?? (current.listId ? current.listId : null);
  const shownAsChosen = heldAnswer ?? offeredRow?.id ?? null;
  // The gate's answer is the one thing the step must actually emit, and it is
  // emitted ONCE: the offer answers the question the step is parked on, so the
  // Continue is available without a second press on a row the reader already
  // made.
  const offerEmitted = useRef(false);
  useEffect(() => {
    if (!offeredRow || heldAnswer || offerEmitted.current) return;
    offerEmitted.current = true;
    onChangeRef.current({
      scope: "list",
      listId: offeredRow.id,
      listName: offeredRow.name,
      memberCount: offeredRow.memberCount,
    });
  }, [offeredRow, heldAnswer]);

  // THE MAKE-ONE ROAD, drawn where the gate-that-lists draws it: UNDER the rows
  // (Agent run & review §I.1 — "Under the rows sits Generate new ideas ... and
  // the primary Continue, right-aligned over a hairline floor"). The primary
  // Continue itself is the gate's own control floor, one level up; this is the
  // secondary road beside it.
  //
  // THE RETURN IS ADDRESSED, NOT DESCRIBED (cinatra#3358). The href used to
  // carry `onComplete=list-picker` alone, which named the step that offered
  // the road but not the run parked at it — so nothing downstream could work
  // out where to go back to, and the completion contract was read nowhere. The
  // link now carries this run's own identity beside the name, and the generic
  // new-run launcher carries the pair onto the run it creates (the contract's
  // query keys and their readers live in the agent-path grammar,
  // `@/lib/agent-url`). A step with no run identity in hand still offers the
  // bare road: the link opens, it just has no return.
  //
  // Separate-run UX (not nested HITL): the runtime does not yet support
  // surfacing child gates in a parent run, so deep-linking keeps the child
  // run's review gates visible and actionable.
  //
  // "Create new list" stays retired. CRM lists are scoped to the provider, so
  // operators make one through the provider's own screens or through the run
  // this road starts.
  const makeOneRoad = (
    <div className="flex justify-start">
      <Button asChild type="button" variant="default" disabled={disabled}>
        <Link
          href={newRunHrefWithCompletionReturn(
            "/agents/cinatra-ai/list-curator-agent/new",
            "list-picker",
            runId,
          )}
          target="_blank"
          rel="noreferrer"
          data-testid="build-list-with-ai-cta"
        >
          Build a list with AI
        </Link>
      </Button>
    </div>
  );

  return (
    <div className="flex flex-col gap-3" data-conformance-id="gate-that-lists">
      {/* THE GATE OPENS ON ITS QUESTION, OVER ITS STATE LINE (Agent run &
          review §I.1: "Which idea should this run draft?" over "Awaiting your
          pick"). The question is the step's own — declared by the package that
          raised the gate — and the line beneath it says where the gate stands,
          never what to do about it. */}
      <div className="flex flex-col gap-1">
        <h3
          className="text-sm font-semibold text-foreground"
          data-testid="list-picker-question"
        >
          {label}
          {required ? " *" : ""}
        </h3>
        <p
          className="text-xs text-muted-foreground"
          data-testid="list-picker-state-line"
        >
          {loading
            ? "Loading lists…"
            : lists.length === 0
              ? "Nothing to pick"
              : "Awaiting your pick"}
        </p>
      </div>
      {description ? (
        <p className="text-xs text-muted-foreground">{description}</p>
      ) : null}

      {loading ? null : lists.length === 0 ? (
        // THE ZERO-CONTENT READING IS THE DRAWN EMPTY STATE (Components §
        // Empty state: "centred / dashed circle icon / 14px headline · 12px
        // helper / primary action"). It was a plain card carrying one grey
        // sentence, which is the "just empty text" the section names. The
        // primary action sits OUTSIDE the panel — the make-one road below —
        // so the panel states the fact and the road answers it.
        <Empty className="border border-dashed border-line bg-surface py-6">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <List aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>No lists yet.</EmptyTitle>
            <EmptyDescription>
              Build one and it will be offered here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col gap-2">
          {lists.map((list) => {
            const isSelected = shownAsChosen === list.id;
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

      {makeOneRoad}

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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

// THE STEP TAKES SEVERAL ENTRIES (cinatra#3562). The ruling this gate is drawn
// from reads "The user must select at least one view/list and can select
// multiple ones", so the answer is an ORDERED SET of entries rather than one
// identifier. `listId`/`listName` stay beside it as the FIRST ticked entry:
// every reader that already resolves one identifier — the pinned pack's legacy
// branch included — keeps resolving, and nothing downstream has to migrate in
// this slice.
type ListPickerValue = {
  scope: "list";
  /** Every ticked entry, in the order the reader ticked them. */
  listIds: string[];
  listNames: string[];
  /** The first ticked entry, for a reader that resolves a single identifier. */
  listId: string;
  listName: string;
};

function listPickerValue(listIds: string[], listNames: string[]): ListPickerValue {
  return {
    scope: "list",
    listIds,
    listNames,
    listId: listIds[0] ?? "",
    listName: listNames[0] ?? "",
  };
}

/** The entries an incoming answer NAMES, paired as they were written.
 *
 *  A NAME BELONGS TO THE IDENTIFIER IT STANDS BESIDE (convergence round,
 *  cinatra#3562). `listIds` and `listNames` are one list of PAIRS written as two
 *  arrays, so a name is read at the index of its own identifier: filtering the
 *  names on their own would hand an entry whose name this step could not
 *  resolve — for which "" is written — the NEXT entry's name. And a repeated
 *  identifier is ONE ticked entry however the answer was authored, so it is kept
 *  once: keeping it twice would carry a phantom entry into the next answer the
 *  reader makes. */
function namedEntries(rawIds: unknown, rawNames: unknown): {
  ids: string[];
  names: string[];
} {
  const ids: string[] = [];
  const names: string[] = [];
  if (!Array.isArray(rawIds)) return { ids, names };
  const nameAt = Array.isArray(rawNames) ? rawNames : [];
  for (let i = 0; i < rawIds.length; i += 1) {
    const id = rawIds[i];
    if (typeof id !== "string" || id.trim() === "") continue;
    if (ids.includes(id)) continue;
    ids.push(id);
    names.push(typeof nameAt[i] === "string" ? (nameAt[i] as string) : "");
  }
  return { ids, names };
}

// BOTH SHAPES READ BACK (cinatra#3562). A step re-opened on an answer it
// already holds shows those rows ticked, and the answer it holds may have been
// written by this renderer (`listIds`) or by the one-identifier shape that came
// before it (`listId`) — an answer stored before this change is still the
// reader's own, so it is read as the one-entry set it is.
function toListPickerValue(value: unknown): ListPickerValue {
  // Defensive value normalization for the HITL renderer payload.
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    const entries = namedEntries(v.listIds, v.listNames);
    if (entries.ids.length > 0) return listPickerValue(entries.ids, entries.names);
    const legacyId = typeof v.listId === "string" && v.listId.trim() !== "" ? v.listId : "";
    if (legacyId === "") return listPickerValue([], []);
    const legacyName = typeof v.listName === "string" ? v.listName : "";
    return listPickerValue([legacyId], legacyName === "" ? [] : [legacyName]);
  }
  return listPickerValue([], []);
}

// ---------------------------------------------------------------------------
// THE QUESTION A GATE THAT LISTS OPENS ON
// ---------------------------------------------------------------------------

/** The question this gate opens on when the step it draws NAMES NONE (Agent run
 *  & review §I.1, which draws the gate opening on its question — "Which idea
 *  should this run draft?" — over its state line, in every reading including
 *  the zero-content one).
 *
 *  It belongs to the RENDERER'S KIND, not to any package: every binding that
 *  raises a list-picking gate lists lists, so the question asks about a list
 *  and names no pack (the core/extension border). A step that carries its own
 *  question still wins — this is the floor under a step that carries none, and
 *  the reading it replaces was an EMPTY heading. */
export const LIST_PICKER_QUESTION = "Which list should this run use?";

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
  const held = toListPickerValue(value);
  // WHOSE READING THE ROWS SHOW. `null` is "the reader has ticked nothing yet",
  // so the rows show the answer the step arrived holding, whenever it arrived —
  // a step re-hydrated with its stored answer while the rows were still loading
  // shows it the moment they land. Any array is the reader's own set and is the
  // whole truth, the EMPTY one included: an answer the reader ticked back off
  // must draw as empty rather than fall back to what was stored.
  const [pickedIds, setPickedIds] = useState<string[] | null>(null);
  const chosenIds = pickedIds ?? held.listIds;

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

  /** The name the loaded rows give an entry. Every entry an answer made here
   *  carries is one of those rows — see `handleToggle`. */
  function nameOf(id: string): string {
    return lists.find((l) => l.id === id)?.name ?? "";
  }

  // A PRESS TOGGLES, IT DOES NOT REPLACE (cinatra#3562). The single-answer
  // press moved the one identifier, so a second row could never be added; a
  // gate that takes several entries adds the pressed row when it is not among
  // the chosen and drops it when it is.
  function handleToggle(list: AvailableListSummary) {
    // ONLY WHAT THIS STEP SHOWED REACHES THE ANSWER THE READER MAKES
    // (convergence round, cinatra#3562). A held entry the live read no longer
    // returns — a view deleted where the views live since the step was answered
    // — is drawn in no row, so the reader can neither see it ticked nor tick it
    // back off; carrying it into an answer they are making NOW would send the
    // run a scope they were never shown. The rows are loaded by the time any of
    // them can be pressed, so the set the reader sees is the set the answer
    // carries, and every entry in it has a row to take its name from.
    const shown = new Set(lists.map((l) => l.id));
    const kept = chosenIds.filter((id) => shown.has(id));
    const nextIds = kept.includes(list.id)
      ? kept.filter((id) => id !== list.id)
      : [...kept, list.id];
    setPickedIds(nextIds);
    onChangeRef.current(listPickerValue(nextIds, nextIds.map(nameOf)));
  }

  // THE QUESTION THE GATE ACTUALLY OPENS ON. The step's own question wherever
  // the gate's data carries one — the binding's resolved label — and the kind's
  // question wherever it does not. A step whose schema titles the FIELD rather
  // than asking the reader anything reaches this renderer with no label at all,
  // and the heading was rendered from that label alone: the gate opened on an
  // EMPTY h3 over its state line, which is the one reading §I.1 never draws.
  const question =
    typeof label === "string" && label.trim() !== ""
      ? label
      : LIST_PICKER_QUESTION;

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
          {question}
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
        // THE ZERO-CONTENT READING IS THE STATE LINE AND THE SENTENCE, AND
        // NOTHING FRAMES IT OR FOLLOWS IT (cinatra#3562). The ruling reads "If
        // no views/lists are available in Twenty CRM, a message asks the user to
        // create one in Twenty CRM", so the reading says what the reader can do
        // about it where the views and lists actually live, and says the step
        // will list what they make when they come back. It offers NO road: the
        // step that used to send the reader to another agent no longer does, and
        // the run cannot be continued from here either — that is the one shared
        // answer-refusal doing its work (./hitl-gate-submit), not a second rule.
        //
        // IT ASSERTS NO CAUSE THE READING DOES NOT CARRY. An empty set comes
        // back both from a workspace that holds no contact view and from a read
        // that could not be made at all (list-picker-actions.ts degrades a
        // missing capability and a throwing provider to an empty array), so the
        // sentence states what to do rather than why there is nothing.
        <p
          role="status"
          className="text-sm leading-relaxed text-foreground"
          data-testid="list-picker-empty-reading"
        >
          No views or lists yet. Create one in Twenty CRM and this step will list
          it when you come back.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {lists.map((list) => {
            const isSelected = chosenIds.includes(list.id);
            return (
              // A ROW THAT CAN BE TICKED BESIDE OTHERS IS A CHECKBOX, NOT A
              // TOGGLE BUTTON (cinatra#3562). `data-selected` keeps its meaning
              // exactly — this row is among the chosen — and the ARIA moves from
              // `aria-pressed` on `role="button"` to `aria-checked` on
              // `role="checkbox"`, which is what the design system draws a
              // multi-select with (Components § Checkbox / Radio / Switch:
              // "multi-select (checkbox)"). The box itself is the drawn
              // primitive, presentational here because the ROW is the control.
              <Card
                key={list.id}
                role="checkbox"
                tabIndex={disabled ? -1 : 0}
                aria-checked={isSelected}
                data-selected={isSelected ? "true" : "false"}
                onClick={() => {
                  if (!disabled) handleToggle(list);
                }}
                onKeyDown={(e) => {
                  if (disabled) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    handleToggle(list);
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
                    <Checkbox
                      checked={isSelected}
                      disabled={disabled}
                      tabIndex={-1}
                      aria-hidden="true"
                      className="pointer-events-none"
                    />
                    <span className="flex-1 truncate">{list.name}</span>
                    <Badge variant="secondary">{list.memberType}</Badge>
                  </CardTitle>
                </CardHeader>
                {/* NO MEMBER COUNT (cinatra#3562). The reader contract returns
                    `memberCount` as null by construction — a Twenty view is
                    filter-defined, not materialized (list-picker-actions.ts) —
                    so a row that printed one printed a number the read never
                    made. The row names the entry and says when it moved. */}
                <CardContent className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
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

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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/lib/cinatra-toast";
import { fetchAvailableLists, type AvailableListSummary } from "./list-picker-actions";
import type {
  FieldRendererProps,
} from "./field-renderer-registry";

// ---------------------------------------------------------------------------
// THE HAND-BACK HALF OF THE CTA'S `?onComplete` CONTRACT
// (cinatra#3369, acceptance item 2)
// ---------------------------------------------------------------------------
//
// The CTA at the foot of this file opens a NEW list-curator run in a second tab
// at `?onComplete=list-picker`. The launcher-side half of that contract -- the
// param and the two functions that carry it onto the fresh run's address --
// lives in `on-complete-return.ts`. THIS half is the finish coming back: the
// key a completed curator run leaves its finish under, and the two functions
// that write and take it.
//
// IT LIVES IN THIS MODULE, and that is measured rather than stylistic.
// `scripts/route-graph.mjs` counts the reachable first-party module graph of the
// locked routes; this renderer is already inside the graph of all four tracked
// application routes through the field-renderer registry, so a separate leaf
// imported from here is a NEW module on every one of them (measured at exactly
// +1 on each, over their pinned ceilings), while the same functions stated here
// are +0. The picker owns the CTA and is the one module that reads the finish
// back, so the contract is stated where it is read; the curator run's watcher
// (`list-picker-return-watcher.tsx`) imports the writer from here, and adds no
// module to any tracked route because none of them reach it.

/** Where a finished curator run leaves its finish for the picker's tab. */
export const LIST_PICKER_RETURN_KEY = "cinatra.agents.list-picker-return";

/** What it leaves there: which run finished, and when. */
export type ListPickerReturn = {
  /** The curator run that finished. */
  runId: string;
  /** Epoch milliseconds at which it finished, so a stale hand-back is refused. */
  at: number;
};

/** The slice of the browser store these two functions use. */
export type ListPickerReturnStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

/**
 * The same-origin store, or `null` when the browser refuses the ACCESSOR.
 *
 * `window.localStorage` itself throws in a browser with site data blocked, so
 * reading it inside an argument list would throw before either guarded function
 * below could refuse. Both sides of the hand-back take the store from here.
 */
export function listPickerReturnStore(): ListPickerReturnStore | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * The finished curator run's hand-back.
 *
 * Every access is guarded: a browser with site data blocked throws on the
 * accessor itself, and a curator run that cannot hand back must still finish
 * normally -- the operator then returns to a picker that re-reads nothing,
 * which is the pre-existing behaviour, not a broken run.
 */
export function publishListPickerReturn(
  store: ListPickerReturnStore | null | undefined,
  value: ListPickerReturn,
): void {
  if (!store) return;
  try {
    store.setItem(LIST_PICKER_RETURN_KEY, JSON.stringify(value));
  } catch {
    // Site data blocked. Nothing to hand back through.
  }
}

/**
 * Read the hand-back AND take it, in one act.
 *
 * It is consumed on read so one finished curator run moves the picker once:
 * the picker re-reads its options on every return to the tab, and a hand-back
 * left lying there would re-select a list on each of them.
 */
export function consumeListPickerReturn(
  store: ListPickerReturnStore | null | undefined,
): ListPickerReturn | null {
  if (!store) return null;
  let raw: string | null = null;
  try {
    raw = store.getItem(LIST_PICKER_RETURN_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    store.removeItem(LIST_PICKER_RETURN_KEY);
  } catch {
    // Readable but not writable: the timestamp check below still refuses it twice.
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.runId !== "string" || record.runId === "") return null;
  if (typeof record.at !== "number" || !Number.isFinite(record.at)) return null;
  return { runId: record.runId, at: record.at };
}

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

  // The options this picker is currently offering. Held in a ref beside the
  // state so a re-read can tell a list that arrived while the operator was away
  // from one that was already on offer — which is the whole of "the NEW listId".
  const listsRef = useRef<AvailableListSummary[]>([]);

  // Has the first load answered? Until it has, `listsRef` is not yet the set
  // this picker was offering, so "the option that was not there before" cannot
  // be asked — a hand-back arriving in that window is left where it is and read
  // on the next return instead of selecting the first list that loads.
  const offeringSettledRef = useRef(false);

  // When this picker was drawn. A hand-back stamped before that belongs to a
  // curator run the operator finished before this step was on screen; it is
  // taken (so it stops lying around) and discarded rather than acted on.
  const drawnAtRef = useRef(Date.now());

  // Did THIS picker open the curator? The hand-back key is one same-origin
  // slot, so a second outreach run's picker in another tab hears the same
  // browser event; without this, whichever picker read first would take a
  // finish it never asked for and re-select ITS campaign's audience. Only the
  // picker whose own CTA was clicked acts on a finish.
  const launchedRef = useRef(false);

  // Did the first load answer with a real set of options? A load that FAILED
  // leaves `listsRef` empty, and an empty baseline makes every list look new —
  // the re-read would then pre-select the first list in the account as the
  // campaign's audience. Without a baseline the re-read still offers what it
  // reads; it selects nothing.
  const baselineKnownRef = useRef(false);

  // The same "has the first load answered" fact as `offeringSettledRef`, held
  // as state as well so the return effect re-runs when it becomes true: a
  // hand-back that arrived while the first load was in flight is read then,
  // rather than waiting for another browser event that may never come.
  const [offeringSettled, setOfferingSettled] = useState(false);

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
    // A new run identity is a new offering: until THIS load answers, the set in
    // `listsRef` belongs to the previous one and cannot be the baseline for
    // "the option that was not there before".
    offeringSettledRef.current = false;
    baselineKnownRef.current = false;
    setOfferingSettled(false);
    fetchAvailableLists(runId ?? "")
      .then((items) => {
        if (!cancelled) {
          listsRef.current = items;
          offeringSettledRef.current = true;
          baselineKnownRef.current = true;
          setOfferingSettled(true);
          setLists(items);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          offeringSettledRef.current = true;
          baselineKnownRef.current = false;
          setOfferingSettled(true);
          setLoading(false);
          toast.error("Could not load lists.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  // THE RETURN HALF OF THE CTA'S CONTRACT (cinatra#3369, acceptance item 2).
  //
  // "on completion they return to this picker with the new listId pre-selected
  // via the ?onComplete query param" — the sentence stated beside the CTA
  // below. The curator runs in a SECOND TAB (`target="_blank"`), so the return
  // is the operator coming back to this one, and what has to be true when they
  // do is that this picker knows about the list they just built.
  //
  // A proof round on a development boot measured that it never was: the run
  // finished and this step was unchanged — no list offered, the picker still
  // empty.
  //
  // The finished curator run leaves its finish in the same-origin store
  // (`list-picker-return-watcher.tsx`, mounted on that run because its address
  // carries the query). This reads it on the two occasions that can carry it:
  //
  //   storage          — the other tab wrote while this one was open, which the
  //                      browser delivers here whether or not it is focused;
  //   focus /
  //   visibilitychange — the operator came back to this tab. The wake channel
  //                      this package already re-resolves on when the reader
  //                      returns from deciding something elsewhere
  //                      (`run-recommendation-chip-row.tsx`).
  //
  // Neither fires on an idle focused tab, so this adds no steady-state traffic,
  // and the hand-back is TAKEN on read, so one finished run moves this picker
  // exactly once.
  useEffect(() => {
    let cancelled = false;

    const readOptionsBack = () => {
      if (disabled) return;
      if (!offeringSettledRef.current) return;
      const handBack = consumeListPickerReturn(listPickerReturnStore());
      // ONLY THIS PICKER'S OWN LAUNCH. A finish left by a curator run this
      // picker did not open belongs to someone else's step; it is left where it
      // is (the taking above is undone) and this picker does nothing.
      if (!launchedRef.current) {
        if (handBack) publishListPickerReturn(listPickerReturnStore(), handBack);
        return;
      }
      // Stamped before this step was drawn: a finish from before this picker
      // existed. Taken, so it stops lying around, and discarded.
      if (handBack && handBack.at < drawnAtRef.current) return;
      const baselineKnown = baselineKnownRef.current;
      const alreadyOffered = new Set(listsRef.current.map((l) => l.id));
      fetchAvailableLists(runId ?? "")
        .then((items) => {
          if (cancelled) return;
          listsRef.current = items;
          baselineKnownRef.current = true;
          setLists(items);
          setLoading(false);
          // The one option that was not on offer before the operator left is
          // the list they just built. Nothing new means the CRM has not
          // published it yet — the re-read still put every list it does have on
          // offer, which is the "list offered" half, and the next return asks
          // again rather than selecting something the operator did not build.
          // With no baseline (the first load failed) nothing can be shown to be
          // new, so the options are offered and nothing is selected.
          if (!baselineKnown) return;
          const built = items.find((l) => !alreadyOffered.has(l.id));
          if (!built) return;
          // This launch has been answered; later returns to the tab go back to
          // reading nothing until the operator builds another list.
          launchedRef.current = false;
          setSelectedId(built.id);
          onChangeRef.current({
            scope: "list",
            listId: built.id,
            listName: built.name,
            memberCount: built.memberCount,
          });
        })
        .catch(() => {
          // The options stay as they were. The finish is PUT BACK so the next
          // return asks again: a failed re-read is not an answer about what the
          // operator built, and a taken-and-dropped finish would never return.
          if (handBack) publishListPickerReturn(listPickerReturnStore(), handBack);
        });
    };

    const onStorage = (event: StorageEvent) => {
      // A `null` key is a whole-store clear, which this key does not survive
      // either — both are occasions to look.
      if (event.key !== null && event.key !== LIST_PICKER_RETURN_KEY) return;
      readOptionsBack();
    };
    const onWake = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      readOptionsBack();
    };

    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", onWake);
    document.addEventListener("visibilitychange", onWake);
    // The first load may have been in flight when the finish arrived, and a
    // `storage` event does not come twice. This is that read, taken as soon as
    // the offering settles.
    if (offeringSettled) readOptionsBack();
    return () => {
      cancelled = true;
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", onWake);
      document.removeEventListener("visibilitychange", onWake);
    };
  }, [runId, disabled, offeringSettled]);

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
          <Link
            href="/agents/cinatra-ai/list-curator-agent/new?onComplete=list-picker"
            target="_blank"
            rel="noreferrer"
            data-testid="build-list-with-ai-cta"
            // THIS picker opened the curator. The finish the curator leaves is
            // acted on only here — see the return effect above.
            onClick={() => {
              launchedRef.current = true;
            }}
          >
            Build a list with AI
          </Link>
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

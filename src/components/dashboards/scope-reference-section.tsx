"use client";
/**
 * The add-to-scope REFERENCE section — concept A of the unified Add-dashboard
 * popup (cinatra#2474 PR3), extracted verbatim in behaviour from the standalone
 * `<AddToScopePicker>` dialog it replaces (cinatra#1897 B4; the ratified design
 * spec `specs/app-artifacts.html` §IX.1).
 *
 * It is the SAME picker — the same server-dispositioned candidate pool, the same
 * three dispositions, the same copy — with the dialog chrome removed so it can be
 * embedded as one section of `<AddDashboardDialog>` alongside Create and the
 * installed-catalog section. Nothing about the collection-add contract moved.
 *
 * conformance id `scope-dashboards-add-picker` (field
 * candidate=collectionAdd.listable; actions add-listing -> listing-added,
 * request-promotion -> promotion-requested; the closed data-state set empty /
 * error / loading). A bounded panel over the dashboards the ACTING USER can see,
 * excluding any already homed or listed here (server-derived). Each candidate is
 * dispositioned by the collection-add contract server-side:
 *
 *   - addable      → a direct Add (adds the secondary listing; the canonical home
 *                    does not move);
 *   - promotion    → the #1437 promotion REQUEST in the exact target-visibility
 *                    vocabulary ("Request team visibility…" / "Request
 *                    organization visibility…") — never an in-place add, never a
 *                    silent widen;
 *   - not-addable  → stated plainly, no offer (a project scope's null recourse).
 *
 * The section never ADDS a dashboard the scope can't see and never widens one
 * silently — the structured denial of the contract, rendered.
 *
 * It reports a successful add UP (`onAdded`) rather than refreshing in place: the
 * candidate pool it is showing has just gone stale (the added dashboard is now
 * listed, so it must leave the pool), and the owner closes the popup and
 * refreshes the collection panel — the behaviour the standalone picker had, kept
 * (codex convergence).
 */
import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { toast } from "@/lib/cinatra-toast";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  SCOPE_LISTING_REASON_COPY,
  type AddPickerCandidateView,
  type AddPickerLoadState,
  type ScopeReferenceSource,
} from "./scope-dashboards-contract";

export function ScopeReferenceSection({
  source,
  onAdded,
}: {
  source: ScopeReferenceSource;
  /** A listing was added — the pool is stale; the owner closes + refreshes. */
  onAdded: () => void;
}) {
  const [state, setState] = useState<AddPickerLoadState>({ status: "loading" });
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    source
      .listCandidates()
      .then((candidates) => {
        if (!live) return;
        if (candidates === null) {
          setState({ status: "error" });
        } else if (candidates.length === 0) {
          setState({ status: "empty" });
        } else {
          setState({ status: "ready", candidates });
        }
      })
      .catch(() => {
        if (live) setState({ status: "error" });
      });
    return () => {
      live = false;
    };
  }, [source]);

  const onAdd = (dashboardId: string) => {
    setBusyId(dashboardId);
    void source
      .addListing(dashboardId)
      .then((res) => {
        setBusyId(null);
        if (res.ok) {
          toast.success("Dashboard listed in this scope");
          onAdded();
        } else {
          toast.error(SCOPE_LISTING_REASON_COPY[res.reason]);
        }
      })
      // A REJECTED action (transport/server fault) must clear the row's busy
      // state too — otherwise the button stays "Adding…" forever with no way
      // back (codex convergence).
      .catch(() => {
        setBusyId(null);
        toast.error("Couldn’t add that dashboard. Try again.");
      });
  };

  const onPromote = (dashboardId: string) => {
    setBusyId(dashboardId);
    void source
      .requestPromotion(dashboardId)
      .then((res) => {
        setBusyId(null);
        if (res.ok) {
          toast.success("Visibility request sent");
        } else {
          toast.error(SCOPE_LISTING_REASON_COPY[res.reason]);
        }
      })
      .catch(() => {
        setBusyId(null);
        toast.error("Couldn’t send that request. Try again.");
      });
  };

  const visible =
    state.status === "ready"
      ? state.candidates.filter((c) =>
          c.name.toLowerCase().includes(query.trim().toLowerCase()),
        )
      : [];

  return (
    <div
      data-conformance-id="scope-dashboards-add-picker"
      data-field="candidate=collectionAdd.listable"
      className="flex flex-col gap-2.5"
    >
      {/* Search your dashboards (§IX.1). */}
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search your dashboards"
          aria-label="Search your dashboards"
          className="h-8 pl-8 text-xs"
        />
      </div>

      {state.status === "loading" ? (
        <div data-state="loading" className="grid gap-2" aria-busy>
          <Skeleton className="h-10 rounded-md" />
          <Skeleton className="h-10 rounded-md opacity-70" />
        </div>
      ) : state.status === "error" ? (
        <div
          data-state="error"
          className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-4 text-center text-xs font-semibold text-foreground"
        >
          Couldn’t load your dashboards
        </div>
      ) : state.status === "empty" || visible.length === 0 ? (
        <div
          data-state="empty"
          className="rounded-md border border-dashed border-line px-3 py-5 text-center text-xs text-muted-foreground"
        >
          {state.status === "empty"
            ? "No dashboards you can add to this scope."
            : "No dashboards match your search."}
        </div>
      ) : (
        <ul className="overflow-hidden rounded-lg border border-line">
          {visible.map((candidate) => (
            <CandidateRow
              key={candidate.dashboardId}
              candidate={candidate}
              busy={busyId === candidate.dashboardId}
              onAdd={onAdd}
              onPromote={onPromote}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function CandidateRow({
  candidate,
  busy,
  onAdd,
  onPromote,
}: {
  candidate: AddPickerCandidateView;
  busy: boolean;
  onAdd: (dashboardId: string) => void;
  onPromote: (dashboardId: string) => void;
}) {
  return (
    <li
      className={
        "flex items-start gap-2.5 border-b border-line px-3 py-2.5 last:border-b-0" +
        (candidate.disposition === "promotion" ? " bg-amber-500/[0.06]" : "")
      }
    >
      <span className="min-w-0 flex-1 text-xs text-foreground">
        {candidate.name}
        <span className="mt-0.5 block font-mono text-badge-2xs text-muted-foreground">
          {candidate.homeNote}
        </span>
      </span>
      {candidate.disposition === "addable" ? (
        <Button
          type="button"
          size="xs"
          disabled={busy}
          data-action="add-listing -> listing-added"
          onClick={() => onAdd(candidate.dashboardId)}
        >
          {busy ? "Adding…" : "Add"}
        </Button>
      ) : candidate.disposition === "promotion" ? (
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={busy}
          className="whitespace-nowrap"
          data-action="request-promotion -> promotion-requested"
          onClick={() => onPromote(candidate.dashboardId)}
        >
          {candidate.promotionLabel ?? "Request visibility…"}
        </Button>
      ) : (
        <span className="flex-none whitespace-nowrap pt-1 text-badge-2xs text-muted-foreground">
          Not addable
        </span>
      )}
    </li>
  );
}

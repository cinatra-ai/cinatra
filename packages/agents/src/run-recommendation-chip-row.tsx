"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

import type { RecommendedSkillForChip } from "./server-actions";
import { getRunRecommendedSkillsAction } from "./server-actions";
import {
  confirmRunRecommendationAction,
  skipRunRecommendationAction,
} from "./run-recommendation-actions";

// ---------------------------------------------------------------------------
// RunRecommendationChipRow — the SHARED run-start recommendation chip-row
// (cinatra#2067, epic #2037 C3). ONE component serving BOTH the canonical run
// view (instance-screens.tsx) and the chat-mounted run panel (agentic-run-panel
// .tsx) — issue #2067 item 5 (chat parity is not assumed; it uses the SAME
// component). Reuses the HitlSkillChips visual language (a collapsible chip row
// + a per-skill detail Sheet) and adds the confirm / adjust / skip affordances:
//
//   ADJUST  — toggle a chip on/off (a recommended chip starts selected; a
//             non-recommended candidate starts unselected and rides
//             `forcedRevisions` when turned on).
//   CONFIRM — write the currently-selected set as the authoritative per-run
//             selection and release the run-start hold (the run dispatches).
//   SKIP    — proceed with the computed default set (durable skip evidence).
//
// These are skill-selection affordances, NOT a review decision — the review
// floor (Approve/Reject/Comment) is untouched (issue #2067 AC-8).
//
// `decision` drives the two visual modes:
//   "pending"   → the interactive chip-row (a live parked hold).
//   a summary   → the read-only decided state (a released hold) — confirmed
//                 (labeled skills) or skipped.
// ---------------------------------------------------------------------------

export type RunRecommendationDecision =
  | { kind: "pending" }
  | { kind: "confirmed"; skillNames: string[] }
  | { kind: "skipped" };

type Props = {
  runId: string;
  agentPackageName: string;
  /** JSON-serialized run intent (inputParams) for request-aware scoring. */
  promptText?: string;
  /** Server-prefetched candidates (run view). Omit to fetch on mount (chat). */
  initialRecommendations?: RecommendedSkillForChip[];
  decision: RunRecommendationDecision;
  /** Compact styling for the inline chat mount. */
  variant?: "panel" | "inline";
};

export function RunRecommendationChipRow({
  runId,
  agentPackageName,
  promptText,
  initialRecommendations,
  decision,
  variant = "panel",
}: Props) {
  const router = useRouter();
  const [recs, setRecs] = useState<RecommendedSkillForChip[]>(
    initialRecommendations ?? [],
  );
  const [loaded, setLoaded] = useState(initialRecommendations != null);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set((initialRecommendations ?? []).filter((r) => r.recommended).map((r) => r.skillId)),
  );
  const [detail, setDetail] = useState<RecommendedSkillForChip | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Chat mount: fetch candidates on mount when not server-prefetched.
  useEffect(() => {
    if (loaded || decision.kind !== "pending") return;
    let cancelled = false;
    getRunRecommendedSkillsAction({ agentPackageName, promptText })
      .then((r) => {
        if (cancelled) return;
        setRecs(r);
        setSelected(new Set(r.filter((s) => s.recommended).map((s) => s.skillId)));
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [loaded, decision.kind, agentPackageName, promptText]);

  // ── Read-only decided state (a released hold) ────────────────────────────
  if (decision.kind === "confirmed") {
    return (
      <div
        data-run-recommendation-decision="confirmed"
        className="flex flex-wrap items-center gap-2 rounded-panel border border-line bg-surface-muted px-4 py-3"
      >
        <Check className="h-4 w-4 text-muted-foreground" aria-hidden />
        <span className="text-xs font-medium text-muted-foreground">
          Skills confirmed ({decision.skillNames.length})
        </span>
        {decision.skillNames.map((n) => (
          <Badge key={n} variant="secondary" className="rounded-chip text-xs">
            {n}
          </Badge>
        ))}
      </div>
    );
  }
  if (decision.kind === "skipped") {
    return (
      <div
        data-run-recommendation-decision="skipped"
        className="flex items-center gap-2 rounded-panel border border-line bg-surface-muted px-4 py-3"
      >
        <span className="text-xs font-medium text-muted-foreground">
          Skill recommendation skipped — running with the default set.
        </span>
      </div>
    );
  }

  // ── Interactive chip-row (a live parked hold) ────────────────────────────
  const toggle = (skillId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(skillId)) next.delete(skillId);
      else next.add(skillId);
      return next;
    });
  };

  const onConfirm = () => {
    setError(null);
    const confirmedSkillIds = [...selected];
    // Forced revisions: a SELECTED skill that was NOT recommended is a
    // human-forced addition — pin its exact revision.
    const forcedRevisions: Record<string, string> = {};
    for (const r of recs) {
      if (!r.recommended && selected.has(r.skillId)) forcedRevisions[r.skillId] = r.skillRevisionId;
    }
    startTransition(async () => {
      const res = await confirmRunRecommendationAction({
        runId,
        agentPackageName,
        confirmedSkillIds,
        promptText,
        forcedRevisions: Object.keys(forcedRevisions).length ? forcedRevisions : undefined,
      });
      if (!res.ok) {
        setError(res.error || "Could not confirm the skill selection.");
        return;
      }
      router.refresh();
    });
  };

  const onSkip = () => {
    setError(null);
    startTransition(async () => {
      const res = await skipRunRecommendationAction({ runId });
      if (!res.ok) {
        setError(res.error || "Could not skip.");
        return;
      }
      router.refresh();
    });
  };

  return (
    <div
      data-run-recommendation-chip-row=""
      data-variant={variant}
      className="flex flex-col gap-3 rounded-panel border border-line bg-surface p-4"
    >
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-foreground">
          Confirm the skills for this run
        </span>
        <span className="text-xs text-muted-foreground">
          Recommended for your request. Adjust the selection, then confirm — or skip to run
          with the default set.
        </span>
      </div>

      <Collapsible defaultOpen>
        <div className="flex items-center gap-2">
          <CollapsibleTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="gap-1 rounded-chip text-muted-foreground hover:text-foreground"
            >
              <span className="text-xs font-medium">
                Skills ({selected.size}/{recs.length})
              </span>
              <ChevronDown className="h-3.5 w-3.5" />
            </Button>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent>
          <div className="flex flex-wrap gap-2 pt-2">
            {!loaded ? (
              <span className="text-xs text-muted-foreground">Loading recommendations…</span>
            ) : recs.length === 0 ? (
              <span className="text-xs text-muted-foreground">No candidate skills.</span>
            ) : (
              recs.map((skill) => {
                const isSelected = selected.has(skill.skillId);
                return (
                  <div key={skill.skillId} className="flex items-center">
                    <Button
                      type="button"
                      variant={isSelected ? "default" : "outline"}
                      size="sm"
                      className="rounded-chip gap-1.5 text-xs"
                      aria-pressed={isSelected}
                      data-skill-id={skill.skillId}
                      data-selected={isSelected ? "true" : "false"}
                      data-forced={!skill.recommended ? "true" : undefined}
                      onClick={() => toggle(skill.skillId)}
                      onDoubleClick={() => {
                        setDetail(skill);
                        setSheetOpen(true);
                      }}
                      title={
                        skill.recommended
                          ? `Recommended (rank ${skill.rank})`
                          : "Not recommended — adding forces this skill"
                      }
                    >
                      {isSelected ? <Check className="h-3 w-3" /> : null}
                      {skill.name}
                    </Button>
                  </div>
                );
              })
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>

      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          onClick={onConfirm}
          disabled={pending || !loaded}
          data-action="confirm-run-recommendation"
        >
          {pending ? "Working…" : "Confirm"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onSkip}
          disabled={pending}
          data-action="skip-run-recommendation"
        >
          Skip
        </Button>
      </div>

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="right" className="w-[480px] sm:max-w-[480px] overflow-y-auto">
          <SheetHeader>
            <SheetTitle className="text-foreground">{detail?.name ?? ""}</SheetTitle>
            <SheetDescription className="text-muted-foreground">
              {detail?.recommended
                ? `Recommended · rank ${detail?.rank} · score ${detail?.score?.toFixed?.(2) ?? detail?.score}`
                : "Not among the recommendations for this request."}
            </SheetDescription>
          </SheetHeader>
          {detail ? (
            <div className="mt-4 flex flex-col gap-2">
              <span className="text-xs font-medium text-muted-foreground">Scored on</span>
              <ul className="flex flex-col gap-1">
                {(detail.scoredFeatures ?? []).map((f, i) => (
                  <li key={i} className="text-xs text-foreground">
                    <span className="text-muted-foreground">{f.kind}</span> · {f.detail}{" "}
                    <span className="text-muted-foreground">(+{f.contribution})</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}

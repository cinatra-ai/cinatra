"use client";

// ---------------------------------------------------------------------------
// Field renderer for @cinatra-ai/skill-recommender-agent.
//
// Fetches the skills assigned to @cinatra-ai/email-drafting-agent, displays them
// with HitlSkillChips so the user can inspect each skill, then calls
// onChange({ confirmed: true }) via the Continue button to advance the
// interrupt and let the drafts step run.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { HitlSkillChips } from "./hitl-skill-chips";
import { getSkillsForAgentAction } from "./server-actions";
import type { SkillForChip } from "./server-actions";
import type { FieldRendererProps } from "./field-renderer-registry";

const DRAFTS_PACKAGE = "@cinatra-ai/email-drafting-agent";

export function SkillRecommenderRenderer({
  onChange,
  disabled,
}: FieldRendererProps) {
  const [skills, setSkills] = useState<SkillForChip[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    getSkillsForAgentAction(DRAFTS_PACKAGE)
      .then((s) => {
        setSkills(s);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  const handleContinue = useCallback(async () => {
    if (submitting || disabled) return;
    setSubmitting(true);
    try {
      await onChange({ confirmed: true });
    } finally {
      setSubmitting(false);
    }
  }, [onChange, submitting, disabled]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-semibold text-foreground">
          Skills for email drafting
        </span>
        <span className="text-sm text-muted-foreground">
          These skills will guide the drafting step. Review them before
          continuing.
        </span>
      </div>

      {loaded && skills.length > 0 && <HitlSkillChips skills={skills} />}

      {loaded && skills.length === 0 && (
        <span className="text-sm text-muted-foreground">
          No skills are currently assigned to the drafting step.
        </span>
      )}

      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={submitting || disabled || !loaded}
          onClick={() => {
            void handleContinue();
          }}
        >
          {submitting ? "Continuing…" : "Continue"}
        </Button>
      </div>
    </div>
  );
}

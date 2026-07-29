import type { Metadata } from "next";
import { listSkillsUsedForRun } from "@/lib/agent-run-skills-used";
import { readRunSelectedSkillRevisions } from "@/lib/run-selected-skill-revisions";
import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const metadata: Metadata = { title: "Agent — Skills" };

// Selection-source → run-visible ledger label (cinatra#2067 item 6). A ledger
// skill sourced from a run's authoritative selection set is labeled by HOW it
// was selected — confirmed by a human, auto-applied headless, or human-forced —
// distinguishing it from a computed-default skill (no selection row → no label).
const SELECTION_LABEL: Record<string, { text: string; variant: "default" | "secondary" | "outline" }> = {
  recommended_confirmed: { text: "Confirmed", variant: "default" },
  recommended_auto_applied: { text: "Auto-applied", variant: "secondary" },
  user_forced: { text: "Forced", variant: "outline" },
};

type Props = {
  params: Promise<{ vendor: string; packageName: string; instanceId: string }>;
};

/**
 * Skills tab.
 *
 * Surfaces the per-run skill ledger (agent_run_skills_used) for the agent
 * instance. The agent-execution worker calls snapshotSkillsAtRunStart at run
 * start, writing the resolved skill set with invocation_count=0.
 *
 * Records the installed catalog skills resolved for the run — the same set the
 * run's LLM steps receive via the sessionless llm-bridge resolution.
 */
export default async function AgentPackageInstanceSkillsPage({ params }: Props) {
  const { instanceId } = await params;
  const skills = listSkillsUsedForRun({ runId: instanceId });
  // Join the telemetry ledger against the authoritative per-run selection set so
  // each ledger row can be labeled by its selection source (cinatra#2067 item 6).
  const selectionSourceBySkillId = new Map(
    readRunSelectedSkillRevisions(instanceId).map((s) => [s.skillId, s.selectionSource]),
  );

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="Skills"
        description="Skills resolved + invoked during this run."
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        <Card className="border-line bg-surface backdrop-blur-none">
          <CardHeader>
            <CardTitle>
              {skills.length === 0
                ? "No skills recorded for this run"
                : `${skills.length} skill${skills.length === 1 ? "" : "s"}`}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {skills.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Skills resolved for this run are recorded when the run starts
                executing; see <code>src/lib/agent-run-skills-used.ts</code>.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {skills.map((s) => (
                  <li
                    key={s.id}
                    className="soft-panel flex flex-row items-center justify-between gap-3 px-4 py-3"
                  >
                    <div className="flex flex-col">
                      <span className="font-medium text-foreground">{s.skillId}</span>
                      <span className="text-xs text-muted-foreground">
                        first invoked at {new Date(s.firstInvokedAt).toLocaleString()}
                      </span>
                    </div>
                    <div className="flex flex-row items-center gap-2">
                      {(() => {
                        const src = selectionSourceBySkillId.get(s.skillId);
                        const label = src ? SELECTION_LABEL[src] : undefined;
                        return label ? (
                          <Badge variant={label.variant} data-selection-source={src}>
                            {label.text}
                          </Badge>
                        ) : null;
                      })()}
                      <Badge variant="secondary">{s.skillKind}</Badge>
                      <Badge variant="outline">{s.invocationCount}×</Badge>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </PageContent>
    </Main>
  );
}

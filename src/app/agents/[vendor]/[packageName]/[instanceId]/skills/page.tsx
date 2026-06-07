import type { Metadata } from "next";
import { listSkillsUsedForRun } from "@/lib/agent-run-skills-used";
import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const metadata: Metadata = { title: "Agent — Skills" };

type Props = {
  params: Promise<{ vendor: string; packageName: string; instanceId: string }>;
};

/**
 * Skills tab.
 *
 * Surfaces the per-run skill ledger (agent_run_skills_used) for the agent
 * instance. snapshotSkillsAtRunStart writes the resolved skill set at run
 * start with invocation_count=0; /api/llm-bridge increments invocation_count
 * on each skill resolution during LLM steps.
 *
 * Shows all skills used in the run, including agent, custom, and third-party
 * skills.
 */
export default async function AgentPackageInstanceSkillsPage({ params }: Props) {
  const { instanceId } = await params;
  const skills = listSkillsUsedForRun({ runId: instanceId });

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
                Skills will appear here once the run executes its first LLM step.
                The /api/llm-bridge route writes one row per skill resolved during
                the run; see <code>src/lib/agent-run-skills-used.ts</code>.
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

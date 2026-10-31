import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { readAgentRunById, readAgentTemplateById } from "@cinatra-ai/agents/store";
import type { ActorRoleHints } from "@cinatra-ai/agents/auth-policy";
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import { AuthzError } from "@/lib/authz";
import {
  getAuthSession,
  isPlatformAdmin,
  resolveOrgRoleForSession,
  signInRedirectTarget,
} from "@/lib/auth-session";
import { redirect } from "next/navigation";
import { CrumbContributions } from "@/components/crumb-contributions";
import { scopeSurfaceCrumbEntries, type ScopeSurfaceRef } from "@/lib/scope-surfaces";
import { listSkillsUsedForRun } from "@/lib/agent-run-skills-used";
import { readRunSelectedSkillRevisions } from "@/lib/run-selected-skill-revisions";
import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { agentInstancePathname, resolveAgentInstanceMetadata } from "@/lib/agent-instance-tab-title";
import { launchScopeInstanceLabel, readLaunchScopeAnchor } from "@/lib/launch-scope-anchor";

// THE TAB MIRRORS THE TRAIL (cinatra#2934, fix leg 9). The static title this
// route used to export was re-applied over the mirrored one on every live-poll
// re-render, so the derivation moved to the server, behind one helper every
// id-bearing route under the run shares.
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { vendor, packageName, instanceId } = await params;
  return resolveAgentInstanceMetadata({ vendor, packageName, instanceId, subRoute: "skills" });
}

// Selection-source → run-visible ledger label (cinatra#2067 item 6). A ledger
// skill sourced from a run's authoritative selection set is labeled by HOW it
// was selected — confirmed by a human, auto-applied headless, or human-forced —
// distinguishing it from a computed-default skill (no selection row → no label).
const SELECTION_LABEL: Record<string, { text: string; variant: "default" | "secondary" | "outline" }> = {
  recommended_confirmed: { text: "Confirmed", variant: "default" },
  recommended_auto_applied: { text: "Auto-applied", variant: "secondary" },
  user_forced: { text: "Forced", variant: "outline" },
  // cinatra#2841 — the reader opened ADJUST on a skill the scorer DID recommend
  // and settled it there. Distinct from "Forced", which asserts the scorer never
  // recommended it, and from "Confirmed", which asserts it was taken as scored.
  user_adjusted: { text: "Adjusted", variant: "outline" },
};

type Props = {
  params: Promise<{ vendor: string; packageName: string; instanceId: string }>;
};

/**
 * WHAT THE SCOPED SHELL HANDS THIS PAGE (cinatra#3693).
 *
 * Every other screen below an instance takes these three, so the scoped shell
 * can mount them all the same way: the base the page is read under, the scope
 * itself for the trail's head, and the scope's resolved name. This page was the
 * one sub-route that took none of them, so `<base>/…/<run>/skills` answered 404
 * while the same run's Schedule, Permissions and Data panes all resolved.
 *
 * IT RUNS NO HOME CHECK, and that is a decision rather than an omission: this
 * pane is not addressed by anything the product draws, so no reader arrives here
 * at the wrong base for a run. The scope it was read under is what its trail
 * says, and the base is where it publishes the run's crumb.
 */
type ScopeProps = {
  /** The scope base the page is mounted under, e.g. `/teams/<id>`. */
  scopeBase?: string | null;
  /** The scope itself, for the trail's head. */
  launchScope?: ScopeSurfaceRef | null;
  /** The scope's resolved name, read behind the scope's own gate. */
  scopeTitle?: string | null;
};

/**
 * THE RUN'S NAME FOR THE TRAIL (cinatra#4453), the identity the run page publishes:
 * the run's title, else the template's name, else the drawing's placeholder, and
 * the owner beside it on a personal run. Called only after the run's access check,
 * so the reader this names the run for is one who may read it. Without it the
 * trail drew "Agent run", the label the drawing keeps for a refused or missing run.
 */
async function readRunCrumbLabel(
  run: { title?: string | null; templateId?: string | null; launchScopeAnchor?: unknown },
  instanceId: string,
): Promise<string> {
  let name = run.title?.trim() || null;
  if (!name && run.templateId) {
    try {
      name = (await readAgentTemplateById(run.templateId))?.name?.trim() || null;
    } catch {
      name = null;
    }
  }
  const label = name ?? `${instanceId.slice(0, 8)}…`;
  const owner = launchScopeInstanceLabel(readLaunchScopeAnchor(run.launchScopeAnchor), {});
  return owner === "Personal (owner)" ? `${label} · ${owner}` : label;
}

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
export default async function AgentPackageInstanceSkillsPage({
  params,
  scopeBase,
  launchScope,
  scopeTitle,
}: Props & ScopeProps) {
  const { vendor, packageName, instanceId } = await params;

  // ── THE RUN'S OWN ACCESS DOOR, BEFORE ANY LEDGER IS READ (cinatra#3693) ───
  //
  // The two reads below are plain SQL over `run_id` and take no actor: they
  // enforce nothing themselves, so whatever stands in front of them IS the
  // door. Nothing did. `readAgentRunById` with the actor is that door — the same
  // call, with the same actor and the same role hints, the run page and the
  // Permissions pane make — and it enforces the run's effective auth policy
  // (`runDataVisibility`) on top of ownership. A refusal arrives as `AuthzError`
  // and is answered as not-found, so a reader who may not see the run is not
  // told it exists.
  const session = await getAuthSession();
  if (!session) redirect(await signInRedirectTarget());
  const actor: PrimitiveActorContext = {
    actorType: "human",
    source: "ui",
    userId: session.user?.id ?? undefined,
  };
  const roles: ActorRoleHints = {
    platformRole: isPlatformAdmin(session) ? "platform_admin" : "member",
    orgRole: await resolveOrgRoleForSession({
      user: { id: session.user.id },
      session: session.session,
    }),
    actorOrganizationId: session.session?.activeOrganizationId ?? undefined,
  };
  let run: Awaited<ReturnType<typeof readAgentRunById>>;
  try {
    run = await readAgentRunById(instanceId, actor, roles);
  } catch (err) {
    if (err instanceof AuthzError) notFound();
    throw err;
  }
  if (!run) notFound();

  const skills = listSkillsUsedForRun({ runId: instanceId });
  // Join the telemetry ledger against the authoritative per-run selection set so
  // each ledger row can be labeled by its selection source (cinatra#2067 item 6).
  const selectionSourceBySkillId = new Map(
    readRunSelectedSkillRevisions(instanceId).map((s) => [s.skillId, s.selectionSource]),
  );

  return (
    <Main className="min-h-screen">
      <CrumbContributions
        entries={[
          // The vantage decides the trail's head, exactly as it does on the run page.
          ...(launchScope
            ? scopeSurfaceCrumbEntries(launchScope, "agents", scopeTitle ?? undefined)
            : []),
          {
            prefix: `${scopeBase ?? ""}${agentInstancePathname({ vendor, packageName, instanceId })}`,
            label: await readRunCrumbLabel(run, instanceId),
          },
        ]}
      />
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

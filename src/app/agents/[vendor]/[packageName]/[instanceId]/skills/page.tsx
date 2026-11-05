import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { readAgentRunById } from "@cinatra-ai/agents/store";
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
import { resolveAgentInstanceMetadata } from "@/lib/agent-instance-tab-title";
import { readAgentInstanceIdFromSegment } from "@/lib/agent-url";

// THE TAB MIRRORS THE TRAIL (cinatra#2934, fix leg 9). The static title this
// route used to export was re-applied over the mirrored one on every live-poll
// re-render, so the derivation moved to the server, behind one helper every
// id-bearing route under the run shares.
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { vendor, packageName, instanceId: instanceIdSegment } = await params;
  return resolveAgentInstanceMetadata({
    vendor,
    packageName,
    // cinatra#3080 - the helper is handed the id, read back once here.
    instanceId: readAgentInstanceIdFromSegment(instanceIdSegment),
    subRoute: "skills",
  });
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
 * says.
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
  const { instanceId: instanceIdSegment } = await params;
  // cinatra#3080 - the router hands this segment over still percent-encoded.
  // A repair run's id carries a colon, so the raw segment is no run's id and
  // the screen answered 404 for a run that was right there. Every ordinary run
  // id is a uuid and reads back byte-identical.
  const instanceId = readAgentInstanceIdFromSegment(instanceIdSegment);
  // The base decides nothing here (see `ScopeProps`); the vantage decides the
  // trail's head, exactly as it does on the run page.
  void scopeBase;

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
  try {
    if (!(await readAgentRunById(instanceId, actor, roles))) notFound();
  } catch (err) {
    if (err instanceof AuthzError) notFound();
    throw err;
  }

  const skills = listSkillsUsedForRun({ runId: instanceId });
  // Join the telemetry ledger against the authoritative per-run selection set so
  // each ledger row can be labeled by its selection source (cinatra#2067 item 6).
  const selectionSourceBySkillId = new Map(
    readRunSelectedSkillRevisions(instanceId).map((s) => [s.skillId, s.selectionSource]),
  );

  return (
    <Main className="min-h-screen">
      {launchScope ? (
        <CrumbContributions
          entries={scopeSurfaceCrumbEntries(launchScope, "agents", scopeTitle ?? undefined)}
        />
      ) : null}
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

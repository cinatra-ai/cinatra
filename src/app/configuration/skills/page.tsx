import type { Metadata } from "next";
import Link from "next/link";
import { getGitHubAPIStatus, getGitHubOAuthSettings, listGitHubRepositories } from "@/lib/github-api";
import { getNangoFrontendConfig, getNangoStatus, getPrimarySavedNangoConnection } from "@/lib/nango-system";
import { NangoUserConnectButton } from "@cinatra-ai/sdk-ui/nango";
import { StatusPill } from "@/components/ui/status-pill";
import {
  readAgentSkillMatches,
  readAgentsForSkillMatching,
} from "@/lib/agents-store";
import { dedupSkillsByName, listInstalledSkills, readSchedule, readLatestBatchRun, skillMatchesStore } from "@cinatra-ai/skills";
import { readSkillsStorageConfig } from "@cinatra-ai/skills/store";
// Rendering this page exposes agent lists, skill lists, match rows, and
// OAuth/PAT settings, so gate the page boundary in addition to downstream
// server actions. `requireAdminSession()` redirects non-admin actors to
// /not-authorized before read-side data is fetched.
import { requireAdminSession } from "@/lib/auth-session";
import { ChangeRepoButton } from "./change-repo-modal";
import { AddMatchSkillSelector, RemoveMatchForm } from "./matches-client";
import { MatchesStatusPanel } from "./_matches-status-panel";
import { MatchesCronPicker } from "./_matches-cron-picker";
import { MatchesBatchModal } from "./_matches-batch-modal";
// Danger-zone client component for recreating the skills library.
import { RecreateLibrarySection } from "./recreate-library-section";
import { MatchesRowAction } from "./_matches-row-action";
import { SkillAutosaveForm } from "./skill-autosave-form";
import { SaveSkillsDataPathForm } from "./save-skills-data-path-form";
import { SaveSkillsGitHubPatForm } from "./save-skills-github-pat-form";
import { refreshAgentsAndMatchAction } from "./actions";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { Main } from "@/components/layout/main";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Field, FieldLabel } from "@/components/ui/field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { SettingsTabNav } from "@/components/settings-tab-nav";
// Connector-contributed skills-settings tabs resolve from the generated
// manifest map (lazy/guarded host-access cutover) — presence-
// aware, generator-classified loaders; an absent/degraded entry renders an
// "extension unavailable" note instead of the tab content.
import {
  GENERATED_CONNECTOR_SKILLS_SETTINGS_TABS,
} from "@/lib/generated/connector-setup-pages";
import { isDegradedExtensionLoad } from "@/lib/extension-load-guard";
import type { ComponentType } from "react";

export const metadata: Metadata = { title: "Skills Administration" };

const TABS = [
  { value: "library", label: "Library" },
  { value: "autosave", label: "Autosave" },
  { value: "matches", label: "Matches" },
  { value: "shell", label: "Shell" },
];

type Props = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function SettingsSkillsPage({ searchParams }: Props) {
  // Gate the entire page on admin membership before any data fetching.
  // `requireAdminSession()` redirects non-admin actors to /not-authorized;
  // for admins it returns the session and execution proceeds.
  await requireAdminSession();

  const resolved = await (searchParams ?? Promise.resolve({} as Record<string, string | string[] | undefined>));
  const tab = (Array.isArray(resolved.tab) ? resolved.tab[0] : resolved.tab) ?? "library";

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="Skills"
        description="Configure local storage, GitHub sync, autosave, and the sandboxed shell runtime for skill execution."
        divider={false}
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        <SettingsTabNav tabs={TABS} activeTab={tab} />

        {tab === "library" && <LibraryTabContent />}
        {tab === "autosave" && <AutosaveTabContent />}
        {tab === "matches" && <MatchesTabContent searchParams={resolved} />}
        {tab === "shell" && (
          <>
            <p className="max-w-[64ch] text-sm leading-[1.55] text-pretty text-muted-foreground">
              The shell runtime mounts installed skill packages into a sandboxed Docker container that OpenAI can
              invoke as tools. Each skill exposes a
              <code className="mx-1 font-mono text-xs">SKILL.md</code>
              that the model reads to understand its inputs and behavior. Configure the container image, workspace
              path, and which skills to mount here.
            </p>
            <ConnectorSkillsSettingsTabs />
          </>
        )}
      </PageContent>
    </Main>
  );
}

async function LibraryTabContent() {
  const [githubStatus, settings, storageConfig] = await Promise.all([
    getGitHubAPIStatus(),
    getGitHubOAuthSettings(),
    Promise.resolve(readSkillsStorageConfig()),
  ]);

  const nangoFrontendConfig = getNangoFrontendConfig();
  const connectionServiceReady = getNangoStatus().status === "connected";
  const savedConnection = getPrimarySavedNangoConnection("github");
  const repositories = savedConnection ? await listGitHubRepositories().catch(() => []) : [];

  const isConnected = githubStatus.status === "connected";
  const isIncomplete = githubStatus.status === "incomplete";

  return (
    <>
      <div className="grid gap-4 lg:grid-cols-2">

        <section className="soft-panel rounded-card px-6 py-6">
          <h2 className="text-lg font-semibold text-foreground">Local storage</h2>
          <p className="mt-2 max-w-[64ch] text-sm leading-[1.55] text-pretty text-muted-foreground">
            The local directory where skill packages are stored. Relative paths are resolved from the project root. Default: <code className="font-mono text-xs">data/skills</code>.
          </p>
          <SaveSkillsDataPathForm className="mt-5 flex flex-wrap items-end gap-3">
            <Field className="flex-1" style={{ minWidth: "240px" }}>
              <FieldLabel>Data path</FieldLabel>
              <Input
                name="dataPath"
                defaultValue={storageConfig.dataPath}
                placeholder="data/skills"
              />
            </Field>
            <Button type="submit" variant="outline">
              Save
            </Button>
          </SaveSkillsDataPathForm>
        </section>

        <section className="soft-panel rounded-card px-6 py-6">
          <h2 className="text-lg font-semibold text-foreground">GitHub sync</h2>
          <p className="mt-2 max-w-[64ch] text-sm leading-[1.55] text-pretty text-muted-foreground">
            Connect a GitHub account and select a repository. Cinatra will automatically clone skill packages from it on first access.
          </p>

          {!savedConnection ? (
            <div className="mt-5 flex flex-wrap items-center gap-4">
              <NangoUserConnectButton
                connectorKey="github"
                connected={false}
                connectLabel="Connect GitHub"
                nangoFrontendConfig={nangoFrontendConfig}
                className="inline-flex items-center justify-center rounded-control bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground transition hover:bg-primary/80 disabled:opacity-60"
              />
              {!connectionServiceReady && (
                <p className="text-sm text-muted-foreground">
                  Set up the connection service in{" "}
                  <Link href="/configuration/llm" className="underline underline-offset-4">
                    LLM
                  </Link>{" "}
                  first.
                </p>
              )}
              {!settings.clientId && connectionServiceReady && (
                <p className="text-sm text-muted-foreground">
                  Configure GitHub OAuth credentials in{" "}
                  <Link href="/configuration/llm/github" className="underline underline-offset-4">
                    LLM / GitHub
                  </Link>{" "}
                  first.
                </p>
              )}
            </div>
          ) : (
            <div className="mt-5">
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2">
                  <StatusPill status="approved">
                    Connected
                    {savedConnection.displayName ? ` as ${savedConnection.displayName}` : ""}
                  </StatusPill>
                  {isConnected && settings.selectedRepositoryFullName ? (
                    <span className="rounded-full border border-line bg-surface-strong px-3 py-1 font-mono text-xs text-muted-foreground">
                      {settings.selectedRepositoryFullName}
                    </span>
                  ) : (
                    <StatusPill status="hold">No repository selected</StatusPill>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  <ChangeRepoButton
                    repositories={repositories}
                    currentRepo={settings.selectedRepositoryFullName}
                  />
                  <NangoUserConnectButton
                    connectorKey="github"
                    reconnectConnectionId={savedConnection.connectionId}
                    connected={true}
                    reconnectLabel="Reconnect"
                    nangoFrontendConfig={nangoFrontendConfig}
                    className="inline-flex items-center justify-center rounded-control border border-line bg-surface-strong px-5 py-3 text-sm font-semibold text-foreground transition hover:border-primary disabled:opacity-60"
                  />
                </div>
              </div>
              {(isIncomplete || !settings.selectedRepositoryFullName) && (
                <p className="mt-3 text-sm text-muted-foreground">
                  Click <strong>Change repo</strong> to select a repository.
                </p>
              )}
            </div>
          )}
          <div className="mt-5 border-t border-line pt-5">
            <p className="text-sm font-medium text-foreground">Personal Access Token <span className="font-normal text-muted-foreground">(fallback when OAuth is unavailable)</span></p>
            <p className="mt-1 text-xs text-muted-foreground">
              If GitHub OAuth via Nango is not working, enter a PAT with <code className="font-mono">repo</code> scope. Cinatra will use it to push skill changes to the connected repo.
            </p>
            <SaveSkillsGitHubPatForm className="mt-3 flex flex-wrap items-end gap-3">
              <Input
                name="personalAccessToken"
                type="password"
                defaultValue={settings.personalAccessToken ?? ""}
                placeholder="ghp_…"
                className="flex-1 font-mono"
                style={{ minWidth: "240px" }}
              />
              <Button type="submit" variant="outline">
                Save
              </Button>
            </SaveSkillsGitHubPatForm>
          </div>
        </section>

        {/* Recreate Library danger zone. Type-to-confirm + optional GitHub force-push. */}
        <RecreateLibrarySection />

      </div>
    </>
  );
}

async function MatchesTabContent({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const [agents, matchState, skills, latestBatch, schedule, matchedRows] = await Promise.all([
    // The matches tab shows installed runnable agents.
    readAgentsForSkillMatching(),
    readAgentSkillMatches(),
    listInstalledSkills(),
    readLatestBatchRun().catch(() => null),
    readSchedule().catch(() => ({
      enabled: false,
      cronExpression: null,
      timezone: "UTC",
    })),
    skillMatchesStore.readAllMatched().catch(() => []),
  ]);
  const skillsById = new Map(skills.map((skill) => [skill.id, skill] as const));
  // Per-row metadata is sourced directly from the skill_matches table.
  // Keyed by `${agentPackageId}:${skillId}` because AgentSkillMatch.agentId
  // is a slug, not a packageId.
  const agentPackageIdById = new Map(agents.map((a) => [a.id, a.packageId] as const));
  const matchedRowsByPair = new Map(
    matchedRows.map((row) => [`${row.agentId}:${row.skillId}`, row] as const),
  );
  const refreshed = searchParams.refreshed === "1";
  const matched = searchParams.matched === "1";

  const initialLatest = latestBatch
    ? {
        batchId: latestBatch.batchId,
        status: latestBatch.status,
        pairCount: latestBatch.pairCount,
        submittedAt: latestBatch.submittedAt.toISOString(),
        completedAt: latestBatch.completedAt ? latestBatch.completedAt.toISOString() : null,
        lastPolledAt: latestBatch.lastPolledAt ? latestBatch.lastPolledAt.toISOString() : null,
        errorMessage: latestBatch.errorMessage,
        evaluatorVersion: latestBatch.evaluatorVersion,
      }
    : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="max-w-[64ch] text-sm leading-[1.55] text-pretty text-muted-foreground">
            These assignments are used as the default checked skills on agent-specific review pages.
          </p>
          {matchState.matchedAt ? (
            <p className="mt-2 text-xs uppercase tracking-[0.18em] text-muted-foreground">
              Last matched {new Date(matchState.matchedAt).toLocaleString()}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <MatchesBatchModal />
          <form action={refreshAgentsAndMatchAction}>
            <Button type="submit" variant="outline">
              Refresh &amp; rematch
            </Button>
          </form>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <MatchesStatusPanel initialLatest={initialLatest} />
        <MatchesCronPicker
          initial={{
            enabled: schedule.enabled,
            cronExpression: schedule.cronExpression,
            timezone: schedule.timezone,
          }}
        />
      </div>

      {refreshed || matched ? (
        <Alert variant="success" className="rounded-control">
          <AlertDescription>Agent package skill files were re-read and matches were updated.</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4">
        {agents.map((agent) => {
          const assignments = matchState.matches.filter((match) => match.agentId === agent.id);
          // Exclude skills bundled with or authored for a specific agent
          // (level=agent OR agentId set), then dedup by display name.
          // Filter must precede dedup so an agent-linked row cannot win
          // dedup with strong provenance and then get filtered out, leaving
          // a legitimate cross-agent skill that shared its name absent from
          // the dropdown.
          const availableSkills = dedupSkillsByName(
            skills
              .filter((skill) => skill.level !== "agent" && !skill.agentId)
              .filter((skill) => {
                const assigned = matchState.matches.find((match) => match.skillId === skill.id);
                return !assigned || assigned.agentId === agent.id;
              }),
          ).sort((left, right) => left.name.localeCompare(right.name));
          return (
            <section key={agent.id} className="soft-panel rounded-panel px-5 py-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="text-lg font-semibold text-foreground">{agent.humanReadableName}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{agent.identifier}</p>
                </div>
                <AddMatchSkillSelector
                  agentId={agent.id}
                  skills={availableSkills.map((skill) => ({
                    id: skill.id,
                    name: skill.name,
                    packageName: skill.packageName,
                  }))}
                />
              </div>
              {assignments.length === 0 ? (
                <p className="mt-4 text-sm leading-6 text-muted-foreground">No skills have been assigned to this agent yet.</p>
              ) : (
                <div className="mt-4 grid gap-3">
                  {assignments.map((assignment) => {
                    const skill = skillsById.get(assignment.skillId);
                    const packageId = agentPackageIdById.get(agent.id) ?? agent.id;
                    const row = matchedRowsByPair.get(`${packageId}:${assignment.skillId}`);
                    const source = row?.source ?? "rule";
                    const evaluatorVersion = row?.evaluatorVersion ?? "—";
                    const evaluatedAt = row?.evaluatedAt ?? null;
                    return (
                      <div key={assignment.id} className="rounded-control border border-line bg-surface-strong px-4 py-4">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="flex-1">
                            <p className="text-sm font-semibold text-foreground">{skill?.name ?? assignment.skillId}</p>
                            <p className="mt-1 text-sm text-muted-foreground">{skill?.packageName ?? "Unknown package"}</p>
                            <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                              <span>Source:</span>
                              <Badge variant="secondary">{source}</Badge>
                              <span>· Score: {assignment.score ?? "—"}</span>
                              <span>· Evaluator: {evaluatorVersion}</span>
                            </p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              Evaluated {evaluatedAt ? new Date(evaluatedAt).toLocaleString() : "—"}
                            </p>
                            <p className="mt-2 text-sm leading-6 text-muted-foreground">{assignment.rationale}</p>
                          </div>
                          <div className="flex flex-shrink-0 items-center gap-2">
                            <MatchesRowAction agentId={packageId} skillId={assignment.skillId} />
                            <RemoveMatchForm>
                              <input type="hidden" name="agentId" value={agent.id} />
                              <input type="hidden" name="skillId" value={assignment.skillId} />
                              <Button type="submit" variant="outline" size="sm">
                                Remove
                              </Button>
                            </RemoveMatchForm>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

async function AutosaveTabContent() {
  const { readSkillAutosaveConfig } = await import("@/lib/skill-autosave");
  const autosaveConfig = readSkillAutosaveConfig();

  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-[64ch] text-sm leading-[1.55] text-pretty text-muted-foreground">
        When enabled, submitted prompts in draft update fields are automatically distilled into personal skills after each rewrite completes.
      </p>
      <SkillAutosaveForm initialConfig={autosaveConfig} />
    </div>
  );
}

// Render every connector-contributed skills-settings tab from the generated
// map. Convention: the module exports `SkillsSettingsTabContent` (a server
// component). Degraded/absent entries (post-build uninstall) render a loud
// note; a PRESENT module missing the conventional export is a contract bug
// and throws (fail-loud, mirroring connector-mcp-registration).
async function ConnectorSkillsSettingsTabs() {
  const sections = await Promise.all(
    Object.entries(GENERATED_CONNECTOR_SKILLS_SETTINGS_TABS).map(async ([slug, entry]) => {
      const loaded = await entry.load();
      if (isDegradedExtensionLoad(loaded)) {
        console.warn(
          `[skills-settings-tabs] "${slug}": optional connector module is absent post-build — ` +
            `rendering the unavailable note (${loaded.reason})`,
        );
        return { slug, Content: null };
      }
      const Content = (loaded as { SkillsSettingsTabContent?: ComponentType }).SkillsSettingsTabContent;
      if (typeof Content !== "function") {
        throw new Error(
          `[skills-settings-tabs] "${slug}": module exports no SkillsSettingsTabContent component`,
        );
      }
      return { slug, Content };
    }),
  );
  return (
    <>
      {sections.map(({ slug, Content }) =>
        Content ? (
          <Content key={slug} />
        ) : (
          <Alert key={slug}>
            <AlertDescription>
              The {slug} extension is unavailable in this build — its shell settings cannot be
              shown. Reinstall/rebuild the extension to manage these settings.
            </AlertDescription>
          </Alert>
        ),
      )}
    </>
  );
}

import type { AgentRunRecord } from "./agent-run-record";
import { ensureRunTitle, readAgentTemplateById } from "./store";

// ---------------------------------------------------------------------------
// THE RUN'S NAME, READ ONE WAY FOR ITS PAGE AND ITS PANES (cinatra#4453).
//
// The components drawing, Breadcrumb section: "under an agent instance the
// trail names the agent's display name", and "While a name is genuinely
// unavailable, the crumb shows the id's first eight characters plus an
// ellipsis". The run page (`instance-screens.tsx`, through
// `agent-page-layout.tsx`) and the skills pane both name a run with this read
// and hand it nothing but the run, so for the same run and the same answers of
// the store they draw the same name: a template read that fails draws the id's
// characters on both, never the template the run page's route resolved.
//
// Call it only after the run's access check: it names the run for a reader who
// may read it. The read:
//   - The run's template is the run's own, read by its id (`run.templateId`).
//     A run with no `templateId` has no template.
//   - The run's name is its title, trimmed. A started run with no title gets
//     its numbered name from `ensureRunTitle` ("Blog Draft Writer Agent (1)");
//     a run still waiting for its first input gets none, so no numbered slot is
//     spent on an abandoned run.
//   - Neither read fails the page: a template read that fails is no template,
//     and a numbered name that cannot be written is no name.
//   - Without a name, the crumb draws the template's name, else the id's first
//     eight characters plus an ellipsis.
// ---------------------------------------------------------------------------

export type RunCrumbIdentityRun = Pick<AgentRunRecord, "id" | "title" | "templateId" | "runBy" | "status">;

export type RunCrumbIdentity = {
  /** The run's own name, trimmed; "" when it has none. */
  runName: string;
  /** What the crumb draws while the run has no name. Never empty. */
  fallbackName: string;
};

export async function readRunCrumbIdentity(run: RunCrumbIdentityRun): Promise<RunCrumbIdentity> {
  let templateName: string | null = null;
  if (run.templateId) {
    try {
      templateName = (await readAgentTemplateById(run.templateId))?.name?.trim() || null;
    } catch {
      templateName = null;
    }
  }
  let runName = run.title?.trim() ?? "";
  if (!runName && templateName !== null && run.status !== "pending_input") {
    try {
      runName = (await ensureRunTitle(run, templateName)).trim();
    } catch {
      runName = "";
    }
  }
  return { runName, fallbackName: templateName ?? `${run.id.slice(0, 8)}…` };
}

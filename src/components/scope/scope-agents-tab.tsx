// ---------------------------------------------------------------------------
// ScopeAgentsTab — the Agents tab of a scope page (cinatra#2808, per-scope
// surfaces S2).
//
// "Agents tab: reuse AgentAllCard/AgentRunClient with a scoped runHref (S3) and
//  EXTEND the card + row model by name: per-entry Settings (opens the assignment
//  page — the assignment epic), version, status."
//
// So there is no new list here: this IS <AgentRunClient> — the same filterable
// card grid /agents renders — over rows the per-scope eligibility loader
// produced and `buildScopeAgentRows` addressed at this scope.
// ---------------------------------------------------------------------------

import {
  AgentRunClient,
  type AgentRunRowModel,
} from "@cinatra-ai/agents/agent-run-client";

export function ScopeAgentsTab({ rows }: { rows: AgentRunRowModel[] }) {
  return (
    <div data-testid="scope-agents-list">
      <AgentRunClient rows={rows} />
    </div>
  );
}

/**
 * The AGENTS tab body of every scope base (cinatra#2808, per-scope surfaces S2).
 *
 * It renders nothing of its own: each row is the SAME `AgentAllCard` the
 * /agents "All Agents" tab draws — the ratified §IV card — with the scoped Run
 * href of #2809 and the card extended BY NAME with the per-entry Settings
 * control, the version and the status the issue's change item 2 names. The
 * global /agents surface passes none of those three, so it renders exactly as
 * before.
 *
 * Server-renderable: every card is its own client component (it lifts the
 * detail modal's open state), and this body holds no state at all.
 */
import type { ScopeAgentCardRow } from "@/lib/scope-surface-rows";
import { AgentAllCard } from "@/components/extensions/agent-all-card";

export function ScopeAgentsTab({ rows }: { rows: readonly ScopeAgentCardRow[] }) {
  return (
    <section className="grid grid-cols-1 gap-4" data-testid="scope-agents-list">
      {rows.map((row) => (
        <AgentAllCard key={row.key} row={row} />
      ))}
    </section>
  );
}

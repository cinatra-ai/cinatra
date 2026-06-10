// The agent-CREATION-flow package set, derived from the creation skill-lane
// definitions this package already owns — NOT a hand-maintained literal list.
//
// Semantics: a package is "creation flow" exactly when its chat dispatch must
// run `preflightAgentCreation()` BEFORE enqueue, i.e. when it participates in
// the creation skill lanes (`resolveRequiredCreationSkillIds` resolves catalog
// skills for it under the Anthropic pin):
//   - the reviewer lanes (`REVIEWER_LANE_PACKAGES` — the canonical lane
//     definition in agent-creation-review.ts), and
//   - the author lane (`AUTHOR_AGENT_PACKAGE_NAME` — run-author-agent.ts).
//
// The lint-policy agent is NOT a lane (it is the deterministic, skill-free
// scanner), so it is excluded by construction — including it would cause a
// false `anthropic_no_skills_resolved` preflight failure when the pin is
// active. This module deliberately contains NO extension package literals;
// the literals live with (and only with) their owning lane definitions.

import { REVIEWER_LANE_PACKAGES } from "./agent-creation-review";
import { AUTHOR_AGENT_PACKAGE_NAME } from "./run-author-agent";

/**
 * The packages whose explicit-dispatch from chat must run the creation
 * preflight gate. Computed fresh per call (the inputs are module constants;
 * the cost is negligible and callers may freeze/copy as they wish).
 */
export function getAgentCreationFlowPackages(): ReadonlySet<string> {
  return new Set<string>([...REVIEWER_LANE_PACKAGES, AUTHOR_AGENT_PACKAGE_NAME]);
}

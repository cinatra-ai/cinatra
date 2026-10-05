import type { AgentTemplateRecord } from "./store";

type RequiredFields =
  | "id"
  | "packageName"
  | "hitlRequired"
  | "hitlScreens"
  | "gatedSteps"
  | "hasArtifactBindings"
  | "agentDependencies"
  | "sourceType";

export type HitlRunFilterTemplate = Pick<AgentTemplateRecord, RequiredFields>;

export function templateHasOwnHitl(t: HitlRunFilterTemplate): boolean {
  if (t.hitlRequired) return true;
  if ((t.hitlScreens?.length ?? 0) > 0) return true;
  if ((t.gatedSteps?.length ?? 0) > 0) return true;
  return false;
}

function templateHasReview(t: HitlRunFilterTemplate): boolean {
  // The installed template persists whether its declared outputs bind an
  // artifact. The application reviews that output even when the agent has
  // no gate of its own. Unknown legacy declarations are not a review signal.
  return templateHasOwnHitl(t) || t.hasArtifactBindings === true;
}

/**
 * Returns the set of installed agent templates that should be rendered on
 * `/agents`:
 *
 *   1. Any internal template with at least one HITL signal of its own
 *      (`hitlRequired`, `hitlScreens.length > 0`, or `gatedSteps.length > 0`),
 *      or a declared artifact output that the application reviews
 *      (`hasArtifactBindings === true`).
 *   2. Any internal template whose `packageName` is a transitive descendant of
 *      a (1) template via `agentDependencies` — captures sub-agents the user
 *      can still launch directly because their parent flow has a review.
 *   3. Any external template (`sourceType === "external"`) — Cinatra cannot
 *      pre-classify HITL behavior of remote A2A agents, so we never hide them.
 *
 * Templates without a `packageName` are dropped from descendant resolution
 * because the `/agents` Run button cannot route to them. External
 * templates are exempt from the packageName requirement because the page
 * links them by (connectorSlug, remoteAgentId) instead.
 */
export function selectHitlRunVisibleTemplates<T extends HitlRunFilterTemplate>(
  templates: ReadonlyArray<T>,
): T[] {
  const byPackageName = new Map<string, T>();
  for (const t of templates) {
    if (t.sourceType === "internal" && t.packageName) {
      byPackageName.set(t.packageName, t);
    }
  }

  const visibleIds = new Set<string>();

  for (const t of templates) {
    if (t.sourceType === "external") {
      visibleIds.add(t.id);
      continue;
    }
    if (templateHasReview(t)) {
      visibleIds.add(t.id);
    }
  }

  const queue: string[] = [];
  for (const t of templates) {
    if (
      t.sourceType === "internal" &&
      t.packageName &&
      templateHasReview(t) &&
      t.agentDependencies
    ) {
      for (const dep of Object.keys(t.agentDependencies)) queue.push(dep);
    }
  }

  while (queue.length > 0) {
    const pkg = queue.shift()!;
    const dep = byPackageName.get(pkg);
    if (!dep) continue;
    if (visibleIds.has(dep.id)) continue;
    visibleIds.add(dep.id);
    if (dep.agentDependencies) {
      for (const childPkg of Object.keys(dep.agentDependencies)) {
        queue.push(childPkg);
      }
    }
  }

  return templates.filter((t) => visibleIds.has(t.id));
}

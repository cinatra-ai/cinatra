import "server-only";

// ---------------------------------------------------------------------------
// WHAT ONE SCOPE ASSIGNED, HYDRATED FOR THE PAGE (cinatra#2814, per-scope
// assignment S2).
//
// The page lists exactly the rows the S1 stores hold at the section's EXACT
// scope tuple, and labels them. Two rules carry over from the drawing:
//
//   - a chosen skill that has since degraded (archived, role changed, no
//     longer installed) STAYS in the list with its state, because clearing it
//     is exactly what an admin came to do. The labels therefore come from the
//     assignability predicate's verdict on the assigned ids, never from the
//     search population, which excludes exactly those rows;
//   - a chosen context artifact the reader can no longer see keeps its row
//     and its remove control, but never its title: naming an artifact the
//     reader may not read would be a read through this page.
//
// The same helpers answer the chooser's searches, so the offer and the list
// can never disagree about what "this scope" holds.
// ---------------------------------------------------------------------------

import type { AgentContextSlot } from "@cinatra-ai/extensions/agent-context-slots-reader";
import type { AssignableSkillCandidate } from "@cinatra-ai/skills/assignable-skill-search";
import type { SkillAssignability } from "@cinatra-ai/skills/agent-skill-assignability";

import { resolveInstalledVendorName } from "@cinatra-ai/registries";

import { artifactKindLabelFor } from "@/lib/artifacts/artifact-kind-label";
import type { ActorContext } from "@/lib/authz/actor-context";
import type { AssignmentScope } from "@/lib/assignment-scope";
import {
  contextSlotSearchPlaceholder,
  contextSlotTakesText,
  contextSlotTitle,
  type ScopeAssignmentArtifactCandidate,
  type ScopeAssignmentArtifactRow,
  type ScopeAssignmentSkillCandidate,
  type ScopeAssignmentSkillRow,
  type ScopeAssignmentSkillStatus,
  type ScopeAssignmentSlotGroup,
} from "./scope-assignment-model";

/** The artifact reads this module needs, in the shape the artifact service
 *  answers them. */
export type ScopeAssignmentArtifactSummary = {
  artifactId: string;
  title: string | null;
  eligibleExtensions: string[];
  primaryExtension: string | null;
  projectId: string | null;
};

export type ScopeAssignmentArtifactAccess =
  | { kind: "ok"; artifact: ScopeAssignmentArtifactSummary }
  | { kind: "not-found" }
  | { kind: "denied" };

export type ScopeAssignmentReadDeps = {
  readAssignedSkills: (
    packageName: string,
    scope: AssignmentScope,
  ) => Promise<Array<{ skillId: string }>>;
  resolveAssignability: (skillIds: string[]) => Promise<Map<string, SkillAssignability>>;
  listSkillCandidates: () => Promise<AssignableSkillCandidate[]>;
  readInstallStatuses: (packageNames: string[]) => Promise<Map<string, Array<{ status: string }>>>;
  readAssignedContext: (
    packageName: string,
    scope: AssignmentScope,
  ) => Promise<Array<{ slotId: string; artifactId: string }>>;
  readArtifact: (input: {
    artifactId: string;
    orgId: string | null;
    actor: ActorContext;
  }) => ScopeAssignmentArtifactAccess | Promise<ScopeAssignmentArtifactAccess>;
  listArtifacts: (input: {
    orgId: string;
    actor: ActorContext;
    extensionPackageName: string;
    projectId: string | null;
  }) => ScopeAssignmentArtifactSummary[] | Promise<ScopeAssignmentArtifactSummary[]>;
  /** A slot's accepted extensions, widened by the installed satisfies graph. */
  expandAcceptedExtensions: (accepted: readonly string[]) => Promise<string[]>;
  artifactKindLabel: (extension: string) => string;
  /** The installed card's vendor byline resolver. */
  resolveVendorName: (input: { manifestVendorName: string | null; author: string | null }) => string | null;
};

// ---------------------------------------------------------------------------
// Skills.
// ---------------------------------------------------------------------------

function skillStatus(verdict: SkillAssignability | undefined): ScopeAssignmentSkillStatus {
  if (!verdict) return "unavailable";
  if (verdict.assignable) return "ok";
  switch (verdict.reason) {
    case "unknown-skill":
    case "no-owning-extension":
    case "not-installed":
      return "missing";
    case "archived":
      return "archived";
    case "not-injectable":
    case "not-globally-visible":
      return "role-changed";
    default:
      return "unavailable";
  }
}

/** The providing extension's labels, the way the installed card resolves them. */
function candidateLabels(
  candidate: AssignableSkillCandidate,
  deps: ScopeAssignmentReadDeps,
): { displayName: string; vendorName: string | null } {
  const displayName = candidate.extensionDisplayName?.trim() || candidate.ownerPackageName;
  const vendorName =
    deps.resolveVendorName({
      manifestVendorName: candidate.extensionVendorName,
      author: candidate.extensionAuthor,
    }) ?? null;
  return { displayName, vendorName };
}

/** The chosen skills at one exact scope, in their stored order, labelled. */
export async function readScopeSkillRows(
  packageName: string,
  scope: AssignmentScope,
  deps: ScopeAssignmentReadDeps,
): Promise<ScopeAssignmentSkillRow[]> {
  const rows = await deps.readAssignedSkills(packageName, scope);
  if (rows.length === 0) return [];
  const verdicts = await deps.resolveAssignability(rows.map((r) => r.skillId));
  // Labels for the rows that are still assignable; a failed population read
  // leaves every row on its package-name fallback rather than half-labelled.
  const labels = new Map<string, { displayName: string; vendorName: string | null }>();
  try {
    const candidates = await deps.listSkillCandidates();
    for (const c of candidates) {
      const verdict = verdicts.get(c.skillId);
      if (!verdict || verdict.ownerPackageName !== c.ownerPackageName || labels.has(c.skillId)) continue;
      labels.set(c.skillId, candidateLabels(c, deps));
    }
  } catch {
    labels.clear();
  }
  return rows.map((row) => {
    const verdict = verdicts.get(row.skillId);
    const label = labels.get(row.skillId);
    const skillName = verdict?.skill?.name || row.skillId;
    return {
      skillId: row.skillId,
      skillName,
      displayName: label?.displayName ?? verdict?.ownerPackageName ?? skillName,
      vendorName: label?.vendorName ?? null,
      status: skillStatus(verdict),
    };
  });
}

/**
 * The skills the chooser offers at one exact scope: every assignable skill
 * minus the ones this scope already chose, matched against the query, in a
 * stable order so successive pages neither drop nor repeat a row.
 */
export async function searchScopeSkillCandidates(
  packageName: string,
  scope: AssignmentScope,
  query: string,
  page: { offset: number; limit: number },
  deps: ScopeAssignmentReadDeps,
): Promise<{ results: ScopeAssignmentSkillCandidate[]; hasMore: boolean }> {
  const [candidates, chosen] = await Promise.all([
    deps.listSkillCandidates(),
    deps.readAssignedSkills(packageName, scope),
  ]);
  const taken = new Set(chosen.map((r) => r.skillId));
  const offered = candidates.filter((c) => !taken.has(c.skillId));
  let statuses = new Map<string, Array<{ status: string }>>();
  try {
    const keys = [...new Set(offered.flatMap((c) => c.ownerPackageCandidates))];
    if (keys.length > 0) statuses = await deps.readInstallStatuses(keys);
  } catch {
    // The badge is a label, not the liveness decision (the predicate took
    // that): an unreadable status labels every offered skill Active.
  }
  const needle = query.trim().toLowerCase();
  const rows: ScopeAssignmentSkillCandidate[] = [];
  for (const c of offered) {
    const installRows =
      statuses.get(c.ownerPackageName) ?? c.ownerPackageCandidates.flatMap((k) => statuses.get(k) ?? []);
    if (installRows.length > 0 && installRows.every((r) => r.status === "archived")) continue;
    const { displayName, vendorName } = candidateLabels(c, deps);
    const haystack = `${c.skillName} ${displayName} ${vendorName ?? ""}`.toLowerCase();
    if (needle && !haystack.includes(needle)) continue;
    rows.push({
      skillId: c.skillId,
      skillName: c.skillName,
      displayName,
      vendorName,
      status: installRows.some((r) => r.status === "locked") ? "locked" : "active",
    });
  }
  rows.sort((a, b) =>
    a.skillName === b.skillName ? (a.skillId < b.skillId ? -1 : 1) : a.skillName < b.skillName ? -1 : 1,
  );
  return pageOf(rows, page);
}

// ---------------------------------------------------------------------------
// Context artifacts.
// ---------------------------------------------------------------------------

/** A slot's accepted extensions, widened by the installed satisfies graph
 *  (single hop), exactly as the run-time resolver widens them. */
export async function acceptedExtensionsForSlot(
  slot: AgentContextSlot,
  deps: ScopeAssignmentReadDeps,
): Promise<string[]> {
  return deps.expandAcceptedExtensions(slot.acceptedArtifactExtensions);
}

function artifactKindOf(
  artifact: ScopeAssignmentArtifactSummary,
  accepted: readonly string[],
  deps: ScopeAssignmentReadDeps,
): string | null {
  const ext = artifact.eligibleExtensions.find((e) => accepted.includes(e)) ?? artifact.primaryExtension;
  return ext ? deps.artifactKindLabel(ext) : null;
}

/** Where a section's artifacts are read: the section's organization, or the
 *  session's for the workspace tier and the personal scope. */
export type ScopeArtifactVantage = {
  orgId: string | null;
  actor: ActorContext;
  /** The project a project page narrows its artifacts to. */
  projectId: string | null;
};

/** One declared slot's chosen rows at one exact scope, labelled. */
export async function readScopeSlotGroups(
  packageName: string,
  slots: readonly AgentContextSlot[],
  scope: AssignmentScope,
  vantage: ScopeArtifactVantage,
  deps: ScopeAssignmentReadDeps,
): Promise<ScopeAssignmentSlotGroup[]> {
  const assigned = slots.length > 0 ? await deps.readAssignedContext(packageName, scope) : [];
  const groups: ScopeAssignmentSlotGroup[] = [];
  for (const slot of slots) {
    const accepted = await acceptedExtensionsForSlot(slot, deps);
    const kindLabels = slot.acceptedArtifactExtensions.map((e) => deps.artifactKindLabel(e));
    const rows: ScopeAssignmentArtifactRow[] = [];
    for (const row of assigned.filter((r) => r.slotId === slot.slotId)) {
      rows.push(await readArtifactRow(row.artifactId, accepted, vantage, deps));
    }
    groups.push({
      slotId: slot.slotId,
      title: contextSlotTitle(slot.slotId),
      takesText: contextSlotTakesText(kindLabels, slot.minItems, slot.maxItems),
      placeholder: contextSlotSearchPlaceholder(kindLabels),
      maxItems: typeof slot.maxItems === "number" ? slot.maxItems : null,
      rows,
    });
  }
  return groups;
}

async function readArtifactRow(
  artifactId: string,
  accepted: readonly string[],
  vantage: ScopeArtifactVantage,
  deps: ScopeAssignmentReadDeps,
): Promise<ScopeAssignmentArtifactRow> {
  let access: ScopeAssignmentArtifactAccess;
  try {
    access = await deps.readArtifact({ artifactId, orgId: vantage.orgId, actor: vantage.actor });
  } catch {
    access = { kind: "denied" };
  }
  if (access.kind === "denied") return { artifactId, title: null, kindLabel: null, status: "not-visible" };
  if (access.kind === "not-found") return { artifactId, title: null, kindLabel: null, status: "deleted" };
  const { artifact } = access;
  const compatible = artifact.eligibleExtensions.some((e) => accepted.includes(e));
  return {
    artifactId,
    title: artifact.title?.trim() || "Untitled artifact",
    kindLabel: artifactKindOf(artifact, accepted, deps),
    status: compatible ? "ok" : "incompatible",
  };
}

/**
 * The artifacts a slot's chooser offers at one exact scope: the stored
 * artifacts the reader can see in the section's organization (narrowed to the
 * project on a project page), of a kind the slot takes, minus the ones this
 * scope already chose for the slot.
 */
export async function searchScopeArtifactCandidates(
  packageName: string,
  slot: AgentContextSlot,
  scope: AssignmentScope,
  vantage: ScopeArtifactVantage,
  query: string,
  page: { offset: number; limit: number },
  deps: ScopeAssignmentReadDeps,
): Promise<{ results: ScopeAssignmentArtifactCandidate[]; hasMore: boolean }> {
  if (!vantage.orgId) return { results: [], hasMore: false };
  const accepted = await acceptedExtensionsForSlot(slot, deps);
  const chosen = new Set(
    (await deps.readAssignedContext(packageName, scope))
      .filter((r) => r.slotId === slot.slotId)
      .map((r) => r.artifactId),
  );
  const byId = new Map<string, ScopeAssignmentArtifactCandidate>();
  for (const extension of accepted) {
    const listed = await deps.listArtifacts({
      orgId: vantage.orgId,
      actor: vantage.actor,
      extensionPackageName: extension,
      projectId: vantage.projectId,
    });
    for (const artifact of listed) {
      if (chosen.has(artifact.artifactId) || byId.has(artifact.artifactId)) continue;
      // The listing's extension filter is the eligibility set; re-check it so
      // a wrong kind can never ride in on a listing that ignored the filter.
      if (!artifact.eligibleExtensions.some((e) => accepted.includes(e))) continue;
      byId.set(artifact.artifactId, {
        artifactId: artifact.artifactId,
        title: artifact.title?.trim() || "Untitled artifact",
        kindLabel: artifactKindOf(artifact, accepted, deps) ?? deps.artifactKindLabel(extension),
      });
    }
  }
  const needle = query.trim().toLowerCase();
  const rows = [...byId.values()]
    .filter((c) => !needle || c.title.toLowerCase().includes(needle))
    .sort((a, b) =>
      a.title === b.title ? (a.artifactId < b.artifactId ? -1 : 1) : a.title < b.title ? -1 : 1,
    );
  return pageOf(rows, page);
}

/** Can the writer see this artifact at this section, and does the slot take
 *  it? The two answers the context store asks, from ONE read. */
export async function inspectArtifactForSlot(
  artifactId: string,
  accepted: readonly string[],
  vantage: ScopeArtifactVantage,
  deps: ScopeAssignmentReadDeps,
): Promise<{ visible: boolean; compatible: boolean }> {
  const access = await deps.readArtifact({ artifactId, orgId: vantage.orgId, actor: vantage.actor });
  if (access.kind !== "ok") return { visible: false, compatible: false };
  if (vantage.projectId && access.artifact.projectId && access.artifact.projectId !== vantage.projectId) {
    return { visible: false, compatible: false };
  }
  return {
    visible: true,
    compatible: access.artifact.eligibleExtensions.some((e) => accepted.includes(e)),
  };
}

const MAX_PAGE = 50;

function pageOf<T>(rows: T[], page: { offset: number; limit: number }): { results: T[]; hasMore: boolean } {
  const offset = Math.max(0, Math.floor(Number(page?.offset) || 0));
  const limit = Math.min(MAX_PAGE, Math.max(1, Math.floor(Number(page?.limit) || 20)));
  return { results: rows.slice(offset, offset + limit), hasMore: rows.length > offset + limit };
}

// ---------------------------------------------------------------------------
// The production I/O.
// ---------------------------------------------------------------------------

function toSummary(a: {
  artifactId: string;
  title: string | null;
  eligibleExtensions: string[];
  primaryExtension: string | null;
  projectId: string | null;
}): ScopeAssignmentArtifactSummary {
  return {
    artifactId: a.artifactId,
    title: a.title,
    eligibleExtensions: a.eligibleExtensions,
    primaryExtension: a.primaryExtension,
    projectId: a.projectId,
  };
}

export const defaultScopeAssignmentReadDeps: ScopeAssignmentReadDeps = {
  readAssignedSkills: async (packageName, scope) =>
    (await import("@/lib/agent-assigned-skills-store")).readAssignedSkillsForAgentScope(packageName, scope),
  resolveAssignability: async (ids) =>
    (await import("@cinatra-ai/skills/agent-skill-assignability")).resolveSkillAssignability(ids),
  listSkillCandidates: async () =>
    (await import("@cinatra-ai/skills/assignable-skill-search")).listAssignableSkillCandidates(),
  readInstallStatuses: async (names) =>
    (await import("@cinatra-ai/extensions/canonical-store")).readInstalledExtensionsByPackageNames(names),
  readAssignedContext: async (packageName, scope) =>
    (await import("@/lib/agent-assigned-context-store")).readAssignedContextForAgentScope(packageName, scope),
  readArtifact: async ({ artifactId, orgId, actor }) => {
    const { readArtifactForDetail } = await import("@/lib/artifacts/artifact-service");
    const access = readArtifactForDetail({ artifactId, orgId, actor });
    return access.kind === "ok" ? { kind: "ok", artifact: toSummary(access.artifact) } : access;
  },
  listArtifacts: async ({ orgId, actor, extensionPackageName, projectId }) => {
    const { listArtifacts } = await import("@/lib/artifacts/artifact-service");
    return listArtifacts({ orgId, actor, extensionPackageName, projectId }).map(toSummary);
  },
  expandAcceptedExtensions: async (accepted) => {
    const [{ expandAcceptedViaSatisfies }, { getInstalledExtensionDescriptors }] = await Promise.all([
      import("@/lib/artifacts/context-resolver"),
      import("@/lib/artifacts/context-mcp"),
    ]);
    return expandAcceptedViaSatisfies(accepted, getInstalledExtensionDescriptors());
  },
  artifactKindLabel: artifactKindLabelFor,
  resolveVendorName: (input) => resolveInstalledVendorName(input) ?? null,
};

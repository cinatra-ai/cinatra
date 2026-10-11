"use server";

// ---------------------------------------------------------------------------
// The per-scope assignment page's server actions (cinatra#2814, per-scope
// assignment S2). Thin by design: each one hands its untrusted input to the
// write core in `scope-assignment-writes.server.ts`, which re-resolves the
// package, the scope and the reader's authority before any store is touched.
// "use server" modules may export async functions only.
// ---------------------------------------------------------------------------

import type {
  ScopeAssignmentActionResult,
  ScopeAssignmentActionTarget,
  ScopeAssignmentArtifactCandidate,
  ScopeAssignmentSearchResult,
  ScopeAssignmentSkillCandidate,
} from "./scope-assignment-model";

async function core() {
  return import("./scope-assignment-writes.server");
}

export async function searchScopeAssignableSkillsAction(
  target: ScopeAssignmentActionTarget,
  query: string,
  page: { offset: number; limit: number },
): Promise<ScopeAssignmentSearchResult<ScopeAssignmentSkillCandidate>> {
  return (await core()).searchScopeSkills(target, query, page);
}

export async function assignScopeSkillAction(
  target: ScopeAssignmentActionTarget,
  skillId: string,
): Promise<ScopeAssignmentActionResult> {
  return (await core()).assignScopeSkill(target, skillId);
}

export async function removeScopeSkillAction(
  target: ScopeAssignmentActionTarget,
  skillId: string,
): Promise<ScopeAssignmentActionResult> {
  return (await core()).removeScopeSkill(target, skillId);
}

export async function searchScopeContextArtifactsAction(
  target: ScopeAssignmentActionTarget,
  slotId: string,
  query: string,
  page: { offset: number; limit: number },
): Promise<ScopeAssignmentSearchResult<ScopeAssignmentArtifactCandidate>> {
  return (await core()).searchScopeContextArtifacts(target, slotId, query, page);
}

export async function assignScopeContextArtifactAction(
  target: ScopeAssignmentActionTarget,
  slotId: string,
  artifactId: string,
): Promise<ScopeAssignmentActionResult> {
  return (await core()).assignScopeContextArtifact(target, slotId, artifactId);
}

export async function removeScopeContextArtifactAction(
  target: ScopeAssignmentActionTarget,
  slotId: string,
  artifactId: string,
): Promise<ScopeAssignmentActionResult> {
  return (await core()).removeScopeContextArtifact(target, slotId, artifactId);
}

export async function reorderScopeContextArtifactsAction(
  target: ScopeAssignmentActionTarget,
  slotId: string,
  orderedArtifactIds: string[],
): Promise<ScopeAssignmentActionResult> {
  return (await core()).reorderScopeContextArtifacts(target, slotId, orderedArtifactIds);
}

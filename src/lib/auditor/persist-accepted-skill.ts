import "server-only";

// ---------------------------------------------------------------------------
// persistAcceptedAuditorSkill (cinatra#1625)
//
// The durable Accept side of the auditor per-item model. When /api/auditor/apply
// consumes the SoD receipt and applies the accepted proposals, the accepted
// per-item changes are also persisted as the parent agent's personal skill so
// they inform future runs (owner per-item-accept ruling, 2026-07-19).
//
// PER-ITEM over PROPOSAL IDS: only the ACCEPTED proposal patches contribute —
// each accepted patch's human-readable `message` becomes a promptEntry driving
// createOrUpdateCustomSkillForAgent (the same upsert the retired
// getAuditDrawerDataAction used, now driven by the accepted patch set rather
// than the raw HITL prompts). Dismissed proposals never persist.
//
// The personal skill is owned by the RUN OWNER (run.runBy); the run-derived
// actor gates the matched-skill catalog read so admin-hidden `system` skill
// content cannot leak into the generation prompt / persisted basedOnSkillIds.
//
// Called best-effort from the apply route: the deterministic mutation + the
// consumed receipt are the authoritative durable acceptance record; a persist
// failure here is logged, not fatal.
// ---------------------------------------------------------------------------

import {
  createOrUpdateCustomSkillForAgent,
  buildDefaultPersonalSkillName,
  listCustomSkillsForCurrentUserAndAgent,
} from "@cinatra-ai/skills";
import { buildActorContextFromRun } from "@/lib/authz/build-actor-context-from-run";
import type { ProposalSnapshot } from "@cinatra-ai/agents/auditor-snapshot-store";

type RunLike = { id: string; runBy: string | null; orgId: string | null; title?: string | null };

export async function persistAcceptedAuditorSkill(args: {
  run: RunLike;
  parentPackageName: string;
  snapshot: ProposalSnapshot;
  acceptedPatchIds: string[];
}): Promise<{ persisted: boolean }> {
  const { run, parentPackageName, snapshot, acceptedPatchIds } = args;

  // No run owner / org → no personal-skill home; skip (the mutation still
  // applied). buildActorContextFromRun also throws on a null orgId — guard here
  // so the best-effort persist degrades quietly rather than throwing.
  if (!run.runBy || !run.orgId) return { persisted: false };
  const runBy = run.runBy;
  const orgId = run.orgId;

  const acceptedSet = new Set(acceptedPatchIds);
  const acceptedPatches = snapshot.patches.filter((p) => acceptedSet.has(p.id));

  // Build one promptEntry per accepted proposal. Empty-message proposals are
  // dropped by createOrUpdateCustomSkillForAgent's own trim filter.
  const nowIso = new Date().toISOString();
  const promptEntries = acceptedPatches.map((p) => ({
    id: `${snapshot.id}:${p.id}`,
    kind: "initial" as const,
    prompt: (p.message ?? "").trim() || `${p.op} ${p.fieldPath}`,
    savedAt: nowIso,
  }));

  if (promptEntries.length === 0) return { persisted: false };

  const actor = await buildActorContextFromRun({
    id: run.id,
    runBy,
    orgId,
  });

  const existing = await listCustomSkillsForCurrentUserAndAgent(
    parentPackageName,
    runBy,
  );
  const existingSkillId = existing[0]?.id;

  const skillName =
    snapshot.preview.name?.trim() ||
    buildDefaultPersonalSkillName({
      campaignName: run.title ?? parentPackageName,
      sourceLabel: "HITL audit",
    });

  await createOrUpdateCustomSkillForAgent({
    agentId: parentPackageName,
    promptEntries,
    skillName,
    existingSkillId,
    userId: runBy,
    actor,
  });

  return { persisted: true };
}

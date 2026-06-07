"use server";

import { redirect } from "next/navigation";
import { saveGitHubRepositorySelection, saveGitHubPersonalAccessToken } from "@/lib/github-api";
import {
  matchAgentsToSkills,
  readAgentsForSkillMatching,
  readAgentSkillExclusions,
  readAgentSkillMatches,
  saveAgentSkillExclusions,
  saveAgentSkillMatches,
  syncInstalledAgentsToDatabase,
  writeManualSkillMatchAdd,
  writeManualSkillMatchRemove,
} from "@/lib/agents-store";
import { writeSkillsStorageConfig } from "@cinatra-ai/skills/store";
import {
  cloneConfiguredGitHubSkillRepository,
  computeInputHashes,
  listInstalledSkills,
  // Canonical adapters from llm-matching/adapters.ts include matchWhenRaw, so
  // manual add/remove rows produce the same skillInputHash as the inline,
  // batch, and admin re-evaluate paths. Hand-rolling the shape locally
  // re-introduces hash drift for rule-bearing skills.
  adaptAgentForMatching,
  adaptSkillForMatching,
} from "@cinatra-ai/skills";
import { requireAdminSession } from "@/lib/auth-session";
import {
  createInProcessPrimitiveTransport,
  invokePrimitive,
  type PrimitiveActorContext,
} from "@cinatra-ai/mcp-client";
import { createSkillsPrimitiveHandlers } from "@cinatra-ai/skills/mcp-handlers";

// ---------------------------------------------------------------------------
// Admin-gated server actions for skill matching.
// These actions call requireAdminSession() first. Defense-in-depth: the
// underlying MCP handlers also call requireAdminActor().
//
// Existing actions in this file are also gated with requireAdminSession();
// admin-only routes already gate the page, but server actions are
// independently invokable POST endpoints.
// ---------------------------------------------------------------------------

async function callSkillsHandler<T>(primitiveName: string, input: unknown): Promise<T> {
  const session = await requireAdminSession();
  const actor: PrimitiveActorContext = {
    actorType: "human",
    source: "ui",
    userId: session.user.id,
    sessionId: session.session?.id,
    platformRole: "platform_admin",
  };
  const transport = createInProcessPrimitiveTransport(createSkillsPrimitiveHandlers());
  return invokePrimitive<unknown, T>(transport, {
    primitiveName,
    input,
    actor,
    mode: "deterministic",
  });
}

export async function saveSkillsDataPathAction(formData: FormData) {
  await requireAdminSession();
  const dataPath = String(formData.get("dataPath") ?? "").trim() || "data/skills";
  writeSkillsStorageConfig({ dataPath });
}

export async function saveGitHubRepoFromSkillsAction(formData: FormData) {
  await requireAdminSession();
  const repositoryFullName = String(formData.get("repositoryFullName") ?? "").trim();
  try {
    await saveGitHubRepositorySelection({ repositoryFullName });
    await cloneConfiguredGitHubSkillRepository();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to save the repository.";
    throw new Error(message);
  }
  // Returns void on success
}

export async function saveSkillAutosaveAction(formData: FormData) {
  await requireAdminSession();
  const { writeSkillAutosaveConfig } = await import("@/lib/skill-autosave");
  const userCanSeeIndicator = formData.get("userCanSeeIndicator") === "on";
  // Defense-in-depth: users cannot toggle something they cannot see.
  const userCanConfigure = userCanSeeIndicator ? formData.get("userCanConfigure") === "on" : false;
  writeSkillAutosaveConfig({
    enabled: formData.get("enabled") === "on",
    userCanConfigure,
    userCanSeeIndicator,
  });
}

export async function saveGitHubPersonalAccessTokenAction(formData: FormData) {
  await requireAdminSession();
  const pat = String(formData.get("personalAccessToken") ?? "").trim() || null;
  saveGitHubPersonalAccessToken(pat);
}

export async function matchAgentsToSkillsAction() {
  await requireAdminSession();
  await matchAgentsToSkills();
  redirect("/configuration/skills?tab=matches&matched=1");
}

export async function refreshAgentsAndMatchAction() {
  await requireAdminSession();
  await syncInstalledAgentsToDatabase();
  await matchAgentsToSkills();
  redirect("/configuration/skills?tab=matches&refreshed=1");
}

// ---------------------------------------------------------------------------
// Admin-gated scheduling and batch-evaluation server actions.
// ---------------------------------------------------------------------------

export async function getScheduleAction() {
  await requireAdminSession();
  return callSkillsHandler("skills_match_schedule_get", {});
}

export async function setScheduleAction(formData: FormData) {
  await requireAdminSession();
  const enabled = formData.get("enabled") === "on";
  const cronExpressionRaw = String(formData.get("cronExpression") ?? "").trim();
  const cronExpression = cronExpressionRaw.length > 0 ? cronExpressionRaw : null;
  const timezone = String(formData.get("timezone") ?? "UTC").trim() || "UTC";
  return callSkillsHandler("skills_match_schedule_set", { enabled, cronExpression, timezone });
}

export async function getBatchEstimateAction() {
  await requireAdminSession();
  return callSkillsHandler("skills_match_batch_run_now", { dryRun: true });
}

export async function runBatchNowAction() {
  await requireAdminSession();
  return callSkillsHandler("skills_match_batch_run_now", { dryRun: false });
}

export async function evaluatePairAction(formData: FormData) {
  await requireAdminSession();
  const agentId = String(formData.get("agentId") ?? "").trim();
  const skillId = String(formData.get("skillId") ?? "").trim();
  if (!agentId || !skillId) {
    throw new Error("agentId and skillId are required");
  }
  return callSkillsHandler("skills_match_evaluate_pair", { agentId, skillId });
}

export async function addAgentSkillMatchAction(formData: FormData) {
  const session = await requireAdminSession();
  const agentId = String(formData.get("agentId") ?? "").trim();
  const skillId = String(formData.get("skillId") ?? "").trim();

  if (!agentId || !skillId) {
    throw new Error("Select a skill first.");
  }

  const [matchState, exclusionState, skills] = await Promise.all([
    readAgentSkillMatches(),
    readAgentSkillExclusions(),
    listInstalledSkills(),
  ]);
  const skill = skills.find((entry) => entry.id === skillId);
  if (!skill) {
    throw new Error("The selected skill is not installed.");
  }

  const withoutSkill = matchState.matches.filter((entry) => entry.skillId !== skillId);
  const existingForAgent = withoutSkill.filter((entry) => entry.agentId === agentId);
  if (existingForAgent.length >= 5) {
    throw new Error("Each agent can have a maximum of 5 skills.");
  }

  const nextMatches = [
    ...withoutSkill,
    {
      id: `${agentId}:${skillId}`,
      agentId,
      skillId,
      score: 100,
      rationale: "Manually assigned.",
    },
  ].sort((left, right) => left.agentId.localeCompare(right.agentId) || right.score - left.score || left.skillId.localeCompare(right.skillId));

  await saveAgentSkillMatches(nextMatches);
  await saveAgentSkillExclusions(
    exclusionState.exclusions.filter((entry) => !(entry.agentId === agentId && entry.skillId === skillId)),
  );

  // Also assert the manual row in skill_matches so
  // getAssignedSkillIdsForAgent + the visibility filter see it.
  // Manual rows have source=manual + matched=true and block subsequent
  // rule/llm overwrites.
  // Manual add uses the installed-agent reader.
  const agents = await readAgentsForSkillMatching();
  const agent = agents.find((entry) => entry.id === agentId);
  if (agent) {
    // Use the canonical adapters so manual add rows hash identically to
    // inline, batch, and admin re-evaluate rows for rule-bearing skills.
    // The local literal omits matchWhenRaw, which would diverge skillInputHash.
    const adaptedAgent = adaptAgentForMatching(agent);
    const adaptedSkill = adaptSkillForMatching({
      id: skill.id,
      name: skill.name,
      level: skill.level,
      content: skill.content ?? "",
      agentId: undefined,
    });
    const { agentInputHash, skillInputHash } = computeInputHashes(adaptedAgent, adaptedSkill);
    await writeManualSkillMatchAdd({
      agentId: agent.packageId,
      skillId: skill.id,
      actorId: session.user.id,
      agentInputHash,
      skillInputHash,
    });
  }
}

export async function removeAgentSkillMatchAction(formData: FormData) {
  const session = await requireAdminSession();
  const agentId = String(formData.get("agentId") ?? "").trim();
  const skillId = String(formData.get("skillId") ?? "").trim();

  if (!agentId || !skillId) {
    throw new Error("Unable to remove that assignment.");
  }

  const [matchState, exclusionState] = await Promise.all([readAgentSkillMatches(), readAgentSkillExclusions()]);
  const nextMatches = matchState.matches.filter((entry) => !(entry.agentId === agentId && entry.skillId === skillId));
  await saveAgentSkillMatches(nextMatches);
  const exclusionId = `${agentId}:${skillId}`;
  await saveAgentSkillExclusions(
    [
      ...exclusionState.exclusions.filter((entry) => entry.id !== exclusionId),
      {
        id: exclusionId,
        agentId,
        skillId,
        reason: "Manually removed from matches.",
      },
    ].sort((left, right) => left.agentId.localeCompare(right.agentId) || left.skillId.localeCompare(right.skillId)),
  );

  // Also assert a manual-exclusion row in skill_matches
  // (source=manual + matched=false). This blocks rule/llm transports from
  // re-asserting the pair.
  // Manual remove uses the installed-agent reader.
  const [agents, skills] = await Promise.all([
    readAgentsForSkillMatching(),
    listInstalledSkills(),
  ]);
  const agent = agents.find((entry) => entry.id === agentId);
  const skill = skills.find((entry) => entry.id === skillId);
  if (agent && skill) {
    // Use the canonical adapters so manual remove rows hash identically to
    // inline, batch, and admin re-evaluate rows for rule-bearing skills. The
    // local literal omits matchWhenRaw, which would diverge skillInputHash.
    const adaptedAgent = adaptAgentForMatching(agent);
    const adaptedSkill = adaptSkillForMatching({
      id: skill.id,
      name: skill.name,
      level: skill.level,
      content: skill.content ?? "",
      agentId: undefined,
    });
    const { agentInputHash, skillInputHash } = computeInputHashes(adaptedAgent, adaptedSkill);
    await writeManualSkillMatchRemove({
      agentId: agent.packageId,
      skillId: skill.id,
      actorId: session.user.id,
      agentInputHash,
      skillInputHash,
    });
  }
}

// ---------------------------------------------------------------------------
// Recreate Library admin action.
//
// Purges all skill data (DB rows + on-disk content under data/skills/) and
// reseeds. Two-stage: TRUNCATE all skill_* tables + path_relocations CASCADE,
// then rm -rf the on-disk skills root, then re-register the BullMQ batch
// scheduler so matching resumes on a clean slate.
//
// TRUNCATE is preferred over DELETE because:
//   (1) it's significantly faster on populated tables,
//   (2) it does NOT fire row-level triggers — important because DELETE on
//       skill_packages would otherwise NOT trigger anything, but a DELETE
//       on agent_templates would fire enqueue_agent_owner_move via cascade,
//       producing thousands of spurious path_relocations rows that we'd
//       then have to also wipe.
//
// The optional `forcePushEmptyToGitHub` flag subsumes the (misleadingly
// named) /api/skills/reset-repo route. With the local store empty after
// rm -rf, pushSkillStoreToGitHub({ force: true }) produces an empty tree
// commit on the configured GitHub repo.
//
// For production safety, this destructive action is blocked when the
// SUPABASE_DB_URL hostname matches CINATRA_DB_PROD_HOSTS. The guard is
// inactive when the env var is unset.
// ---------------------------------------------------------------------------

import { revalidatePath } from "next/cache";
import { sql } from "drizzle-orm";
import { rm, mkdir } from "node:fs/promises";
import {
  getSkillsDataRootPath,
  pushSkillStoreToGitHub,
  unregisterSkillMatchSchedule,
  registerSkillMatchScheduleAtBoot,
} from "@cinatra-ai/skills";
import { projectsDb } from "@/lib/projects-store";
import { postgresSchema } from "@/lib/database";

export interface RecreateLibraryOptions {
  forcePushEmptyToGitHub: boolean;
  /** Type-to-confirm guard — must equal the literal "recreate library". */
  confirmationPhrase: string;
}

export interface RecreateLibraryResult {
  truncatedTables: string[];
  removedDiskRoot: string;
  forcePushed: boolean;
  commitSha: string | null;
  /** Surface partial failure of the GH push so the UI can warn the operator
   *  instead of showing a misleading success toast. */
  forcePushError: string | null;
}

export async function recreateLibraryAction(
  opts: RecreateLibraryOptions,
): Promise<RecreateLibraryResult> {
  const session = await requireAdminSession();

  if (opts.confirmationPhrase !== "recreate library") {
    throw new Error(
      "Recreate Library requires the literal confirmation phrase 'recreate library'. " +
        "This safety check matches the type-to-confirm input in the Library tab dialog.",
    );
  }

  // Production hostname guard. If CINATRA_DB_PROD_HOSTS is set, refuse to run
  // when SUPABASE_DB_URL matches any of the comma-separated hostnames. Empty
  // env var = local dev = allowed.
  const dbUrlEnv = process.env.SUPABASE_DB_URL;
  const prodHostsEnv = process.env.CINATRA_DB_PROD_HOSTS;
  if (dbUrlEnv && prodHostsEnv) {
    const url = new URL(dbUrlEnv);
    const prodHosts = prodHostsEnv.split(",").map((s) => s.trim()).filter(Boolean);
    if (prodHosts.some((h) => url.hostname.endsWith(h))) {
      throw new Error(
        `Recreate Library refused: target DB host ${url.hostname} matches ` +
          `production pattern (CINATRA_DB_PROD_HOSTS=${prodHostsEnv}). ` +
          `Run from a non-production environment or unset the env var to override.`,
      );
    }
  }

  console.log(`[recreate-library] starting (initiator=${session.user.id})`);

  // 1. Unregister the BullMQ batch scheduler so no new matching jobs fire
  //    during the wipe. Best-effort — if Redis is unavailable, the worker
  //    can't be running anyway; continue with the DB+disk wipe.
  try {
    await unregisterSkillMatchSchedule();
  } catch (err) {
    console.warn("[recreate-library] unregisterSkillMatchSchedule failed:", err);
  }

  // 2. TRUNCATE skill tables + path_relocations CASCADE. One transaction.
  const truncatedTables = [
    // Include `skills` (primary skill-content table) and
    // `agent_run_skills_used` (per-run skill usage join). Both are part of the
    // skill data model; omitting them leaves phantom entries after a
    // "Recreate Library" run.
    "skills",
    "skill_packages",
    "skill_package_co_owners",
    "skill_co_owners",
    "agent_run_skills_used",
    "custom_skill_assignments",
    "skill_matches",
    "skill_match_batch_runs",
    "path_relocations",
  ];
  const ident = (n: string) =>
    `"${postgresSchema.replaceAll('"', '""')}"."${n}"`;
  const truncateSql = truncatedTables.map((t) => ident(t)).join(", ");
  await projectsDb.execute(sql.raw(`TRUNCATE ${truncateSql} CASCADE`));
  console.log(`[recreate-library] truncated ${truncatedTables.length} tables`);

  // 3. rm -rf data/skills/* (preserve the directory itself + re-create).
  const root = getSkillsDataRootPath();
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  console.log(`[recreate-library] cleared on-disk root: ${root}`);

  // 4. Optional: force-push empty state to GitHub. Capture and surface failure
  //    in the result so the UI can warn the operator. Local TRUNCATE + rm -rf
  //    already succeeded; failing the entire action would be misleading.
  //    Instead return forcePushed=false + forcePushError.
  let commitSha: string | null = null;
  let forcePushed = false;
  let forcePushError: string | null = null;
  if (opts.forcePushEmptyToGitHub) {
    try {
      const result = await pushSkillStoreToGitHub({ force: true });
      commitSha = result?.commitSha ?? null;
      forcePushed = true;
      console.log(`[recreate-library] force-pushed empty state to GitHub: ${commitSha ?? "(no sha)"}`);
    } catch (err) {
      forcePushError = err instanceof Error ? err.message : String(err);
      console.warn("[recreate-library] GitHub force-push failed:", err);
    }
  }

  // 5. Re-register the BullMQ scheduler so matching resumes on the next batch tick.
  try {
    await registerSkillMatchScheduleAtBoot();
  } catch (err) {
    console.warn("[recreate-library] re-register scheduler failed:", err);
  }

  revalidatePath("/configuration/skills");
  console.log(`[recreate-library] complete`);

  return {
    truncatedTables,
    removedDiskRoot: root,
    forcePushed,
    commitSha,
    forcePushError,
  };
}

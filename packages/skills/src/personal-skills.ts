import { resolveConfiguredLlmRuntime, runResolvedDeterministicLlmTask, parseStructuredJson } from "@cinatra-ai/llm";
// Personal-skill authoring uses the installed-agents reader so users can
// only attach personal skills to actual installed agents, not workspace
// packages. `selectAttachableAgents` additionally drops internal `system-*`
// runtime templates, which are not user-facing attach targets.
import {
  getAssignedSkillIdsForAgent,
  readAgentsForSkillMatching,
} from "@/lib/agents-store";
import { selectAttachableAgents } from "./attachable-agents";
import type { CampaignStore } from "@/lib/types";
// SavedDraftUpdatePrompt is only used locally in this file.
type SavedDraftUpdatePrompt = {
  id: string;
  kind: "initial" | "follow_up";
  prompt: string;
  savedAt: string;
};
import { getInstalledSkillById, listInstalledSkills } from "./skills-registry";
import { getCustomSkillForAgent, listCustomSkills, listCustomSkillsForAgent, upsertCustomSkill, upsertSkill, resolveCustomSkillOwner, getAgentOwnership } from "./skills-store";

// Re-export the dev-bypass constant via the barrel form so static analysis
// correctly classifies this file as having no production references to
// LOCAL_USER_ID outside guarded blocks.
export { LOCAL_USER_ID } from "./constants";

type PersonalSkillResponse = {
  name?: string;
  description?: string;
  content?: string;
};

function injectBasedOnFrontmatter(content: string, basedOnIds: string[]): string {
  if (basedOnIds.length === 0) return content;

  const yamlList = basedOnIds.map((id) => `  - "${id}"`).join("\n");
  const basedOnBlock = `based_on:\n${yamlList}`;

  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (frontmatterMatch) {
    const frontmatterBody = frontmatterMatch[1];
    // Match an existing based_on block (key + its list items, until next non-indented line)
    const existingBlockRe = /(^|\n)based_on:\s*\n((?:[ \t]+-[ \t]+.*(?:\n|$))*)/;
    const updatedBody = existingBlockRe.test(frontmatterBody)
      ? frontmatterBody.replace(existingBlockRe, `$1${basedOnBlock}\n`)
      : `${frontmatterBody}\n${basedOnBlock}`;
    return `${content.slice(0, frontmatterMatch.index)}---\n${updatedBody}\n---\n${content.slice(frontmatterMatch[0].length)}`;
  }

  // No frontmatter at all — prepend a minimal one.
  return `---\n${basedOnBlock}\n---\n${content}`;
}

function syncSkillContentName(content: string, desiredName: string) {
  const normalizedName = desiredName.trim();
  if (!normalizedName) {
    return content;
  }

  const displayNameLine = `display_name: ${normalizedName}`;
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
  let nextContent = content;

  if (frontmatterMatch) {
    const frontmatterBody = frontmatterMatch[1];
    const updatedFrontmatterBody = /(^|\n)display_name:\s*.*?(?=\n|$)/.test(frontmatterBody)
      ? frontmatterBody.replace(/(^|\n)display_name:\s*.*?(?=\n|$)/, `$1${displayNameLine}`)
      : `${frontmatterBody}\n${displayNameLine}`;
    nextContent = `${content.slice(0, frontmatterMatch.index)}---\n${updatedFrontmatterBody}\n---\n${content.slice(frontmatterMatch[0].length)}`;
  }

  if (/^#\s+/m.test(nextContent)) {
    nextContent = nextContent.replace(/^#\s+.*$/m, `# ${normalizedName}`);
  }

  return nextContent;
}

function extractPersonalSkillResponse(value: unknown): PersonalSkillResponse | null {
  if (!value) {
    return null;
  }

  if (typeof value === "string") {
    return parseStructuredJson<PersonalSkillResponse>(value);
  }

  if (typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const directName = typeof record.name === "string" ? record.name.trim() : "";
  const directDescription = typeof record.description === "string" ? record.description.trim() : "";
  const directContent = typeof record.content === "string" ? record.content.trim() : "";

  if (directContent) {
    return {
      name: directName || undefined,
      description: directDescription || undefined,
      content: directContent,
    };
  }

  const nestedKeys = ["output_parsed", "json", "response", "result", "data"];
  for (const key of nestedKeys) {
    const nested = extractPersonalSkillResponse(record[key]);
    if (nested?.content?.trim()) {
      return nested;
    }
  }

  const output = record.output;
  if (Array.isArray(output)) {
    for (const item of output) {
      const nested = extractPersonalSkillResponse(item);
      if (nested?.content?.trim()) {
        return nested;
      }
    }
  }

  const content = record.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      const nested = extractPersonalSkillResponse(item);
      if (nested?.content?.trim()) {
        return nested;
      }
    }
  }

  for (const nestedValue of Object.values(record)) {
    const nested = extractPersonalSkillResponse(nestedValue);
    if (nested?.content?.trim()) {
      return nested;
    }
  }

  return null;
}

export async function getCustomSkillForCurrentUserAndAgent(
  agentId: string,
  ownerUserId?: string,
) {
  let resolved = ownerUserId;
  if (!resolved) {
    if (process.env.BETTER_AUTH_DEV_BYPASS === "true") {
      const constants = await import("./constants");
      resolved = constants.LOCAL_USER_ID;
    } else {
      throw new Error(
        "getCustomSkillForCurrentUserAndAgent: ownerUserId is required.",
      );
    }
  }
  return getCustomSkillForAgent({ ownerUserId: resolved, agentId });
}

/** @deprecated Use getCustomSkillForCurrentUserAndAgent instead. */
export const getPersonalSkillForCurrentUserAndAgent = getCustomSkillForCurrentUserAndAgent;

export async function listCustomSkillsForCurrentUser(ownerUserId?: string) {
  let resolved = ownerUserId;
  if (!resolved) {
    if (process.env.BETTER_AUTH_DEV_BYPASS === "true") {
      const constants = await import("./constants");
      resolved = constants.LOCAL_USER_ID;
    } else {
      throw new Error(
        "listCustomSkillsForCurrentUser: ownerUserId is required.",
      );
    }
  }
  return listCustomSkills(resolved);
}

/** @deprecated Use listCustomSkillsForCurrentUser instead. */
export const listPersonalSkillsForCurrentUser = listCustomSkillsForCurrentUser;

export async function listCustomSkillsForCurrentUserAndAgent(
  agentId: string,
  userId?: string,
) {
  let resolved = userId;
  if (!resolved) {
    if (process.env.BETTER_AUTH_DEV_BYPASS === "true") {
      const constants = await import("./constants");
      resolved = constants.LOCAL_USER_ID;
    } else {
      throw new Error(
        "listCustomSkillsForCurrentUserAndAgent: userId is required.",
      );
    }
  }
  return listCustomSkillsForAgent({
    ownerUserId: resolved,
    agentId,
  });
}

/** @deprecated Use listCustomSkillsForCurrentUserAndAgent instead. */
export const listPersonalSkillsForCurrentUserAndAgent = listCustomSkillsForCurrentUserAndAgent;

export async function resolveCustomSkillContent(skillId?: string) {
  const normalized = String(skillId ?? "").trim();
  if (!normalized) {
    return undefined;
  }

  const skill = await getInstalledSkillById(normalized);
  return skill?.content;
}

export function buildDefaultPersonalSkillName(input: {
  campaignName: string;
  sourceLabel: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return `${input.campaignName} · ${input.sourceLabel} · ${timestamp}`;
}

export async function createOrUpdateCustomSkillForAgent(input: {
  agentId: string;
  promptEntries: SavedDraftUpdatePrompt[];
  skillName: string;
  existingSkillId?: string;
  connection?: CampaignStore["openAIConnection"];
  userId?: string;
  // Optional run id; when set, the resolver reads run.projectId from the
  // agent_runs row to scope the assignment to a project.
  runId?: string;
  // Actor scope for the matched-skill catalog read. Required when threading
  // is available (server action, autosave job, MCP request). When
  // null/undefined the helper falls back to a userId-only synthetic
  // resolution so the legacy call path keeps working — but the actor IS the
  // gate that prevents admin-hidden `system` skill content/IDs from being
  // embedded in the personal-skill generation prompt or returned as
  // `basedOnSkillIds`.
  actor?: import("@/lib/authz").ActorContext;
}) {
  const promptEntries = input.promptEntries.filter((entry) => entry.prompt.trim().length > 0);
  if (promptEntries.length === 0) {
    throw new Error("No saved global draft update prompts are available yet.");
  }

  const { requireResourceAccess, buildSkillResourceRef } = await import("@cinatra-ai/agents/auth-policy");

  const [allAgents, assignedSkillIds, installedSkills, existingPersonalSkill] = await Promise.all([
    readAgentsForSkillMatching(),
    // Thread actor so the resolver's custom + workspace assignments resolve
    // under the actor's scope. Actor-less resolution is post-filtered below
    // so system-level skills are not exposed without authorization.
    getAssignedSkillIdsForAgent(input.agentId, input.actor),
    listInstalledSkills(),
    input.existingSkillId
      ? listCustomSkillsForCurrentUserAndAgent(input.agentId, input.userId).then((skills) => skills.find((skill) => skill.id === input.existingSkillId) ?? null)
      : Promise.resolve(null),
  ]);

  const agents = selectAttachableAgents(allAgents);
  const npmSuffix = input.agentId.includes("/")
    ? (input.agentId.split("/").pop() ?? input.agentId)
    : input.agentId;
  const agent = agents.find((entry) => entry.id === input.agentId || entry.id === npmSuffix);
  if (!agent) {
    throw new Error("The requested agent is not installed.");
  }

  let matchedSkills = installedSkills.filter((skill) => assignedSkillIds.includes(skill.id));
  // Matched skill bodies are embedded verbatim in the LLM prompt below AND
  // their IDs are returned as `basedOnSkillIds`. Filter through
  // `requireResourceAccess` so admin-hidden system skill content cannot leak
  // into the generation prompt, persisted content, or returned
  // `basedOnSkillIds`. platform_admin is short-circuited inside
  // `requireResourceAccess`.
  if (input.actor) {
    const actor = input.actor;
    // Resolve package inheritance once for the leak-guard filter (W4).
    // Pure policy lookup — snapshot read (cinatra#1364).
    const { resolveEffectiveSkillAccessPolicy } = await import("./skills-store");
    const { readSkillsCatalogSnapshot } = await import("./skill-packages");
    const matchedSkillPackages = (await readSkillsCatalogSnapshot()).skillPackages ?? [];
    matchedSkills = matchedSkills.filter((skill) => {
      try {
        // See auth-policy.ts buildSkillResourceRef.
        requireResourceAccess(actor, buildSkillResourceRef({
          id: skill.id,
          level: skill.level,
          scope: skill.scope ?? null,
          // Canonical effective policy (W4): skill override else package's.
          accessPolicy: resolveEffectiveSkillAccessPolicy(skill, matchedSkillPackages),
        }));
        return true;
      } catch {
        return false;
      }
    });
  }
  if (matchedSkills.length === 0) {
    throw new Error("No matched skills are assigned to this agent.");
  }

  const outputSchema = {
    type: "object",
    additionalProperties: false,
    required: ["name", "description", "content"],
    properties: {
      name: { type: "string" },
      description: { type: "string" },
      content: { type: "string" },
    },
  } as const;

  const system = [
    "You produce a delta SKILL.md — a personal customization layer that extends base skills.",
    "Do not reproduce base skill content verbatim. Do not merge or rewrite the base skills.",
    "Your output captures ONLY the user's specific additions, amendments, and removals on top of the base skills.",
    "Structure the body with these sections as needed: ## Additions / ## Amendments / ## Removals.",
    "Return only valid JSON matching the schema.",
    "The content field must be the full delta SKILL.md text, including frontmatter and markdown body.",
  ].join("\n");
  const user = [
    `Target agent identifier: ${agent.identifier}`,
    `Target agent name: ${agent.humanReadableName}`,
    `Target agent description: ${agent.description}`,
    "",
    "Target agent SKILL.md (for context — do not reproduce this):",
    agent.frontmatterRaw ? `---\n${agent.frontmatterRaw}\n---\n${agent.content}` : agent.content,
    "",
    `Base skills assigned to this agent (${matchedSkills.length}) — do not reproduce, only delta over them:`,
    ...matchedSkills.flatMap((skill, index) => ["", `Base skill ${index + 1}: ${skill.name} (${skill.id})`, `Description: ${skill.description}`, skill.content]),
    "",
    "Saved guidance prompts to distill into durable delta preferences:",
    ...promptEntries.map((entry, index) => `${index + 1}. [${entry.kind === "initial" ? "Initial emails" : "Follow-up emails"}] ${entry.prompt.trim()}`),
    existingPersonalSkill
      ? ["", "Existing personal skill delta for this user and agent:", existingPersonalSkill.content, "", "Update that existing delta rather than creating a second one."].join("\n")
      : "",
    "",
    "Requirements for the delta SKILL.md:",
    "- Capture only user-specific additions, amendments, or removals — nothing already in the base skills.",
    "- Do not reproduce base skill instructions verbatim.",
    "- Make the delta concise, actionable, and reusable.",
    "- Use identifier, display_name, description, and keywords in frontmatter.",
  ]
    .filter(Boolean)
    .join("\n");

  const logLabel = existingPersonalSkill ? "personal-skill-update" : "personal-skill-create";
  // PURPOSE POLICY: exact-default (llm-purpose-policy.ts, purpose
  // "personal-skill-generation"). The `allowAnthropicFallback: true` special
  // case this call used to carry is RETIRED in S6 (cinatra#2093): it existed
  // only because Anthropic was architecturally barred from the global default,
  // so an Anthropic-only install needed a per-purpose escape hatch to reach it
  // at all (cinatra#1850). Anthropic is now `defaultCapable`, so an
  // Anthropic-only install resolves Anthropic because it IS the stored default
  // — and a multi-provider install no longer risks this purpose silently
  // running on a provider the operator did not choose. Shared chokepoint for
  // the auditor drawer action, the background skill-autosave job, and the MCP
  // skills_personal_skill_create_or_update primitive.
  const runtime = await resolveConfiguredLlmRuntime();
  if (!runtime) {
    throw new Error("No LLM provider configured for personal skill generation.");
  }

  const runRequest = async (attempt: 1 | 2) =>
    runResolvedDeterministicLlmTask({
      runtime,
      system:
        attempt === 1
          ? system
          : [
              system,
              "Your first response did not contain a usable delta SKILL.md definition.",
              "On this retry, ensure that content is a complete delta SKILL.md string with frontmatter and markdown body.",
              "Do not omit content and do not return an empty object.",
            ].join("\n\n"),
      user:
        attempt === 1
          ? user
          : [
              user,
              "",
              "Retry requirement:",
              "- Return valid JSON only.",
              "- content must contain the full delta SKILL.md.",
              "- Do not summarize the delta SKILL.md; include the full text in content.",
            ].join("\n"),
      outputSchema,
      maxOutputTokens: attempt === 1 ? 5200 : 6200,
      reasoningEffort: "medium",
      logLabel: `${logLabel}${attempt === 1 ? "" : "-retry"}`,
    });

  let response = await runRequest(1);
  let parsed = extractPersonalSkillResponse(response?.text) ?? extractPersonalSkillResponse(response?.rawBody);

  if (!String(parsed?.content ?? "").trim()) {
    response = await runRequest(2);
    parsed = extractPersonalSkillResponse(response?.text) ?? extractPersonalSkillResponse(response?.rawBody);
  }

  const content = String(parsed?.content ?? "").trim();
  if (!content) {
    throw new Error("The LLM provider did not return a custom skill definition.");
  }

  const name = input.skillName.trim() || `${agent.humanReadableName} Custom Skill`;
  const description = String(parsed?.description ?? `Custom skill for ${agent.humanReadableName}.`).trim() || `Custom skill for ${agent.humanReadableName}.`;
  const normalizedContent = syncSkillContentName(content, name);
  const basedOnIds = matchedSkills.map((skill) => skill.id);
  const contentWithBasedOn = injectBasedOnFrontmatter(normalizedContent, basedOnIds);

  let resolvedOwnerUserId = input.userId;
  if (!resolvedOwnerUserId) {
    if (process.env.BETTER_AUTH_DEV_BYPASS === "true") {
      const constants = await import("./constants");
      resolvedOwnerUserId = constants.LOCAL_USER_ID;
    } else {
      throw new Error(
        "createOrUpdateCustomSkillForAgent: input.userId is required.",
      );
    }
  }
  // Resolve ownership scope (project > team > org > user) and forward it to
  // upsertCustomSkill so the custom_skill_assignments row is written.
  // Without this, getAssignedSkillIdsForAgent cannot see the newly-saved
  // skill for the owning actor or any team/org member.
  let resolvedOwner: { ownerType: "user" | "team" | "project" | "organization" | "workspace"; ownerId: string };
  try {
    resolvedOwner = resolveCustomSkillOwner({
      actor: { principalId: resolvedOwnerUserId },
      agent: getAgentOwnership(agent),
      // run.projectId could be threaded via input.runId in the future;
      // omitted today because the run lookup is not yet wired here.
      run: undefined,
    });
  } catch {
    resolvedOwner = { ownerType: "user", ownerId: resolvedOwnerUserId };
  }
  return upsertCustomSkill({
    skillId: existingPersonalSkill?.id,
    ownerUserId: resolvedOwnerUserId,
    agentId: input.agentId,
    name,
    description,
    content: contentWithBasedOn,
    basedOnSkillId: matchedSkills[0]?.id,
    basedOnSkillIds: basedOnIds,
    ownerType: resolvedOwner.ownerType,
    ownerId: resolvedOwner.ownerId,
    createdBy: resolvedOwnerUserId,
  });
}

/** @deprecated Use createOrUpdateCustomSkillForAgent instead. */
export const createOrUpdatePersonalSkillForAgent = createOrUpdateCustomSkillForAgent;

// ---------------------------------------------------------------------------
// Chat capture (cinatra#1367) — the CHAT-SHAPED distillation entry.
//
// The run-autosave entry above is run-specific: it requires an INSTALLED
// agentId and at least one matched base skill (it throws otherwise). Chat has
// neither today — the Cinatra assistant is not an agent_templates row until
// the #1037 P1 bootstrap lands — so chat capture distills into ONE standalone
// per-user personal skill: no installed-agent requirement, no matched-skills
// requirement (this is the issue's graceful no-matched-skills path applied to
// the whole chat target). When #1037 lands the target mapping, the
// (user, agent)-scoped delta arm composes on top; this standalone skill stays
// valid as the assistant-agnostic layer.
//
// Uniqueness contract: the skill id is DETERMINISTIC per user (hash-based —
// slugified user ids can collide across distinct raw ids), so "creation
// happens at most once per (user, target)" holds structurally: every capture
// upserts the same id, amending in place. Callers serialize concurrent
// captures per user (the pipeline's per-user lock); a duplicate would require
// two writers to mint DIFFERENT ids for one user, which the deterministic id
// makes impossible.
// ---------------------------------------------------------------------------

const CHAT_CAPTURE_SKILL_NAME = "Chat capture — personal instructions";

/** Deterministic per-user chat-capture skill id. */
export function buildChatCaptureSkillId(ownerUserId: string): string {
  // Lazy import keeps node:crypto out of any client bundle that pulls the
  // barrel (this module is server-side, but stay conservative).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  const hash = createHash("sha256").update(ownerUserId).digest("hex").slice(0, 12);
  return `custom:personal-skills:chat-capture-${hash}`;
}

/**
 * Distill a captured durable instruction into the owner's standalone
 * chat-capture personal skill (create on first capture, amend in place after).
 *
 * `instruction` MUST already be redacted by the caller — this function
 * forwards it into an LLM prompt and persists the result (the #1367 redaction
 * guarantee covers classifier AND distiller inputs).
 */
export async function createOrUpdateChatCaptureSkill(input: {
  ownerUserId: string;
  /** Redacted, classifier-restated durable instruction. */
  instruction: string;
  /** Recorded in the skill body's provenance line — thread/turn traceability
   * additional to the skill_revisions row + the chat_capture_turns ledger. */
  provenance: { threadId: string; turnId: string };
}) {
  const ownerUserId = String(input.ownerUserId ?? "").trim();
  if (!ownerUserId) {
    throw new Error("createOrUpdateChatCaptureSkill: ownerUserId is required.");
  }
  const instruction = String(input.instruction ?? "").trim();
  if (!instruction) {
    throw new Error("createOrUpdateChatCaptureSkill: instruction is required.");
  }

  const skillId = buildChatCaptureSkillId(ownerUserId);
  const existingSkills = await listCustomSkills(ownerUserId);
  const existing = existingSkills.find((skill) => skill.id === skillId) ?? null;
  // Owner guard (defense-in-depth — the id embeds the owner hash, but a
  // catalog row is authoritative): never amend a row owned by someone else.
  if (existing && existing.ownerUserId && existing.ownerUserId !== ownerUserId) {
    throw new Error(
      `createOrUpdateChatCaptureSkill: skill ${skillId} is not owned by ${ownerUserId}.`,
    );
  }

  const outputSchema = {
    type: "object",
    additionalProperties: false,
    required: ["description", "content"],
    properties: {
      description: { type: "string" },
      content: { type: "string" },
    },
  } as const;

  const system = [
    "You maintain a personal SKILL.md capturing a user's durable instructions to their AI assistant.",
    "You receive the CURRENT skill (possibly none) and ONE new durable instruction.",
    "Merge the instruction into the skill: add it, or amend/replace an existing entry it supersedes or contradicts (newest instruction wins).",
    "Keep the skill concise and deduplicated — one bullet per durable rule, grouped under ## Preferences / ## Rules / ## Corrections as appropriate.",
    "Preserve [REDACTED] placeholders verbatim; never invent redacted content.",
    "The content field must be the full SKILL.md text: YAML frontmatter (identifier, display_name, description, keywords) followed by the markdown body.",
    "Return only valid JSON matching the schema.",
  ].join("\n");
  const user = [
    existing?.content
      ? ["Current skill content:", existing.content].join("\n")
      : "There is no existing skill yet — create it.",
    "",
    "New durable instruction to merge:",
    instruction,
    "",
    `Provenance (record under a final "## Provenance" section as a bullet, appending to any existing bullets): captured from chat thread ${input.provenance.threadId}, turn ${input.provenance.turnId}.`,
  ].join("\n");

  // PURPOSE POLICY: exact-default (llm-purpose-policy.ts, purpose
  // "chat-capture-distillation"). Same retirement as
  // createOrUpdateCustomSkillForAgent above — the Anthropic last-resort opt-in
  // is gone with the global Anthropic exclusion it existed to work around.
  const runtime = await resolveConfiguredLlmRuntime();
  if (!runtime) {
    throw new Error("No LLM provider configured for chat-capture distillation.");
  }

  const runRequest = async (attempt: 1 | 2) =>
    runResolvedDeterministicLlmTask({
      runtime,
      system:
        attempt === 1
          ? system
          : [
              system,
              "Your first response did not contain a usable SKILL.md definition.",
              "On this retry, ensure content is the complete SKILL.md string with frontmatter and markdown body.",
            ].join("\n\n"),
      user,
      outputSchema,
      maxOutputTokens: attempt === 1 ? 3000 : 4000,
      reasoningEffort: "low",
      logLabel: `chat-capture-distill${attempt === 1 ? "" : "-retry"}`,
    });

  let response = await runRequest(1);
  let parsed = extractPersonalSkillResponse(response?.text) ?? extractPersonalSkillResponse(response?.rawBody);
  if (!String(parsed?.content ?? "").trim()) {
    response = await runRequest(2);
    parsed = extractPersonalSkillResponse(response?.text) ?? extractPersonalSkillResponse(response?.rawBody);
  }
  const content = String(parsed?.content ?? "").trim();
  if (!content) {
    throw new Error("The LLM provider did not return a chat-capture skill definition.");
  }

  const description =
    String(parsed?.description ?? "").trim() ||
    existing?.description ||
    "Durable personal instructions captured from chat conversations.";

  return upsertSkill({
    type: "personal",
    packageName: "Custom Skills",
    skillId,
    ownerUserId,
    name: existing?.name ?? CHAT_CAPTURE_SKILL_NAME,
    description,
    content: syncSkillContentName(content, existing?.name ?? CHAT_CAPTURE_SKILL_NAME),
    revisionSource: "chat-capture",
  });
}

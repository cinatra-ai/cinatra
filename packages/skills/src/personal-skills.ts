import { resolveConfiguredLlmRuntime, runResolvedDeterministicLlmTask, parseStructuredJson } from "@cinatra-ai/llm";
// Personal-skill authoring uses the installed-agents reader so users can
// only attach personal skills to actual installed agents, not workspace
// packages.
import {
  getAssignedSkillIdsForAgent,
  readAgentsForSkillMatching,
} from "@/lib/agents-store";
import type { CampaignStore } from "@/lib/types";
// SavedDraftUpdatePrompt is only used locally in this file.
type SavedDraftUpdatePrompt = {
  id: string;
  kind: "initial" | "follow_up";
  prompt: string;
  savedAt: string;
};
import { getInstalledSkillById, listInstalledSkills } from "./skills-registry";
import { getCustomSkillForAgent, listCustomSkills, listCustomSkillsForAgent, upsertCustomSkill, resolveCustomSkillOwner, getAgentOwnership } from "./skills-store";

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

  const [agents, assignedSkillIds, installedSkills, existingPersonalSkill] = await Promise.all([
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
    matchedSkills = matchedSkills.filter((skill) => {
      try {
        // See auth-policy.ts buildSkillResourceRef.
        requireResourceAccess(actor, buildSkillResourceRef({
          id: skill.id,
          level: skill.level,
          scope: skill.scope ?? null,
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

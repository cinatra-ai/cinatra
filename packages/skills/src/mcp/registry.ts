import { z } from "zod";
import type { McpRuntimeToolServer } from "@cinatra-ai/mcp-server";
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";
import { buildActorFromMcpContextWithStore, type SkillsActorEnvelope } from "./build-actor-from-context";
import {
  createSkillsPrimitiveHandlers,
  skillIdSchema,
  agentIdSchema,
  upsertSkillSchema,
  deleteSkillSchema,
  installFromGitHubSchema,
  uninstallPackageSchema,
  libraryListSchema,
  installedSkillIdSchema,
  resolveForAgentSchema,
  createOrUpdateCustomSkillSchema,
  listInstalledSkillsInputSchema,
  upsertInstalledSkillSchema,
  // Admin-gated skill-match handler schemas.
  skillMatchScheduleGetSchema,
  skillMatchScheduleSetSchema,
  skillMatchBatchRunNowSchema,
  skillMatchEvaluatePairSchema,
} from "./handlers";

const TOOL_META: Record<string, { description: string; inputSchema: z.ZodTypeAny }> = {
  "skills_catalog_list": {
    description: "List all skills available in the catalog (installable skills).",
    inputSchema: z.object({}),
  },
  "skills_personal_list": {
    description: "List all personal skills saved for the current user.",
    inputSchema: z.object({}),
  },
  "skills_personal_list_for_agent": {
    description: "List personal skills assigned to a specific agent.",
    inputSchema: agentIdSchema,
  },
  "skills_personal_get": {
    description: "Get a single personal skill by its ID.",
    inputSchema: skillIdSchema,
  },
  "skills_personal_upsert": {
    description: "Create or update a personal skill (identified by agentId + name).",
    inputSchema: upsertSkillSchema,
  },
  "skills_personal_delete": {
    description: "Delete a personal skill by its ID.",
    inputSchema: deleteSkillSchema,
  },
  "skills_packages_list": {
    description: "List all installed skill packages (monorepo and third-party) with their level and skill count.",
    inputSchema: z.object({}),
  },
  "skills_packages_install_from_github": {
    description: "Install a skill package from a GitHub repository. Pass owner/repo (e.g. 'acme/my-skills'). The repository is cloned into data/skills/third-party/ and its skills become available immediately.",
    inputSchema: installFromGitHubSchema,
  },
  "skills_packages_uninstall": {
    description: "Uninstall a third-party skill package by its packageId. Removes the package from disk and from the catalog.",
    inputSchema: uninstallPackageSchema,
  },
  "skills_library_list": {
    description: "List skills in the catalog, optionally filtered by level (personal, team, organization, third-party) or a search query.",
    inputSchema: libraryListSchema,
  },
  "skills_installed_get": {
    description: "Get a single installed skill by its ID. Returns the full manifest including a `body` field with frontmatter stripped, ready for use as a system prompt in LLM API calls.",
    inputSchema: installedSkillIdSchema,
  },
  "skills_installed_list": {
    description: "List all installed skills (monorepo system skills and third-party) — metadata only (id, name, slug, description, packageId, packageName, packageSlug, sourceUrl, usedBy, level, scope). Call skills_installed_get to retrieve the full skill content (SKILL.md body). Uses cursor-based pagination: if nextCursor is present, call again with cursor=<nextCursor> to retrieve the next page.",
    inputSchema: listInstalledSkillsInputSchema,
  },
  "skills_matches_refresh": {
    description: "Re-run the agent-to-skill matching algorithm and persist the results. Call this after installing new skill packages or renaming agents to ensure skill chips reflect the current catalog.",
    inputSchema: z.object({}),
  },
  "skills_installed_resolve_for_agent": {
    description: "Resolve the assigned skill IDs and optional personal skill content for a given agent.",
    inputSchema: resolveForAgentSchema,
  },
  "skills_personal_skill_create_or_update": {
    description: "Create or update a personal skill for an agent by distilling saved draft update prompts into a reusable skill via LLM.",
    inputSchema: createOrUpdateCustomSkillSchema,
  },
  "skills_installed_upsert": {
    description: "Update the content of an existing installed system skill (e.g. '@cinatra-ai/agent-builder:agent-builder-compiler-agentic'). Only updates skills that already exist in the catalog — use this to sync a SKILL.md change from disk into the running server without a restart.",
    inputSchema: upsertInstalledSkillSchema,
  },
  // Admin-gated skill-match handlers.
  "skills_match_schedule_get": {
    description: "Read the current skill-match batch scheduler config (admin only).",
    inputSchema: skillMatchScheduleGetSchema,
  },
  "skills_match_schedule_set": {
    description: "Update the skill-match batch scheduler config and apply immediately without a restart (admin only).",
    inputSchema: skillMatchScheduleSetSchema,
  },
  "skills_match_batch_run_now": {
    description: "Submit a fresh skill-match batch run; pass { dryRun: true } first for a pre-submit cost estimate (admin only).",
    inputSchema: skillMatchBatchRunNowSchema,
  },
  "skills_match_evaluate_pair": {
    description: "Synchronously re-evaluate a single (agent, skill) pair via the LLM matcher (admin only).",
    inputSchema: skillMatchEvaluatePairSchema,
  },
};

/**
 * Forwards request-context fields (`userId`, `orgId`, `platformRole`) into
 * the actor envelope so admin-gated handlers honor the transport-stamped
 * platformRole. Pure helper lives in `./build-actor-from-context.ts` for
 * hermetic test isolation.
 */
function buildActorFromMcpContext(): SkillsActorEnvelope {
  return buildActorFromMcpContextWithStore(mcpRequestContextStorage.getStore());
}

export function registerSkillsPrimitives(server: McpRuntimeToolServer) {
  const handlers = createSkillsPrimitiveHandlers();

  for (const [name, handler] of Object.entries(handlers)) {
    const meta = TOOL_META[name] ?? { description: name, inputSchema: z.object({}).passthrough() };
    server.registerTool(
      name,
      {
        title: name,
        description: meta.description,
        inputSchema: meta.inputSchema,
      },
      (async (input: unknown) => {
        const result = await handler({
          primitiveName: name,
          input,
          actor: buildActorFromMcpContext() as never,
          mode: "agentic",
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: Array.isArray(result) ? { items: result } : typeof result === "object" && result !== null ? (result as Record<string, unknown>) : { result },
        };
      }) as any,
    );
  }
}

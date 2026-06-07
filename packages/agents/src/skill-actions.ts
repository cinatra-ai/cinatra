"use server";

import {
  createInProcessPrimitiveTransport,
  invokePrimitive,
  type PrimitiveActorContext,
} from "@cinatra-ai/mcp-client";
import { createSkillsPrimitiveHandlers } from "@cinatra-ai/skills/mcp-handlers";

const ACTOR: PrimitiveActorContext = { actorType: "human", source: "ui" };

type SkillItem = { id: string; name: string; description: string; packageName?: string };

async function callSkills<T>(primitiveName: string, input: Record<string, unknown>): Promise<T> {
  const transport = createInProcessPrimitiveTransport(createSkillsPrimitiveHandlers());
  return invokePrimitive<Record<string, unknown>, T>(transport, {
    primitiveName,
    input,
    actor: ACTOR,
    mode: "deterministic",
  });
}

// listPersonalSkillsForAgent returns a plain array (not { items: [] })
export async function fetchPersonalSkillsForAgent(agentId: string): Promise<SkillItem[]> {
  const result = await callSkills<SkillItem[]>("skills_personal_list_for_agent", { agentId });
  return Array.isArray(result) ? result : [];
}

/**
 * Fetches a step-specific system skill by slug + optional packageSlug.
 * Constructs the canonical skill ID (@cinatra/<packageSlug>:<slug>) and calls
 * skills_installed_get directly — this surfaces system/monorepo skills that
 * skills_installed_list omits due to catalog sync filtering.
 */
export async function fetchSkillsBySlug(slug: string, packageSlug?: string): Promise<SkillItem[]> {
  if (!packageSlug) return [];
  const skillId = `@cinatra-ai/${packageSlug}:${slug}`;
  try {
    const result = await callSkills<Record<string, unknown>>("skills_installed_get", { skillId });
    if (!result?.id) return [];
    return [{
      id: String(result.id),
      name: String(result.name ?? result.slug ?? slug),
      description: String(result.description ?? ""),
      packageName: result.packageName ? String(result.packageName) : undefined,
    }];
  } catch {
    return [];
  }
}

// Fetches installed skills assigned to the agent, resolved with name + description.
export async function fetchInstalledSkillsForAgent(agentId: string): Promise<SkillItem[]> {
  const resolved = await callSkills<{ skillIds: string[] }>("skills_installed_resolve_for_agent", { agentId });
  const assignedIds = new Set(resolved.skillIds ?? []);
  if (assignedIds.size === 0) return [];

  // Page through installed skills and collect those in the assigned set.
  const collected: SkillItem[] = [];
  let cursor: string | undefined;
  do {
    const page = await callSkills<{ items: Array<SkillItem & { packageName?: string }>; nextCursor?: string }>("skills_installed_list", {
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    for (const skill of page.items ?? []) {
      if (assignedIds.has(skill.id)) {
        collected.push({ id: skill.id, name: skill.name, description: skill.description, packageName: skill.packageName });
      }
    }
    cursor = page.nextCursor;
  } while (cursor && collected.length < assignedIds.size);

  return collected;
}

import "server-only";
import { runResolvedSkillAwareDeterministicLlmTask, resolveConfiguredLlmRuntime, buildLlmMcpServerTool } from "@cinatra-ai/llm";
import { updateSkillPrefillTextInDatabase, readSkillCatalogFromDatabase } from "@/lib/database";
import { ensureSkillForCapability } from "./extension-skill-resolver";

// The prefill meta-skill is resolved by stable, package-OWNED capability key
// (declared in the providing extension's `cinatra.capabilities`) via the
// generic `ensureSkillForCapability` resolver — which also lazily registers the
// SKILL.md body into the catalog. No hardcoded extension package name or
// on-disk SKILL.md path (the true-IoC contract).
const SKILL_PREFILL_CAPABILITY = "skill.prefill-generation";

function buildPrefillUserPrompt(skillContent: string): string {
  return `SKILL.md:\n${skillContent}`;
}

/**
 * Generate prefill text for a single skill via the skill-aware orchestration path.
 * The skill-prefill-generation meta-skill is delivered as a tool via skillIds so
 * it appears in the LLM request log rather than being embedded in the system prompt.
 * Returns the trimmed text or null if the model returned an empty response.
 * Re-throws any LLM error so the caller (the BullMQ job) can decide whether
 * to continue with other skills or abort.
 */
export async function generateSkillPrefillText(skill: {
  id: string;
  name: string;
  content: string;
}): Promise<string | null> {
  const runtime = await resolveConfiguredLlmRuntime();
  if (!runtime) {
    throw new Error("No LLM provider configured for skill prefill generation.");
  }
  // Pass the Cinatra MCP tool explicitly so the deduplication guard in
  // runResolvedSkillAwareDeterministicLlmTask fires and skips injecting
  // registered external MCPs (e.g. Apify) that have no role here.
  const cinatraMcpTool = await buildLlmMcpServerTool(runtime.provider);
  // Resolve the meta-skill by capability (lazily registering its SKILL.md body
  // into the catalog) before resolution.
  const prefillSkillId = await ensureSkillForCapability(SKILL_PREFILL_CAPABILITY);
  const response = await runResolvedSkillAwareDeterministicLlmTask({
    runtime,
    system: "",
    user: buildPrefillUserPrompt(skill.content),
    skillIds: [prefillSkillId],
    maxOutputTokens: 80,
    logLabel: `skill-prefill-generation:${skill.id}`,
    extraTools: cinatraMcpTool ? [cinatraMcpTool] : [],
  });
  const text = (response.text ?? "").trim();
  if (!text) {
    return null;
  }
  // Strip any leading/trailing quotes the model might emit despite the system instruction.
  const stripped = text.replace(/^["'`]+|["'`]+$/g, "").trim();
  return stripped.length > 0 ? stripped : null;
}

/**
 * BullMQ job runner. Receives a list of skill ids, looks them up in the
 * current catalog, and generates + persists prefillText for each one that
 * still needs it.
 *
 * Skills that:
 *   - Already have a non-empty prefillText, OR
 *   - Are missing from the catalog (deleted between enqueue and run), OR
 *   - Have empty content
 * are skipped silently.
 *
 * Each successful generation is persisted immediately so partial progress
 * is durable across job restarts. Per-skill failures are logged and do not
 * abort the rest of the batch.
 */
export async function runSkillPrefillGenerationJob(
  data: { skillIds: string[] },
  jobId?: string,
): Promise<{ generated: number; skipped: number; failed: number }> {
  const skillIds = Array.isArray(data?.skillIds) ? data.skillIds : [];
  if (skillIds.length === 0) {
    return { generated: 0, skipped: 0, failed: 0 };
  }

  const catalog = readSkillCatalogFromDatabase();
  const skillsById = new Map<string, Record<string, unknown>>();
  for (const record of catalog.skills) {
    const id = (record as Record<string, unknown>).id;
    if (typeof id === "string") {
      skillsById.set(id, record as Record<string, unknown>);
    }
  }

  let generated = 0;
  let skipped = 0;
  let failed = 0;

  for (const skillId of skillIds) {
    const record = skillsById.get(skillId);
    if (!record) {
      skipped += 1;
      continue;
    }
    const existingPrefillText =
      typeof record.prefillText === "string" && record.prefillText.trim().length > 0
        ? record.prefillText.trim()
        : null;
    if (existingPrefillText) {
      skipped += 1;
      continue;
    }
    const name = typeof record.name === "string" ? record.name : "";
    const content = typeof record.content === "string" ? record.content : "";
    if (!content.trim()) {
      skipped += 1;
      continue;
    }
    try {
      const prefillText = await generateSkillPrefillText({ id: skillId, name, content });
      if (!prefillText) {
        failed += 1;
        console.warn(`[skill-prefill-generation] Empty response for skill "${skillId}"`);
        continue;
      }
      const wrote = updateSkillPrefillTextInDatabase(skillId, prefillText);
      if (wrote) {
        generated += 1;
      } else {
        failed += 1;
      }
    } catch (error) {
      failed += 1;
      console.warn(
        `[skill-prefill-generation] Failed to generate prefill text for skill "${skillId}":`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  console.log(
    `[skill-prefill-generation] Job ${jobId ?? "(no id)"} complete — generated=${generated} skipped=${skipped} failed=${failed}`,
  );
  return { generated, skipped, failed };
}

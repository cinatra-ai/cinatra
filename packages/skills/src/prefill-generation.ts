import "server-only";
import { runResolvedDeterministicLlmTask, resolveConfiguredLlmRuntime } from "@cinatra-ai/llm";
import { readSkillFileContent } from "./skills-store";
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
 * Read the prefill meta-skill's SKILL.md body from the catalog row the
 * capability resolver just registered. Fails LOUD: an unreadable meta-skill is a
 * configuration error, and generating prefill text without its instructions
 * would silently produce garbage.
 */
async function readPrefillMetaSkillBody(prefillSkillId: string): Promise<string> {
  const catalog = readSkillCatalogFromDatabase();
  const record = catalog.skills.find(
    (entry) => (entry as Record<string, unknown>).id === prefillSkillId,
  ) as Record<string, unknown> | undefined;
  const inlineBody =
    typeof record?.content === "string" ? record.content.trim() : "";
  if (inlineBody) return inlineBody;
  const sourcePath =
    typeof record?.sourcePath === "string" ? record.sourcePath : "";
  if (sourcePath) {
    const fromDisk = (await readSkillFileContent(sourcePath)).trim();
    if (fromDisk) return fromDisk;
  }
  throw new Error(
    `The skill-prefill-generation meta-skill "${prefillSkillId}" resolved to no readable body.`,
  );
}

/**
 * Generate prefill text for a single skill.
 *
 * cinatra#2091 S4 — prefill generation LEAVES THE INJECTION WORLD. Its
 * meta-skill is an INTERNAL skill (S3): it is never assigned to an agent, never
 * uploaded, and it instructs the generator rather than the run. Delivering it
 * through the skill-injection contract would have required an intent for a
 * caller that has no run, no agent, and no user — so it is now read CORE-SIDE as
 * plain prompt context and dispatched through the NON-skill-aware API. That is
 * the same bytes reaching the model, minus a whole injection surface.
 *
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
  // Resolve the meta-skill by capability (lazily registering its SKILL.md body
  // into the catalog), then read its body as PLAIN PROMPT CONTEXT.
  const prefillSkillId = await ensureSkillForCapability(SKILL_PREFILL_CAPABILITY);
  const prefillInstructions = await readPrefillMetaSkillBody(prefillSkillId);
  const response = await runResolvedDeterministicLlmTask({
    runtime,
    system: prefillInstructions,
    user: buildPrefillUserPrompt(skill.content),
    maxOutputTokens: 80,
    logLabel: `skill-prefill-generation:${skill.id}`,
    // Declare the Cinatra self-MCP toolbox EXPLICITLY so the registered
    // external MCPs (Apify, ...) that have no role here are never injected —
    // the same net tool set the pre-contract call assembled through
    // `extraTools` plus the skill-aware arm's dedup guard.
    declaredToolboxIds: ["cinatra-mcp"],
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

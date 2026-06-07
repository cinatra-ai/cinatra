import { readLocalPackageSkillContent, stripSkillFrontmatter } from "@cinatra-ai/skills";
import { generate, parseStructuredJson } from "@cinatra-ai/llm";

function loadSystemPrompt(skillName: string): string {
  const raw = readLocalPackageSkillContent({
    packageDir: "campaigns",
    skillSlug: skillName,
  });
  if (!raw) {
    throw new Error(`Missing SKILL.md for campaigns/${skillName}`);
  }
  return stripSkillFrontmatter(raw);
}

const SYSTEM_GENERATE_CAMPAIGN_BLUEPRINT = loadSystemPrompt("generate-campaign-blueprint");
const SYSTEM_CLASSIFY_CAMPAIGN_TYPE_TEMPLATE = loadSystemPrompt("classify-campaign-type");
import {
  CAMPAIGN_TYPE_OPTIONS,
  CAMPAIGN_TYPE_VALUES,
  deriveCampaignTypeDescription,
  formatCampaignTypeCategory,
  inferCampaignTypeHeuristically,
} from "@/lib/campaign-type-catalog";
import type { CampaignTypeCategory } from "@/lib/types";

function getCategoryLabel(category: CampaignTypeCategory) {
  return formatCampaignTypeCategory(category);
}

export async function generateCampaignTypeBlueprint(input: {
  name: string;
  description: string;
  prompt: string;
  category: CampaignTypeCategory;
}) {
  try {
    const response = await generate({
      logLabel: "campaign-type-blueprint",
      system: SYSTEM_GENERATE_CAMPAIGN_BLUEPRINT,
      prompt: [
        `Campaign type: ${input.name}`,
        `Category: ${getCategoryLabel(input.category)}`,
        `Description: ${input.description}`,
        `Builder prompt: ${input.prompt}`,
      ].join("\n"),
      maxTokens: 900,
    });
    return response.text;
  } catch {
    return null;
  }
}

export async function classifyCampaignTypeFromPrompt(input: {
  name: string;
  prompt: string;
}) {
  let rawText: string;
  try {
    const response = await generate({
      logLabel: "campaign-type-classification",
      system: SYSTEM_CLASSIFY_CAMPAIGN_TYPE_TEMPLATE.replace(
        "{{CATEGORY_LIST}}",
        CAMPAIGN_TYPE_OPTIONS.map((option) => `${option.value}: ${option.label}`).join("\n"),
      ),
      prompt: `Campaign type name: ${input.name}\nBuilder prompt: ${input.prompt}`,
      maxTokens: 300,
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["category", "description"],
        properties: {
          category: { type: "string" },
          description: { type: "string" },
        },
      },
    });
    rawText = response.text ?? "";
  } catch {
    const category = inferCampaignTypeHeuristically(input.prompt);
    return {
      category,
      description: deriveCampaignTypeDescription(input.prompt, category),
    };
  }

  try {
    const parsed = parseStructuredJson<{ category?: string; description?: string }>(rawText);
    if (!parsed) {
      throw new Error("No structured response");
    }
    const category = parsed.category && CAMPAIGN_TYPE_VALUES.includes(parsed.category as (typeof CAMPAIGN_TYPE_VALUES)[number])
      ? parsed.category
      : inferCampaignTypeHeuristically(input.prompt);

    return {
      category,
      description: parsed.description?.trim() || deriveCampaignTypeDescription(input.prompt, category),
    };
  } catch {
    const category = inferCampaignTypeHeuristically(input.prompt);
    return {
      category,
      description: deriveCampaignTypeDescription(input.prompt, category),
    };
  }
}

import type { HostRequiredPackageDefinition } from "@cinatra-ai/sdk-extensions";
import { openAIAPIConnectionPackage, openAIAPISkillsPackage } from "@cinatra-ai/openai-connector";

export const hostRequiredPackages: HostRequiredPackageDefinition[] = [openAIAPIConnectionPackage, openAIAPISkillsPackage];

export function getHostRequiredPackageBySlug(slug: string) {
  return hostRequiredPackages.find((entry) => entry.slug === slug) ?? null;
}

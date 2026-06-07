import type { SkillPackageDefinition } from "@cinatra-ai/sdk-extensions";

// No third-party skill packages ship bundled in the monorepo anymore.
// Operators install skill packages at runtime via the GitHub upload flow at
// /configuration/extensions/upload, which calls
// installSkillPackageFromGitHub() and persists rows in cinatra.skill_packages
// with isCustom: true.
export const installedSkillPackages: SkillPackageDefinition[] = [];

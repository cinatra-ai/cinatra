// Vitest stub for the `@cinatra-ai/skills` barrel.
//
// Tests that consume the workspace package transitively (e.g. via
// `@/lib/agents-store`) only need `readSkillsCatalog`,
// `evaluateSkillMatchRulesStrict`, `buildAgentMatchContext`,
// `LOCAL_USER_ID`, and `buildDefaultPersonalSkillName`. Importing the
// real barrel pulls in `actions.ts` / `plugin-pages.tsx` which transitively
// drag in app-only modules. This stub re-exports only the leaf modules
// that don't require Next.js / app code.
export { readSkillsCatalog } from "../../src/skills-store";
export {
  evaluateSkillMatchRulesStrict,
  buildAgentMatchContext,
} from "../../src/matching";
export { LOCAL_USER_ID } from "../../src/constants";
export { buildDefaultPersonalSkillName } from "../../src/personal-skills";
export { upsertPersonalSkill } from "../../src/skills-store";

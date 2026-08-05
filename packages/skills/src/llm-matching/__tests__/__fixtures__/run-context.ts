/**
 * Shared frozen run-context fixture for the matching test suite (setup-flow
 * S6). Mirrors what `mintSkillMatchRunContext()` would return on an
 * OpenAI-default install; tests that assert provider/model provenance on rows
 * reference these fields rather than re-typing literals.
 */
import { LLM_MATCHER_VERSION } from "../../constants";
import type { SkillMatchRunContext } from "../../types";

export const TEST_RUN_CONTEXT: SkillMatchRunContext = {
  provider: "openai",
  model: "gpt-4o-mini",
  evaluatorVersion: LLM_MATCHER_VERSION,
};

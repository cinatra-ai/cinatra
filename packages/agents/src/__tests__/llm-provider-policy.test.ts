/**
 * Contract tests for the shared default OpenAI model constant in
 * `llm-provider-policy.ts`.
 *
 * Locks DEFAULT_OPENAI_MODEL_ID to "gpt-5.5" so the /setup/ai and
 * /configuration/llm default-model pickers and the persisted
 * openai-connection store (which all route their fallbacks through the
 * constant) cannot silently drift to another default, and asserts the
 * constant stays a member of the canonical ALLOWED_MODEL_IDS.openai
 * allowlist.
 *
 * Run: cd packages/agents && pnpm exec vitest run \
 *      src/__tests__/llm-provider-policy.test.ts
 */
import { describe, expect, it } from "vitest";

import { ALLOWED_MODEL_IDS, DEFAULT_OPENAI_MODEL_ID } from "../llm-provider-policy";

describe("DEFAULT_OPENAI_MODEL_ID", () => {
  it('is "gpt-5.5"', () => {
    expect(DEFAULT_OPENAI_MODEL_ID).toBe("gpt-5.5");
  });

  it("is a member of ALLOWED_MODEL_IDS.openai", () => {
    expect(ALLOWED_MODEL_IDS.openai).toContain(DEFAULT_OPENAI_MODEL_ID);
  });
});

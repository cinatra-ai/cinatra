/**
 * Shared schema for the labelled golden-eval fixture.
 *
 * Lives next to the fixture (NOT in __tests__) so consumers can import
 * `GoldenMatchRowSchema` + `GoldenMatchRow` without triggering vitest's
 * test-file discovery cascade. Two consumers today:
 *
 *   - `__tests__/golden-fixture-schema.test.ts` — offline schema validation
 *     of golden-matches.jsonl (runs in every unit-suite invocation).
 *   - `__tests__/golden-eval.live.test.ts` — live OpenAI-gated eval that
 *     deserialises rows before calling evaluatePair (only runs when
 *     OPENAI_API_KEY is set).
 *
 * Keeping the schema in a `.ts` (not `.test.ts`) file means importing it
 * does NOT re-run the schema-validation test cases as a side effect of
 * the live test loading.
 */

import { z } from "zod";

export const ScoreBandSchema = z.enum(["high", "medium", "low"]);
export const ExpectedSourceSchema = z.enum(["rule", "llm"]);
export const CategorySchema = z.enum([
  "obvious-match",
  "obvious-no-match",
  "borderline",
  "rule-short-circuit",
  "rule-fallthrough-to-llm",
]);

export const AgentSchema = z.object({
  packageId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  tags: z.array(z.string()),
});

export const SkillSchema = z.object({
  skillId: z.string().min(1),
  name: z.string().min(1),
  level: z.string().min(1),
  // matchWhenRaw is REQUIRED on rule-* category rows; optional on LLM-only
  // rows. The cross-field check in the validation test enforces the
  // rule-category requirement.
  content: z.string().min(1),
  matchWhenRaw: z.string().optional(),
});

export const GoldenMatchRowSchema = z.object({
  id: z.string().regex(/^GM-\d{2}[a-z]?$/, "id must match GM-NN[a-z] (see README)"),
  category: CategorySchema,
  agent: AgentSchema,
  skill: SkillSchema,
  expectedMatched: z.boolean(),
  expectedScoreBand: ScoreBandSchema,
  expectedSource: ExpectedSourceSchema,
  rationale: z.string().min(1),
});

export type GoldenMatchRow = z.infer<typeof GoldenMatchRowSchema>;

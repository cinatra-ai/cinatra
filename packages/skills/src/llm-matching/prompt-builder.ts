/**
 * Renders the matcher system+user prompt for a single (agent, skill) pair from
 * packages/skills/src/llm-matching/prompt.md.
 *
 * prompt.md is the sole source of the matcher prompt template. No inline prompt
 * strings live anywhere in the *.ts files of this directory. The template is
 * loaded once at module init via fs.readFileSync.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SKILL_MATCH_MAX_INPUT_TOKENS_PER_PAIR } from "./constants";
import type { AgentForMatching, SkillForMatching } from "./types";

// Resolve the directory of this module across CJS + ESM. import.meta.dirname is
// Node 21+ (we run on 24+) but vitest's transform layer may go either way, so we
// fall back to fileURLToPath(import.meta.url) which works in both ESM and the
// vitest transform bridge.
const moduleDir = (() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dirnameFromMeta = (import.meta as any)?.dirname as string | undefined;
  if (dirnameFromMeta) return dirnameFromMeta;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const urlFromMeta = (import.meta as any)?.url as string | undefined;
  if (urlFromMeta) return dirname(fileURLToPath(urlFromMeta));
  // CJS fallback (only hit under non-ESM transforms).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (typeof __dirname !== "undefined" ? __dirname : ".") as string;
})();

const PROMPT_TEMPLATE: string = readFileSync(join(moduleDir, "prompt.md"), "utf-8");

// Conservative byte budget: 1 token ≈ 4 bytes. Over-counts vs reality, which is
// fine for truncation — the LLM-side cap is enforced by maxTokens at the gateway.
const MAX_SKILL_CONTENT_BYTES = SKILL_MATCH_MAX_INPUT_TOKENS_PER_PAIR * 4;

// Split prompt.md into system (everything before the first H1) and user (from
// the first H1 onward). This keeps prompt.md as the sole source, with no inline
// system-prompt strings in any *.ts file.
const FIRST_H1 = PROMPT_TEMPLATE.indexOf("\n# ");
const SYSTEM_TEMPLATE: string =
  FIRST_H1 > 0 ? PROMPT_TEMPLATE.slice(0, FIRST_H1).trim() : PROMPT_TEMPLATE.trim();
const USER_TEMPLATE: string =
  FIRST_H1 > 0 ? PROMPT_TEMPLATE.slice(FIRST_H1 + 1) : "";

export interface PromptForPair {
  system: string;
  user: string;
}

export function buildPromptForPair(
  agent: AgentForMatching,
  skill: SkillForMatching,
): PromptForPair {
  // The truncation slice below is BYTE-based, not codepoint-based.
  // `Buffer.subarray(0, N)` cuts at byte offset N; if N lands inside a UTF-8
  // multibyte sequence the subsequent `toString("utf-8")` replaces the partial
  // bytes with the U+FFFD replacement character (3 bytes). This is
  // deterministic: the same input always produces the same truncated output.
  // The "\n\n[truncated]" marker is appended unconditionally, so the prompt
  // sent to the LLM is always well-formed UTF-8 even if it contains a single
  // U+FFFD glyph at the cut.
  //
  // The matching `redactRawResponse` in response-parser.ts uses a
  // codepoint-boundary walk-back to avoid emitting U+FFFD, because that path's
  // output is stored in the DB and shown to admins. Here the output is consumed
  // by the LLM and never persisted, so a single U+FFFD is acceptable. If this
  // prompt path needs byte-perfect UTF-8, lift the walk-back helper out of
  // response-parser.ts into a shared module and reuse it.
  const skillContentBytes = Buffer.byteLength(skill.content, "utf-8");
  const skillContent =
    skillContentBytes > MAX_SKILL_CONTENT_BYTES
      ? `${Buffer.from(skill.content, "utf-8").subarray(0, MAX_SKILL_CONTENT_BYTES).toString("utf-8")}\n\n[truncated]`
      : skill.content;

  const tags = agent.tags.length > 0 ? agent.tags.join(", ") : "(none)";
  const matchWhenHint =
    skill.matchWhenRaw && skill.matchWhenRaw.trim().length > 0
      ? skill.matchWhenRaw
      : "(none)";

  const render = (template: string): string =>
    template
      .replaceAll("{{agentName}}", agent.name)
      .replaceAll("{{agentDescription}}", agent.description)
      .replaceAll("{{agentTags}}", tags)
      .replaceAll("{{skillName}}", skill.name)
      .replaceAll("{{skillContent}}", skillContent)
      .replaceAll("{{matchWhenHint}}", matchWhenHint);

  return {
    system: render(SYSTEM_TEMPLATE),
    user: render(USER_TEMPLATE),
  };
}

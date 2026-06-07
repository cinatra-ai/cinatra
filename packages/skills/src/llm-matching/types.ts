/**
 * Type definitions for the shared skill-matching evaluator core.
 *
 * Used by inline and batch transports, MCP handlers, and the matcher reader.
 * The same SkillMatchRow shape MUST be produced by all transports.
 *
 * --- Leaf-safety contract ---------------------------------------------------
 *
 * THIS MODULE MUST REMAIN IMPORT-FREE.
 *
 * Reachable via the dedicated sub-path `@cinatra-ai/skills/llm-matching/types`
 * (declared in `tsconfig.json` and `packages/skills/package.json` exports).
 * Client components and other leaf-only consumers import from this sub-path
 * to obtain the shared types WITHOUT pulling in the side-effectful main
 * `@cinatra-ai/skills` barrel (which transitively re-exports `server-only`
 * modules like `event-hooks.ts`, `batch-runs-store.ts`, `schedule-boot.ts`,
 * `personal-skills.ts`, `prefill-generation.ts`, `extension-handler.ts`,
 * `local-skill-files.ts`, and `jobs.ts`).
 *
 * Do NOT add `import "server-only"` here, and do NOT add any `import` from
 * a sibling module that itself transitively pulls server-only modules. The
 * only acceptable additions are pure type definitions and (if ever needed)
 * `import type { … }` from other equally-leaf-safe `*.ts` files in this
 * directory (e.g. constants.ts).
 * ---------------------------------------------------------------------------
 */

export type MatchSource = "rule" | "llm" | "manual";
export type MatchStatus = "ok" | "error" | "skipped";

export type SkillMatchRow = {
  /** Canonical packageId — e.g. "@cinatra/email-agent" — used as the FK to agents. */
  agentId: string;
  skillId: string;
  source: MatchSource;
  matched: boolean;
  /** Range 0.000-1.000; null only when source=manual due to the DB constraint. */
  score: number | null;
  rationale: string | null;
  evaluatorVersion: string;
  agentInputHash: string;
  skillInputHash: string;
  status: MatchStatus;
  errorCode: string | null;
  errorMessage: string | null;
  evaluatedAt: Date;
  jobStartedAt: Date;
};

export type MatchDecision = {
  matched: boolean;
  score: number;
  rationale: string;
};

export type ParseResult =
  | { ok: true; value: MatchDecision }
  | { ok: false; errorCode: string; rawRedacted: string };

export type AgentForMatching = {
  packageId: string;
  name: string;
  description: string;
  tags: string[];
  /** Optional version string. Presence vs absence MUST change agentInputHash. */
  version?: string;
};

export type SkillForMatching = {
  skillId: string;
  name: string;
  level: string;
  agentId?: string;
  content: string;
  /** Raw `match_when:` block from SKILL.md frontmatter (YAML). May be malformed. */
  matchWhenRaw?: string;
};

export type MatchInputHashes = {
  agentInputHash: string;
  skillInputHash: string;
};

// ---------------------------------------------------------------------------
// CatalogProvider seam
// ---------------------------------------------------------------------------

/**
 * Minimal agent shape the BullMQ job handlers need from the host's catalog.
 *
 * Mirrors the subset of `PersistedAgent` that `adaptAgentForMatching()`
 * actually reads — keeping the interface narrow so the seam stays tight and
 * `@cinatra-ai/skills` does not develop new structural coupling to the host's
 * agent-catalog row shape.
 */
export type CatalogAgent = {
  packageId: string;
  humanReadableName?: string;
  packageName: string;
  description: string;
  keywords: string[];
};

/**
 * Minimal skill shape the BullMQ job handlers need from the host's installed
 * skill registry.
 *
 * Mirrors the subset of `SkillManifest` (from `../skills-registry`) that
 * `adaptSkillForMatching()` actually reads. Keeping the seam narrow lets the
 * seam type live in this leaf-safe types module without dragging
 * `skills-registry` (which transitively imports `@/lib/agents-store`) into
 * the cycle path.
 */
export type CatalogSkill = {
  id: string;
  name: string;
  level?: string;
  content: string;
};

/**
 * Lazy-DI seam injected into the four BullMQ job handlers
 * (handleInlineForSkill, handleInlineForAgent, handleBatchSubmit,
 * handleBatchPoll).
 *
 * Breaks the Skills ⇄ Agents circular dependency by moving the host-side reads
 * (`readAgentsCatalog` from `@/lib/agents-store`, `listInstalledSkills` /
 * `getInstalledSkillById` from `../skills-registry`) out of `jobs.ts` and
 * behind this interface. The concrete provider is constructed at the dispatch
 * site (`src/lib/background-jobs.ts`) which is the SOLE place
 * `@cinatra-ai/skills` and `@/lib/agents-store` collaborate via the seam.
 *
 * Tests pass an inline mock provider — no static dependency on the host app
 * is required to exercise the handlers in unit tests.
 */
export interface CatalogProvider {
  readAgents(): Promise<CatalogAgent[]>;
  listSkills(): Promise<CatalogSkill[]>;
  getSkillById(skillId: string): Promise<CatalogSkill | null>;
}

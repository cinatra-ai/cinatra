/**
 * Skill tools for the unified LLM orchestration layer.
 *
 * Skills are exposed as LlmTool definitions so the LLM decides when to
 * read and apply them. SKILL.md content is never dumped into the system
 * prompt — only skill IDs and descriptions are listed so the LLM knows
 * what's available.
 *
 * All skill information is retrieved through the skills package library
 * via createDeterministicSkillsClient().
 */

import * as path from "node:path";
import { existsSync } from "node:fs";
import { readSkillFileContent, type SkillSource } from "@cinatra-ai/skills";
import { createDeterministicSkillsClient } from "@cinatra-ai/skills/mcp-client";
import {
  readOpenAIShellSettings,
  runOpenAIShellCommandInDocker,
  type OpenAIShellSettings,
} from "@cinatra-ai/openai-connector";
import type { LlmTool, LlmShellTool, LlmFunctionTool, LlmMcpServerTool, LlmWebSearchTool } from "../types";

type SkillSummary = {
  id: string;
  name: string;
  slug: string;
  description: string;
  /** Path to the SKILL.md file (from the skills package MCP primitive). */
  sourcePath?: string;
  /** Path to the skill directory (derived from sourcePath via path.dirname). */
  directoryPath?: string;
  /**
   * The SkillSource descriptor as recorded on the resolved catalog row.
   * Carried through resolveSkills so downstream shell mounting (local +
   * OpenAI Docker) can observe the active-head/digest revision and source
   * origin without re-fetching the catalog. Resolved FRESH on every call
   * (the deterministic-skills-client `installed.get` always reads the
   * current catalog state) so a digest/active-head flip is picked up at the
   * next mount, not cached against a stale snapshot.
   *
   * Consumers do NOT yet route content reads through `source`. This field is
   * the seam.
   */
  source?: SkillSource | null;
};

// ---------------------------------------------------------------------------
// Internal: resolve skills through the skills library
// ---------------------------------------------------------------------------

function getSkillsClient() {
  return createDeterministicSkillsClient({
    actor: { actorType: "model", source: "agent" },
  });
}

/**
 * Public accessor for resolved skill summaries (id / name / description).
 * Used by the Anthropic skill-delivery adapter to build a model-facing
 * availability cue. Internal `resolveSkills` stays private; this is a thin
 * re-export so the seam does not reach into module internals.
 */
export async function resolveSkillSummaries(
  skillIds: string[],
): Promise<Array<{ id: string; name: string; description: string }>> {
  const skills = await resolveSkills(skillIds);
  return skills.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
  }));
}

async function resolveSkills(skillIds: string[]): Promise<SkillSummary[]> {
  const client = getSkillsClient();
  const skills: SkillSummary[] = [];

  for (const skillId of skillIds) {
    const skill = await client.installed.get(skillId);
    if (skill) {
      // sourcePath is the SKILL.md file path from the skills package MCP primitive.
      // directoryPath is the containing folder — what the shell tool needs.
      const directoryPath = skill.sourcePath ? path.dirname(skill.sourcePath) : undefined;
      // Carry the SkillSource through. installed.get returns the field at
      // runtime (PersistedSkill.source); declare it on the typed surface as
      // well so consumers can route through it. Read fresh per resolveSkills
      // call — no caching against a stale snapshot.
      const source = (skill as { source?: SkillSource | null }).source ?? null;
      skills.push({
        id: skill.id,
        name: skill.name,
        slug: skill.slug,
        description: skill.description,
        sourcePath: skill.sourcePath,
        directoryPath,
        source,
      });
    }
  }

  return skills;
}

// ---------------------------------------------------------------------------
// local skill shell tool — reads skill files from disk without Docker
//
// The legacy `createReadSkillTool` / `read_skill` function-tool was retired
// to close the catalog-bypass surface (see CLAUDE.md
// "skills CATALOG-registry-only + shell-tool delivery rule"). Bridge / agent
// paths that previously fell back to `read_skill` now either ship the shell
// tool with a catalog-resolved sourcePath, or degrade to no inline skill
// tool with a structured warning. A CI gate enforces this; see
// `scripts/audit/read-skill-function-tool-banned.mjs`.
// ---------------------------------------------------------------------------

/**
 * Create a shell-type tool whose execute function reads skill files from
 * disk via the skills package layer. Supports `cat`, `head`, and `tail`
 * on paths within the mounted skill directories. No Docker required.
 *
 * This is the default shell tool used whenever skills have local paths.
 * The model receives the same `type: "shell"` declaration with skill paths
 * as it would with the Docker-based shell, but execution is handled locally.
 */
export function createLocalSkillShellTool(options: {
  mountedSkills: SkillSummary[];
}): LlmShellTool {
  const mountedSkills = options.mountedSkills;

  // Map virtual paths (exposed to the LLM) to real directory paths.
  // We never expose real filesystem paths to avoid confusion and privacy leakage.
  const virtualToReal = new Map<string, string>();
  for (const s of mountedSkills) {
    if (s.directoryPath) {
      virtualToReal.set(`/skills/${s.slug}`, s.directoryPath);
    }
  }

  return {
    type: "shell",
    skills: mountedSkills.map((s) => ({
      name: s.slug,
      description: s.description,
      path: `/skills/${s.slug}`,
    })),
    execute: async (action): Promise<Array<{ stdout: string; stderr: string; outcome: { type: "exit"; exitCode: number } | { type: "timeout" } }>> => {
      return Promise.all(
        action.commands.map(async (command) => {
          try {
            const result = await executeLocalSkillCommand(command, mountedSkills, virtualToReal);
            return {
              stdout: result,
              stderr: "",
              outcome: { type: "exit" as const, exitCode: 0 },
            };
          } catch (error) {
            return {
              stdout: "",
              stderr: error instanceof Error ? error.message : "Command failed",
              outcome: { type: "exit" as const, exitCode: 1 },
            };
          }
        }),
      );
    },
  };
}

/**
 * Execute a read-only shell command (cat/head/tail) on a file within a
 * mounted skill directory. Resolves the target path and delegates to
 * the skills package layer for secure file reading.
 *
 * Handles `cd <dir> && <cmd>` prefixes — the LLM often navigates to the
 * skill directory before issuing a cat command. The `cd` is stripped and
 * the remainder is executed with the path resolved against the virtual map.
 */
async function executeLocalSkillCommand(
  command: string,
  mountedSkills: SkillSummary[],
  virtualToReal?: Map<string, string>,
): Promise<string> {
  // Strip `cd "<dir>" &&` or `cd <dir> &&` prefix the LLM commonly emits.
  let effectiveCommand = command.trim();
  const cdMatch = effectiveCommand.match(/^cd\s+"?([^"&]+)"?\s*&&\s*/);
  if (cdMatch) {
    effectiveCommand = effectiveCommand.slice(cdMatch[0].length).trim();
  }

  // Scan all &&-chained segments for the first supported read command.
  // The LLM sometimes generates multi-step probes (e.g. `printf '%s\n' path && sed -n '1,220p' path`)
  // or chains commands after a cd. Find the first segment with a supported verb, or translate
  // `sed -n 'X,Yp' path` → `head -n Y path`. Falls back to the first segment on no match.
  const chainedSegments = effectiveCommand.split(/\s*&&\s*/);
  if (chainedSegments.length > 1) {
    let resolved: string | undefined;
    for (const seg of chainedSegments) {
      const segVerb = seg.trim().split(/\s+/)[0]?.toLowerCase();
      if (segVerb === "cat" || segVerb === "head" || segVerb === "tail") {
        resolved = seg.trim();
        break;
      }
      // Translate `sed -n 'X,Yp' path` or `sed -n X,Yp path` → `head -n Y path`
      const sedMatch = seg.trim().match(/^sed\s+-n\s+['"]?(?:\d+,)?(\d+)p['"]?\s+(.+)$/);
      if (sedMatch) {
        resolved = `head -n ${sedMatch[1]} ${sedMatch[2].trim()}`;
        break;
      }
    }
    effectiveCommand = resolved ?? chainedSegments[0]?.trim() ?? effectiveCommand;
  }

  // Strip pipe suffix — piped transforms (| sed, | sort, | grep, etc.) are not executed here.
  // The full file content is returned as-is; use head/tail flags for line limits instead.
  const commandBeforePipe = effectiveCommand.split("|")[0].trim();

  // Parse command — accept: cat <path>, head [-n N] <path>, tail [-n N] <path>
  const parts = commandBeforePipe.split(/\s+/);
  const verb = parts[0]?.toLowerCase();

  if (verb !== "cat" && verb !== "head" && verb !== "tail") {
    throw new Error(
      `This shell reads skill files only (cat/head/tail). ` +
      `To fetch web pages use the web_search tool — do not write shell scripts for HTTP requests. ` +
      `Unsupported command: ${verb}`,
    );
  }

  // Extract the file path (last non-flag, non-verb argument; strip surrounding quotes)
  const rawTarget = parts.filter((p) => !p.startsWith("-") && p !== verb).pop();
  const targetPath = rawTarget ? rawTarget.replace(/^["']|["']$/g, "") : undefined;
  if (!targetPath) {
    throw new Error(`No file path found in command: ${command}`);
  }

  // Resolve target path — virtual paths first, then real directoryPaths, then relative.
  let resolvedPath: string | undefined;

  if (path.isAbsolute(targetPath)) {
    // Check virtual path map (e.g. /skills/scrape-data/SKILL.md → real dir)
    if (virtualToReal) {
      for (const [virtual, real] of virtualToReal) {
        if (targetPath === virtual || targetPath.startsWith(virtual + path.sep)) {
          resolvedPath = real + targetPath.slice(virtual.length);
          break;
        }
      }
    }
    // Fall back to real directory paths (legacy — real path exposed directly)
    if (!resolvedPath) {
      for (const skill of mountedSkills) {
        if (!skill.directoryPath) continue;
        if (targetPath.startsWith(skill.directoryPath + path.sep) || targetPath === skill.directoryPath) {
          resolvedPath = targetPath;
          break;
        }
      }
    }
  } else {
    // Relative path — resolve against the first available skill directory.
    for (const skill of mountedSkills) {
      if (skill.directoryPath) {
        resolvedPath = path.join(skill.directoryPath, targetPath);
        break;
      }
    }
  }

  if (!resolvedPath) {
    throw new Error(`Path '${targetPath}' is not within any mounted skill directory.`);
  }

  const content = await readSkillFileContent(resolvedPath);

  // Apply head/tail line limits if requested.
  if (verb === "head" || verb === "tail") {
    const nFlag = parts.indexOf("-n");
    const lineCount = nFlag >= 0 ? parseInt(parts[nFlag + 1] ?? "10", 10) : 10;
    const lines = content.split("\n");
    return (verb === "head" ? lines.slice(0, lineCount) : lines.slice(-lineCount)).join("\n");
  }

  return content;
}

// ---------------------------------------------------------------------------
// shell tool — executes commands in a sandboxed Docker container
// ---------------------------------------------------------------------------

export function createShellTool(options: {
  administration?: OpenAIShellSettings;
  mountedSkills: SkillSummary[];
}): LlmShellTool {
  const settings = options.administration ?? readOpenAIShellSettings();
  const mountedSkills = options.mountedSkills;

  return {
    type: "shell",
    skills: mountedSkills.map((s) => ({
      name: s.slug,
      description: s.description,
      path: s.directoryPath ?? `/tmp/skills/${s.slug}`,
    })),
    execute: async (action) => {
      const maxOutputLength = action.maxOutputLength ?? settings.maxOutputKilobytes * 1024;
      const timeoutMs = action.timeoutMs ?? undefined;

      return Promise.all(
        action.commands.map(async (command) => {
          try {
            const result = await runOpenAIShellCommandInDocker({
              shellCommand: command,
              administration: settings,
              timeoutMs: timeoutMs ?? undefined,
              maxOutputLength,
            });
            return {
              stdout: result.stdout,
              stderr: result.stderr,
              outcome: result.timedOut
                ? { type: "timeout" as const }
                : { type: "exit" as const, exitCode: result.exitCode ?? -1 },
            };
          } catch (error) {
            return {
              stdout: "",
              stderr: error instanceof Error ? error.message : "Command execution failed",
              outcome: { type: "exit" as const, exitCode: 1 },
            };
          }
        }),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Helper: build skill tools for a given set of skill IDs
// ---------------------------------------------------------------------------

/**
 * Create the set of LlmTool definitions for a skill-aware task.
 *
 * Shell-only delivery is required for skill-aware tasks. Every skill ID in
 * `skillIds` MUST resolve to a real catalog entry with an on-disk `sourcePath`
 * (register via `upsertSkill` or `registerExtensionSkill`). If any skill
 * is undeliverable, this function throws fail-loud naming the offending IDs.
 *
 * - No `skillIds` (or empty array) → returns `[]`. No skill intent means
 *   no skill tool.
 * - All skills resolved + have `sourcePath` → returns the shell tool with
 *   those skills mounted.
 * - Any skill missing from catalog OR resolved without `sourcePath` →
 *   throws fail-loud naming the offending IDs.
 *
 * `providers/anthropic.ts` does not inject `read_skill`. Anthropic skill
 * delivery is exclusively `container.skills` via
 * `AnthropicContainerSkillDelivery`, and a fail-closed guard at the Anthropic
 * provider boundary throws if any shell/read_skill/bash skill tool reaches it.
 * The Anthropic provider never calls this builder.
 *
 * The Gemini adapter doesn't go through this builder either: it reads
 * skill content inline via `readSkillContent`.
 *
 * NOTE: MCP server access is provided independently via buildMcpTools() —
 * it is NOT gated on skills being present. Instructions, system prompts,
 * or user messages can reference MCP primitives without any skills.
 */
export async function buildSkillTools(input: {
  skillIds?: string[];
  /**
   * When true, use the Docker-based shell executor instead of the default
   * local file reader. Only needed for write-capable shell tasks.
   * @deprecated Pass nothing — the local shell tool is now always included
   * when skills have disk paths.
   */
  includeShell?: boolean;
}): Promise<LlmTool[]> {
  const skillIds = input.skillIds ?? [];
  if (skillIds.length === 0) {
    return [];
  }

  const skills = await resolveSkills(skillIds);
  const mountableSkills = skills.filter((s) => s.directoryPath);

  // Guard: refuse to build a request when a skill file is missing on disk.
  for (const skill of mountableSkills) {
    if (skill.sourcePath && !existsSync(skill.sourcePath)) {
      throw new Error(
        `Skill file missing at ${skill.sourcePath}. Re-create or update this skill to restore it.`,
      );
    }
  }

  if (mountableSkills.length > 0) {
    // Diagnostic for partial-resolve mixed cases. Log (don't throw) when some
    // skills resolved via shell but others were unresolvable. The shell-mounted
    // skills still work; the unresolvable ones are silently dropped. Operators
    // see the warning and can fix catalog records.
    const resolvedIds = new Set(skills.map((s) => s.id));
    const dropped = skillIds.filter(
      (id) => !resolvedIds.has(id) || !skills.find((s) => s.id === id)?.directoryPath,
    );
    if (dropped.length > 0) {
      console.warn(
        `[buildSkillTools] partial skill delivery — shell tool emitted for ${mountableSkills.length} skill(s); ` +
          `dropped (catalog miss or no sourcePath): ${dropped.join(", ")}`,
      );
    }
    if (input.includeShell) {
      return [createShellTool({ mountedSkills: mountableSkills })];
    }
    return [createLocalSkillShellTool({ mountedSkills: mountableSkills })];
  }

  // No skill resolved with an on-disk sourcePath. The legacy
  // `read_skill` function-tool fallback was retired; we now log a
  // structured warning and return an empty tool array. Chat's shell-only
  // registration is enforced upstream by `ensureChatSkillRegistered`; bridge
  // / agent paths register via `registerExtensionSkill`. A
  // request that reaches here means the upstream registration failed.
  console.warn(
    `[buildSkillTools] no mountable skills resolved for skillIds=[${skillIds.join(", ")}] — ` +
      `skill tool delivery degrades (no fallback function-tool). ` +
      `Verify the upstream registration path ran (ensureChatSkillRegistered / registerExtensionSkill).`,
  );
  return [];
}

// ---------------------------------------------------------------------------
// MCP server tools — independent from skills
// ---------------------------------------------------------------------------

/**
 * Build MCP server tool(s) for the orchestration layer.
 *
 * MCP server access is provided independently from skills — system prompts,
 * user instructions, or SKILL.md files may all reference MCP primitives.
 * The LLM provider calls the Cinatra MCP server natively (OpenAI, Anthropic)
 * or via function tools (Gemini fallback).
 */
export function buildMcpTools(input: {
  serverUrl: string;
  headers?: Record<string, string>;
  authorization?: string;
  serverLabel?: string;
  allowedTools?: string[] | null;
}): LlmTool[] {
  return [createMcpServerTool(input)];
}

// ---------------------------------------------------------------------------
// readSkillContent — inline skill content for Gemini path
// ---------------------------------------------------------------------------

/**
 * Read the full content of a skill by ID. Returns the SKILL.md body (or null
 * if the skill is not found). Used by the orchestration layer to inline skill
 * content into the system prompt for providers that do not support tool-based
 * skill delivery (e.g. Gemini).
 *
 * Internal helper — not exported from the package public API.
 */
export async function readSkillContent(skillId: string): Promise<string | null> {
  const client = getSkillsClient();
  const skill = await client.installed.get(skillId);
  if (!skill) return null;
  return skill.body ?? skill.content ?? null;
}

// ---------------------------------------------------------------------------
// Helper: build skill context for the system prompt
// ---------------------------------------------------------------------------

/**
 * Build a brief skill context listing for the system prompt.
 * Lists available skill IDs and descriptions so the LLM knows what to
 * request via the read_skill tool. Does NOT include full SKILL.md content.
 *
 * All skill information is resolved through the skills package library.
 */
export async function buildSkillContext(skillIds: string[]): Promise<string> {
  if (skillIds.length === 0) {
    return "";
  }

  const skills = await resolveSkills(skillIds);

  if (skills.length === 0) {
    return "";
  }

  return [
    "Available skills (use the read_skill tool to read their full instructions):",
    ...skills.map((s) => `- ${s.id}: ${s.description || s.name}`),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// MCP server tool — gives the LLM access to the Cinatra MCP server
// ---------------------------------------------------------------------------

/**
 * Create an LlmMcpServerTool that gives the LLM direct access to the
 * Cinatra MCP server. This is needed when skills reference MCP calls
 * (e.g. "call campaigns.list") — the LLM can invoke them natively
 * through the provider's MCP support (OpenAI, Anthropic).
 *
 * For providers without native MCP support (Gemini), MCP primitives
 * must be registered as function tools separately.
 */
// ---------------------------------------------------------------------------
// Web search tool — uses OpenAI's built-in web_search_preview
// ---------------------------------------------------------------------------

/**
 * Create a web search tool that gives the LLM native web access via
 * the OpenAI Responses API `web_search_preview` tool. The model can
 * fetch URLs, follow links, and read live page content within a single
 * multi-step conversation — no separate crawl step needed.
 *
 * Other providers ignore this tool type (no translation defined for them).
 */
export function createWebSearchTool(): LlmWebSearchTool {
  return { type: "web_search" };
}

export function createMcpServerTool(input: {
  serverUrl: string;
  headers?: Record<string, string>;
  authorization?: string;
  serverLabel?: string;
  allowedTools?: string[] | null;
}): LlmMcpServerTool {
  return {
    type: "mcp",
    serverLabel: input.serverLabel ?? "cinatra",
    serverUrl: input.serverUrl,
    headers: input.headers,
    authorization: input.authorization,
    serverDescription:
      "Cinatra MCP server — exposes the platform's agents, workflows, data objects " +
      "(accounts, contacts, campaigns, lists, projects, custom types), content publishing, " +
      "connectors, analytics, and skills. " +
      "Does NOT have access to permissions, settings, or auth functions.",
    allowedTools: input.allowedTools,
    requireApproval: "never",
  };
}

// The pure half of the tool-manifest report (packages/agent-ui-protocol/
// CONTRACT.md section 5.2): for an assembled tool array, the caller-owned
// reference of each tool, the exact projection of each tool kind, and the
// keyed hashes over the projection's canonical JSON.
//
// It reads only the fields the projection names. It never reads or calls
// `execute`, `resolveFiles`, `onRead` or any other function of a tool, and it
// never reads an mcp tool's `headers` or `authorization`. Nothing calls it
// yet. The intended caller is a later route that assembles the tools,
// returns the report and maps a ToolManifestError to
// `503 { "error": <code> }`.

import { createHmac, randomBytes } from "node:crypto";
import type { LlmTool, LlmToolReference } from "@cinatra-ai/llm";
import { CanonicalJsonError, canonicalizeJson } from "./canonical-json";

export const TOOL_MANIFEST_VERSION = 1;

const HASH_KEY_BYTES = 32;
const HASH_PREFIX = "hmac-sha256:";

/** The error codes of the report that this module can raise. */
export type ToolManifestErrorCode = "tool_unserializable" | "assembly_failed";

export class ToolManifestError extends Error {
  readonly code: ToolManifestErrorCode;
  constructor(code: ToolManifestErrorCode, message: string) {
    super(message);
    this.name = "ToolManifestError";
    this.code = code;
  }
}

export type ToolManifestEntry = {
  ref: LlmToolReference;
  schemaHash: string;
};

export type ToolManifestReport = {
  conversationOnly: boolean;
  tools: ToolManifestEntry[];
  manifestHash: string;
};

type Projection = Record<string, unknown>;

function orNull<T>(value: T | undefined): T | null {
  return value === undefined ? null : value;
}

const KNOWN_KINDS: ReadonlySet<string> = new Set([
  "function",
  "mcp",
  "shell",
  "web_search",
  "container_skills",
  "sandbox_execution",
]);

/** The kind of a tool; any kind section 5.2 does not list is assembly_failed. */
function toolKind(tool: LlmTool): string {
  const type = (tool as { type?: unknown }).type;
  if (type === undefined || type === "function") return "function";
  if (typeof type !== "string") {
    throw new ToolManifestError("assembly_failed", "a tool has a non-string type");
  }
  if (!KNOWN_KINDS.has(type)) {
    throw new ToolManifestError("assembly_failed", `unknown tool kind ${JSON.stringify(type)}`);
  }
  return type;
}

function projectStagedSkills(
  staged: ReadonlyArray<{ skillId: string; slug: string; description: string }> | undefined,
): Projection[] | null {
  if (staged === undefined) return null;
  return staged.map((skill) => ({
    skillId: skill.skillId,
    slug: skill.slug,
    description: skill.description,
  }));
}

/** The caller-owned identity of a tool, as LlmToolReference states it. */
export function toolReferenceOf(tool: LlmTool): LlmToolReference {
  const kind = toolKind(tool);
  switch (kind) {
    case "function":
      return { type: "function", name: (tool as { name: string }).name };
    case "mcp":
      return { type: "mcp", serverLabel: (tool as { serverLabel: string }).serverLabel };
    case "shell":
      return { type: "shell" };
    case "web_search":
      return { type: "web_search" };
    case "container_skills":
      return { type: "container_skills" };
    case "sandbox_execution":
      return { type: "sandbox_execution" };
    default:
      throw new ToolManifestError("assembly_failed", `unknown tool kind ${JSON.stringify(kind)}`);
  }
}

/**
 * The projection of one tool: exactly the fields section 5.2 names for its
 * kind, an absent optional field as null unless a default is named.
 */
export function projectToolForManifest(tool: LlmTool): Projection {
  const kind = toolKind(tool);
  switch (kind) {
    case "function": {
      const t = tool as { name?: string; description?: string; parameters?: unknown };
      return {
        type: "function",
        name: orNull(t.name),
        description: orNull(t.description),
        parameters: orNull(t.parameters),
      };
    }
    case "mcp": {
      const t = tool as Extract<LlmTool, { type: "mcp" }>;
      return {
        type: "mcp",
        serverLabel: orNull(t.serverLabel),
        serverUrl: orNull(t.serverUrl),
        serverDescription: orNull(t.serverDescription),
        allowedTools: orNull(t.allowedTools),
        approval: t.approval ?? "auto_execute",
        transport: t.transport ?? "unknown",
      };
    }
    case "shell": {
      const t = tool as Extract<LlmTool, { type: "shell" }>;
      return {
        type: "shell",
        skills: (t.skills ?? []).map((skill) => ({
          name: skill.name,
          description: skill.description,
          path: skill.path,
        })),
        stagedSkills: projectStagedSkills(t.stagedSkills),
      };
    }
    case "container_skills": {
      const t = tool as Extract<LlmTool, { type: "container_skills" }>;
      return {
        type: "container_skills",
        skills: (t.skills ?? []).map((skill) => ({
          skillId: skill.skillId,
          version: skill.version,
          catalogSkillId: orNull(skill.catalogSkillId),
        })),
      };
    }
    case "sandbox_execution": {
      const t = tool as Extract<LlmTool, { type: "sandbox_execution" }>;
      return {
        type: "sandbox_execution",
        toolName: orNull(t.toolName),
        description: orNull(t.description),
        stagedSkills: projectStagedSkills(t.stagedSkills),
      };
    }
    case "web_search":
      return { type: "web_search" };
    default:
      throw new ToolManifestError("assembly_failed", `unknown tool kind ${JSON.stringify(kind)}`);
  }
}

function keyedHash(value: unknown, key: Buffer): string {
  let text: string;
  try {
    text = canonicalizeJson(value);
  } catch (error) {
    if (error instanceof CanonicalJsonError) {
      throw new ToolManifestError("tool_unserializable", error.message);
    }
    throw error;
  }
  return HASH_PREFIX + createHmac("sha256", key).update(text, "utf8").digest("hex");
}

/**
 * A fresh hash key for one response. The caller passes it to
 * buildToolManifestReport and never puts it in a response, a log or a store.
 */
export function createToolManifestHashKey(): Buffer {
  return randomBytes(HASH_KEY_BYTES);
}

/**
 * The report of one road: each tool's reference and schema hash, in the
 * order of the assembled array, and the manifest hash over
 * `{ conversationOnly, tools }`. A conversation-only provider takes no tools,
 * so its list is empty; the kind of every given tool is still checked first,
 * so an unknown kind is assembly_failed on that road too.
 */
export function buildToolManifestReport(input: {
  conversationOnly: boolean;
  tools: readonly LlmTool[];
  key: Buffer;
}): ToolManifestReport {
  if (input.key.length !== HASH_KEY_BYTES) {
    throw new ToolManifestError("assembly_failed", "the hash key is not 32 bytes");
  }
  for (const tool of input.tools) toolKind(tool);
  const tools: ToolManifestEntry[] = input.conversationOnly
    ? []
    : input.tools.map((tool) => ({
        ref: toolReferenceOf(tool),
        schemaHash: keyedHash(projectToolForManifest(tool), input.key),
      }));
  return {
    conversationOnly: input.conversationOnly,
    tools,
    manifestHash: keyedHash({ conversationOnly: input.conversationOnly, tools }, input.key),
  };
}

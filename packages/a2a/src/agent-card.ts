import "server-only";

import type { AgentTemplateRecord, AgentTemplateVersionRecord } from "@cinatra-ai/agents";
import { sanitizePackageNameToToolName } from "@cinatra-ai/agents";

// ---------------------------------------------------------------------------
// A2A AgentCard types
// ---------------------------------------------------------------------------

/**
 * One hitlScreen entry with schema.
 *
 * `id` is the namespaced x-renderer ID (e.g. "@cinatra-ai/email-delivery-agent:send-confirmation").
 * `schema` is the JSON Schema describing the input the HITL renderer expects;
 * defaults to `{}` when no schema is declared (legacy agents and code-based modules).
 */
export type AgentCardHitlScreen = {
  id: string;
  schema: Record<string, unknown>;
};

/**
 * One AgentCard skill entry. One per published virtual agent.
 *
 * - `id` and `toolName` are always equal — the sanitized MCP tool name — so A2A
 *   consumers and MCP consumers see the same identifier.
 * - `operativeVersion` is the currently published version; `supportedVersions`
 *   lists every version currently resolvable from the registry. Consumers use
 *   this for request-time version pinning.
 * - `hitlScreens` lists namespaced renderer IDs for HITL gates.
 *   Upgraded from `string[]` to `AgentCardHitlScreen[]` so external AG-UI
 *   consumers can discover the input schema for each HITL renderer.
 */
export type AgentCardSkill = {
  id: string;
  name: string;
  description: string;
  tags: string[];
  inputModes: readonly ["text"];
  outputModes: readonly ["text"];
  toolName: string;
  packageName: string;
  operativeVersion: string;
  supportedVersions: string[];
  hitlScreens: AgentCardHitlScreen[];
  /**
   * Orchestrator dependency manifest.
   *
   * Map of `@cinatra/*` package name → semver range, surfaced so external A2A
   * callers can discover orchestrator requirements without fetching the tarball.
   * Always present; defaults to `{}` when the template declares none. Sourced
   * from `agent_templates.agent_dependencies` populated by
   * `@cinatra/agent-builder`'s `installAgentFromPackage`.
   */
  agentDependencies: Record<string, string>;
  /**
   * Agent classification for A2A consumers.
   *
   * - `leaf` — single bounded task (default).
   * - `proxy` — multi-step sequential execution in one session.
   * - `orchestrator` — phased with sub-agents over a long time horizon.
   *
   * Sourced from `agent_templates.type`. A type change triggers a MAJOR semver
   * bump so pinned callers continue to resolve the old type until they upgrade.
   */
  type: "leaf" | "proxy" | "orchestrator" | "parallel" | "supervisor" | "iterative" | "node" | "flow";
};

/**
 * AgentCard authentication block. Per A2A spec, schemes are advertised but no
 * credentials are embedded. `tokenEndpoint` is included when the caller supplies
 * it (the route handler passes `${baseUrl}/api/auth/oauth2/token`) so consumers
 * can discover the OAuth2 token URL without prior knowledge of Cinatra's auth
 * structure.
 */
export type AgentCardAuthentication = {
  schemes: readonly ["Bearer", "OAuth2"];
  credentials: null;
  tokenEndpoint?: string;
};

export type AgentCard = {
  name: "Cinatra";
  description: string;
  url: string;
  version: string;
  defaultInputModes: ["text"];
  defaultOutputModes: ["text"];
  capabilities: { streaming: true; pushNotifications: false };
  authentication: AgentCardAuthentication;
  skills: AgentCardSkill[];
  /**
   * AG-UI protocol declaration.
   *
   * `uiProtocol: "ag-ui"` signals to external consumers (e.g. LangGraph
   * frontends, custom AG-UI clients) that Cinatra emits AG-UI events alongside
   * A2A task state transitions in its SSE stream. Consumers that do not
   * understand AG-UI silently ignore the additional `event: ag-ui` SSE frames.
   *
   * `agUiVersion: "1.0"` is the AG-UI spec version Cinatra implements.
   *
   * Feature-flagged: the external AG-UI passthrough requires
   * `CINATRA_AGUI_EXTERNAL_ENABLED=true` at the route level. The declaration in
   * AgentCard is always present so callers can discover the capability without
   * needing to probe the SSE stream first.
   */
  uiProtocol: "ag-ui";
  agUiVersion: "1.0";
};

export type BuildAgentCardInput = {
  baseUrl: string;
  hostVersion?: string;
  tokenEndpoint?: string;
  templates: AgentTemplateRecord[];
  versionsByTemplateId: Record<string, AgentTemplateVersionRecord[]>;
};

// ---------------------------------------------------------------------------
// Pure transform — no I/O, no DB, no Next.js
// ---------------------------------------------------------------------------

const TOP_LEVEL_DESCRIPTION =
  "Cinatra agent platform — a multi-agent host. Each published virtual agent is exposed as a named skill.";

/**
 * Strips trailing `/` characters from a string in linear time.
 *
 * Replaces the regex `value.replace(/\/+$/, "")`, which is polynomial
 * (O(n^2)) on adversarial input such as `"/".repeat(n) + "x"` — the
 * end-anchored `\/+$` retries at every offset (js/polynomial-redos, eng#196).
 * Behaviorally identical to the old regex (verified by fuzz).
 */
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47 /* "/" */) end--;
  return value.slice(0, end);
}

/**
 * Builds a valid A2A AgentCard from a list of published virtual agent
 * templates. Pure deterministic transform — same input always produces a
 * byte-identical JSON.stringify output.
 *
 * Caller responsibilities:
 *  - `templates` should already be filtered to status=published with packageName set
 *    (defended here as well — entries without packageName are dropped).
 *  - `baseUrl` should not contain a trailing slash (one is stripped defensively).
 *  - `versionsByTemplateId` maps template.id → version list; pass `{}` when
 *    versions are unavailable (operativeVersion still flows from packageVersion).
 */
export function buildAgentCard(input: BuildAgentCardInput): AgentCard {
  const baseUrl = stripTrailingSlashes(input.baseUrl);
  const hostVersion = input.hostVersion ?? "1.0.0";

  const skills: AgentCardSkill[] = [];
  for (const template of input.templates) {
    // Defensive: drop templates lacking a packageName since they cannot produce
    // a stable MCP tool identifier. Caller (readPublishedAgentTemplates) should
    // have filtered, but we double-guard so the AgentCard contract is never
    // violated by a malformed row.
    const packageName = template.packageName;
    if (!packageName) continue;

    const toolName = sanitizePackageNameToToolName(packageName);
    const description =
      template.description ?? firstUsableSourceNlLine(template.sourceNl);
    const operativeVersion = template.packageVersion ?? "0.0.0";
    const versions = input.versionsByTemplateId[template.id] ?? [];
    const supportedVersions = versions.map((v) => v.semver);
    // hitlScreens is declared on AgentTemplateRecord. Null becomes an empty
    // array for the card contract. Entries use AgentCardHitlScreen[] so external
    // AG-UI consumers see the input schema per HITL renderer.
    // Legacy string[] entries are promoted to { id, schema: {} }.
    const rawHitlScreens: string[] = template.hitlScreens ?? [];
    const hitlScreens: AgentCardHitlScreen[] = rawHitlScreens.map((id) => ({
      id,
      schema: {},
    }));
    // Surface the orchestrator dependency manifest. Empty `{}` when the source
    // manifest declared none, so consumers always see a stable shape.
    const agentDependencies = template.agentDependencies ?? {};
    // Surface agent type to A2A consumers. Defaults to "leaf" for legacy/test
    // fixtures that predate the field.
    const type = template.type ?? "leaf";

    skills.push({
      id: toolName,
      name: template.name,
      description,
      tags: [],
      inputModes: ["text"] as const,
      outputModes: ["text"] as const,
      toolName,
      packageName,
      operativeVersion,
      supportedVersions,
      hitlScreens,
      agentDependencies,
      type,
    });
  }

  // Conditionally include tokenEndpoint — never emit empty string or undefined
  // so JSON.stringify output is deterministic and the field is either present
  // with a real value or absent entirely.
  const authentication: AgentCardAuthentication =
    typeof input.tokenEndpoint === "string" && input.tokenEndpoint.length > 0
      ? {
          schemes: ["Bearer", "OAuth2"] as const,
          credentials: null,
          tokenEndpoint: input.tokenEndpoint,
        }
      : {
          schemes: ["Bearer", "OAuth2"] as const,
          credentials: null,
        };

  return {
    name: "Cinatra",
    description: TOP_LEVEL_DESCRIPTION,
    url: `${baseUrl}/api/a2a`,
    version: hostVersion,
    defaultInputModes: ["text"] as const,
    defaultOutputModes: ["text"] as const,
    capabilities: { streaming: true, pushNotifications: false },
    authentication,
    skills,
    // AG-UI protocol declaration. Always present so external callers can
    // discover the capability from AgentCard without probing the SSE stream.
    uiProtocol: "ag-ui" as const,
    agUiVersion: "1.0" as const,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the first non-empty, non-Markdown-header line of `sourceNl` (trimmed),
 * or `""` if no usable line is found. Markdown headers (lines whose trimmed form
 * starts with `#`) are skipped to avoid surfacing unhelpful headers like
 * `# Email Agent` in AgentCard descriptions.
 */
function firstUsableSourceNlLine(sourceNl: string): string {
  for (const raw of sourceNl.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith("#")) continue;
    return line;
  }
  return "";
}

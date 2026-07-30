import "server-only";

// The assistant conversational runtime (cinatra-ai/cinatra#1037 P2a).
//
// EXTRACTED from src/app/api/chat/runner.ts: the former `runChatTurn` is now
// `runAssistantTurn(runtimeConfig, args)` — parameterized by an
// `AssistantRuntimeConfig` (persona/fallback, skill bundle, allowed
// tools/agents, model prefs, tool-round ceiling) instead of the hardcoded
// `CHAT_*` module constants. `src/app/api/chat/runner.ts` now delegates here
// with the Cinatra assistant's reference config, so BOTH legacy entry shapes —
// the HTTP SSE route (POST /api/chat) and the in-process MCP path
// (chat_thread_send → packages/chat/src/mcp/handlers.ts) — keep importing
// `runChatTurn` unchanged. The SSE vocabulary, the persistence subroutes, and
// the chat_thread_send port are NOT touched here (that is P2b / P3).
//
// The per-concern host connector services are published in
// `@/lib/register-host-connector-services` and run on import via the
// instrumentation entrypoint. In dev (Turbopack) the chat route bundle
// can compile separately without that side-effect — a connector's lazy
// host-service resolution then throws "host service not registered"
// mid-chat. Importing the registrar here side-effects into the chat
// bundle's module graph too, so the services every serverEntry transport
// adapts are published before the chat turn runs (the registry is
// globalThis-anchored, so one publication serves every bundle). This is
// a core->core edge: the registrar is host code, no extension is named here.
import "@/lib/register-host-connector-services";

import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  detectExplicitDispatchDirective,
  detectExplicitDispatchPackage,
} from "@/app/api/chat/explicit-dispatch";
import { serverSideExplicitDispatch } from "@/app/api/chat/explicit-dispatch-server";
import { createDeterministicSkillsClient } from "@cinatra-ai/skills/mcp-client";
import {
  ensureInstalledSkillsRegistered,
  resolveInstalledSkillSourcePath,
  retireSupersededChatSkillsOnce,
} from "@cinatra-ai/skills";
import { getAllStagedByType } from "@/lib/wizard-staging-store";
import { getAllManifests } from "@/lib/wizard-manifest-registry";
// Connector-owned user-context sections (gmail send-as addresses, calendar
// appointment schedules, ...) resolve through the chat-user-context capability
// registry — the runtime no longer imports any connector package by name.
import { buildChatUserContextSections } from "@/app/api/chat/chat-user-context";
import { shouldDeliverChatShellSkillTools } from "@/app/api/chat/shell-skill-gate";
import {
  describeLlmRuntimeUnavailability,
  stream,
  selectSkillDeliveryAdapter,
  deliverInjectedSkillsInline,
  resolveBoundDefaultAdapter,
  BoundDefaultProviderUnavailableError,
  resolveProviderAdapter,
  resolveChatExternalMcpTools,
  buildLlmMcpServerToolForChat,
  buildLlmMcpServerToolForWidget,
  checkPublicMcpReachability,
} from "@cinatra-ai/llm";
import type { LlmTool, LlmProvider } from "@cinatra-ai/llm";
// cinatra#2091 (epic #2086 S4): the assistant runtime routes through the ONE
// typed injection contract + the provider delivery seam. Its former direct
// `buildSkillTools` call was the last production bypass of that seam.
import {
  resolveInjectedSkillSet,
  injectedCatalogSkillIds,
  injectedSkillDrops,
  isInlineSkillMechanism,
  type InjectionAuthorization,
  type InjectionResolverPorts,
} from "@cinatra-ai/skills/injection";
import {
  assertScriptedProviderNotProduction,
  isScriptedTestProviderEnabled,
  runScriptedWidgetAssistantTurn,
} from "@cinatra-ai/llm/scripted-test-provider";
import {
  observeSurfaceExecutionDispatches,
  resolveSurfaceExecutionBinding,
} from "@/lib/execution/surface-execution-session";
import { evaluateExecutionProvenance } from "@cinatra-ai/llm/execution-plane";
import { issueChatMcpActorToken } from "@/lib/chat-mcp-actor-token";
import { issueWidgetMcpActorToken } from "@/lib/widget-mcp-actor-token";
import { readInstanceIdentity } from "@/lib/instance-identity-store";
import type { ActorContext } from "@/lib/authz/actor-context";
import {
  buildExtensionImplementationConfirmationPolicy,
} from "@/app/api/chat/extension-confirmation";
// cinatra#2020 S5 (PR-4) — the bounded pending-confirmation outcome section
// (§6.3): one term in the system-context assembly below; empty string when
// the viewer has no recent confirmation transitions.
import { buildPendingConfirmationContext } from "./pending-confirmation-context";
// Chat-side resolver ports are scoped to the session's active org
// (auth-derived; never caller-controlled).
import { buildAttachmentResolverPorts } from "@/lib/artifacts/attachment-resolver-ports";
import { isAllowedByList, type AssistantRuntimeConfig } from "./ports";
import {
  selectAdapterProvider,
  isConversationOnlyProvider,
  conversationOnlyNoticeFor,
} from "./model-routing";
import type { WidgetPrincipal } from "./widget-principal";

/**
 * Type-narrowing guard: a provider with NATIVE MCP (OpenAI/Anthropic) is the
 * tool-capable set. Deriving it from the shared `isConversationOnlyProvider`
 * data list keeps one source of truth while giving TypeScript the narrowing the
 * tool-assembly calls (`buildLlmMcpServerToolFor*`, `resolveChatExternalMcpTools`,
 * all typed to `"openai" | "anthropic"`) require now that Gemini flows through to
 * the conversation-only branch instead of early-returning (cinatra#1875 AC#5).
 */
function isNativeMcpProvider(provider: LlmProvider): provider is "openai" | "anthropic" {
  return !isConversationOnlyProvider(provider);
}

// ---------------------------------------------------------------------------
// Public types (unchanged from the pre-extraction runner; re-exported by
// src/app/api/chat/runner.ts so both entry shapes keep their imports)
// ---------------------------------------------------------------------------

// Chat messages may carry artifact refs; resolved per-message in
// stream via the chat-side resolver ports (sessionOrgId-scoped).
export type ChatRequestMessage = {
  role: "user" | "assistant";
  content: string;
  attachments?: import("@cinatra-ai/llm").LlmAttachmentRef[];
};
export type ChatStreamSink = (event: string, data: unknown) => void;
export type RunChatTurnArgs = {
  messages: ChatRequestMessage[];
  actorContext: ActorContext;
  userId: string | undefined;
  platformRole: "platform_admin" | "member";
  sessionOrgId: string | null;
  send: ChatStreamSink;
  /** Aborted when the client disconnects (#503) so the run stops LLM/MCP work
   *  promptly instead of running to completion with nobody listening. */
  signal?: AbortSignal;
  /**
   * The assistant PRINCIPAL identity this turn runs as (cinatra#2091 S4) — the
   * `assistant` injection intent's subject. Absent ⇒ the runtime uses the
   * config's skill-id namespace, which is the assistant's own stable package
   * identity (`@cinatra-ai/chat`, `@cinatra-ai/wordpress`, …).
   */
  assistantId?: string;
  /**
   * The session this turn belongs to (cinatra#2091 S4). Absent ⇒ the runtime
   * mints a per-turn server-side binding so the intent subject is complete; the
   * load-bearing authorization checks are the assistant identity and the
   * AUTHENTICATED user, both of which the runtime holds directly.
   */
  sessionId?: string;
  /**
   * S5 public-site (WordPress/Drupal) widget path. When present, the caller is
   * the broker-auth widget branch of `/api/assistants/chat`, which has already
   * run the full dual-token fail-closed sequence and built this SERVER-VERIFIED
   * principal (pinned canonical instance + connector kind + `public_site_widget`
   * discriminator). The seam then mints a `cinatra.widget.mcp-obo` OBO token
   * (`src/lib/widget-mcp-actor-token.ts`) instead of the chat token so the CMS
   * write authorizes AS THE END USER against the pinned instance, with
   * platform-admin floored to `member` — no privilege widening.
   *
   * `null`/absent = the cookie-session `@cinatra` chat path, which is
   * byte-identical to before (chat token + `delegated-chat` allowlist). The
   * seam swap that consumes this lands with the audience-rescope wave; this arg
   * is threaded now so the type contract is stable for both waves.
   */
  widgetPrincipal?: WidgetPrincipal | null;
};

export { describeLlmRuntimeUnavailability };

// ---------------------------------------------------------------------------
// Presentation helpers (SSE surface — unchanged; P2b/P3 own the wire change)
// ---------------------------------------------------------------------------

const HIDDEN_TOOL_NAMES = new Set([
  "skills_catalog_list",
  "skills_installed_list",
  "skills_installed_get",
  "skills_installed_resolve_for_agent",
  "agent_run_list",
  "agent_run_messages_list",
  "email_outreach_campaign_get_workflow_state",
  "email_outreach_async_operation_status",
  "email_outreach_campaign_async_operation_status",
  "calendar_appointments_list",
]);

function isHiddenTool(name: string) {
  // Do not hide `serverLabel === "cinatra"`. Native `type: "mcp"`
  // injection is the only way the chat reaches cinatra primitives, so those
  // events are the primary signal. The UI and the chat-mcp test harness both
  // rely on `tool_call` + `tool_result` for run-id extraction and step
  // display. `serverLabel` is retained in the signature for cosmetic use
  // via `formatServerLabel` at the call sites, but is not a filter input.
  return name === "shell" || HIDDEN_TOOL_NAMES.has(name);
}

function formatServerLabel(serverLabel: string): string {
  return serverLabel
    .replace(/^external-/, "")
    .replace(/-connector$/, "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

const TOOL_ACTION_LABELS: Record<string, string> = {
  "gmail_email_send": "Email sent",
  "linkedin_post_publish": "LinkedIn post published",
  // The generic, per-instance governed forwarding primitives (cinatra#2022) —
  // `toolName` alone doesn't carry which underlying site ability a call
  // dispatched, so these labels stay ability-agnostic on purpose.
  "wordpress_site_tool_call": "WordPress action performed",
  "wordpress_site_tools_list": "WordPress tools loaded",
  "agent_source_list": "Agent sources loaded",
  "agent_source_read": "Agent source read",
  "agent_source_write": "Agent source written",
  "agent_source_write_files": "Agent package files written",
  "agent_source_validate": "Agent source validated",
  "agent_source_compile": "Agent source compiled",
  "agent_source_publish": "Agent source published",
  // Chat writes contacts + accounts via canonical `objects_save` /
  // `objects_update` / `objects_delete`.
  "campaigns_create": "Campaign created",
  "campaigns_update": "Campaign updated",
  "campaigns_delete": "Campaign deleted",
  "blog_project_create": "Blog project created",
  "drupal_content_editor_run":     "Drupal node edited",
  "wordpress_content_editor_run":  "WordPress post edited",
};

function deriveResultLabel(toolName: string, result: string, serverLabel?: string): string {
  if (serverLabel && serverLabel !== "cinatra") {
    const connector = formatServerLabel(serverLabel);
    const action = toolName.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    return `${connector} · ${action}`;
  }
  if (TOOL_ACTION_LABELS[toolName]) return TOOL_ACTION_LABELS[toolName];

  const parts = toolName.split("_");
  const action = parts.pop() ?? "";
  const resource = parts.length > 1 ? parts.slice(1).join(" ") : parts[0] ?? "";

  try {
    const parsed = JSON.parse(result);
    if (Array.isArray(parsed)) {
      const label = resource.replace(/_/g, " ");
      return parsed.length === 1 ? `1 ${label.replace(/s$/, "")} found` : `${parsed.length} ${label} found`;
    }
    if (parsed && typeof parsed === "object") {
      if (Array.isArray(parsed.items)) {
        const label = resource.replace(/_/g, " ");
        return parsed.items.length === 1 ? `1 ${label.replace(/s$/, "")} found` : `${parsed.items.length} ${label} found`;
      }
      if (parsed.name) return parsed.name as string;
      if (parsed.startupCount !== undefined) return `${parsed.startupCount} startups loaded`;
    }
  } catch {
    // Not JSON
  }

  const resourceLabel = resource.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
  if (action === "list" || action === "get") return `${resourceLabel} loaded`;
  if (action === "read") return `${resourceLabel} read`;
  if (action === "write") return `${resourceLabel} written`;
  const verb = action === "send" ? "sent"
    : action === "publish" ? "published"
    : action === "create" ? "created"
    : action === "update" ? "updated"
    : action === "delete" ? "deleted"
    : action.endsWith("e") ? `${action}d` : `${action}ed`;
  return `${resourceLabel} ${verb}`.trim();
}

// ---------------------------------------------------------------------------
// System prompt / context assembly (parameterized by the runtime config)
// ---------------------------------------------------------------------------

// Catalog-unavailable fallback: read the assistant's system SKILL.md straight
// from disk. The on-disk location is resolved through the skills layer's generic
// install/uninstall-aware extension scan (the same substrate that registers
// the sub-skills), NOT through hardcoded extension path candidates — the
// runtime names only the stable `systemSkillId` (an auth-policy data-contract
// id), never the providing extension package or its disk path.
async function loadSystemPromptFromDisk(systemSkillId: string): Promise<string | null> {
  try {
    const skillMdPath = await resolveInstalledSkillSourcePath(systemSkillId);
    if (skillMdPath && existsSync(skillMdPath)) {
      const raw = readFileSync(skillMdPath, "utf8");
      const stripped = raw.replace(/^---[\s\S]*?\n---\n/, "");
      return stripped.trim();
    }
  } catch (err) {
    console.warn("[assistant-runtime] disk SKILL.md fallback failed:", (err as Error).message);
  }
  return null;
}

// Idempotent server-side preflight: ensure the assistant sub-skills are
// registered in the skills layer with a real on-disk `sourcePath`.
// `buildSkillTools` requires a registered skill to emit the shell tool; this
// preflight is the load-bearing path that makes shell delivery work.
//
// Each Cinatra chat router bundle is co-located in its own successor
// `kind:"skill"` extension package (the cinatra#2090 S3 fold of the former
// `assistant-skills` pack), so the generic, install/uninstall-aware batch
// resolver materializes every requested bundle's SKILL.md body into the
// catalog per providing package (`registerColocatedWorkspaceSkills` registers
// a whole providing package once), while keeping each requested id
// independently retryable on a transient upsert failure. The resolver
// memoizes successful registration per-id per-process and drops the memo for
// an id that failed to register so a later turn retries it, so this is safe
// to call every turn.
//
// AFTER the successors register, the superseded `@cinatra-ai/chat:<old-slug>`
// rows the retired pack left behind are retired by exact id (idempotent,
// memoized, never throws) — the upsert-only store would keep them resolving
// forever otherwise.
async function ensureAssistantSkillsRegistered(skillIds: string[]): Promise<void> {
  await ensureInstalledSkillsRegistered(skillIds);
  await retireSupersededChatSkillsOnce();
}

async function loadSystemPrompt(
  systemSkillId: string,
  fallbackPersona: string,
): Promise<string> {
  try {
    const client = createDeterministicSkillsClient({
      actor: { actorType: "system", source: "worker" },
    });
    const skill = await client.installed.get(systemSkillId);
    if (skill?.body) {
      return skill.body;
    }
  } catch {
    // fall through
  }
  const onDisk = await loadSystemPromptFromDisk(systemSkillId);
  if (onDisk) return onDisk;
  // The assistant's persona (from its sidecar) is the identity of last resort.
  return fallbackPersona;
}

async function buildUserContext(userId?: string): Promise<string> {
  // Connector-owned sections first (send-as addresses, appointment
  // schedules, ...) — resolved registration-driven from the chat-user-context
  // capability registry, deterministically ordered and failure-isolated.
  const sections: string[] = await buildChatUserContextSections(userId);
  // Live widget/wizard manifests — resolved ONCE per turn from the extension
  // manifest + lifecycle (both loops below read the same snapshot).
  const allManifests = await getAllManifests();

  for (const manifest of allManifests) {
    if (!manifest.wizard) continue;
    const { resourceType, resourceIdArg } = manifest.wizard.staging;
    const staged = getAllStagedByType(resourceType);
    if (staged.length === 0) continue;
    const list = staged.map((s) => {
      const c = s.config;
      const fields = Object.entries(c)
        .filter(([, v]) => v != null && v !== "")
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
        .slice(0, 8)
        .join(", ");
      return `${resourceType} ${s.resourceId} (staged): ${fields || "no fields set yet"}`;
    }).join("\n");
    const updateTools = manifest.wizard.staging.updateTools.join(" or ");
    sections.push(`Staged ${resourceType}s (use ${resourceIdArg} to update via ${updateTools}):\n${list}`);
  }

  const wizards = allManifests.filter((m) => m.wizard);
  if (wizards.length > 0) {
    const widgetSections = wizards.map((m) => {
      const steps = m.wizard!.steps.map((s) => `  - ${s.description}`).join("\n");
      return `${m.description}\nSteps:\n${steps}`;
    });
    sections.push(`Available widget wizards:\n${widgetSections.join("\n\n")}`);
  }

  sections.push(
    "Formatting rules:\n" +
    "- Items returned by tools include a `detailPath` field. In tables, always make the title or name column a clickable markdown link using detailPath: [Title](/detailPath). Do not list links separately outside the table.\n" +
    "- For external URLs (e.g. a podcast or video link), embed them as markdown links in the relevant column: [Title](https://...).",
  );

  return `\n\nUser context:\n${sections.join("\n\n")}`;
}

// Fully-resolved instance namespace context. The chat SKILL.md uses
// `<vendor>` as a placeholder for the operator's instance namespace.
// The chat tools (agent_source_write_files, agent_source_publish, etc.)
// embed that namespace into the published registry scope and the
// `package.json#name` field. The on-disk path is fixed to
// `extensions/cinatra-ai/<packageSlug>/` regardless of vendor; only
// `<package.json>#name` and the published scope are vendor-aware. Surfacing
// the namespace here lets the LLM emit the correct `@<vendor>/<slug>` package
// name from the first scaffold, instead of pattern-matching off the shipped
// Cinatra examples.
function buildInstanceContext(): string {
  let identity: ReturnType<typeof readInstanceIdentity> | null = null;
  try {
    identity = readInstanceIdentity();
  } catch {
    /* identity store may be uninitialised in early boot — silently skip */
  }
  if (!identity || !identity.instanceNamespace) {
    return "";
  }
  const ns = identity.instanceNamespace;
  const frozen = identity.firstPublishedAt !== null;
  const frozenNote = frozen
    ? ` This namespace is FROZEN (first package already published) and cannot be renamed; never propose changing it.`
    : "";
  return (
    `\n\nInstance vendor namespace: "${ns}".${frozenNote} ` +
    `When SKILL.md templates reference \`<vendor>\` in a package name (e.g. \`@<vendor>/<slug>\`), always substitute ` +
    `\`<vendor>\` with "${ns}". Every package name MUST be \`@${ns}/<slug>\` — never \`@cinatra/<slug>\` unless the ` +
    `operator's namespace literally happens to be "cinatra". The disk layout is currently fixed to ` +
    `\`extensions/cinatra-ai/<packageSlug>/...\` regardless of vendor. The server-side write ` +
    `handler normalizes \`package.json#name\` to "@${ns}/<packageSlug>" defensively, but you should still emit the right ` +
    `value the first time.`
  );
}

// ---------------------------------------------------------------------------
// runAssistantTurn — the assistant-config-parameterized runtime.
//
// Extracted from the former /api/chat POST `runChatTurn` so every conversational
// surface (the HTTP SSE route and the in-process MCP chat_thread_send path)
// drives ONE runtime, differing only by its `AssistantRuntimeConfig`. The
// Cinatra assistant's reference config reproduces the former hardcoded chat
// constants exactly (see cinatra-assistant-config.ts + cinatra-parity.test.ts).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Injection ports for the assistant surface (cinatra#2091, epic #2086 S4).
// Co-located with its only caller: the factory closes over the AUTHENTICATED
// identity this turn already resolved, and the authorization port compares the
// intent against it.
// ---------------------------------------------------------------------------

export type AssistantInjectionPortsInput = {
  /** The assistant agent identity the surface resolved. */
  agentId: string;
  /** The AUTHENTICATED user this turn runs for. */
  userId: string;
  /** The session id the surface bound. */
  sessionId: string;
  /** The assistant's own required injectable set (its runtime config bundle). */
  requiredSkillIds: readonly string[];
};

export function buildAssistantInjectionPorts(
  input: AssistantInjectionPortsInput,
): InjectionResolverPorts {
  return {
    async authorizeAssistantSession(intent): Promise<InjectionAuthorization> {
      if (intent.agentId !== input.agentId) {
        return {
          ok: false,
          reason: `intent names assistant "${intent.agentId}" but the surface vetted "${input.agentId}"`,
        };
      }
      if (intent.userId !== input.userId) {
        return {
          ok: false,
          reason: "the intent names a user this session is not authenticated as",
        };
      }
      if (!intent.sessionId || intent.sessionId !== input.sessionId) {
        return { ok: false, reason: "the intent names a different session" };
      }
      return { ok: true, runOwnerUserId: input.userId };
    },
    async resolveAssistantRequiredSkills() {
      return input.requiredSkillIds.map((skillId) => ({ skillId }));
    },
  };
}


export async function runAssistantTurn(
  runtimeConfig: AssistantRuntimeConfig,
  args: RunChatTurnArgs,
): Promise<void> {
  const { messages, actorContext, userId, platformRole, sessionOrgId, send, signal } = args;
  // S5 (cinatra#1221) — the public-site (WordPress/Drupal) widget path. When
  // present, the caller is the `/api/assistants/chat` broker-auth branch, which
  // has already run the full dual-token fail-closed sequence and built this
  // SERVER-VERIFIED principal. The seam below mints a `cinatra.widget.mcp-obo`
  // OBO token instead of the chat token so the CMS write authorizes AS THE END
  // USER against the pinned instance, floored to `member`. `null` = the
  // cookie-session `@cinatra` chat path, byte-identical to before.
  const widgetPrincipal = args.widgetPrincipal ?? null;

  // Scripted-test-provider short-circuit for the public-site widget path
  // (cinatra#1919 AC3). The deterministic WP/Drupal Playwright UAT app carries
  // NO real provider creds, so `resolveDefaultAdapter()` below resolves null and
  // the turn dies with "No LLM provider configured." before the scripted stream
  // can answer (the endpoint's pre-stream availability gate — today
  // `describeLlmRuntimeUnavailability` — shares the blind spot; fixed in
  // registry.ts). When the deterministic provider is enabled, stream
  // the deterministic content-editor reply directly through the SAME `send` sink
  // the real turn uses — text → sentinel; an edit intent → a
  // `*_content_editor_run` tool_call + tool_result — then finish.
  //
  // SCOPE: gated to the widget path (`widgetPrincipal` present) so the
  // cookie-session `@cinatra` chat-mcp e2e — which DOES configure a provider and
  // relies on the host `stream()`'s own scripted seam for tool orchestration —
  // is UNAFFECTED (its adapter resolves; `stream()` short-circuits there). And
  // fail-loud outside an explicit development runtime
  // (assertScriptedProviderNotProduction): a no-op unless the env flag is set,
  // so PRODUCTION is byte-identical — the scripted branch is never reachable
  // there.
  if (widgetPrincipal && isScriptedTestProviderEnabled()) {
    assertScriptedProviderNotProduction();
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const instructions =
      typeof lastUser?.content === "string" ? lastUser.content : "";
    await runScriptedWidgetAssistantTurn({
      instructions,
      assistantHandle: widgetPrincipal.assistantHandle,
      onText: (content) => send("text", { content }),
      onToolCall: (call) =>
        send("tool_call", { id: call.id, name: call.name, status: "running" }),
      onToolResult: (result) =>
        send("tool_result", {
          id: result.id,
          name: result.name,
          status: "completed",
          resultLabel: deriveResultLabel(result.name, result.result),
          result: result.result,
        }),
    });
    return;
  }

  // Assistant-owned native MCP injection with a delegated human actor token.
  //
  // The runtime must NOT let `injectMcpTools` auto-prepend the default cinatra
  // self-MCP tool: that path attaches the LLM provider's machine
  // `client_credentials` token, which /api/mcp resolves to an anonymous
  // machine actor. The assistant must connect to /api/mcp AS THE HUMAN USER so
  // `agent_run` writes `run_by = userId` and the follow-up `agent_run_get`
  // passes `enforceRunAccess`.
  //
  // So the runtime assembles its own tool array (skipMcpInjection: true):
  //   - ONE `type: "mcp"` reference to the cinatra self-MCP carrying a
  //     short-lived delegated actor token for the current user
  //     (src/lib/chat-mcp-actor-token.ts → verified by the MCP transport)
  //   - ALL connected third-party MCP servers (WordPress, Drupal, Apify,
  //     any externally-registered) — those are external, not Cinatra-authz-
  //     gated, so the machine-token path is fine for them
  //   - the skill-mounting shell tool (the assistant's skill bundle)
  //   - the OpenAI provider-native `web_search` tool
  //
  // Model routing honours the assistant's `modelPrefs`: an explicit `model`
  // pref is passed to `stream` when set (else the connection default is used —
  // byte-parity with the legacy chat). `provider`/`temperature` prefs are
  // carried on the config; their full routing lands with the AG-UI endpoint
  // (P3) once the LLM layer exposes them — the reference config leaves them
  // empty, so this path is byte-identical for Cinatra.
  // Assistant-level model routing (cinatra#1875 W2, AC#5). An assistant's
  // `modelPrefs.provider` selects the adapter where the legacy runtime always
  // chose the platform default. The Cinatra reference assistant carries an EMPTY
  // modelPrefs, so it resolves through `resolveDefaultAdapter()` exactly as
  // before (byte-parity). A pinned provider resolves EXACTLY that provider (or
  // fails) — an assistant declared for Anthropic never silently downgrades to the
  // global default. Consumes #1711's live resolver via `resolveProviderAdapter`
  // (declaration ∩ activation ∩ readiness) once its surfaces land.
  //
  // PURPOSE POLICY: exact-default (llm-purpose-policy.ts, purpose
  // "assistant-runtime"). S6 (cinatra#2093) AC: "the assistant uses exactly the
  // stored provider; unavailability is a VISIBLE error, not a silent hop."
  // `resolveBoundDefaultAdapter` binds to the stored provider exactly (unless
  // the admin stored the explicit "ordered" failover policy) and THROWS a
  // provider-naming error instead of returning null, so the operator is told
  // WHICH provider is down rather than the useless "No LLM provider configured".
  const { modelPrefs } = runtimeConfig;
  const pinnedProvider = selectAdapterProvider(modelPrefs);
  let adapter: Awaited<ReturnType<typeof resolveProviderAdapter>> = null;
  if (pinnedProvider) {
    adapter = await resolveProviderAdapter(
      pinnedProvider as Parameters<typeof resolveProviderAdapter>[0],
    );
  } else {
    try {
      adapter = await resolveBoundDefaultAdapter();
    } catch (err) {
      if (err instanceof BoundDefaultProviderUnavailableError) {
        send("error", { message: err.message });
        return;
      }
      throw err;
    }
  }
  if (!adapter) {
    send("error", {
      message: pinnedProvider
        ? `No LLM provider configured for '${pinnedProvider}'.`
        : "No LLM provider configured.",
    });
    return;
  }
  if (!userId) {
    send("error", {
      message: "Chat MCP dispatch requires an authenticated user.",
    });
    return;
  }
  // Capability-degraded conversation-only mode (cinatra#1875 W2, AC#5). A
  // provider with no NATIVE MCP support (Gemini today) can NOT host the Cinatra
  // self-MCP / connector tools, so instead of the legacy HARD REJECT it runs a
  // tool-less conversational turn — `gemini-assistant` works day one. The user is
  // told EXPLICITLY (a system-prompt notice below) that tools are unavailable, so
  // a tool-needing request degrades with a notice rather than a silent drop. This
  // interim mode is SUPERSEDED by #1717 native-MCP activation when it fires.
  const conversationOnly = isConversationOnlyProvider(adapter.provider);
  const conversationOnlyNotice = conversationOnlyNoticeFor(conversationOnly);

  // Tool array. Conversation-only providers (Gemini, AC#5) carry NO tools; every
  // MCP/skill assembly + the dead-ingress reachability probe is skipped for them.
  // Tool-capable providers (OpenAI/Anthropic) assemble the full array below,
  // byte-identical to before.
  // cinatra#2091 S4 — the assistant declares its INTENT; the resolver derives
  // the members (its own required injectable set) and applies the hard cap of
  // 8 TOTAL. Resolved BEFORE the provider branch so the cap is enforced
  // IDENTICALLY on every provider, including the conversation-only (no-native-
  // MCP) branch that assembles no tools at all.
  const assistantAgentId = args.assistantId ?? runtimeConfig.skillIdNamespace;
  const assistantSessionId = args.sessionId ?? `assistant-turn:${randomUUID()}`;
  const injectedSkills = await resolveInjectedSkillSet(
    {
      kind: "assistant",
      agentId: assistantAgentId,
      userId,
      sessionId: assistantSessionId,
    },
    buildAssistantInjectionPorts({
      agentId: assistantAgentId,
      userId,
      sessionId: assistantSessionId,
      requiredSkillIds: runtimeConfig.skillIds,
    }),
  );
  // The CINATRA assistant never truncates BY DESIGN: its bundle's SIZE
  // CONTRACT (cinatra-assistant-config.ts, pinned by its test) keeps the
  // required set at 5 slugs — at most 7 — so 5 + the personal delta = 6 ≤ the
  // hard cap of 8. This guard therefore exists for the OTHER configs that
  // reach this runtime: an extension-declared assistant's `skillBundle` is
  // schema-unbounded, and a drop the resolver recorded must reach an operator
  // rather than vanish here.
  const injectionDrops = injectedSkillDrops(injectedSkills);
  if (injectionDrops.length > 0) {
    console.error(
      `[assistant-runtime] the injection contract dropped ${injectionDrops.length} ` +
        `skill(s) for assistant "${assistantAgentId}" — its required bundle of ` +
        `${runtimeConfig.skillIds.length} exceeds the hard cap of 8 per request: ` +
        injectionDrops.map((d) => `${d.skillId} (${d.reason})`).join(", "),
    );
  }

  let tools: LlmTool[] = [];
  // The provider's skill contribution to the system prompt: an availability cue
  // on a tool-mount/container provider, the EXPANDED skill bodies on an inline
  // provider. Declared out here because both branches below feed it.
  let skillSystemContext = "";
  if (isInlineSkillMechanism(adapter.provider)) {
    // Inline mechanism (Gemini): core SHORT-CIRCUITS — no delivery adapter, no
    // connector surface. It reads each member's router body plus its ONE-HOP
    // references and merges them under the per-request byte budget, so a
    // conversation-only turn still receives the assistant's skills instead of
    // silently losing every one of them.
    await ensureAssistantSkillsRegistered(runtimeConfig.skillIds);
    const inline = await deliverInjectedSkillsInline({ set: injectedSkills });
    skillSystemContext = inline.systemContext;
    if (inline.dropped.length > 0) {
      console.warn(
        `[assistant-runtime] inline expansion dropped ${inline.dropped.length} ` +
          `whole skill(s) for assistant "${assistantAgentId}": ` +
          inline.dropped.map((d) => `${d.skillId} (${d.reason})`).join(", "),
      );
    }
  }
  if (isNativeMcpProvider(adapter.provider)) {
  // adapter.provider is narrowed to "openai" | "anthropic" in this block
  // (equivalent to `!conversationOnly`), so the tool-assembly calls type-check.
  // Guarantee the assistant's skills resolve with an on-disk sourcePath so
  // buildSkillTools emits the shell tool (also feeds the catalog-backed
  // loadSystemPrompt above; the read_skill fallback is retired).
  await ensureAssistantSkillsRegistered(runtimeConfig.skillIds);
  // Model-aware shell delivery (issue #47). OpenAI rejects the hosted
  // `shell` tool for gpt-5 / gpt-5-mini; sending it 400s EVERY turn.
  // No per-request model is passed, so adapter.defaultModel (the
  // connection's defaultModel) is exactly the model this request uses.
  // Mirror the llm-bridge degrade semantics: skip the skill shell tool and
  // keep the turn running — never reintroduce a read_skill function tool.
  const deliverShellSkillTools = shouldDeliverChatShellSkillTools(adapter);
  if (!deliverShellSkillTools) {
    console.warn(
      `[assistant-runtime] shell-incompatible OpenAI model "${adapter.defaultModel}" — ` +
        "skipping the skill shell tool (skill delivery degrades; the " +
        "turn continues with MCP + web_search tools only)",
    );
  }
  let skillTools: LlmTool[] = [];
  if (deliverShellSkillTools) {
    const catalogSkillIds = injectedCatalogSkillIds(injectedSkills);
    if (catalogSkillIds.length > 0) {
      const delivery = await selectSkillDeliveryAdapter(adapter.provider).deliver({
        skillIds: catalogSkillIds,
        // The authoritative cap already ran in the contract; the adapter's own
        // cap is a defence-in-depth invariant.
        selectionMode: "general",
      });
      skillTools = delivery.tools;
      skillSystemContext = delivery.systemContext;
    }
  }
  // Dead-ingress guard (#1699): a configured-but-unreachable public MCP URL
  // is WORSE than a missing one — OpenAI silently omits the hosted MCP server
  // (200 completed, no mcp_list_tools, no 424), chat loses every Cinatra tool
  // with no signal, and the model confabulates that the tools don't exist.
  // Probe (cached, short timeout) and fail LOUD like the unconfigured case
  // below instead of running a turn that lies about the platform.
  const mcpReachability = await checkPublicMcpReachability();
  if (mcpReachability.status === "unreachable") {
    console.error(
      `[assistant-runtime] public MCP URL ${mcpReachability.url} is unreachable ` +
        `(${mcpReachability.reason}) — refusing to run the turn without Cinatra tools (#1699)`,
    );
    send("error", {
      message:
        `Cinatra tools are unavailable: the public MCP URL ${mcpReachability.url} is not reachable ` +
        `(${mcpReachability.reason}). The assistant can't use platform tools until the tunnel is ` +
        "restored — check /configuration/development?tab=tunnel and run its connection test.",
    });
    return;
  }
  // SEAM (S5, cinatra#1221). The cinatra self-MCP tool carries a DIFFERENT
  // delegated actor token depending on the caller:
  //   · widget principal present → a `cinatra.widget.mcp-obo` OBO token (pinned
  //     canonical instance + connector kind + `public_site_widget` discriminator;
  //     platform-admin floored to `member` at mint). A fresh per-turn `jti` is
  //     minted here (turn-binding for replay containment); the 120 s TTL is bound
  //     at verify. The MCP transport verifies it to a `delegation:
  //     "public_site_widget"` actor → the CLOSED, kind-keyed `delegated-widget`
  //     tool policy applies (only the bound kind's `*_content_editor_run`).
  //   · absent → the existing chat OBO token (`delegation: "chat"`), byte-
  //     identical to before — the cookie-session `@cinatra` path is unchanged.
  //
  // A mint/build failure returns null on BOTH paths → the same fail-closed error
  // below (the widget path never silently falls back to the chat token or the
  // machine token).
  const chatCinatraMcpTool = widgetPrincipal
    ? await buildLlmMcpServerToolForWidget(
        adapter.provider,
        {
          userId: widgetPrincipal.userId,
          orgId: widgetPrincipal.orgId,
          instanceId: widgetPrincipal.instanceId,
          kind: widgetPrincipal.assistantHandle,
          jti: randomUUID(),
        },
        issueWidgetMcpActorToken,
      )
    : await buildLlmMcpServerToolForChat(
        adapter.provider,
        { delegation: "chat", userId, orgId: sessionOrgId, platformRole },
        issueChatMcpActorToken,
      );
  if (!chatCinatraMcpTool) {
    send("error", {
      message:
        "Cinatra MCP public URL is not configured for hosted MCP access. Set it at /configuration/development?tab=tunnel.",
    });
    return;
  }

  // cinatra#2019 S4: cookie-chat and widget-principal turns share this
  // external-tool assembly, so the build context carries the REAL surface —
  // surface-gating toolboxes (trusted-site native read-injection) emit only
  // for "chat" and refuse widget builds fail-closed instead of leaking
  // chat-scoped injections onto public-site widget turns.
  const externalMcpTools = await resolveChatExternalMcpTools(
    adapter.provider,
    widgetPrincipal ? { surface: "public_site_widget" } : { surface: "chat" },
  );
  const assembledTools: LlmTool[] = [
    chatCinatraMcpTool,
    ...externalMcpTools,
    ...skillTools,
    { type: "web_search" },
  ];
  // Apply the assistant's tool allow-list. EMPTY = no restriction beyond
  // platform policy (the sidecar contract), so the filter is a strict no-op
  // for the Cinatra reference assistant — byte-identical tool array. A
  // non-empty list keeps only its members; MCP server tools (which expose many
  // primitives behind one `type: "mcp"` entry) and provider-native tools carry
  // no filterable `name`, so they are unaffected by name-level allow-listing at
  // this layer (per-primitive gating is an MCP-layer concern for a later slice).
  tools = assembledTools.filter((tool) => {
    const name = (tool as { name?: string }).name;
    if (typeof name !== "string") return true;
    return isAllowedByList(name, runtimeConfig.allowedTools);
  });
  } // end !conversationOnly tool assembly

  const systemPrompt = await loadSystemPrompt(
    runtimeConfig.systemSkillId,
    runtimeConfig.fallbackPersona,
  );
  const userContext = await buildUserContext(userId);
  // Surface the operator's instance namespace + freeze state to the LLM so
  // it stops emitting hardcoded `@cinatra/<slug>` package names on non-cinatra
  // deployments. The SKILL.md uses `@<vendor>/<slug>` as a placeholder;
  // this context substitutes the real vendor.
  const instanceContext = buildInstanceContext();

  const extensionConfirmationPolicy = buildExtensionImplementationConfirmationPolicy();

  // cinatra#2020 S5 (PR-4): the viewer's recent destructive-confirmation
  // outcomes (max 5 lines, last hour; "" when none — byte-identical system
  // string for users with no confirmation activity).
  const pendingConfirmationContext =
    userId && sessionOrgId
      ? await buildPendingConfirmationContext({ orgId: sessionOrgId, userId })
      : "";

  // Deterministic explicit-dispatch pre-router.
  //
  // SOFT layer (system-message directive): scans the latest user message
  // for verb-anchored explicit `@cinatra-ai/<slug>` references and prepends
  // a hard "OVERRIDES every other instruction" directive to the system
  // message. Unit tests verify the directive, but provider behavior can still
  // skip the expected tool call.
  //
  // HARD layer (server-side dispatch, this section): when the regex matches,
  // invoke `agent_run` server-side bypassing the LLM entirely, emit synthetic
  // tool_call + tool_result + text SSE events, and early-return from the turn.
  // The LLM never gets a chance to skip the tool. The chat-mcp e2e
  // harness's `tool_call` listener fires immediately and the run is queued
  // exactly as if the LLM had called it.
  //
  // SKIPPED in conversation-only mode (cinatra#1875 AC#5): a no-native-MCP
  // provider (Gemini) runs tool-less, and server-side `agent_run` dispatch IS a
  // tool action — firing it would contradict the "no live actions" notice and
  // let a tool-less turn perform a live dispatch. The directive/dispatch are both
  // gated so the conversation-only turn is genuinely tool-free.
  const explicitDispatchDirective = conversationOnly
    ? ""
    : detectExplicitDispatchDirective(messages);
  const explicitDispatchPackage = conversationOnly
    ? null
    : detectExplicitDispatchPackage(messages);

  if (explicitDispatchPackage) {
    // Find the latest user message; the pre-router uses it as source material
    // for input extraction so the agent's StartNode required inputs are
    // pre-filled and the setup-loop HITL gate isn't surfaced to the user.
    const lastUserMessage = [...messages]
      .reverse()
      .find((m) => m.role === "user");
    const userPrompt =
      typeof lastUserMessage?.content === "string" ? lastUserMessage.content : "";
    const dispatchResult = await serverSideExplicitDispatch({
      packageName: explicitDispatchPackage,
      actor: actorContext,
      send,
      userPrompt,
    });
    if (dispatchResult.ok) {
      // Run is queued + SSE events emitted. The e2e harness will pick up
      // the synthetic tool_call/tool_result and continue polling
      // /api/agents/runs/<runId> on its own. No LLM turn needed.
      console.info(
        `[assistant-runtime] explicit-dispatch pre-router HARD short-circuit: ${explicitDispatchPackage} → runId=${dispatchResult.runId}`,
      );
      return;
    }
    // Terminal failures (e.g. creation-flow preflight refusal) must NOT fall
    // through to the LLM. The synthetic tool_result + text events already
    // explained the gate to the user; an LLM turn would re-author the run
    // despite the gate and bypass the chat-side preflight invariant.
    // Early-return.
    if ((dispatchResult as { terminal?: boolean }).terminal === true) {
      console.warn(
        `[assistant-runtime] explicit-dispatch pre-router TERMINAL failure for ${explicitDispatchPackage}: ${dispatchResult.error} — no LLM fallthrough`,
      );
      return;
    }
    // On non-terminal dispatch failure (e.g. unknown agent, registry miss),
    // fall through to the regular LLM path — the synthetic tool_result
    // already emitted carries the error, and the LLM can offer alternatives.
    console.warn(
      `[assistant-runtime] explicit-dispatch pre-router HARD attempt failed for ${explicitDispatchPackage}: ${dispatchResult.error} — falling through to LLM`,
    );
  }

  // Build chat-side resolver ports when any user message in this turn carries
  // attachments. Per-message resolution happens inside stream now,
  // so we no longer need to flatten the last user's attachments into the
  // request-level field. sessionOrgId is auth-derived
  // (session.activeOrganizationId), never caller-controlled. Without an active
  // org or any attachments, ports stay undefined and the stream call
  // remains byte-identical for text-only chat.
  const anyUserAttachments = messages.some(
    (m) =>
      m.role === "user" && m.attachments && m.attachments.length > 0,
  );
  const chatAttachmentResolverPorts =
    anyUserAttachments && sessionOrgId
      ? buildAttachmentResolverPorts({ orgId: sessionOrgId })
      : undefined;

  // exec-plane S1b (cinatra#2138 deliverable 2): the chat surface is a TRUSTED
  // execution-session issuer. `sessionOrgId` is auth-derived
  // (session.activeOrganizationId) and `userId` is the authenticated human — a
  // chat turn carries NO run binding, so the session is minted without a runId.
  // Rollout flag off ⇒ an empty spread ⇒ this call stays byte-identical.
  const chatExecutionBinding = resolveSurfaceExecutionBinding({
    surface: "chat",
    orgId: sessionOrgId,
    userId,
  });
  // cinatra#2175 — render-side execution provenance. A live turn with the
  // capability fully injected answered a "run this" request with prose shaped
  // exactly like captured stdout: no tool call, no `execution_sandbox` audit
  // row, a wrong digest. The audit trail was right (nothing ran) and the
  // surface was wrong (it looked like something had). So the turn now carries
  // its own provenance: the executor is wrapped to COUNT completed dispatches
  // — each one is the broker round-trip that writes the audit row — and the
  // assistant's own text is accumulated alongside. At the end of the turn the
  // two are compared and an unbacked execution claim is MARKED in the
  // transcript (below), never blocked and never rewritten.
  //
  // `executionCapabilityOffered` is the runtime's own view of the offer: a
  // minted session AND a registered executor, i.e. everything the injection
  // layer needs. It over-approximates that layer's `injected` verdict on
  // purpose — a turn refused deeper in (unsealable session, opted-out org)
  // still ran nothing, so marking a claim there is equally true. Flag off ⇒
  // empty binding ⇒ `false` ⇒ the guard is inert and this turn is
  // byte-identical to before.
  const chatExecutionObserver =
    observeSurfaceExecutionDispatches(chatExecutionBinding);
  const executionCapabilityOffered = Boolean(
    chatExecutionBinding.executionSession &&
      chatExecutionBinding.executionExecutor,
  );
  let assistantTurnText = "";
  let executionProvenanceEmitted = false;
  // Emitted on BOTH terminal paths. A turn that streamed fabricated output and
  // then failed (provider timeout, client abort) still PERSISTS that text, so
  // marking only the clean path would leave the worst case — a half-finished
  // turn nobody re-ran — unmarked. Idempotent: at most one marker per turn.
  const markUnverifiedExecutionClaim = () => {
    if (executionProvenanceEmitted) return;
    const verdict = evaluateExecutionProvenance({
      capabilityOffered: executionCapabilityOffered,
      dispatches: chatExecutionObserver.readLog(),
      text: assistantTurnText,
    });
    if (verdict.status !== "unverified") return;
    executionProvenanceEmitted = true;
    console.warn(
      "[execution-plane] chat: execution claim with NO sandbox dispatch that " +
        `reached a sandbox — marking the turn unverified (claims: ${verdict.matchedClaims.join(", ")})`,
    );
    send("text", { content: verdict.notice });
  };

  try {
    await stream({
      provider: adapter.provider,
      actorContext,
      ...chatExecutionObserver.binding,
      // An explicit `model` pref overrides the connection default; absent, the
      // field is omitted so the call is byte-identical to the legacy chat.
      ...(modelPrefs.model ? { model: modelPrefs.model } : {}),
      system:
        explicitDispatchDirective +
        systemPrompt +
        // The provider's skill contribution: an availability cue (Anthropic
        // container listing; empty for OpenAI shell delivery, which must not be
        // told about a read_skill tool) or, on an inline provider, the expanded
        // skill bodies. Separated explicitly — the fragment carries no leading
        // blank line of its own, and a trimmed/fallback persona would otherwise
        // run straight into its first heading.
        (skillSystemContext ? `\n\n${skillSystemContext}` : "") +
        userContext +
        instanceContext +
        extensionConfirmationPolicy +
        pendingConfirmationContext +
        // AC#5: the conversation-only degrade notice (empty for tool-capable
        // providers, so their system string is byte-identical to before).
        conversationOnlyNotice,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        // Forward per-message attachments; omit when absent so every text-only
        // caller remains byte-identical.
        ...(m.attachments && m.attachments.length > 0
          ? { attachments: m.attachments }
          : {}),
      })),
      tools,
      // Per-message attachments flow through `messages[].attachments`;
      // stream resolves each user turn independently. Only the
      // resolver ports cross here.
      ...(chatAttachmentResolverPorts
        ? { attachmentResolverPorts: chatAttachmentResolverPorts }
        : {}),
      // The runtime assembles its own cinatra self-MCP tool (delegated
      // human-actor token) plus external MCP servers. Auto-injection MUST be
      // skipped: it would prepend a second cinatra-mcp entry with the machine
      // client_credentials token, which resolves as an anonymous machine actor
      // and breaks run-ownership authz.
      skipMcpInjection: true,
      maxSteps: runtimeConfig.maxToolRounds,
      // Abort on the 120s ceiling OR the caller's signal (client disconnect,
      // #503) so a torn-down stream stops LLM/MCP work promptly.
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(120_000)])
        : AbortSignal.timeout(120_000),
      logLabel: "chat",
      onTextDelta: (delta) => {
        // Accumulated for the end-of-turn execution-provenance verdict
        // (cinatra#2175); the sink emission itself is unchanged.
        assistantTurnText += delta;
        send("text", { content: delta });
      },
      onToolCall: (call) => {
        if (isHiddenTool(call.name)) return;
        send("tool_call", {
          id: call.id,
          name: call.name,
          status: "running",
          serverLabel: call.serverLabel,
        });
      },
      onToolResult: (result) => {
        if (isHiddenTool(result.name)) return;
        send("tool_result", {
          id: result.id,
          name: result.name,
          status: "completed",
          serverLabel: result.serverLabel,
          resultLabel: deriveResultLabel(result.name, result.result, result.serverLabel),
          result: result.result.length > 2000 ? result.result.slice(0, 2000) + "..." : result.result,
        });
      },
      onStepStart: (step) => {
        send("thinking_start", { round: step });
      },
      onStepEnd: (step) => {
        send("thinking_end", { round: step });
      },
      onCitations: (citations) => {
        const searchId = `web_search_${Date.now()}`;
        send("tool_call", { id: searchId, name: "web_search", status: "running" });
        send("tool_result", {
          id: searchId,
          name: "web_search",
          status: "completed",
          resultLabel: `${citations.length} source${citations.length === 1 ? "" : "s"} found`,
        });
        send("citations", { citations });
      },
      onError: (error) => {
        // `error` is a TERMINAL sink frame: the AG-UI adapter ignores every
        // event after the first terminal. An adapter that reports through this
        // callback and then RESOLVES would therefore have its marker dropped
        // if we only evaluated after the stream — so the verdict is taken here,
        // on the text accumulated so far, before the terminal goes out.
        markUnverifiedExecutionClaim();
        send("error", { message: error.message });
      },
    });

    // Execution-provenance verdict (cinatra#2175). Rides the EXISTING text
    // path, so the marker persists with the turn (`assistant_turns.content`),
    // renders through the same markdown the reply does, and needs no new
    // stream vocabulary or component. `not_applicable` (the default, and the
    // only reachable status while the plane is dark) emits nothing.
    markUnverifiedExecutionClaim();

    send("done", {});
  } catch (error) {
    // Same verdict before the terminal error frame: the partial text is
    // persisted either way, so an unbacked claim inside it must be marked
    // either way.
    markUnverifiedExecutionClaim();
    const message = error instanceof Error ? error.message : "Chat request failed.";
    send("error", { message });
  }
}

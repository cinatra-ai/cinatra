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
  buildCapabilityKeyResolver,
  buildConnectorInventory,
  DEFAULT_CONNECTOR_INVENTORY_DEPS,
} from "@/lib/connector-inventory.server";
import { connectionSubjectUserId } from "@/lib/connection-use-gate";

import type { ChatMcpCatalogState, ServableChatPrimitive } from "@cinatra-ai/llm";
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
// cinatra#2240 (finding F8): the durable per-turn skill-DELIVERY record. The
// chat surface used to deliver skills to a provider and leave NO trace, so an
// audit could only be settled at the wire.
import { recordTurnSkillDelivery } from "@/lib/agent-run-skills-used";
import {
  buildTurnSkillDeliveryRows,
  type TurnSkillDeliveryRow,
} from "./skill-delivery-record";
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
import type { LlmTool, LlmProvider, LlmCapabilityRequirement } from "@cinatra-ai/llm";
// cinatra#2091 (epic #2086 S4): the assistant runtime routes through the ONE
// typed injection contract + the provider delivery seam. Its former direct
// `buildSkillTools` call was the last production bypass of that seam.
import {
  resolveInjectedSkillSet,
  injectedCatalogSkillIds,
  injectedSkillDrops,
  injectedSkillMembers,
  isInlineSkillMechanism,
  type InjectionAuthorization,
  type InjectionResolverPorts,
} from "@cinatra-ai/skills/injection";
import {
  assertScriptedProviderNotProduction,
  isScriptedTestProviderEnabled,
  runScriptedChatAssistantTurn,
  runScriptedWidgetAssistantTurn,
  scriptedTurnAsksForLifecyclePull,
  scriptedTurnAsksForScheduleProposal,
} from "@cinatra-ai/llm/scripted-test-provider";
// The reserved producer label the sink's recognizer requires. Stamped by THIS
// module, on THIS module's own record of what it actually dispatched — never by
// the provider, which holds no provenance.
import { LIFECYCLE_PRODUCER_SERVER_LABEL } from "./lifecycle-view-envelope";
import {
  observeSurfaceExecutionDispatches,
  resolveSurfaceExecutionBinding,
} from "@/lib/execution/surface-execution-session";
import { evaluateExecutionProvenance } from "@cinatra-ai/llm/execution-plane";
import { issueChatMcpActorToken } from "@/lib/chat-mcp-actor-token";
// cinatra#2771 lever 2 — the stable-head-first system-string composer.
import {
  composeChatSystemPrompt,
  type ChatSystemPromptFragments,
} from "./chat-system-prefix";
import { issueWidgetMcpActorToken } from "@/lib/widget-mcp-actor-token";
// The scripted widget turn's REAL self-MCP dispatcher (cinatra#2683). Imported
// unconditionally (a module, not a side effect); CONSTRUCTED only inside the
// scripted branch, which is fenced to an explicit development runtime.
import {
  createScriptedChatSelfMcpDispatch,
  createScriptedSelfMcpDispatch,
} from "./scripted-self-mcp-dispatch";
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
// S5 (cinatra#2390): terminal stream errors are CLASSIFIED (stable code +
// sanitized actionable copy with an Administration pointer), never raw.
import {
  classifyAssistantRuntimeError,
  isAllowedByList,
  // cinatra#2580 — the per-turn no-progress guard. The agentic loop re-sends the
  // WHOLE request envelope on every step, so a turn that keeps re-issuing one
  // dead tool call bills a full ~43k-token context per round until the ceiling.
  // The guard ends such a turn once one call identity has returned nothing on
  // four consecutive billed steps (the full predicate and its disclosed trade
  // live beside the implementation in ./ports).
  createTurnCostGuard,
  noProgressMessage,
  TURN_STOPPED_NO_PROGRESS_CODE,
  type AssistantRuntimeConfig,
} from "./ports";
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
  /**
   * The DURABLE identity of this turn (cinatra#2240) — the `assistant_turns`
   * row id plus the AG-UI run id, both already minted by every chat entry point
   * BEFORE the producer runs (`streamAgUiChatTurn` for the HTTP surfaces,
   * `driveTurn` for the in-process `chat_thread_send` MCP surface). It keys the
   * per-turn skill-delivery record.
   *
   * REQUIRED, deliberately: an optional identity with a "log and skip" fallback
   * would silently reproduce finding F8 (a turn that delivers skills and
   * records nothing) the first time a new entry point forgot to pass it.
   */
  turnIdentity: { turnId: string; runId: string };
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
  "appointment_schedule_list",
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
// SPLIT INTO IDENTITY + FREEZE STATE (cinatra#2771, codex round-2 finding 2).
//
// These two things have DIFFERENT LIFETIMES and used to share one sentence:
//
//   · the namespace and its substitution rule are fixed for the deployment —
//     `instanceNamespace` is assigned once and the rest of the text is a
//     constant template around it, so it belongs in the cacheable head;
//   · the FREEZE NOTE is `firstPublishedAt !== null`, and the tool that sets
//     `firstPublishedAt` is `agent_source_publish` — a chat tool. A user can
//     publish their first package IN THE MIDDLE OF A CONVERSATION, and the next
//     turn of that same conversation then renders a longer instance sentence.
//
// While they were one string, "the stable head is byte-identical across turns"
// was false on exactly that transition, and nothing caught it: the composer
// test only mutated already-volatile keys and the runtime test stubs
// `readInstanceIdentity` to null so neither half was ever exercised. Splitting
// them makes the classification honest — the identity half really is stable,
// and the freeze half is declared volatile and composed in the tail.
//
// ONE READ, TWO FRAGMENTS: the identity store is read once and both strings are
// derived from that single observation, so the two fragments can never disagree
// about the namespace they describe.
function buildInstanceContext(): {
  identity: string;
  freezeState: string;
} {
  let identity: ReturnType<typeof readInstanceIdentity> | null = null;
  try {
    identity = readInstanceIdentity();
  } catch {
    /* identity store may be uninitialised in early boot — silently skip */
  }
  if (!identity || !identity.instanceNamespace) {
    return { identity: "", freezeState: "" };
  }
  const ns = identity.instanceNamespace;
  const frozen = identity.firstPublishedAt !== null;
  return {
    identity:
      `\n\nInstance vendor namespace: "${ns}". ` +
      `When SKILL.md templates reference \`<vendor>\` in a package name (e.g. \`@<vendor>/<slug>\`), always substitute ` +
      `\`<vendor>\` with "${ns}". Every package name MUST be \`@${ns}/<slug>\` — never \`@cinatra/<slug>\` unless the ` +
      `operator's namespace literally happens to be "cinatra". The disk layout is currently fixed to ` +
      `\`extensions/cinatra-ai/<packageSlug>/...\` regardless of vendor. The server-side write ` +
      `handler normalizes \`package.json#name\` to "@${ns}/<packageSlug>" defensively, but you should still emit the right ` +
      `value the first time.`,
    // Its own sentence, and self-contained: it names the namespace again so it
    // still reads correctly at its new position in the volatile tail, far from
    // the identity fragment it used to be spliced into.
    freezeState: frozen
      ? `\n\nThe vendor namespace "${ns}" is FROZEN (first package already published) and cannot be renamed; never propose changing it.`
      : "",
  };
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

/**
 * A delivery adapter is an EXTENSION surface, so it can report a
 * `deliveryMode` this build has no vehicle name for. The record stays truthful
 * (`delivered`, vehicle `unknown`, raw mode preserved) rather than fabricating
 * a transport or demoting a real delivery to a drop — but an unclassifiable
 * vehicle means an operator's audit answer is degraded, so it is never silent.
 */
function warnOnUnclassifiedVehicles(
  rows: readonly TurnSkillDeliveryRow[],
  provider: string,
): void {
  const unclassified = rows.filter((r) => r.vehicle === "unknown");
  if (unclassified.length === 0) return;
  console.error(
    `[assistant-runtime] ${provider} delivery reported ${unclassified.length} ` +
      "skill(s) under a delivery mode this build cannot classify into a vehicle " +
      `— recorded as delivered/vehicle=unknown: ` +
      unclassified.map((r) => `${r.skillId} (mode=${r.deliveryMode})`).join(", "),
  );
}

// ---------------------------------------------------------------------------
// The chat surface's self-MCP catalog state (cinatra#2771).
//
// The catalog the model is offered is DERIVED, never listed. Three inputs, all
// already available to this turn:
//
//   SERVABLE      every primitive the delegated-chat perimeter can serve.
//   ADMISSION     the authoritative policy predicate, the only thing that may
//                 admit a name.
//   AVAILABILITY  the connector keys this VERIFIED actor holds an authorized
//                 connection for, read through the same per-row `use` gate the
//                 connector inventory uses.
//
// The capability key for a primitive is derived from the LIVE connector
// catalog rather than from a table: a primitive whose name matches a catalog
// connector's declared `mcpPrimitivePrefixes` is gated on that connector,
// longest prefix winning. A connector installed tomorrow gates its own
// primitives with no code change here, and a primitive whose name matches no
// catalog prefix is never gated. See `connector-inventory.server.ts`.
//
// Failure posture is fail-OPEN to the authoritative gate, never fail-closed
// onto the user. If state cannot be resolved the turn runs unrestricted and
// the transport still decides what is callable. A narrowing hint must never be
// the reason a turn loses its tools.
// ---------------------------------------------------------------------------
async function resolveChatMcpCatalogState(input: {
  actorContext: ActorContext;
  userId: string;
  sessionOrgId: string | null;
}): Promise<ChatMcpCatalogState | undefined> {
  try {
    const inventory = await buildConnectorInventory({
      ...DEFAULT_CONNECTOR_INVENTORY_DEPS,
      // The turn already holds a verified actor. The default resolver reads an
      // MCP request frame, which does not exist on a chat turn, so the turn's
      // own actor is supplied instead.
      resolveActor: async () => ({
        actor: input.actorContext,
        subjectUserId: connectionSubjectUserId(input.actorContext) ?? input.userId,
        organizationId: input.sessionOrgId,
      }),
    });

    const authorizedKeys = new Set(
      inventory.connectors
        .filter((row) => row.hasAuthorizedConnection)
        .map((row) => row.connectorKey),
    );
    // The capability key comes from each row's catalog-declared
    // `mcpPrimitivePrefixes` (`gmail-connector` -> `gmail_`), LONGEST PREFIX
    // WINS. It cannot come from `connectorKey`: that is a slug
    // (`gmail-connector`) and primitives are underscore-named
    // (`gmail_aliases_list`), so a key-based match admits no name at all and
    // the filter silently gates nothing.
    const capabilityKeyFor = buildCapabilityKeyResolver(inventory.connectors);

    // cinatra#2817 slice 1 — THE SEEDING SITE, now the request-scoped
    // registration PLAN rather than a static name list. The pass that decides
    // what registers is the pass that produces this, so the catalog cannot
    // advertise a primitive the perimeter refuses (or hide one it serves): the
    // servable subset IS the set `registerTool` accepted, each entry carrying
    // the class its registration put in force and the capability key resolved
    // from the live connector catalog.
    // LAZY, deliberately: `@/lib/mcp-server` carries the whole connector /
    // module / database graph, and a static import here would put it on every
    // route this runtime is on (and force every test of an unrelated turn seam
    // to stub it). The catalog hint is best-effort and already inside a
    // try/catch, so the import cost is paid only when the hint is built.
    //
    // REBUILT EVERY TURN, ON PURPOSE, WITH NO MEMO.
    // The plan is only valid for the (activationGeneration, admissionGeneration)
    // pair it was built under: an install/activation or a recorded/withdrawn
    // review changes what the same primitive name resolves to. Caching it would
    // mean holding a decision made against a policy that may no longer be in
    // force, and the failure would be SILENT because this whole block is
    // fail-open (a stale hint looks exactly like a fresh one). Rebuilding is the
    // conservative direction: the cost is one registration pass plus one store
    // read per turn, and the hint is best-effort anyway.
    //
    // `admissionSnapshotCacheKey` (packages/mcp-server/src/delegated-chat-admission.ts)
    // states the key any future cache here MUST use. It has no production
    // consumer for exactly this reason: there is no cache to consume it yet.
    const { buildDelegatedChatCapabilityPlan } = await import("@/lib/mcp-server");
    const plan = await buildDelegatedChatCapabilityPlan({
      resolveCapabilityKey: capabilityKeyFor,
    });
    const servable: ServableChatPrimitive[] = plan.servable.map((entry) => ({
      name: entry.name,
      declaredClass: entry.declaredClass,
      capabilityKey: entry.capabilityKey,
    }));

    // HOST ADMISSION IS THE PLAN (cinatra#2817 slice 3). The plan's servable
    // subset is exactly what the shared evaluator admitted under this request's
    // admission snapshot, so membership in it IS host approval. Re-deriving the
    // answer here from a name would be the second answer this issue removes —
    // and a name-keyed predicate could not express the decision anyway, which
    // is about an owner at a version with a reviewed declaration.
    const admitted = new Set(servable.map((primitive) => primitive.name));
    return {
      servable,
      isHostApproved: (name) => admitted.has(name),
      isCapabilityAvailable: (key) => authorizedKeys.has(key),
    };
  } catch {
    // Unresolvable state means no hint, not a smaller turn.
    return undefined;
  }
}

/**
 * Commit the turn's durable skill-delivery record (cinatra#2240).
 *
 * AWAITED, never fire-and-forget: a detached promise can lose the write when
 * the process/lambda tears down at the end of the turn, which would reproduce
 * exactly the "delivered but unrecorded" gap this closes.
 *
 * Best-effort BUT LOUD: telemetry persistence must not fail a user's turn (the
 * same posture as the agent-run ledger in `/api/llm-bridge`), so a failure is
 * swallowed — but it is reported as a structured `console.error` naming the
 * turn and run, because a silently-lost record makes the acceptance
 * ("leaves a durable row") unverifiable in operation.
 */
async function persistTurnSkillDelivery(
  turnIdentity: { turnId: string; runId: string },
  rows: readonly TurnSkillDeliveryRow[],
): Promise<void> {
  if (rows.length === 0) return;
  try {
    await recordTurnSkillDelivery({ turnId: turnIdentity.turnId, rows });
  } catch (err) {
    console.error(
      `[assistant-runtime] durable skill-delivery record write FAILED for turn ` +
        `${turnIdentity.turnId} (run ${turnIdentity.runId}, ${rows.length} row(s)) — ` +
        "the turn continues, but this run's delivery is NOT auditable from the store:",
      err instanceof Error ? err.message : String(err),
    );
  }
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
  // SCOPE. The CMS stand-in above stays gated to the widget path
  // (`widgetPrincipal` present); the cookie-session `@cinatra` chat-mcp e2e —
  // which DOES configure a provider and relies on the host `stream()`'s own
  // scripted seam for tool orchestration — keeps resolving its adapter. The ONE
  // cookie-session turn that short-circuits here is the lifecycle question the
  // provider itself claims (`scriptedTurnAsksForLifecyclePull`), added by
  // cinatra#2683 so the proof can photograph the SAME primitive on `/chat` and in
  // the widget; every other chat turn under the flag is byte-identical to before.
  // A SECOND question joins it here: the schedule proposal the provider claims
  // with `scriptedTurnAsksForScheduleProposal`, so the §VI card can be reached
  // in a conversation at all. Both predicates are the PROVIDER's readings; this
  // module still invents no intent of its own, and a turn both decline falls
  // through to the real adapter path untouched.
  //
  // ONE PRODUCTION FENCE, BOTH BRANCHES. `assertScriptedProviderNotProduction`
  // runs before either can be entered: a no-op unless the env flag is set, so
  // PRODUCTION is byte-identical and neither scripted branch is reachable there.
  assertScriptedProviderNotProduction();
  const scriptedProviderEnabled = isScriptedTestProviderEnabled();
  const scriptedInstructions = scriptedProviderEnabled
    ? (() => {
        const lastUser = [...messages].reverse().find((m) => m.role === "user");
        return typeof lastUser?.content === "string" ? lastUser.content : "";
      })()
    : "";
  if (widgetPrincipal && scriptedProviderEnabled) {
    const instructions = scriptedInstructions;
    // THE TOOL LAYER IS REAL ON THIS PATH (cinatra#2683, epic #2564 S8f).
    //
    // The provider decides WHICH primitive to call and with what arguments — the
    // one thing a real model decides here — and this dispatcher performs the call
    // against the REAL self-MCP server, over the real transport, carrying a real
    // `cinatra.widget.mcp-obo` token minted from the SERVER-VERIFIED principal.
    // Every check downstream of that is the shipped one: the transport's token
    // verification, the closed kind-keyed widget tool policy, the handler's own
    // caller resolution through S8a's live-standing actor, the per-row access
    // check, the S1 authorization ladder, and the producer's own envelope mint.
    //
    // THE LABEL IS EARNED, NOT ASSERTED. `serverLabel` is the provenance half of
    // the sink's recognizer, so it may only ride a result this frame KNOWS came
    // back from the cinatra self-MCP. `dispatchedResults` is that knowledge:
    // every string the dispatcher actually returned, recorded by the dispatcher
    // itself. A result the provider composed — the content-editor stand-in, or a
    // hypothetical invented envelope — is not in that set and is emitted with NO
    // label, so `recognizeLifecycleViewEnvelope` refuses it and no card mints.
    // The anti-fabrication property is therefore structural: the provider cannot
    // put a lifecycle card on screen, only the producer can.
    const dispatchedResults = new Set<string>();
    const callSelfMcpTool = createScriptedSelfMcpDispatch({
      widgetPrincipal,
      // The `run` seal (cinatra#2687) — THIS turn's AG-UI run id, the same value
      // the production mint below passes. The scripted path carries the SHIPPED
      // sealed credential or it carries nothing that works: the authorization
      // layer refuses an unsealed token, so an omission here would 401 every
      // call and photograph an empty panel.
      turnRunId: args.turnIdentity.runId,
      onDispatched: (resultText) => dispatchedResults.add(resultText),
    });
    await runScriptedWidgetAssistantTurn({
      instructions,
      assistantHandle: widgetPrincipal.assistantHandle,
      callSelfMcpTool,
      onText: (content) => send("text", { content }),
      onToolCall: (call) =>
        send("tool_call", { id: call.id, name: call.name, status: "running" }),
      onToolResult: (result) =>
        send("tool_result", {
          id: result.id,
          name: result.name,
          status: "completed",
          ...(dispatchedResults.has(result.result)
            ? { serverLabel: LIFECYCLE_PRODUCER_SERVER_LABEL }
            : {}),
          resultLabel: deriveResultLabel(result.name, result.result),
          result: result.result,
        }),
    });
    return;
  }

  // THE SAME GATE, ON `/chat` (cinatra#2683, epic #2564 S8f — the parity proof's
  // comparison view).
  //
  // The widget branch above proved the primitive answers a widget reader. The
  // proof's V5 asks for the OTHER half of the same sentence: the identical
  // primitive, on the first-party cookie-session surface, so the two cards can be
  // read side by side. The obstacle was never authorization — the delegated-chat
  // policy has reached these three primitives since S3 — it was that a keyless
  // dev stack has no model to CHOOSE the tool. This branch supplies exactly that
  // choice and nothing else.
  //
  // NARROW BY CONSTRUCTION, in three ways that are each checkable:
  //   · the provider decides (`scriptedTurnAsksForLifecyclePull`) — the runtime
  //     invents no intent of its own, and a turn it declines falls through to the
  //     real adapter path below, untouched;
  //   · the dispatcher carries the SHIPPED chat bearer for THIS session's user,
  //     so the transport applies the delegated-CHAT policy and every downstream
  //     check — run access, the S1 ladder, the producer's own mint — is the one a
  //     real chat turn gets. A reader who may not read a gate sees the same fixed
  //     refusal here as anywhere else;
  //   · `serverLabel` rides only what `dispatchedResults` recorded, exactly as on
  //     the widget path. A string the provider composed reaches the sink
  //     unlabelled and `recognizeLifecycleViewEnvelope` refuses it, so this
  //     branch can no more fabricate a card than its twin can.
  //
  // `userId` is required and unfaked: without a signed-in human there is no chat
  // identity to delegate, so the turn falls through to the adapter path, whose
  // own guard answers with the authenticated-user error.
  if (
    !widgetPrincipal &&
    scriptedProviderEnabled &&
    userId &&
    (scriptedTurnAsksForLifecyclePull(scriptedInstructions) ||
      scriptedTurnAsksForScheduleProposal(scriptedInstructions))
  ) {
    const dispatchedResults = new Set<string>();
    const callSelfMcpTool = createScriptedChatSelfMcpDispatch({
      userId,
      orgId: sessionOrgId,
      platformRole,
      onDispatched: (resultText) => dispatchedResults.add(resultText),
    });
    await runScriptedChatAssistantTurn({
      instructions: scriptedInstructions,
      callSelfMcpTool,
      onText: (content) => send("text", { content }),
      onToolCall: (call) =>
        send("tool_call", { id: call.id, name: call.name, status: "running" }),
      onToolResult: (result) =>
        send("tool_result", {
          id: result.id,
          name: result.name,
          status: "completed",
          ...(dispatchedResults.has(result.result)
            ? { serverLabel: LIFECYCLE_PRODUCER_SERVER_LABEL }
            : {}),
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
  // cinatra#2776 — the capability THIS turn pins on the adapter. Set to
  // `"native_mcp"` exactly where the Cinatra self-MCP toolbox is handed over
  // (below, once `chatCinatraMcpTool` has assembled), and left undefined
  // otherwise. A conversation-only provider (Gemini) never assembles that tool,
  // so it never carries the requirement either and its request stays
  // byte-identical to before.
  let selfMcpCapabilityRequired: LlmCapabilityRequirement | undefined;
  // The provider's skill contribution to the system prompt: an availability cue
  // on a tool-mount/container provider, the EXPANDED skill bodies on an inline
  // provider. Declared out here because both branches below feed it.
  let skillSystemContext = "";
  // cinatra#2240 — the turn's DELIVERY FACTS, captured here during preparation
  // and COMMITTED at the true dispatch boundary (immediately before `stream()`,
  // or on the refusal return). Capturing and committing at different points is
  // deliberate: several paths return between delivery preparation and dispatch
  // (an unreachable public MCP URL, the explicit-dispatch short circuit), and a
  // record written at `deliver()` time would claim skills reached a model they
  // never reached.
  let turnSkillDeliveryRows: TurnSkillDeliveryRow[] = [];
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
    // The inline vehicle has no adapter and no refusal path of its own: a
    // skill that did not make the byte budget is a DROP, not a refusal, and is
    // recorded as one. Both drop channels feed the record — the injection
    // contract's cap drops and the inline expansion's whole-skill drops.
    turnSkillDeliveryRows = buildTurnSkillDeliveryRows({
      provider: adapter.provider,
      requestedSkillIds: injectedSkillMembers(injectedSkills).map((m) => m.skillId),
      exposure: inline.exposure,
      contractDrops: [...injectionDrops, ...inline.dropped].map((d) => ({
        skillId: d.skillId,
        reason: d.reason,
      })),
    });
    warnOnUnclassifiedVehicles(turnSkillDeliveryRows, adapter.provider);
  }
  if (isNativeMcpProvider(adapter.provider)) {
  // adapter.provider is narrowed to "openai" | "anthropic" in this block
  // (equivalent to `!conversationOnly`), so the tool-assembly calls type-check.
  // Guarantee the assistant's skills resolve with an on-disk sourcePath so
  // buildSkillTools emits the shell tool (also feeds the catalog-backed
  // loadSystemPrompt above; the read_skill fallback is retired).
  await ensureAssistantSkillsRegistered(runtimeConfig.skillIds);
  // SKILL DELIVERY ALWAYS RUNS (cinatra#2094 F11). There is no caller-side
  // model gate any more: the model-aware NATIVE-SHELL decision belongs to the
  // provider adapter, which already owns it. For a shell-incompatible OpenAI
  // model the adapter emits the RESTRICTED, NAMED `skill_file_read` function
  // tool instead of the hosted `shell` (exec-plane S2's singular-native-shell
  // rule, cinatra#1707) — so the 400 the old gate defended against (issue #47)
  // cannot reach the wire, and gating here only DESTROYED delivery.
  //
  // What the old gate did, measured: on a shell-incompatible model the chat
  // turn shipped ZERO skills behind a `console.warn` — a silent no-delivery on a
  // configuration the wizard's own model input can produce. Silent no-delivery
  // is the one forbidden outcome, so the gate is retired and the seam decides.
  let skillTools: LlmTool[] = [];
  const catalogSkillIds = injectedCatalogSkillIds(injectedSkills);
  // cinatra#2240 — the record's DENOMINATOR is every member the injection
  // contract RESOLVED, not the catalog subset the native vehicle can carry.
  // `injectedCatalogSkillIds` filters to `deliveryMode === "catalog"`, so a
  // non-catalog member (the personal delta, always `inline`) is absent from it
  // — and this runtime never merges a non-catalog member's body into the system
  // context on a native provider. Keying the record on the catalog subset would
  // therefore leave such a member RESOLVED, UNDELIVERED and UNRECORDED, which is
  // precisely the shape finding F8 reported. It is recorded as a DROP naming the
  // structural reason instead.
  //
  // Latent rather than live today: `buildAssistantInjectionPorts` supplies no
  // `resolvePersonalDelta` port, so the assistant surface currently resolves
  // catalog members only and this set equals `catalogSkillIds`. The point is
  // that wiring the delta later cannot silently reintroduce an unrecorded
  // member.
  const resolvedMembers = injectedSkillMembers(injectedSkills);
  const resolvedSkillIds = resolvedMembers.map((m) => m.skillId);
  const nonCatalogDrops = resolvedMembers
    .filter((m) => m.deliveryMode !== "catalog")
    .map((m) => ({
      skillId: m.skillId,
      reason:
        `resolved as a "${m.deliveryMode}" member (rank "${m.rank}") — the ` +
        `${adapter.provider} native vehicle delivers catalog members only, so it ` +
        "never reached the model",
    }));
  const nativeContractDrops = [
    ...injectionDrops.map((d) => ({ skillId: d.skillId, reason: d.reason })),
    ...nonCatalogDrops,
  ];
  if (catalogSkillIds.length > 0) {
    const delivery = await selectSkillDeliveryAdapter(adapter.provider).deliver({
      skillIds: catalogSkillIds,
      // The authoritative cap already ran in the contract; the adapter's own
      // cap is a defence-in-depth invariant.
      selectionMode: "general",
    });
    skillTools = delivery.tools;
    skillSystemContext = delivery.systemContext;
    // cinatra#2240 — capture what the adapter reported it delivered (per-skill
    // mode → vehicle), the Anthropic container refs actually emitted, and every
    // resolved-but-undelivered skill with its reason.
    turnSkillDeliveryRows = buildTurnSkillDeliveryRows({
      provider: adapter.provider,
      requestedSkillIds: resolvedSkillIds,
      exposure: delivery.exposure ?? [],
      tools: delivery.tools,
      contractDrops: nativeContractDrops,
      adapterDroppedSkillIds: delivery.droppedSkillIds,
      adapterSelectionReason: delivery.selectionReason,
    });
    warnOnUnclassifiedVehicles(turnSkillDeliveryRows, adapter.provider);
    // LOUD, never silent: the injection contract resolved skills for this turn,
    // so a delivery that produced no vehicle at all means the operator's
    // assistant is running WITHOUT its instructions. Refuse the turn rather than
    // answer as a skill-less assistant while claiming to be the configured one.
    if (skillTools.length === 0 && !delivery.systemContext) {
      const refusalReason =
        `skill delivery produced NO vehicle for provider "${adapter.provider}" ` +
        `model "${adapter.defaultModel}" — the turn was refused`;
      console.error(
        `[assistant-runtime] skill delivery produced NO vehicle for provider ` +
          `"${adapter.provider}" model "${adapter.defaultModel}" with ` +
          `${catalogSkillIds.length} resolved skill(s) — refusing the turn ` +
          "(a silently skill-less assistant is never an acceptable degrade)",
      );
      // The refusal record IS the point of #2240: it names every skill the
      // operator's assistant lost, durably, so the refusal is answerable from
      // the store and not only from a log line. Committed BEFORE the error
      // event so a client that tears down on `error` cannot race the write.
      //
      // The refusal is NOT the whole story: a skill the injection contract or
      // the adapter had ALREADY dropped was never part of the delivery attempt,
      // so it keeps its own drop reason rather than being relabelled "refused"
      // (or, worse, losing its row entirely — the finding-F8 failure mode).
      await persistTurnSkillDelivery(
        args.turnIdentity,
        buildTurnSkillDeliveryRows({
          provider: adapter.provider,
          requestedSkillIds: resolvedSkillIds,
          exposure: [],
          contractDrops: nativeContractDrops,
          adapterDroppedSkillIds: delivery.droppedSkillIds,
          adapterSelectionReason: delivery.selectionReason,
          refusalReason,
        }),
      );
      send("error", {
        message:
          `The assistant's skills could not be delivered to ${adapter.provider} ` +
          `(model "${adapter.defaultModel}"). The turn was refused instead of ` +
          "answering without them — check the provider's model setting at " +
          "/configuration/llm.",
        // S5 (cinatra#2390): stable classification for the loud no-vehicle refusal.
        code: "skill_delivery_refused",
      });
      return;
    }
  } else if (nativeContractDrops.length > 0 || resolvedSkillIds.length > 0) {
    // NO catalog member survived to the native vehicle, but the injection
    // contract DID resolve skills for this turn — non-catalog members, or
    // members it dropped at the cap. No delivery adapter runs, so nothing
    // reaches the model; without this branch that turn records NOTHING and the
    // loss is invisible, which is the finding-F8 shape the record exists to
    // close. It is a set of DROPS, never a refusal: the loud refusal is
    // specifically "the adapter ran and produced no vehicle", which did not
    // happen here.
    turnSkillDeliveryRows = buildTurnSkillDeliveryRows({
      provider: adapter.provider,
      requestedSkillIds: resolvedSkillIds,
      exposure: [],
      contractDrops: nativeContractDrops,
    });
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
  //     platform-admin floored to `member` at mint). A fresh nonce is minted
  //     here, and the token is SEALED to two things it cannot outlive
  //     (cinatra#2687): the `cwu_` row this turn authenticated against, and THIS
  //     turn's AG-UI run id. The MCP authorization layer refuses the token once
  //     that sign-in ends or that turn's terminal status is committed — so the
  //     120 s TTL now bounds only the gap between the relay's last call and that
  //     commit, instead of being the whole containment. The transport
  //     verifies it to a `delegation: "public_site_widget"` actor → the CLOSED,
  //     kind-keyed `delegated-widget` tool policy applies (only the bound kind's
  //     `*_content_editor_run`).
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
          // The two seals (cinatra#2687). Both are values THIS turn already
          // holds — the principal's parent row and the harness-bound run id — so
          // the mint invents nothing and nothing downstream can widen them.
          parentJti: widgetPrincipal.parentTokenJti,
          turnRunId: args.turnIdentity.runId,
          // cinatra#2577 (S8d) — the route's own reading of the consumed `cwu_`.
          // The runtime never re-derives it: one observation, carried.
          lifecycleRead: widgetPrincipal.lifecycleRead,
          // The person's real tier, resolved at the route (cinatra#2674). The
          // widget path no longer floors it, because the site no longer holds
          // the credential that made flooring necessary.
          platformRole: widgetPrincipal.platformRole,
        },
        issueWidgetMcpActorToken,
      )
    : await buildLlmMcpServerToolForChat(
        adapter.provider,
        { delegation: "chat", userId, orgId: sessionOrgId, platformRole },
        issueChatMcpActorToken,
        {
          catalogState: await resolveChatMcpCatalogState({
            actorContext,
            userId,
            sessionOrgId,
          }),
        },
      );
  if (!chatCinatraMcpTool) {
    send("error", {
      message:
        "Cinatra MCP public URL is not configured for hosted MCP access. Set it at /configuration/development?tab=tunnel.",
    });
    return;
  }
  // cinatra#2776 (owner ruling 2026-08-15). The self-MCP catalog is now on this
  // turn's tool array, and the ONLY shape in which it may reach a model is ONE
  // provider-hosted MCP reference. Pinning `native_mcp` here makes that a
  // CONTRACT the adapter must satisfy rather than a property of whichever mode
  // the connector happens to be configured in: an adapter whose native path is
  // unavailable — Anthropic's persisted `mcpMode: "function-tools"`, or a
  // native attempt that failed at runtime — must REFUSE the turn before any
  // credential-bearing egress instead of flattening the catalog into inline
  // function schemas (the cost/behavior regression class of cinatra#2771).
  // Both chat surfaces pin it, because both hand over the same toolbox: the
  // cookie-session browser chat and the widget principal's turn.
  // `function-tools` stays reachable only for callers that DECLARE it (the
  // agent-run LLM bridge forwards an agent's own `capabilityRequired`);
  // field-absent is not an opt-in.
  selfMcpCapabilityRequired = "native_mcp";

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
  // Two fragments from one read: stable identity for the cacheable head, and
  // the MUTABLE freeze state for the volatile tail (codex round-2, finding 2).
  const { identity: instanceContext, freezeState: instanceFreezeState } =
    buildInstanceContext();

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

  // cinatra#2240 — THE DISPATCH BOUNDARY, observed rather than assumed.
  //
  // Reaching this line is NOT proof that a provider request happened: `stream()`
  // still resolves the adapter, injects MCP/execution tools and resolves
  // attachments before it calls `adapter.stream()`, and a throw in any of those
  // means nothing left the process. Committing here would leave permanent
  // `delivered` rows for a turn that never dispatched — and because the record
  // is an idempotent insert (a fact is never rewritten), a retry could not
  // repair it.
  //
  // TWO signals, and the record needs BOTH — it FAILS CLOSED, because a false
  // audit fact is strictly worse than a missing one (the missing case is a turn
  // the operator already sees as failed; the false case silently corrupts the
  // answer to "what did this run get?" forever).
  //
  //   providerStepStarted — `onStepStart`, which every provider adapter fires at
  //     the top of its step loop. NOT sufficient on its own: an adapter may do
  //     local work between that callback and the SDK call (the connectors write
  //     an operator-enabled request log there), and a failure in it would leave
  //     `delivered` rows for a request that never left the process.
  //   providerResponded — PROVIDER-PRODUCED output: a text delta, a tool
  //     call/result, citations, or a completed step. None of those can exist
  //     unless the request reached the provider and it answered.
  //
  // TWO THINGS THAT LOOK LIKE PROOF AND ARE NOT — both verified against the
  // shipped adapters (openai-connector `openai-adapter.ts`, anthropic-connector
  // `anthropic-adapter.ts`, gemini-connector `gemini-adapter.ts`):
  //
  //   `onError` is NOT egress. Every shipped adapter routes its stream-iteration
  //     failure through `input.onError(...)` — and a DNS/ECONNREFUSED/TLS
  //     failure raises inside exactly that iteration, BEFORE any byte reaches
  //     the provider. Counting `onError` would stamp permanent `delivered` rows
  //     on the single most common broken-configuration failure, which is
  //     precisely when an operator reads this record.
  //   A RESOLVED `stream()` is NOT egress either. All three adapters call
  //     `onError` and then `break` their step loop, so `adapter.stream()`
  //     RESOLVES NORMALLY after a connection failure. "The stream completed" is
  //     therefore true of a turn that never left the process, and cannot gate
  //     the write.
  //
  //   `onStepEnd` IS egress: every adapter fires it only AFTER the step's stream
  //     was consumed and its final response read — every error path `break`s
  //     before reaching it — so a completed step is provider-produced.
  //
  // KNOWN, DELIBERATE UNDER-REPORTS — two shapes, both accepted:
  //
  //   1. A provider that REJECTS the request outright (the issue-#47 400s that
  //      motivated #2094 F11) produces no output, so its turn records nothing.
  //   2. A turn whose only provider output was a BUFFERED tool call, cut off
  //      mid-stream: every adapter accumulates tool-call chunks and emits
  //      `onToolCall`/`onStepEnd` only after the step's stream is consumed, so a
  //      mid-iteration `ECONNRESET` reports through `onError` alone and this
  //      gate sees nothing.
  //
  // Neither is fixable from this seam WITHOUT reintroducing the false-fact
  // hazard: the only earlier signal is `onError`, which is exactly the callback
  // a pre-egress connection failure also uses. Separating "sent, then cut off"
  // from "never sent" needs an adapter signal the delivery ABI does not expose.
  // Under-reporting is the correct side of that trade — an absent record reads
  // as "not auditable" and is logged loudly, while a false one is
  // indistinguishable from the truth and, because the write is an idempotent
  // insert, can never be repaired.
  let providerStepStarted = false;
  let providerResponded = false;

  // cinatra#2580 — per-turn no-progress guard. Purely observational until it
  // trips: it reads the SAME callbacks the sink already receives and adds NO
  // FIELD to the request envelope, so a turn that makes progress sends the
  // same system prompt, tools, messages and step budget as before. (`signal`
  // is still an `AbortSignal` — a third source was added to the composition,
  // which nothing on the provider side can observe.)
  //
  // On a trip it aborts through the EXISTING `signal` seam rather than a new
  // adapter contract — `AbortSignal.any` already composes the caller's signal
  // with the 120s ceiling, so the guard is a third source on that same wire and
  // every shipped adapter already honours it.
  const turnCostGuard = createTurnCostGuard();
  const noProgressAbort = new AbortController();
  // A private sentinel carried as the abort REASON, so this runtime's own
  // abort is identifiable by reference wherever it resurfaces. It is what lets
  // the terminal frame tell "the adapter reported the stop we caused" (nothing
  // to add) apart from "the adapter reported something else" (report both).
  // Named `AbortError` because that is what an abort reason is expected to
  // look like where it propagates through `AbortSignal.any`.
  const noProgressAbortReason = new Error("assistant turn stopped: no progress");
  noProgressAbortReason.name = "AbortError";
  // Set the instant the guard decides to stop, so the exits below can report
  // the real reason instead of the abort the stop itself raises.
  let noProgressStop: ReturnType<typeof turnCostGuard.verdict> = null;
  // The sink treats the FIRST terminal frame as final, so the stopped-turn
  // frame is emitted exactly once no matter which of the three exits
  // (onError / a resolved stream / a throw) the abort surfaces through. Set
  // AFTER the send returns: a send that throws has not delivered anything, and
  // recording it as delivered would lose the turn's only terminal frame.
  let terminalErrorSent = false;
  const sendTerminalError = (message: string, code: string) => {
    send("error", { message, code });
    terminalErrorSent = true;
  };
  const sendNoProgressTerminal = (verdict: NonNullable<typeof noProgressStop>) => {
    if (terminalErrorSent) return;
    sendTerminalError(noProgressMessage(verdict), TURN_STOPPED_NO_PROGRESS_CODE);
  };
  /**
   * Whether a thrown value IS the abort this runtime raised — the sentinel by
   * identity, or an adapter error that chained it as `cause`.
   *
   * Nothing else qualifies. A bare `AbortError` of unknown provenance is NOT
   * assumed to be ours: after the verdict our controller is always aborted, so
   * "it is an AbortError and we aborted" would accept every abort-shaped
   * failure regardless of where it came from.
   *
   * Attribution is not needed to REPORT the stop, only to decide whether the
   * adapter's own error still has something to say — see the terminal frame,
   * which carries both.
   */
  const isNoProgressAbort = (error: unknown) => {
    if (error === noProgressAbortReason) return true;
    if (typeof error !== "object" || error === null) return false;
    let cause: unknown = (error as { cause?: unknown }).cause;
    // Walk a short chain: an adapter may wrap the reason once or twice.
    for (let depth = 0; depth < 4 && cause != null; depth++) {
      if (cause === noProgressAbortReason) return true;
      cause = (cause as { cause?: unknown }).cause;
    }
    return false;
  };
  /**
   * The stopped-turn frame. The runtime's decision to stop IS the primary
   * fact, so it always leads and always carries the stop's stable code. An
   * error the adapter reported that is NOT provably the stop's own abort is
   * appended verbatim (classified + sanitized) rather than dropped — a genuine
   * adapter failure landing in the same window must never be hidden behind a
   * cost message.
   */
  const sendNoProgressWith = (
    verdict: NonNullable<typeof noProgressStop>,
    error: unknown,
  ) => {
    if (terminalErrorSent) return;
    const underlying = isNoProgressAbort(error)
      ? null
      : classifyAssistantRuntimeError(error);
    sendTerminalError(
      underlying
        ? `${noProgressMessage(verdict)} The provider also reported: ${underlying.message}`
        : noProgressMessage(verdict),
      TURN_STOPPED_NO_PROGRESS_CODE,
    );
  };
  const stopTurnIfStalled = () => {
    if (noProgressStop) return;
    const verdict = turnCostGuard.verdict();
    if (!verdict) return;
    noProgressStop = verdict;
    console.warn(
      // Evaluated at a step boundary, so `steps` is the exact number of
      // full-context rounds this turn paid for before stopping.
      `[assistant-runtime] no-progress stop after ${turnCostGuard.steps} provider step(s): ` +
        `"${verdict.toolName}" returned nothing on ${verdict.repeats} consecutive steps ` +
        "— aborting the turn instead of re-billing another full-context step (cinatra#2580)",
    );
    noProgressAbort.abort(noProgressAbortReason);
  };

  // cinatra#2771 lever 2 — the turn's system fragments, named. Collecting them
  // into one typed record is what lets the composer own the ORDER (stable head
  // first, volatile tail last) and lets a unit test assert byte-stability on
  // the exact same structure the turn builds.
  const chatSystemFragments: ChatSystemPromptFragments = {
    systemPrompt,
    // The provider's skill contribution: an availability cue (Anthropic
    // container listing; empty for OpenAI shell delivery, which must not be
    // told about a read_skill tool) or, on an inline provider, the expanded
    // skill bodies.
    skillSystemContext,
    instanceContext,
    extensionConfirmationPolicy,
    userContext,
    // Volatile: `agent_source_publish` can flip this mid-conversation, so it
    // must not sit in the head (codex round-2, finding 2). It follows
    // `userContext` because it is policy-bearing text and policy is read after
    // user-controlled content, never before it (finding 1).
    instanceFreezeState,
    pendingConfirmationContext,
    explicitDispatchDirective,
    // AC#5: the conversation-only degrade notice (empty for tool-capable
    // providers).
    conversationOnlyNotice,
  };

  try {
    await stream({
      provider: adapter.provider,
      actorContext,
      ...chatExecutionObserver.binding,
      // An explicit `model` pref overrides the connection default; absent, the
      // field is omitted so the call is byte-identical to the legacy chat.
      ...(modelPrefs.model ? { model: modelPrefs.model } : {}),
      // cinatra#2771 lever 2 — composed STABLE HEAD FIRST. The same eight
      // fragments as before, re-ordered so every one that can differ between
      // two turns of a conversation lands after every one that cannot. The
      // composer is pure, so the byte-stability property is unit-asserted
      // rather than inferred (see `chat-system-prefix.ts`).
      system: composeChatSystemPrompt(chatSystemFragments),
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
      // cinatra#2776 — present ONLY when the self-MCP toolbox was assembled
      // (see `selfMcpCapabilityRequired` above). Conditionally spread so a
      // conversation-only turn's adapter input keeps exactly the field set it
      // had before this change.
      ...(selfMcpCapabilityRequired
        ? { capabilityRequired: selfMcpCapabilityRequired }
        : {}),
      maxSteps: runtimeConfig.maxToolRounds,
      // Abort on the 120s ceiling OR the caller's signal (client disconnect,
      // #503) OR the no-progress guard (cinatra#2580) so a torn-down or stalled
      // stream stops LLM/MCP work promptly. The guard's controller never
      // aborts on a progressing turn, so the composed signal behaves exactly as
      // the previous two-source one on every path that used to complete.
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(120_000), noProgressAbort.signal])
        : AbortSignal.any([AbortSignal.timeout(120_000), noProgressAbort.signal]),
      logLabel: "chat",
      onTextDelta: (delta) => {
        // cinatra#2240 — provider engagement: this can only fire once the
        // request carrying these skills actually reached the provider.
        providerResponded = true;
        // Accumulated for the end-of-turn execution-provenance verdict
        // (cinatra#2175); the sink emission itself is unchanged.
        assistantTurnText += delta;
        // cinatra#2580 — user-visible text is progress; it clears the guard's
        // repeat streak. Fed BEFORE the sink so the guard can never be behind
        // what the user already saw.
        turnCostGuard.observeTextDelta(delta);
        send("text", { content: delta });
      },
      onToolCall: (call) => {
        // cinatra#2240 — provider engagement: this can only fire once the
        // request carrying these skills actually reached the provider.
        providerResponded = true;
        // cinatra#2580 — the guard joins arguments to results by call id, so it
        // must see EVERY call, including the hidden ones the sink suppresses (a
        // hidden tool spinning on a dead surface costs exactly as much as a
        // visible one).
        turnCostGuard.observeToolCall(call);
        if (isHiddenTool(call.name)) return;
        send("tool_call", {
          id: call.id,
          name: call.name,
          status: "running",
          serverLabel: call.serverLabel,
        });
      },
      onToolResult: (result) => {
        // cinatra#2240 — provider engagement: this can only fire once the
        // request carrying these skills actually reached the provider.
        providerResponded = true;
        // cinatra#2580 — same reasoning as onToolCall: feed the guard for every
        // result, hidden or not. The verdict is NOT taken here — a single step
        // can carry several parallel calls, and the streak advances per STEP
        // (the billed unit), never per result.
        turnCostGuard.observeToolResult(result);
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
        // cinatra#2240 — a provider step is BEGINNING. Necessary but NOT
        // sufficient on its own; see the dispatch-boundary note above the try.
        providerStepStarted = true;
        send("thinking_start", { round: step });
      },
      onStepEnd: (step) => {
        // cinatra#2240 — provider engagement: this can only fire once the
        // request carrying these skills actually reached the provider.
        providerResponded = true;
        // cinatra#2580 — the step boundary is where the streak advances and
        // where a stop is decided, so the abort lands after a completed step
        // and BEFORE the adapter opens the next step's full-context request.
        turnCostGuard.observeStepEnd();
        stopTurnIfStalled();
        send("thinking_end", { round: step });
      },
      onCitations: (citations) => {
        // cinatra#2240 — provider engagement: this can only fire once the
        // request carrying these skills actually reached the provider.
        providerResponded = true;
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
        // cinatra#2240 — deliberately NOT a dispatch signal. Every shipped
        // adapter reports a stream-iteration failure here, and a DNS/connection
        // failure raises inside that same iteration before anything reaches the
        // provider. See the dispatch-boundary note above the try.
        //
        // `error` is a TERMINAL sink frame: the AG-UI adapter ignores every
        // event after the first terminal. An adapter that reports through this
        // callback and then RESOLVES would therefore have its marker dropped
        // if we only evaluated after the stream — so the verdict is taken here,
        // on the text accumulated so far, before the terminal goes out.
        markUnverifiedExecutionClaim();
        // cinatra#2580 — once the guard has stopped the turn, the stop is what
        // the user needs to read: the raw abort classifies to a bare
        // "aborted" with no cause, while the guard's reason names the
        // unresponsive tool and the remedy. Anything the adapter reported that
        // is NOT that abort rides along in the same frame rather than being
        // dropped. Emitted through the SAME terminal vocabulary as before.
        if (noProgressStop) {
          sendNoProgressWith(noProgressStop, error);
          return;
        }
        // S5 (cinatra#2390): classify — provider stream failures (including
        // skill-delivery rejections surfaced mid-iteration) carry a stable
        // code + sanitized actionable copy, never the raw provider message.
        const classified = classifyAssistantRuntimeError(error);
        sendTerminalError(classified.message, classified.code);
      },
    });

    // Execution-provenance verdict (cinatra#2175). Rides the EXISTING text
    // path, so the marker persists with the turn (`assistant_turns.content`),
    // renders through the same markdown the reply does, and needs no new
    // stream vocabulary or component. `not_applicable` (the default, and the
    // only reachable status while the plane is dark) emits nothing.
    markUnverifiedExecutionClaim();

    // cinatra#2580 — a stopped turn is never `done`. Two adapter behaviors
    // both land here: one that reported the abort through `onError` and then
    // resolved (its terminal frame is already out — emit nothing more, but
    // still do NOT append `done`), and one that honoured the abort by simply
    // BREAKING its step loop and resolving silently (no frame yet — emit the
    // reason so the user is not left with a truncated answer and no
    // explanation).
    if (noProgressStop) {
      sendNoProgressTerminal(noProgressStop);
      return;
    }

    send("done", {});
  } catch (error) {
    // Same verdict before the terminal error frame: the partial text is
    // persisted either way, so an unbacked claim inside it must be marked
    // either way.
    markUnverifiedExecutionClaim();
    // cinatra#2580 — same rule as `onError`: the stop leads, and a throw that
    // is not provably the stop's own abort (adapter teardown, a sink write)
    // is carried in the same frame instead of being swallowed.
    if (noProgressStop) {
      sendNoProgressWith(noProgressStop, error);
      return;
    }
    // S5 (cinatra#2390): classified runtime recovery — a throw anywhere in
    // the turn (skill delivery BEFORE the stream handler included: not-yet-
    // synced skills, an MCP-mode remnant) becomes a stable code + sanitized
    // actionable copy, never a raw provider/internal message.
    const classified = classifyAssistantRuntimeError(error);
    send("error", { message: classified.message, code: classified.code });
  } finally {
    // Commit ONLY when a provider request demonstrably carried these skills: a
    // step began AND the provider PRODUCED something. Anything that failed
    // before egress — adapter resolution, MCP/execution injection, attachment
    // resolution, an adapter's own pre-request work, or a connection that never
    // opened — records NOTHING, including the cases where the adapter reports
    // the failure through `onError` and then resolves normally.
    if (providerStepStarted && providerResponded) {
      await persistTurnSkillDelivery(args.turnIdentity, turnSkillDeliveryRows);
    }
  }
}

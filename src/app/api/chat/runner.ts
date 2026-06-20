import "server-only";

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
import {
  detectExplicitDispatchDirective,
  detectExplicitDispatchPackage,
} from "./explicit-dispatch";
import { serverSideExplicitDispatch } from "./explicit-dispatch-server";
import { createDeterministicSkillsClient } from "@cinatra-ai/skills/mcp-client";
import {
  ensureInstalledSkillsRegistered,
  resolveInstalledSkillSourcePath,
} from "@cinatra-ai/skills";
import { getAllStagedByType } from "@/lib/wizard-staging-store";
import { getAllManifests } from "@/lib/wizard-manifest-registry";
// Connector-owned user-context sections (gmail send-as addresses, calendar
// appointment schedules, ...) resolve through the chat-user-context capability
// registry — the runner no longer imports any connector package by name.
import { buildChatUserContextSections } from "./chat-user-context";
import { shouldDeliverChatShellSkillTools } from "./shell-skill-gate";
import {
  hasConfiguredLlmRuntime,
  stream,
  buildSkillTools,
  resolveDefaultAdapter,
  resolveChatExternalMcpTools,
  buildLlmMcpServerToolForChat,
} from "@cinatra-ai/llm";
import type { LlmTool } from "@cinatra-ai/llm";
import { issueChatMcpActorToken } from "@/lib/chat-mcp-actor-token";
import { readInstanceIdentity } from "@/lib/instance-identity-store";
import type { ActorContext } from "@/lib/authz/actor-context";
import {
  buildExtensionImplementationConfirmationPolicy,
} from "./extension-confirmation";
// Chat-side resolver ports are scoped to the session's active org
// (auth-derived; never caller-controlled).
import { buildAttachmentResolverPorts } from "@/lib/artifacts/attachment-resolver-ports";

// ---------------------------------------------------------------------------
// Public types
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
};

export { hasConfiguredLlmRuntime };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Chat SKILL.md is split into focused sub-skills. The core skill is the
// always-loaded system prompt; all sub-skills are mounted via the shell
// tool so the LLM reads concern-specific guidance on demand.
const CHAT_SKILL_SLUGS = [
  "chat-assistant-core",
  // Shared SPINE for authoring a new extension PACKAGE (kind selection, the
  // trust/confirmation flow, the validator contract, the scaffold→write→
  // validate→build→submit→review lifecycle). The per-kind authoring skills
  // (chat-agent-authoring, chat-workflow-extension-authoring) reference it.
  "chat-extension-authoring-core",
  "chat-agent-authoring",
  // Authoring a reusable WORKFLOW EXTENSION PACKAGE (cinatra.kind:"workflow",
  // a cinatra/workflow.bpmn) via the workflow_source_* tools. DISTINCT from
  // chat-workflow-authoring below, which creates a one-off DRAFT/INSTANCE.
  "chat-workflow-extension-authoring",
  // Authoring a reusable ARTIFACT EXTENSION PACKAGE (cinatra.kind:"artifact",
  // a semantic cinatra.artifact manifest) via the artifact_source_* tools.
  // DISTINCT from chat-create-artifact below, which emits an artifact INSTANCE.
  "chat-artifact-extension-authoring",
  // Authoring a reusable SKILL EXTENSION PACKAGE (cinatra.kind:"skill", a
  // cinatra.capabilities map → co-located skills/<slug>/SKILL.md) via the
  // skill_source_* tools. DISTINCT from the skills_* personal/installed/install
  // mutations, which operate on skill ROWS / install state, not a package.
  "chat-skill-extension-authoring",
  "chat-agent-dispatch",
  "chat-campaign-creation",
  "chat-appointment-schedules",
  "chat-run-polling",
  // Chat-driven authoring of semantic artifacts. Teaches the model to
  // detect "create me an X" intents, find the matching artifact extension
  // via artifact_extension_search, and emit through artifact_authoring_emit
  // (which is recursion-ledger-gated + matcher-suppressed).
  "chat-create-artifact",
  // Workflow DRAFT/INSTANCE authoring + read-only status Q&A. Creates one-off
  // planned runs — NOT reusable workflow PACKAGES (that is
  // chat-workflow-extension-authoring above, via the workflow_source_* tools).
  // Proposal-only: create/revise/preview drafts, never start/approve/reject.
  "chat-workflow-authoring",
  // Blog dashboard surface (the blog-content-workflow extension composes the
  // operator workspace). Teaches the chat how to navigate the new
  // project→idea→post selection chain + publish workflow.
  "blog-content",
] as const;
const CHAT_SYSTEM_SKILL_ID = "@cinatra-ai/chat:chat-assistant-core";
const CHAT_SKILL_IDS = CHAT_SKILL_SLUGS.map((slug) => `@cinatra-ai/chat:${slug}`);
// Raised 16 → 24 because the three-tier discovery flow
// (agent_source_list + agent_list + extensions_search + agent_registry_list
// + agent_source_read of a golden example) adds ~5 calls before authoring
// even starts, on top of the 5–7 calls needed for the OAS source-authoring
// pipeline, plus typical smoke-test retries and the post-publish marketplace
// duplicate search. A live test hit 18 calls and tripped the 16 cap, leaving
// the runtime to emit the fallback "completed the following actions" stub
// instead of a real reply.
const MAX_TOOL_ROUNDS = 24;

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
  "wordpress_post_create_draft": "WordPress draft created",
  "wordpress_post_update_meta": "WordPress post updated",
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

// Catalog-unavailable fallback: read the chat core SKILL.md straight from
// disk. The on-disk location is resolved through the skills layer's generic
// install/uninstall-aware extension scan (the same substrate that registers
// the chat sub-skills), NOT through hardcoded extension path candidates — the
// runner names only the stable `@cinatra-ai/chat:` skill id (an auth-policy
// data-contract id), never the providing extension package or its disk path.
async function loadSystemPromptFromDisk(): Promise<string | null> {
  try {
    const skillMdPath = await resolveInstalledSkillSourcePath(CHAT_SYSTEM_SKILL_ID);
    if (skillMdPath && existsSync(skillMdPath)) {
      const raw = readFileSync(skillMdPath, "utf8");
      const stripped = raw.replace(/^---[\s\S]*?\n---\n/, "");
      return stripped.trim();
    }
  } catch (err) {
    console.warn("[chat] disk SKILL.md fallback failed:", (err as Error).message);
  }
  return null;
}

// Idempotent server-side preflight: ensure the chat sub-skills are registered
// in the skills layer with a real on-disk `sourcePath`. `buildSkillTools`
// requires a registered chat skill to emit the shell tool; this preflight is
// the load-bearing path that makes shell delivery work.
//
// All chat sub-skills are co-located in the `assistant-skills` extension
// package, so the generic, install/uninstall-aware batch resolver materializes
// every co-located chat SKILL.md body into the catalog in a SINGLE scan
// (`registerColocatedWorkspaceSkills` registers the whole providing package
// once), while keeping each requested id independently retryable on a transient
// upsert failure. This replaces the former hardcoded self-heal — a literal
// `@cinatra-ai/chat` package name + literal
// `extensions/cinatra-ai/assistant-skills/.../SKILL.md` candidate paths — which
// was exactly the static extension-INSTANCE coupling the
// `core-extension-instance-coupling-ban` gate exists to kill. The resolver
// memoizes successful registration per-id per-process and drops the memo for an
// id that failed to register so a later turn retries it, so this is safe to
// call every turn. The `@cinatra-ai/chat:` skill-id namespace (an auth-policy
// boundary) is preserved by the resolver's `assistant-skills` special-case in
// `deriveSkillRegistration`. The disk SKILL.md prompt fallback
// (`loadSystemPromptFromDisk`) resolves its path through the same generic
// scan (`resolveInstalledSkillSourcePath`), so it carries no extension path
// candidates either.
function ensureChatSkillRegistered(): Promise<void> {
  return ensureInstalledSkillsRegistered(CHAT_SKILL_IDS);
}

async function loadSystemPrompt(): Promise<string> {
  try {
    const client = createDeterministicSkillsClient({
      actor: { actorType: "system", source: "worker" },
    });
    const skill = await client.installed.get(CHAT_SYSTEM_SKILL_ID);
    if (skill?.body) {
      return skill.body;
    }
  } catch {
    // fall through
  }
  const onDisk = await loadSystemPromptFromDisk();
  if (onDisk) return onDisk;
  return [
    "You are the Cinatra AI assistant.",
    "You help users orchestrate agents, workflows, data, and content across an open source enterprise intelligence platform.",
    "Be concise. Lead with answers. Use tables for data. Never repeat what the user said.",
  ].join("\n");
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
// runChatTurn — extracted from /api/chat POST so MCP callers
// (chat_thread_send) can drive the same orchestration in-process without a
// second HTTP roundtrip through /api/chat (which requires a session cookie
// MCP callers do not have).
// ---------------------------------------------------------------------------

export async function runChatTurn(args: RunChatTurnArgs): Promise<void> {
  const { messages, actorContext, userId, platformRole, sessionOrgId, send } = args;

  // Chat-owned native MCP injection with a delegated human actor token.
  //
  // The chat must NOT let `injectMcpTools` auto-prepend the default cinatra
  // self-MCP tool: that path attaches the LLM provider's machine
  // `client_credentials` token, which /api/mcp resolves to an anonymous
  // machine actor. Chat must connect to /api/mcp AS THE HUMAN CHAT USER so
  // `agent_run` writes `run_by = userId` and the follow-up `agent_run_get`
  // passes `enforceRunAccess`.
  //
  // So the chat assembles its own tool array (skipMcpInjection: true):
  //   - ONE `type: "mcp"` reference to the cinatra self-MCP carrying a
  //     short-lived delegated actor token for the current chat user
  //     (src/lib/chat-mcp-actor-token.ts → verified by the MCP transport)
  //   - ALL connected third-party MCP servers (WordPress, Drupal, Apify,
  //     any externally-registered) — those are external, not Cinatra-authz-
  //     gated, so the machine-token path is fine for them
  //   - the skill-mounting shell tool (chat-assistant SKILL.md)
  //   - the OpenAI provider-native `web_search` tool
  //
  // The chat-assistant SKILL.md teaches the LLM to use `agent_list` +
  // `agent_run` (discovered through the cinatra-mcp server) for agent
  // dispatch — internal + external A2A agents both reachable via `agent_run`
  // (its sourceType branch in packages/agents/src/a2a-actions.ts).
  const adapter = await resolveDefaultAdapter();
  if (!adapter) {
    send("error", { message: "No LLM provider configured." });
    return;
  }
  if (adapter.provider === "gemini") {
    send("error", {
      message:
        "Chat MCP dispatch requires an OpenAI or Anthropic provider (Gemini has no native MCP support).",
    });
    return;
  }
  if (!userId) {
    send("error", {
      message: "Chat MCP dispatch requires an authenticated user.",
    });
    return;
  }

  // Guarantee the chat skill resolves with an on-disk sourcePath so
  // buildSkillTools emits the shell tool (also feeds the catalog-backed
  // loadSystemPrompt above; the read_skill fallback is retired).
  await ensureChatSkillRegistered();
  // Model-aware shell delivery (issue #47). OpenAI rejects the hosted
  // `shell` tool for gpt-5 / gpt-5-mini; sending it 400s EVERY chat turn.
  // Chat passes no per-request model, so adapter.defaultModel (the
  // connection's defaultModel) is exactly the model this request uses.
  // Mirror the llm-bridge degrade semantics: skip the skill shell tool and
  // keep the turn running — never reintroduce a read_skill function tool.
  const deliverShellSkillTools = shouldDeliverChatShellSkillTools(adapter);
  if (!deliverShellSkillTools) {
    console.warn(
      `[chat] shell-incompatible OpenAI model "${adapter.defaultModel}" — ` +
        "skipping the chat skill shell tool (skill delivery degrades; the " +
        "turn continues with MCP + web_search tools only)",
    );
  }
  const skillTools = deliverShellSkillTools
    ? await buildSkillTools({ skillIds: CHAT_SKILL_IDS })
    : [];
  const chatCinatraMcpTool = await buildLlmMcpServerToolForChat(
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

  const externalMcpTools = await resolveChatExternalMcpTools(adapter.provider);
  const tools: LlmTool[] = [
    chatCinatraMcpTool,
    ...externalMcpTools,
    ...skillTools,
    { type: "web_search" },
  ];

  const systemPrompt = await loadSystemPrompt();
  const userContext = await buildUserContext(userId);
  // Surface the operator's instance namespace + freeze state to the LLM so
  // it stops emitting hardcoded `@cinatra/<slug>` package names on non-cinatra
  // deployments. The chat SKILL.md uses `@<vendor>/<slug>` as a placeholder;
  // this context substitutes the real vendor.
  const instanceContext = buildInstanceContext();

  const extensionConfirmationPolicy = buildExtensionImplementationConfirmationPolicy();

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
  // tool_call + tool_result + text SSE events, and early-return from the chat
  // turn. The LLM never gets a chance to skip the tool. The chat-mcp e2e
  // harness's `tool_call` listener fires immediately and the run is queued
  // exactly as if the LLM had called it.
  const explicitDispatchDirective = detectExplicitDispatchDirective(messages);
  const explicitDispatchPackage = detectExplicitDispatchPackage(messages);

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
        `[chat] explicit-dispatch pre-router HARD short-circuit: ${explicitDispatchPackage} → runId=${dispatchResult.runId}`,
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
        `[chat] explicit-dispatch pre-router TERMINAL failure for ${explicitDispatchPackage}: ${dispatchResult.error} — no LLM fallthrough`,
      );
      return;
    }
    // On non-terminal dispatch failure (e.g. unknown agent, registry miss),
    // fall through to the regular LLM path — the synthetic tool_result
    // already emitted carries the error, and the LLM can offer alternatives.
    console.warn(
      `[chat] explicit-dispatch pre-router HARD attempt failed for ${explicitDispatchPackage}: ${dispatchResult.error} — falling through to LLM`,
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

  try {
    await stream({
      provider: adapter.provider,
      actorContext,
      system:
        explicitDispatchDirective +
        systemPrompt +
        userContext +
        instanceContext +
        extensionConfirmationPolicy,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        // Forward per-message attachments; omit when absent so every text-only
        // chat caller remains byte-identical.
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
      // The chat assembles its own cinatra self-MCP tool (delegated
      // human-actor token) plus external MCP servers. Auto-injection MUST be
      // skipped: it would prepend a second cinatra-mcp entry with the machine
      // client_credentials token, which resolves as an anonymous machine actor
      // and breaks run-ownership authz.
      skipMcpInjection: true,
      maxSteps: MAX_TOOL_ROUNDS,
      signal: AbortSignal.timeout(120_000),
      logLabel: "chat",
      onTextDelta: (delta) => {
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
        send("error", { message: error.message });
      },
    });

    send("done", {});
  } catch (error) {
    const message = error instanceof Error ? error.message : "Chat request failed.";
    send("error", { message });
  }
}

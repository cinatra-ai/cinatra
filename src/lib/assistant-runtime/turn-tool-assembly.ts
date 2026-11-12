import "server-only";

// The tool assembly of one assistant turn (packages/agent-ui-protocol/
// CONTRACT.md section 5.2, "One source" and "Read only").
//
// EXTRACTED from `runAssistantTurn` (./runtime.ts) without a change of
// behaviour: the conversation-only check, the injected skill set, the skill
// delivery, the self-MCP reference, the external MCP tools, the skill tools,
// `web_search`, and then the allow-list filter `isAllowedByList`. The turn and
// the later tool-manifest route both call this one function, so the route
// never keeps a second list of tools.
//
// THIS MODULE WRITES NOTHING. It inserts, updates and deletes nothing, mints
// no actor token and no lent-action grant, sends no stream event, persists no
// delivery record and makes no network call to a model provider or to an MCP
// endpoint. Each step of the turn that does one of these stays in
// `runAssistantTurn`, which supplies it here as a port at the point in the
// order where the turn has always run it:
//
//   - the token issuers (`issueChatMcpActorToken`, `issueWidgetMcpActorToken`):
//     the turn passes the real issuers, a reader passes inert ones;
//   - `admitSelfMcpReference`: the turn's reachability probe and its
//     lent-action grant, run after the skill delivery and before the self-MCP
//     reference is built, exactly as before;
//   - `readChatMcpCatalogState`: the chat surface's self-MCP catalog state.
//
// The skill registration runs in `runAssistantTurn` before the call, and the
// delivery record is committed there after it (the refusal record from the
// rows this function returns).

import type {
  ChatMcpCatalogState,
  LlmCapabilityRequirement,
  LlmProvider,
  LlmTool,
} from "@cinatra-ai/llm";
import {
  buildLlmMcpServerToolForChat,
  buildLlmMcpServerToolForWidget,
  deliverInjectedSkillsInline,
  resolveChatExternalMcpTools,
  selectSkillDeliveryAdapter,
} from "@cinatra-ai/llm";
import {
  injectedCatalogSkillIds,
  injectedSkillDrops,
  injectedSkillMembers,
  isInlineSkillMechanism,
  resolveInjectedSkillSet,
  type InjectionResolverPorts,
} from "@cinatra-ai/skills/injection";
import {
  buildTurnSkillDeliveryRows,
  type TurnSkillDeliveryRow,
} from "./skill-delivery-record";
import { isAllowedByList } from "./ports";
import { isConversationOnlyProvider } from "./model-routing";

type NativeMcpProvider = Extract<LlmProvider, "openai" | "anthropic">;

/**
 * Type-narrowing guard: a provider with NATIVE MCP (OpenAI/Anthropic) is the
 * tool-capable set. Deriving it from the shared `isConversationOnlyProvider`
 * keeps one definition of "which providers take tools".
 */
function isNativeMcpProvider(provider: LlmProvider): provider is NativeMcpProvider {
  return !isConversationOnlyProvider(provider);
}

/** Who the self-MCP reference is built for: the chat page or a widget turn. */
export type TurnSelfMcpSubject =
  | {
      kind: "chat";
      actor: Parameters<typeof buildLlmMcpServerToolForChat>[1];
    }
  | {
      kind: "widget";
      actor: Parameters<typeof buildLlmMcpServerToolForWidget>[1];
    };

export type AssistantTurnToolAssemblyInput = {
  provider: LlmProvider;
  defaultModel: string;
  /** The assistant's required skill bundle (its runtime config `skillIds`). */
  skillIds: readonly string[];
  /** The assistant's tool allow-list (its runtime config `allowedTools`). */
  allowedTools: string[];
  assistantAgentId: string;
  userId: string;
  /** The session id of the injection intent (the turn mints one if absent). */
  sessionId: string;
  injectionPorts: InjectionResolverPorts;
  selfMcp: TurnSelfMcpSubject;
};

export type AssistantTurnToolAssemblyPorts = {
  issueChatMcpActorToken: Parameters<typeof buildLlmMcpServerToolForChat>[2];
  issueWidgetMcpActorToken: Parameters<typeof buildLlmMcpServerToolForWidget>[2];
  /** The chat surface's self-MCP catalog state; read for a chat subject only. */
  readChatMcpCatalogState: () => Promise<ChatMcpCatalogState | undefined>;
  /**
   * Called once, for a tool-capable provider, after the skill delivery and
   * before the self-MCP reference is built. Returns the lent-action grant the
   * reference carries, or `null` when the caller stopped the turn (it has then
   * already told the person why).
   */
  admitSelfMcpReference: () => Promise<{ lentActionGrant: string | null } | null>;
};

export type AssistantTurnToolAssembly =
  | {
      kind: "assembled";
      conversationOnly: boolean;
      /** The tool array, in order, after the allow-list filter. */
      tools: LlmTool[];
      /** The provider's skill contribution to the system prompt. */
      skillSystemContext: string;
      /** The turn's delivery facts, committed by the caller at dispatch. */
      deliveryRows: TurnSkillDeliveryRow[];
      /** `"native_mcp"` exactly when the self-MCP reference is on the array. */
      selfMcpCapabilityRequired: LlmCapabilityRequirement | undefined;
      platformMcpLabel: string | undefined;
    }
  | {
      /** The delivery adapter ran and produced no vehicle: the turn refuses. */
      kind: "delivery_refused";
      /** The refusal record the caller commits before it reports the error. */
      refusalRows: TurnSkillDeliveryRow[];
    }
  | {
      /** `admitSelfMcpReference` stopped the turn. */
      kind: "stopped";
    }
  | {
      /** No self-MCP reference could be built (no public MCP URL). */
      kind: "self_mcp_unavailable";
    };

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

export async function assembleAssistantTurnTools(
  input: AssistantTurnToolAssemblyInput,
  ports: AssistantTurnToolAssemblyPorts,
): Promise<AssistantTurnToolAssembly> {
  const { provider } = input;
  const conversationOnly = isConversationOnlyProvider(provider);

  // cinatra#2091 S4 — the assistant declares its INTENT; the resolver derives
  // the members (its own required injectable set) and applies the hard cap of
  // 8 TOTAL. Resolved BEFORE the provider branch so the cap is enforced
  // IDENTICALLY on every provider, including the conversation-only (no-native-
  // MCP) branch that assembles no tools at all.
  const injectedSkills = await resolveInjectedSkillSet(
    {
      kind: "assistant",
      agentId: input.assistantAgentId,
      userId: input.userId,
      sessionId: input.sessionId,
    },
    input.injectionPorts,
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
        `skill(s) for assistant "${input.assistantAgentId}" — its required bundle of ` +
        `${input.skillIds.length} exceeds the hard cap of 8 per request: ` +
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
  let platformMcpLabel: string | undefined;
  // The provider's skill contribution to the system prompt: an availability cue
  // on a tool-mount/container provider, the EXPANDED skill bodies on an inline
  // provider. Declared out here because both branches below feed it.
  let skillSystemContext = "";
  // cinatra#2240 — the turn's DELIVERY FACTS, captured here during preparation
  // and COMMITTED by the caller at the true dispatch boundary (immediately
  // before `stream()`, or on the refusal return). Capturing and committing at
  // different points is deliberate: several paths return between delivery
  // preparation and dispatch (an unreachable public MCP URL, the
  // explicit-dispatch short circuit), and a record written at `deliver()` time
  // would claim skills reached a model they never reached.
  let deliveryRows: TurnSkillDeliveryRow[] = [];
  if (isInlineSkillMechanism(provider)) {
    // Inline mechanism (Gemini): core SHORT-CIRCUITS — no delivery adapter, no
    // connector surface. It reads each member's router body plus its ONE-HOP
    // references and merges them under the per-request byte budget, so a
    // conversation-only turn still receives the assistant's skills instead of
    // silently losing every one of them.
    const inline = await deliverInjectedSkillsInline({ set: injectedSkills });
    skillSystemContext = inline.systemContext;
    if (inline.dropped.length > 0) {
      console.warn(
        `[assistant-runtime] inline expansion dropped ${inline.dropped.length} ` +
          `whole skill(s) for assistant "${input.assistantAgentId}": ` +
          inline.dropped.map((d) => `${d.skillId} (${d.reason})`).join(", "),
      );
    }
    // The inline vehicle has no adapter and no refusal path of its own: a
    // skill that did not make the byte budget is a DROP, not a refusal, and is
    // recorded as one. Both drop channels feed the record — the injection
    // contract's cap drops and the inline expansion's whole-skill drops.
    deliveryRows = buildTurnSkillDeliveryRows({
      provider,
      requestedSkillIds: injectedSkillMembers(injectedSkills).map((m) => m.skillId),
      exposure: inline.exposure,
      contractDrops: [...injectionDrops, ...inline.dropped].map((d) => ({
        skillId: d.skillId,
        reason: d.reason,
      })),
    });
    warnOnUnclassifiedVehicles(deliveryRows, provider);
  }
  if (isNativeMcpProvider(provider)) {
    // `provider` is narrowed to "openai" | "anthropic" in this block
    // (equivalent to `!conversationOnly`), so the tool-assembly calls
    // type-check.
    //
    // SKILL DELIVERY ALWAYS RUNS (cinatra#2094 F11). There is no caller-side
    // model gate any more: the model-aware NATIVE-SHELL decision belongs to the
    // provider adapter, which already owns it. For a shell-incompatible OpenAI
    // model the adapter emits the RESTRICTED, NAMED `skill_file_read` function
    // tool instead of the hosted `shell` (exec-plane S2's singular-native-shell
    // rule, cinatra#1707) — so the 400 the old gate defended against (issue
    // #47) cannot reach the wire, and gating here only DESTROYED delivery.
    let skillTools: LlmTool[] = [];
    const catalogSkillIds = injectedCatalogSkillIds(injectedSkills);
    // cinatra#2240 — the record's DENOMINATOR is every member the injection
    // contract RESOLVED, not the catalog subset the native vehicle can carry.
    // A non-catalog member (the personal delta, always `inline`) is absent
    // from `catalogSkillIds`, and this runtime never merges a non-catalog
    // member's body into the system context on a native provider, so it is
    // recorded as a DROP naming the structural reason (finding F8).
    const resolvedMembers = injectedSkillMembers(injectedSkills);
    const resolvedSkillIds = resolvedMembers.map((m) => m.skillId);
    const nonCatalogDrops = resolvedMembers
      .filter((m) => m.deliveryMode !== "catalog")
      .map((m) => ({
        skillId: m.skillId,
        reason:
          `resolved as a "${m.deliveryMode}" member (rank "${m.rank}") — the ` +
          `${provider} native vehicle delivers catalog members only, so it ` +
          "never reached the model",
      }));
    const nativeContractDrops = [
      ...injectionDrops.map((d) => ({ skillId: d.skillId, reason: d.reason })),
      ...nonCatalogDrops,
    ];
    if (catalogSkillIds.length > 0) {
      const delivery = await selectSkillDeliveryAdapter(provider).deliver({
        skillIds: catalogSkillIds,
        // The authoritative cap already ran in the contract; the adapter's own
        // cap is a defence-in-depth invariant.
        selectionMode: "general",
      });
      skillTools = delivery.tools;
      skillSystemContext = delivery.systemContext;
      // cinatra#2240 — capture what the adapter reported it delivered (per-skill
      // mode → vehicle), the Anthropic container refs actually emitted, and
      // every resolved-but-undelivered skill with its reason.
      deliveryRows = buildTurnSkillDeliveryRows({
        provider,
        requestedSkillIds: resolvedSkillIds,
        exposure: delivery.exposure ?? [],
        tools: delivery.tools,
        contractDrops: nativeContractDrops,
        adapterDroppedSkillIds: delivery.droppedSkillIds,
        adapterSelectionReason: delivery.selectionReason,
      });
      warnOnUnclassifiedVehicles(deliveryRows, provider);
      // LOUD, never silent: the injection contract resolved skills for this
      // turn, so a delivery that produced no vehicle at all means the
      // operator's assistant is running WITHOUT its instructions. The turn is
      // refused rather than answering as a skill-less assistant.
      if (skillTools.length === 0 && !delivery.systemContext) {
        const refusalReason =
          `skill delivery produced NO vehicle for provider "${provider}" ` +
          `model "${input.defaultModel}" — the turn was refused`;
        console.error(
          `[assistant-runtime] skill delivery produced NO vehicle for provider ` +
            `"${provider}" model "${input.defaultModel}" with ` +
            `${catalogSkillIds.length} resolved skill(s) — refusing the turn ` +
            "(a silently skill-less assistant is never an acceptable degrade)",
        );
        // The refusal is NOT the whole story: a skill the injection contract or
        // the adapter had ALREADY dropped was never part of the delivery
        // attempt, so it keeps its own drop reason rather than being
        // relabelled "refused" (or losing its row entirely — finding F8).
        return {
          kind: "delivery_refused",
          refusalRows: buildTurnSkillDeliveryRows({
            provider,
            requestedSkillIds: resolvedSkillIds,
            exposure: [],
            contractDrops: nativeContractDrops,
            adapterDroppedSkillIds: delivery.droppedSkillIds,
            adapterSelectionReason: delivery.selectionReason,
            refusalReason,
          }),
        };
      }
    } else if (nativeContractDrops.length > 0 || resolvedSkillIds.length > 0) {
      // NO catalog member survived to the native vehicle, but the injection
      // contract DID resolve skills for this turn — non-catalog members, or
      // members it dropped at the cap. No delivery adapter runs, so nothing
      // reaches the model; the loss is recorded as a set of DROPS, never a
      // refusal (the loud refusal is specifically "the adapter ran and
      // produced no vehicle", which did not happen here).
      deliveryRows = buildTurnSkillDeliveryRows({
        provider,
        requestedSkillIds: resolvedSkillIds,
        exposure: [],
        contractDrops: nativeContractDrops,
      });
    }

    // The caller's step between the delivery and the self-MCP reference: on a
    // turn, the dead-ingress probe (#1699) and the lent-action grant
    // (cinatra#2932). `null` means the caller stopped the turn.
    const admitted = await ports.admitSelfMcpReference();
    if (!admitted) return { kind: "stopped" };

    // The self-MCP reference carries the token the issuer port returns: the
    // widget OBO token when a widget principal is present, the chat OBO token
    // otherwise. A mint/build failure returns null on BOTH paths and the
    // caller answers with the same fail-closed error.
    const chatCinatraMcpTool =
      input.selfMcp.kind === "widget"
        ? await buildLlmMcpServerToolForWidget(
            provider,
            input.selfMcp.actor,
            ports.issueWidgetMcpActorToken,
            // cinatra#2932 — the widget is on the same road; it carries the
            // grant exactly as the chat page does.
            { lentActionGrant: admitted.lentActionGrant },
          )
        : await buildLlmMcpServerToolForChat(
            provider,
            input.selfMcp.actor,
            ports.issueChatMcpActorToken,
            {
              catalogState: await ports.readChatMcpCatalogState(),
              // cinatra#2932 — this turn's lent-action grant, or null.
              lentActionGrant: admitted.lentActionGrant,
            },
          );
    if (!chatCinatraMcpTool) return { kind: "self_mcp_unavailable" };
    // cinatra#2776 (owner ruling 2026-08-15). The self-MCP catalog is now on
    // this turn's tool array, and the ONLY shape in which it may reach a model
    // is ONE provider-hosted MCP reference. Pinning `native_mcp` makes that a
    // CONTRACT the adapter must satisfy: an adapter whose native path is
    // unavailable must REFUSE the turn before any credential-bearing egress
    // instead of flattening the catalog into inline function schemas
    // (cinatra#2771). Both chat surfaces pin it, because both hand over the
    // same toolbox: the cookie-session browser chat and the widget principal's
    // turn.
    selfMcpCapabilityRequired = "native_mcp";
    platformMcpLabel = chatCinatraMcpTool.serverLabel;

    // cinatra#2019 S4: cookie-chat and widget-principal turns share this
    // external-tool assembly, so the build context carries the REAL surface —
    // surface-gating toolboxes (trusted-site native read-injection) emit only
    // for "chat" and refuse widget builds fail-closed instead of leaking
    // chat-scoped injections onto public-site widget turns.
    const externalMcpTools = await resolveChatExternalMcpTools(
      provider,
      input.selfMcp.kind === "widget" ? { surface: "public_site_widget" } : { surface: "chat" },
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
    // non-empty list keeps only its members; MCP server tools (which expose
    // many primitives behind one `type: "mcp"` entry) and provider-native tools
    // carry no filterable `name`, so they are unaffected by name-level
    // allow-listing at this layer (per-primitive gating is an MCP-layer concern
    // for a later slice).
    tools = assembledTools.filter((tool) => {
      const name = (tool as { name?: string }).name;
      if (typeof name !== "string") return true;
      return isAllowedByList(name, input.allowedTools);
    });
  } // end !conversationOnly tool assembly

  return {
    kind: "assembled",
    conversationOnly,
    tools,
    skillSystemContext,
    deliveryRows,
    selfMcpCapabilityRequired,
    platformMcpLabel,
  };
}

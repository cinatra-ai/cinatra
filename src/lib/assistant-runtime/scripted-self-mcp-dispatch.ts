import "server-only";

import { randomUUID } from "node:crypto";

import { getLocalMcpServerUrl } from "@cinatra-ai/mcp-server/credentials";
import type { ScriptedSelfMcpDispatch } from "@cinatra-ai/llm/scripted-test-provider";

import { issueChatMcpActorToken } from "@/lib/chat-mcp-actor-token";
import { issueWidgetMcpActorToken } from "@/lib/widget-mcp-actor-token";
import type { WidgetPrincipal } from "./widget-principal";

// ---------------------------------------------------------------------------
// The scripted widget turn's REAL self-MCP dispatcher (cinatra#2683, epic #2564
// S8f — the parity proof).
//
// WHY IT EXISTS. The deterministic UAT app carries no provider credentials, so
// `runAssistantTurn` short-circuits to the scripted provider BEFORE it assembles
// the native-MCP tool array — which is the whole point of that short-circuit
// (cinatra#1919 AC3). The consequence, until now, was that the widget's scripted
// turn could reach NO cinatra primitive at all: the model layer was stood in
// for, and the tool layer went with it. A lifecycle card therefore had no
// producer on this path, and the only way to put one on screen would have been
// for the provider to invent the envelope — which the sink correctly refuses,
// and which would have been a fabricated proof besides.
//
// WHAT THIS RESTORES, AND EXACTLY THAT. The tool layer, real. The provider names
// a primitive and its arguments — the ONE decision a real model makes here — and
// this module performs the call against the REAL self-MCP server over the REAL
// transport, carrying a REAL `cinatra.widget.mcp-obo` token minted from the
// route's SERVER-VERIFIED principal. Everything downstream is the shipped path,
// untouched: the transport's token verification, the CLOSED kind-keyed
// `delegated-widget` tool policy, the handler's own caller resolution, the S8a
// live-standing actor, `enforceReviewRunAccess` per row, the S1 authorization
// ladder, and `buildLifecycleViewEnvelope` in the producer. The envelope is
// minted THERE or not at all.
//
// THE PROVENANCE THE SINK CHECKS IS RECORDED HERE, NOT CLAIMED BY THE PROVIDER.
// Every string a real dispatch returns is reported through `onDispatched`, and
// the caller stamps the reserved `cinatra` server label on exactly those results
// and no others. So the provider's OWN compositions — the content-editor
// stand-in, or a hypothetical invented envelope — reach the sink unlabelled and
// `recognizeLifecycleViewEnvelope` refuses them. The anti-fabrication property is
// structural, not a promise: this provider cannot put a lifecycle card on screen,
// only the producer can.
//
// BOTH SURFACES, ONE TRANSPORT. The parity proof owes a comparison view, so the
// cookie-session `/chat` turn reaches the same primitives through the same
// transport — with the SHIPPED chat bearer instead of the widget's OBO grant, and
// therefore under the delegated-CHAT tool policy instead of the closed
// kind-keyed widget one. Which identity a turn carries is decided by the factory
// the runtime picks (`…ForWidget` / `…ForChat`, mirroring the real tool-assembly
// seam) and verified at the transport; the dispatch itself knows only a bearer.
//
// TEST-ONLY REACHABILITY. Constructed only inside the scripted-provider branch,
// which `assertScriptedProviderNotProduction` already fences to an explicit
// development runtime. Production never builds either dispatcher.
// ---------------------------------------------------------------------------

/** The MCP route this app mounts its self-MCP server at. */
const MCP_BASE_PATH = "/api/mcp";

/** The protocol revision to negotiate. The server accepts the current set; a
 *  mismatch surfaces as a loud initialize error rather than a silent no-card. */
const MCP_PROTOCOL_VERSION = "2025-06-18";

/**
 * Bound ONE tool call. By the time a call is made the route is compiled and
 * every request is served from memory — measured at 15-25 ms on the host2 UAT
 * stack — so this is a wedged-transport bound, not a budget anything normal has
 * to fit inside.
 */
export const SELF_MCP_CALL_TIMEOUT_MS = 30_000;

/**
 * Bound the HANDSHAKE, which is a DIFFERENT KIND OF WAIT and is why it has its
 * own constant (cinatra#2683).
 *
 * `initialize` is this process's FIRST request to `/api/mcp`, and under the
 * Next dev server the UAT stack runs, that request pays the route's ON-DEMAND
 * COMPILE — the whole self-MCP surface plus every extension module it registers.
 * Measured on the host2 UAT stack at this branch: 19.2 s for a cold
 * `initialize`, 15-25 ms for every one after it. A single 20 s budget therefore
 * sat one second inside the cold cost on an IDLE machine, and the widget turn is
 * never the only thing compiling — the same stack served a sibling route in 41 s
 * while other routes compiled beside it.
 *
 * What that cost, exactly: the handshake aborted, the dispatcher threw, the
 * provider degraded to its plain reply, and the widget's lifecycle question
 * answered with prose and NO CARD — indistinguishable, on screen, from "nothing
 * is waiting for you". The proof lane read it as a refusal in the producer and
 * spent a wave there. So the budget is now sized for the compile, and the
 * failure is LOGGED (below) instead of only being thrown into a catch.
 *
 * WHAT IT DOES COST, STATED: a server that accepts the connection and then never
 * answers `initialize` now holds this dispatch for two minutes instead of
 * twenty seconds. That is the honest price of covering a compile that is
 * measured in tens of seconds, and it is bounded to the ONE request that can
 * pay a compile — the notification after it, and every tool call, keep the
 * short budget.
 */
export const SELF_MCP_HANDSHAKE_TIMEOUT_MS = 120_000;

type JsonRpcResponse = {
  result?: unknown;
  error?: { code?: number; message?: string };
};

/**
 * Read one JSON-RPC response out of a streamable-HTTP reply. The server answers
 * either `application/json` or an SSE frame sequence depending on negotiation,
 * so both are accepted — the payload is identical.
 */
async function readJsonRpc(response: Response): Promise<JsonRpcResponse> {
  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text();
  if (contentType.includes("text/event-stream")) {
    for (const line of body.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      try {
        return JSON.parse(payload) as JsonRpcResponse;
      } catch {
        // keep scanning: a non-JSON data line is a keepalive, not the answer
      }
    }
    throw new Error("self-MCP dispatch: no JSON-RPC frame in the SSE reply");
  }
  return JSON.parse(body) as JsonRpcResponse;
}

/** The tool result's TEXT content — the exact string the producer returned, which
 *  for a minting primitive IS the S1 envelope byte for byte. */
function toolResultText(result: unknown): string {
  if (typeof result !== "object" || result === null) {
    throw new Error("self-MCP dispatch: tool result was not an object");
  }
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    throw new Error("self-MCP dispatch: tool result carried no content array");
  }
  const texts: string[] = [];
  for (const part of content) {
    if (
      typeof part === "object" &&
      part !== null &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
    ) {
      texts.push((part as { text: string }).text);
    }
  }
  if (texts.length === 0) {
    throw new Error("self-MCP dispatch: tool result carried no text content");
  }
  return texts.join("");
}

/**
 * Called with the EXACT result string every real dispatch returned. The caller
 * uses it to decide which emitted tool_result has earned the reserved `cinatra`
 * producer label — provenance recorded by the frame that performed the call,
 * never claimed by the provider that consumed it.
 */
type OnDispatched = (resultText: string) => void;

/**
 * The transport half, shared by both surfaces (cinatra#2683). It takes a BEARER
 * and nothing else: which identity that bearer carries — a widget's OBO grant or
 * the chat session's own delegated token — is decided by the caller below and
 * verified by the MCP transport, which applies the matching delegated tool policy.
 * Sharing the transport is deliberate: one place to be right about the handshake,
 * the SSE/JSON reply shapes, the timeout and the provenance callback, and no
 * second copy to drift into a wider one.
 */
function createDispatchWithBearer(params: {
  token: string;
  /** Names the surface in the MCP `clientInfo` — visible in transport logs. */
  clientName: string;
  onDispatched?: OnDispatched;
  /**
   * The two budgets, overridable so the transport suite can drive both of them
   * inside a test's own runtime. Production never passes it; the defaults are
   * the shipped values and the suite pins them separately.
   */
  timeouts?: { handshakeMs: number; callMs: number };
}): ScriptedSelfMcpDispatch {
  const { token, clientName, onDispatched } = params;
  const handshakeMs = params.timeouts?.handshakeMs ?? SELF_MCP_HANDSHAKE_TIMEOUT_MS;
  const callMs = params.timeouts?.callMs ?? SELF_MCP_CALL_TIMEOUT_MS;
  const mcpUrl = getLocalMcpServerUrl(MCP_BASE_PATH);

  let sessionId: string | null = null;
  let rpcId = 0;

  async function rpc(
    method: string,
    params: Record<string, unknown> | undefined,
    {
      notification = false,
      timeoutMs = callMs,
    }: { notification?: boolean; timeoutMs?: number } = {},
  ): Promise<JsonRpcResponse> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
    };
    if (sessionId) headers["Mcp-Session-Id"] = sessionId;
    const response = await fetch(mcpUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        ...(notification ? {} : { id: ++rpcId }),
        method,
        ...(params ? { params } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const negotiated = response.headers.get("mcp-session-id");
    if (negotiated) sessionId = negotiated;
    if (notification) {
      // 202/204 carry no body; anything else is drained and ignored.
      void response.text().catch(() => "");
      return {};
    }
    if (!response.ok) {
      throw new Error(
        `self-MCP dispatch: ${method} answered HTTP ${response.status}`,
      );
    }
    const parsed = await readJsonRpc(response);
    if (parsed.error) {
      throw new Error(
        `self-MCP dispatch: ${method} answered JSON-RPC error ` +
          `${parsed.error.code ?? "?"} ${parsed.error.message ?? ""}`.trim(),
      );
    }
    return parsed;
  }

  let handshake: Promise<void> | null = null;
  async function ensureHandshake(): Promise<void> {
    handshake ??= (async () => {
      await rpc(
        "initialize",
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: clientName, version: "1.0.0" },
        },
        // The cold-compile budget — see SELF_MCP_HANDSHAKE_TIMEOUT_MS.
        { timeoutMs: handshakeMs },
      );
      // The CALL budget, deliberately: only `initialize` can pay the compile,
      // and by the time this notification is sent the route is warm. Giving it
      // the cold budget too would make the handshake's worst case the sum of
      // both, and would let a wedged server hold the turn for twice as long as
      // the one wait that has a reason to be long.
      await rpc("notifications/initialized", undefined, { notification: true });
    })();
    await handshake;
  }

  return async (call) => {
    // SAY WHAT FAILED, WHERE (cinatra#2683). The provider degrades a throwing
    // dispatch to its plain reply — correctly, because a card it invented would
    // be a fabricated proof — and that degradation is SILENT on screen: a turn
    // whose transport never answered looks exactly like a turn with nothing to
    // show. One line here is the difference between reading the failure and
    // inferring it from an absent card.
    try {
      await ensureHandshake();
      const answer = await rpc("tools/call", {
        name: call.name,
        arguments: call.args,
      });
      const text = toolResultText(answer.result);
      onDispatched?.(text);
      return text;
    } catch (err) {
      console.error(
        `[scripted-self-mcp] ${clientName}: ${call.name} did not complete against ${mcpUrl} — ` +
          `${err instanceof Error ? err.message : String(err)}. The turn keeps its text and mints no card.`,
      );
      throw err;
    }
  };
}

/**
 * Build the dispatcher for ONE widget turn.
 *
 * The OBO token is minted once per turn and carries the turn's own `jti`, the
 * server-derived instance pin, the bound connector kind and — only when the
 * consumed `cwu_` genuinely granted it — the `lcr` lifecycle-read claim. Those
 * are the principal's values, read off the same object the real path mints from;
 * nothing here can widen them.
 *
 * IT MINTS THE SAME SEALED TOKEN THE PRODUCTION MINT DOES (cinatra#2687). The
 * shipped mint in `runtime.ts` seals the token to two things it cannot outlive —
 * `pjti`, the `cwu_` row the turn authenticated against, and `run`, the AG-UI run
 * id of the turn minting it — and the MCP authorization layer now REFUSES a token
 * carrying neither. A scripted dispatcher that omitted them would not be a
 * weaker proof, it would be a DEAD one: every call would 401 at the transport
 * and the turn would degrade to prose with no card, which on screen is
 * indistinguishable from "nothing is waiting for you" (the exact failure mode
 * SELF_MCP_HANDSHAKE_TIMEOUT_MS exists to stop being silent about).
 *
 * So both seals are REQUIRED inputs here, and both come from the caller rather
 * than from anything this module can invent: `parentJti` off the server-verified
 * principal, `turnRunId` off the harness-bound turn identity. That is the same
 * pair, read off the same two objects, that the production mint uses — which is
 * the property the proof depends on: this path is the shipped credential, not a
 * test-shaped relative of it.
 */
export function createScriptedSelfMcpDispatch(params: {
  widgetPrincipal: WidgetPrincipal;
  /**
   * The AG-UI run id of the turn being served (cinatra#2687's `run` seal). Taken
   * from the runtime's own `turnIdentity`, never derived here — the token must
   * name the turn whose `assistant_turns` row the authorization layer reads, and
   * a run id this module made up would name no row and be refused.
   */
  turnRunId: string;
  onDispatched?: OnDispatched;
  /** Transport-suite only; production takes the shipped budgets. */
  timeouts?: { handshakeMs: number; callMs: number };
}): ScriptedSelfMcpDispatch {
  const { widgetPrincipal, turnRunId, onDispatched } = params;
  return createDispatchWithBearer({
    token: issueWidgetMcpActorToken({
      userId: widgetPrincipal.userId,
      orgId: widgetPrincipal.orgId,
      instanceId: widgetPrincipal.instanceId,
      kind: widgetPrincipal.assistantHandle,
      jti: randomUUID(),
      // The two seals (cinatra#2687), byte-for-byte the pair `runtime.ts` mints
      // on the production path: the principal's parent `cwu_` row, and THIS
      // turn's run id.
      parentJti: widgetPrincipal.parentTokenJti,
      turnRunId,
      lifecycleRead: widgetPrincipal.lifecycleRead,
    }),
    clientName: "cinatra-scripted-widget-turn",
    onDispatched,
    ...(params.timeouts ? { timeouts: params.timeouts } : {}),
  });
}

/**
 * Build the dispatcher for ONE COOKIE-SESSION `/chat` turn (cinatra#2683).
 *
 * The comparison view the parity proof owes: the same primitive, called from the
 * first-party surface, so the two conversations can be read side by side. It
 * mints the SHIPPED chat bearer — `issueChatMcpActorToken`, the exact token the
 * real chat turn's `type: "mcp"` tool carries — from the route's own session
 * values, which is the whole reason this stays a thin wrapper: the identity is
 * the session's, the ceiling is the delegated-CHAT tool policy's, and this frame
 * adds nothing to either. It cannot widen them: it holds no claim of its own and
 * passes the caller's `userId` / `orgId` / `platformRole` straight through.
 *
 * TEST-ONLY REACHABILITY, same as its widget twin: constructed only inside the
 * scripted-provider branch, which `assertScriptedProviderNotProduction` fences to
 * an explicit development runtime.
 */
export function createScriptedChatSelfMcpDispatch(params: {
  /** The signed-in human this turn runs as — the session's own user. */
  userId: string;
  /** The session's active org, or null when the session carries none. */
  orgId: string | null;
  /** The session's platform role, unfloored and uninvented. */
  platformRole: "platform_admin" | "member";
  onDispatched?: OnDispatched;
}): ScriptedSelfMcpDispatch {
  const { userId, orgId, platformRole, onDispatched } = params;
  return createDispatchWithBearer({
    token: issueChatMcpActorToken({
      delegation: "chat",
      userId,
      orgId,
      platformRole,
    }),
    clientName: "cinatra-scripted-chat-turn",
    onDispatched,
  });
}

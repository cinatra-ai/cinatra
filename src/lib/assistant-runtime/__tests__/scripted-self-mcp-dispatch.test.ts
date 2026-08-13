// ---------------------------------------------------------------------------
// THE SCRIPTED TURN'S TRANSPORT, OVER REAL HTTP (cinatra#2683, epic #2564 S8f).
// ---------------------------------------------------------------------------
// The provider-level suite next door proves the SEQUENCE (list, then render,
// results forwarded verbatim) against an injected dispatcher. This file proves
// the half that suite stands in for: the dispatcher itself, talking to a real
// HTTP server over the real streamable-HTTP framing, carrying the real minted
// bearer.
//
// IT EXISTS BECAUSE THE MISSING CARD WAS HERE, NOT IN THE PRODUCER. On the
// rebuilt host2 UAT stack the widget's lifecycle question answered with prose
// and no card, and the recorded turn showed a LIST call with no result and no
// RENDER. The producer was fine: the FIRST request to `/api/mcp` pays that
// route's on-demand compile under the Next dev server, measured at 19.2 s cold
// against 15-25 ms warm, and the dispatcher bounded every request — handshake
// included — at 20 s. The handshake aborted, the dispatcher threw, and the
// provider degraded to its plain reply, which on screen is indistinguishable
// from "nothing is waiting for you".
//
// So the two checks that matter here are: the handshake gets a budget of its own
// (and a slow one still completes), and the bearer the mint actually puts on the
// wire satisfies the SHIPPED verifier — including the `lcr` grant claim, which is
// the thing a missing card would otherwise be blamed on. The stub is not the
// transport and admits any bearer, so nothing here claims a boundary ADMITTED
// the token; `s5-widget-obo-integration.test.ts` is where that side lives.
// ---------------------------------------------------------------------------

import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-scripted-self-mcp-dispatch";

import { runScriptedWidgetAssistantTurn } from "@cinatra-ai/llm/scripted-test-provider";

import { verifyWidgetMcpActorToken } from "@/lib/widget-mcp-actor-token";
import type { WidgetPrincipal } from "../widget-principal";
import {
  createScriptedSelfMcpDispatch,
  SELF_MCP_CALL_TIMEOUT_MS,
  SELF_MCP_HANDSHAKE_TIMEOUT_MS,
} from "../scripted-self-mcp-dispatch";

const WIDGET_PRINCIPAL: WidgetPrincipal = {
  kind: "public_site_widget",
  userId: "u-widget-reader",
  orgId: "org-widget",
  /** The `cwu_` row this turn authenticated against — #2687's `pjti` seal. */
  parentTokenJti: "cwu-row-of-this-signin",
  instanceId: "inst-canonical",
  verifiedOrigin: "https://blog.example.com",
  assistantHandle: "wordpress",
  instancesConfigKey: "wordpress",
  lifecycleRead: true,
  /**
   * The reader's REAL platform tier (cinatra#2674, epic #2564 S8e). REQUIRED on
   * the principal since the widget floor ended, deliberately: a construction
   * site has to answer the question rather than inherit an answer. This fixture
   * is an ORDINARY member, which is also the narrow case — the elevated one is
   * asserted in the platform-parity suites, not by re-running this dispatch.
   */
  platformRole: "member",
};

/** The AG-UI run id of the turn under test — #2687's `run` seal. */
const TURN_RUN_ID = "run-of-this-scripted-turn";

/** One recorded JSON-RPC request: the method, its params, and its bearer. */
type Recorded = { method: string; params: Record<string, unknown>; authorization: string };

type StubOptions = {
  /** Delay the `initialize` reply by this long — the cold-compile stand-in. */
  initializeDelayMs?: number;
  /** The text each named tool answers with. */
  toolResults?: Record<string, string>;
};

/**
 * A self-MCP server reduced to what this transport actually depends on: the
 * JSON-RPC envelope, a session id, and a tool result carrying text content.
 * It records every request so the checks can read what was really sent.
 */
function startStubMcpServer(options: StubOptions = {}): Promise<{
  origin: string;
  recorded: Recorded[];
  close: () => Promise<void>;
}> {
  const recorded: Recorded[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
      };
      recorded.push({
        method: body.method ?? "",
        params: body.params ?? {},
        authorization: String(req.headers.authorization ?? ""),
      });
      const reply = (payload: unknown) => {
        res.writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": "session-1",
        });
        res.end(JSON.stringify(payload));
      };
      if (body.method === "initialize") {
        const send = () =>
          reply({
            jsonrpc: "2.0",
            id: body.id,
            result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: {} },
          });
        if (options.initializeDelayMs) setTimeout(send, options.initializeDelayMs);
        else send();
        return;
      }
      if (body.method === "notifications/initialized") {
        res.writeHead(202).end();
        return;
      }
      if (body.method === "tools/call") {
        const name = String((body.params as { name?: unknown } | undefined)?.name ?? "");
        const text = options.toolResults?.[name] ?? "{}";
        reply({
          jsonrpc: "2.0",
          id: body.id,
          result: { content: [{ type: "text", text }] },
        });
        return;
      }
      res.writeHead(404).end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        recorded,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

let stub: Awaited<ReturnType<typeof startStubMcpServer>> | null = null;
const originalAuthUrl = process.env.BETTER_AUTH_URL;

beforeEach(() => {
  stub = null;
});
afterEach(async () => {
  await stub?.close();
  stub = null;
  if (originalAuthUrl === undefined) delete process.env.BETTER_AUTH_URL;
  else process.env.BETTER_AUTH_URL = originalAuthUrl;
});

/** Point the dispatcher's local-MCP URL at the stub (read at construction). */
async function withStub(options: StubOptions = {}) {
  stub = await startStubMcpServer(options);
  process.env.BETTER_AUTH_URL = stub.origin;
  return stub;
}

describe("the scripted turn's self-MCP transport", () => {
  it("THE COLD ROUTE: a handshake slower than the per-CALL budget still completes the dispatch", async () => {
    // The defect, in miniature. `initialize` answers after a delay that exceeds
    // the per-call budget the tool call runs under; the dispatch must still
    // return the tool's result, because the handshake is bounded by its OWN
    // budget. Under the single budget this replaces, this call threw.
    const server = await withStub({
      initializeDelayMs: 120,
      toolResults: { artifact_review_gates_list: '{"refs":["ref-1"]}' },
    });
    const dispatch = createScriptedSelfMcpDispatch({
      widgetPrincipal: WIDGET_PRINCIPAL,
      turnRunId: TURN_RUN_ID,
      timeouts: { handshakeMs: 2_000, callMs: 60 },
    });
    await expect(
      dispatch({ name: "artifact_review_gates_list", args: {} }),
    ).resolves.toBe('{"refs":["ref-1"]}');
    expect(server.recorded.map((r) => r.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
  });

  it("the two budgets are separate, and the handshake's covers a cold route compile", () => {
    // Measured on the host2 UAT stack at this branch: 19.2 s for the first
    // `/api/mcp` request, 15-25 ms for every one after it — and a sibling route
    // on the same stack took 41 s while other routes compiled beside it. The
    // floor is that measurement plus room for a loaded machine; the ordering is
    // the property that a single shared budget cannot express.
    expect(SELF_MCP_HANDSHAKE_TIMEOUT_MS).toBeGreaterThan(SELF_MCP_CALL_TIMEOUT_MS);
    expect(SELF_MCP_HANDSHAKE_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000);
  });

  // WHAT THIS CAN AND CANNOT SAY. The stub is not the transport: it accepts any
  // bearer, so nothing here proves the boundary ADMITTED this token. What it
  // proves is the half that was in doubt — that the bearer the dispatch actually
  // put on the wire satisfies the shipped verifier, claims and all, against the
  // audience and issuer derived from the URL it posted to. A mint that dropped
  // the grant, or aimed at a different origin, fails this.
  it("THE GRANT IS ON THE WIRE: the bearer the dispatch sent satisfies the shipped verifier, carrying `lcr`", async () => {
    const server = await withStub({
      toolResults: { artifact_review_gates_list: '{"refs":[]}' },
    });
    const dispatch = createScriptedSelfMcpDispatch({
      widgetPrincipal: WIDGET_PRINCIPAL,
      turnRunId: TURN_RUN_ID,
    });
    await dispatch({ name: "artifact_review_gates_list", args: {} });

    const authorization = server.recorded[0]?.authorization ?? "";
    expect(authorization.startsWith("Bearer ")).toBe(true);
    // Verified the way the transport verifies it — same audience, same issuer,
    // both derived from the URL this dispatch actually posted to.
    const actor = verifyWidgetMcpActorToken({
      authHeader: authorization,
      request: new Request(`${server.origin}/api/mcp`),
      expectedAudience: `${server.origin}/api/mcp`,
      expectedIssuer: `${server.origin}/api/auth`,
    });
    expect(actor).not.toBeNull();
    expect(actor?.delegation).toBe("public_site_widget");
    // The transport derives BOTH from this request's own origin and compares
    // them exactly, so a token minted for another origin verifies to null here.
    expect(actor?.userId).toBe(WIDGET_PRINCIPAL.userId);
    expect(actor?.orgId).toBe(WIDGET_PRINCIPAL.orgId);
    expect(actor?.instanceId).toBe(WIDGET_PRINCIPAL.instanceId);
    expect(actor?.kind).toBe("wordpress");
    // The claim the pull's widget branch reads as the grant. A principal WITHOUT
    // it mints no claim, and the negative control below is that reading.
    expect(actor?.lifecycleRead).toBe(true);
  });

  // THE SEALS ARE ON THE WIRE TOO (cinatra#2687).
  //
  // The verifier above already refuses a token carrying neither seal — `pjti`
  // and `run` are REQUIRED and fail-closed there — so `actor !== null` in the
  // previous test is itself the proof that this mint seals SOMETHING. What that
  // cannot say is WHICH values, and the values are the whole property: a seal
  // pointing at a row that is not this sign-in, or a run that is not this turn,
  // would verify perfectly and then be refused one layer down by the
  // authorization leaf, which reads the seals to ask whether the sign-in is
  // still there and the turn still running. So the two claims are pinned to the
  // two objects they must come from.
  it("THE SEALS ARE ON THE WIRE: `pjti` is the principal's parent row and `run` is THIS turn", async () => {
    const server = await withStub({
      toolResults: { artifact_review_gates_list: '{"refs":[]}' },
    });
    const dispatch = createScriptedSelfMcpDispatch({
      widgetPrincipal: WIDGET_PRINCIPAL,
      turnRunId: TURN_RUN_ID,
    });
    await dispatch({ name: "artifact_review_gates_list", args: {} });

    const actor = verifyWidgetMcpActorToken({
      authHeader: server.recorded[0]?.authorization ?? "",
      request: new Request(`${server.origin}/api/mcp`),
      expectedAudience: `${server.origin}/api/mcp`,
      expectedIssuer: `${server.origin}/api/auth`,
    });
    expect(actor?.parentJti).toBe(WIDGET_PRINCIPAL.parentTokenJti);
    expect(actor?.turnRunId).toBe(TURN_RUN_ID);
    // The per-turn nonce stays a fresh audit handle and is NOT either seal —
    // mistaking the nonce for the binding is the defect #2687 closed.
    expect(actor?.jti).not.toBe(TURN_RUN_ID);
    expect(actor?.jti).not.toBe(WIDGET_PRINCIPAL.parentTokenJti);
  });

  // NEGATIVE CONTROL FOR THE SEALS, run rather than asserted. Strip either seal
  // from the minted token and re-verify: the SHIPPED verifier refuses it. That
  // is what an unsealed scripted dispatch would have put on the wire, and it is
  // why the seals are required inputs here instead of optional ones — the turn
  // would not have been weaker, it would have 401'd every call and photographed
  // an empty panel.
  it("STRIPPING EITHER SEAL makes the shipped verifier refuse the very same token", async () => {
    const server = await withStub({
      toolResults: { artifact_review_gates_list: '{"refs":[]}' },
    });
    const dispatch = createScriptedSelfMcpDispatch({
      widgetPrincipal: WIDGET_PRINCIPAL,
      turnRunId: TURN_RUN_ID,
    });
    await dispatch({ name: "artifact_review_gates_list", args: {} });
    const sent = (server.recorded[0]?.authorization ?? "").replace(/^Bearer\s+/, "");

    const verifyAs = (token: string) =>
      verifyWidgetMcpActorToken({
        authHeader: `Bearer ${token}`,
        request: new Request(`${server.origin}/api/mcp`),
        expectedAudience: `${server.origin}/api/mcp`,
        expectedIssuer: `${server.origin}/api/auth`,
      });

    // POSITIVE CONTROL: the untouched token verifies, so a refusal below is
    // attributable to the dropped claim and to nothing else.
    expect(verifyAs(sent)).not.toBeNull();

    // Re-sign the payload without each seal, using the same secret the mint
    // used — the signature is valid, only the claim is gone.
    const [header, payload] = sent.split(".");
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
    const resign = (next: Record<string, unknown>) => {
      const encoded = Buffer.from(JSON.stringify(next), "utf8").toString("base64url");
      const signingInput = `${header}.${encoded}`;
      const signature = createHmac("sha256", process.env.BETTER_AUTH_SECRET!)
        .update(signingInput)
        .digest("base64url");
      return `${signingInput}.${signature}`;
    };
    const { pjti: _noParent, ...withoutParent } = claims;
    const { run: _noRun, ...withoutRun } = claims;
    expect(verifyAs(resign(withoutParent))).toBeNull();
    expect(verifyAs(resign(withoutRun))).toBeNull();
  });

  it("A PRINCIPAL WITHOUT CONSENT MINTS NO GRANT — the verifier reads no `lcr`", async () => {
    const server = await withStub({
      toolResults: { artifact_review_gates_list: '{"refs":[]}' },
    });
    const dispatch = createScriptedSelfMcpDispatch({
      widgetPrincipal: { ...WIDGET_PRINCIPAL, lifecycleRead: false },
      turnRunId: TURN_RUN_ID,
    });
    await dispatch({ name: "artifact_review_gates_list", args: {} });
    const actor = verifyWidgetMcpActorToken({
      authHeader: server.recorded[0]?.authorization ?? "",
      request: new Request(`${server.origin}/api/mcp`),
      expectedAudience: `${server.origin}/api/mcp`,
      expectedIssuer: `${server.origin}/api/auth`,
    });
    expect(actor?.lifecycleRead).toBe(false);
  });

  it("THE WHOLE TURN: a widget lifecycle question LISTS with refs and then RENDERS one", async () => {
    // End to end through the real provider and the real transport: the answer to
    // the list carries a ref, so the turn makes a SECOND dispatch — the render —
    // with that exact ref. This is the shape whose absence was the missing card.
    const server = await withStub({
      toolResults: {
        artifact_review_gates_list: '{"refs":["ref-abc"]}',
        artifact_review_gate_render:
          '{"$cinatraLifecycleView":1,"viewType":"artifact_review_gate","ref":"ref-abc"}',
      },
    });
    const dispatched: string[] = [];
    const dispatch = createScriptedSelfMcpDispatch({
      widgetPrincipal: WIDGET_PRINCIPAL,
      turnRunId: TURN_RUN_ID,
      onDispatched: (text) => dispatched.push(text),
    });
    const toolCalls: string[] = [];
    const results: { name: string; result: string }[] = [];
    await runScriptedWidgetAssistantTurn({
      instructions: "which reviews are waiting for me?",
      assistantHandle: "wordpress",
      callSelfMcpTool: dispatch,
      onText: () => {},
      onToolCall: (c) => toolCalls.push(c.name),
      onToolResult: (r) => results.push({ name: r.name, result: r.result }),
    });

    expect(toolCalls).toEqual([
      "artifact_review_gates_list",
      "artifact_review_gate_render",
    ]);
    expect(results.map((r) => r.name)).toEqual([
      "artifact_review_gates_list",
      "artifact_review_gate_render",
    ]);
    // The render was called with the ref the LIST answered with — not one the
    // provider composed.
    const renderCall = server.recorded.find(
      (r) =>
        r.method === "tools/call" &&
        (r.params as { name?: string }).name === "artifact_review_gate_render",
    );
    expect((renderCall?.params as { arguments?: { ref?: string } })?.arguments?.ref).toBe(
      "ref-abc",
    );
    // Provenance: both results came back from the dispatcher, so both are
    // eligible for the reserved producer label the runtime stamps.
    expect(dispatched).toEqual(results.map((r) => r.result));
  });
});

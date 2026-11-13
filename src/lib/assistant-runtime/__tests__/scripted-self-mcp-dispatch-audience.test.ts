// ---------------------------------------------------------------------------
// THE SCRIPTED DISPATCH SIGNS FOR THE URL IT CALLS.
// ---------------------------------------------------------------------------
// The scripted self-MCP dispatcher posts to the LOCAL MCP URL
// (`getLocalMcpServerUrl`). The chat and widget OBO mints take their audience
// from `getPublicMcpServerUrl()` when an MCP public base URL is stored. The MCP
// transport binds a delegated token to THIS request's own origin, exactly. So on
// a boot whose stored public base URL names another origin than the local one,
// the scripted call answered 401 at `initialize`, the dispatcher threw, and the
// turn started no run and drew no card.
//
// `fetch` sends the WHATWG canonical form of the URL it is given (lowercase
// scheme and host, no explicit default port), and the transport derives its
// expected audience from that request. So the token must name the canonical
// URL too: a local base URL spelt `HTTP://LOCALHOST:3060` or
// `http://localhost:80` must not bring the 401 back.
//
// The stub below answers the way the transport does: it derives the expected
// audience and issuer from its OWN origin and runs the SHIPPED verifier over
// the bearer; a token that fails it gets 401. A public base URL is stored for
// the whole file. The dispatch must still resolve, for both surfaces. The
// real-model mint (no override) keeps the public audience: the hosted MCP relay
// calls the public URL, and that path is unchanged.
// ---------------------------------------------------------------------------

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const originalSecret = process.env.BETTER_AUTH_SECRET;
process.env.BETTER_AUTH_SECRET ??= "test-secret-for-scripted-self-mcp-audience";

const PUBLIC_MCP_URL = "https://pub.example/api/mcp";

vi.mock("@cinatra-ai/mcp-server/credentials", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cinatra-ai/mcp-server/credentials")>();
  return {
    ...actual,
    // A public base URL is stored (`https://pub.example`).
    getPublicMcpServerUrl: () => PUBLIC_MCP_URL,
  };
});

import { issueChatMcpActorToken, verifyChatMcpActorToken } from "@/lib/chat-mcp-actor-token";
import {
  issueWidgetMcpActorToken,
  verifyWidgetMcpActorToken,
} from "@/lib/widget-mcp-actor-token";
import type { WidgetPrincipal } from "../widget-principal";
import {
  createScriptedChatSelfMcpDispatch,
  createScriptedSelfMcpDispatch,
} from "../scripted-self-mcp-dispatch";

const WIDGET_PRINCIPAL: WidgetPrincipal = {
  kind: "public_site_widget",
  userId: "u-widget-reader",
  orgId: "org-widget",
  parentTokenJti: "cwu-row-of-this-signin",
  instanceId: "inst-canonical",
  verifiedOrigin: "https://blog.example.com",
  assistantHandle: "wordpress",
  instancesConfigKey: "wordpress",
  lifecycleRead: true,
  platformRole: "member",
};

const TURN_RUN_ID = "run-of-this-scripted-turn";

type Verify = (input: {
  authHeader: string | null;
  request: Request;
  expectedAudience: string;
  expectedIssuer: string;
}) => unknown;

type Recorded = { method: string; status: number; authorization: string };

/**
 * A self-MCP stub that authenticates like the transport: expected audience and
 * issuer come from its own origin, and the shipped verifier decides. A refused
 * bearer gets 401, which is what the real route answers.
 */
function startVerifyingStub(verify: Verify, toolText: string): Promise<{
  origin: string;
  recorded: Recorded[];
  close: () => Promise<void>;
}> {
  const recorded: Recorded[] = [];
  let origin = "";
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
        id?: number;
        method?: string;
      };
      const authorization = String(req.headers.authorization ?? "");
      const actor = verify({
        authHeader: authorization,
        request: new Request(`${origin}/api/mcp`, { method: "POST" }),
        expectedAudience: `${origin}/api/mcp`,
        expectedIssuer: `${origin}/api/auth`,
      });
      if (!actor) {
        recorded.push({ method: body.method ?? "", status: 401, authorization });
        res.writeHead(401).end();
        return;
      }
      recorded.push({ method: body.method ?? "", status: 200, authorization });
      const reply = (payload: unknown) => {
        res.writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": "session-1",
        });
        res.end(JSON.stringify(payload));
      };
      if (body.method === "initialize") {
        reply({
          jsonrpc: "2.0",
          id: body.id,
          result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: {} },
        });
        return;
      }
      if (body.method === "notifications/initialized") {
        res.writeHead(202).end();
        return;
      }
      if (body.method === "tools/call") {
        reply({
          jsonrpc: "2.0",
          id: body.id,
          result: { content: [{ type: "text", text: toolText }] },
        });
        return;
      }
      res.writeHead(404).end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "localhost", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      origin = `http://localhost:${port}`;
      resolve({
        origin,
        recorded,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

function claimsOf(bearerOrToken: string): Record<string, unknown> {
  const token = bearerOrToken.replace(/^Bearer\s+/, "");
  const payload = token.split(".")[1] ?? "";
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
}

let closeStub: (() => Promise<void>) | null = null;
const originalAuthUrl = process.env.BETTER_AUTH_URL;

afterEach(async () => {
  await closeStub?.();
  closeStub = null;
  vi.unstubAllGlobals();
  if (originalAuthUrl === undefined) delete process.env.BETTER_AUTH_URL;
  else process.env.BETTER_AUTH_URL = originalAuthUrl;
});

afterAll(() => {
  // The fallback secret is this file's own; a later suite in the same process
  // must see the secret exactly as the process had it.
  if (originalSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = originalSecret;
});

/**
 * Replace `fetch` with a transport stand-in that sees what the real `fetch`
 * puts on the wire: the WHATWG canonical form of the URL. It derives the
 * expected audience and issuer from that canonical origin, runs the shipped
 * verifier and answers 401 on a refusal. No socket is opened, so a URL with an
 * explicit default port can be exercised.
 */
function stubCanonicalFetch(verify: Verify, toolText: string): { fetched: string[]; statuses: number[] } {
  const fetched: string[] = [];
  const statuses: number[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    fetched.push(url.href);
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body ?? "{}")) as { id?: number; method?: string };
    const actor = verify({
      authHeader: headers.get("authorization"),
      request: new Request(url.href, { method: "POST" }),
      expectedAudience: `${url.origin}/api/mcp`,
      expectedIssuer: `${url.origin}/api/auth`,
    });
    if (!actor) {
      statuses.push(401);
      return new Response(null, { status: 401 });
    }
    statuses.push(200);
    const json = (payload: unknown) =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json", "mcp-session-id": "session-1" },
      });
    if (body.method === "initialize") {
      return json({
        jsonrpc: "2.0",
        id: body.id,
        result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: {} },
      });
    }
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    return json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: toolText }] } });
  });
  return { fetched, statuses };
}

/** Start the stub and point the dispatcher's local MCP URL at it. */
async function withStub(verify: Verify, toolText: string) {
  const stub = await startVerifyingStub(verify, toolText);
  closeStub = stub.close;
  process.env.BETTER_AUTH_URL = stub.origin;
  return stub;
}

describe("the scripted self-MCP dispatch with a stored MCP public base URL", () => {
  it("CHAT: agent_run resolves, because the bearer is minted for the local URL the dispatch calls", async () => {
    const stub = await withStub(verifyChatMcpActorToken, '{"runId":"run-1"}');
    const dispatch = createScriptedChatSelfMcpDispatch({
      userId: "u-chat",
      orgId: "org-chat",
      platformRole: "member",
    });

    await expect(
      dispatch({ name: "agent_run", args: { agent: "@cinatra-ai/blog-pipeline-agent" } }),
    ).resolves.toBe('{"runId":"run-1"}');

    expect(stub.recorded.map((r) => `${r.method} ${r.status}`)).toEqual([
      "initialize 200",
      "notifications/initialized 200",
      "tools/call 200",
    ]);
    const claims = claimsOf(stub.recorded[0]?.authorization ?? "");
    expect(claims.aud).toBe(`${stub.origin}/api/mcp`);
    expect(claims.iss).toBe(`${stub.origin}/api/auth`);
  });

  it("WIDGET: the dispatch resolves, because the bearer is minted for the local URL the dispatch calls", async () => {
    const stub = await withStub(verifyWidgetMcpActorToken, '{"refs":[]}');
    const dispatch = createScriptedSelfMcpDispatch({
      widgetPrincipal: WIDGET_PRINCIPAL,
      turnRunId: TURN_RUN_ID,
    });

    await expect(
      dispatch({ name: "artifact_review_gates_list", args: {} }),
    ).resolves.toBe('{"refs":[]}');

    expect(stub.recorded.map((r) => `${r.method} ${r.status}`)).toEqual([
      "initialize 200",
      "notifications/initialized 200",
      "tools/call 200",
    ]);
    const claims = claimsOf(stub.recorded[0]?.authorization ?? "");
    expect(claims.aud).toBe(`${stub.origin}/api/mcp`);
    expect(claims.iss).toBe(`${stub.origin}/api/auth`);
  });

  it("the transport check stays exact: a token for the public URL is refused at the local origin", async () => {
    // The negative control. The shipped verifier, unchanged, refuses the
    // real-model mint at the local origin, so the dispatch cases above pass
    // only because the dispatch signs for the URL it calls.
    process.env.BETTER_AUTH_URL = "http://localhost:3060";
    const chat = issueChatMcpActorToken({
      delegation: "chat",
      userId: "u-chat",
      orgId: null,
      platformRole: "member",
    });
    expect(
      verifyChatMcpActorToken({
        authHeader: `Bearer ${chat}`,
        request: new Request("http://localhost:3060/api/mcp"),
        expectedAudience: "http://localhost:3060/api/mcp",
        expectedIssuer: "http://localhost:3060/api/auth",
      }),
    ).toBeNull();
  });

  it("the real-model mint keeps the public audience (no override, unchanged behaviour)", () => {
    process.env.BETTER_AUTH_URL = "http://localhost:3060";
    const chat = issueChatMcpActorToken({
      delegation: "chat",
      userId: "u-chat",
      orgId: null,
      platformRole: "member",
    });
    expect(claimsOf(chat).aud).toBe(PUBLIC_MCP_URL);
    expect(claimsOf(chat).iss).toBe("https://pub.example/api/auth");

    const widget = issueWidgetMcpActorToken({
      userId: WIDGET_PRINCIPAL.userId,
      orgId: WIDGET_PRINCIPAL.orgId,
      instanceId: WIDGET_PRINCIPAL.instanceId,
      kind: "wordpress",
      jti: "jti-1",
      parentJti: WIDGET_PRINCIPAL.parentTokenJti,
      turnRunId: TURN_RUN_ID,
    });
    expect(claimsOf(widget).aud).toBe(PUBLIC_MCP_URL);
    expect(claimsOf(widget).iss).toBe("https://pub.example/api/auth");
  });
  // The local base URL in a spelling that `fetch` canonicalizes. The token must
  // name the canonical URL the request actually reaches.
  const SPELLINGS: { label: string; authUrl: string; wire: string }[] = [
    { label: "uppercase scheme and host", authUrl: "HTTP://LOCALHOST:3060", wire: "http://localhost:3060/api/mcp" },
    { label: "explicit default http port", authUrl: "http://localhost:80", wire: "http://localhost/api/mcp" },
    { label: "explicit default https port", authUrl: "https://Local.Example:443", wire: "https://local.example/api/mcp" },
  ];

  for (const { label, authUrl, wire } of SPELLINGS) {
    it(`CHAT, ${label}: agent_run resolves and the audience is the canonical URL`, async () => {
      const wireLog = stubCanonicalFetch(verifyChatMcpActorToken, '{"runId":"run-2"}');
      process.env.BETTER_AUTH_URL = authUrl;
      const dispatch = createScriptedChatSelfMcpDispatch({
        userId: "u-chat",
        orgId: "org-chat",
        platformRole: "member",
      });
      await expect(
        dispatch({ name: "agent_run", args: { agent: "@cinatra-ai/blog-pipeline-agent" } }),
      ).resolves.toBe('{"runId":"run-2"}');
      expect(wireLog.statuses).toEqual([200, 200, 200]);
      expect(wireLog.fetched).toEqual([wire, wire, wire]);
    });

    it(`WIDGET, ${label}: the dispatch resolves and the audience is the canonical URL`, async () => {
      const wireLog = stubCanonicalFetch(verifyWidgetMcpActorToken, '{"refs":[]}');
      process.env.BETTER_AUTH_URL = authUrl;
      const dispatch = createScriptedSelfMcpDispatch({
        widgetPrincipal: WIDGET_PRINCIPAL,
        turnRunId: TURN_RUN_ID,
      });
      await expect(
        dispatch({ name: "artifact_review_gates_list", args: {} }),
      ).resolves.toBe('{"refs":[]}');
      expect(wireLog.statuses).toEqual([200, 200, 200]);
      expect(wireLog.fetched).toEqual([wire, wire, wire]);
    });
  }
});

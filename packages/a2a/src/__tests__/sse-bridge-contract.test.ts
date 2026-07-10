/**
 * SSE producer/parser bridge contract — real wire, un-mocked.
 *
 * WHY THIS EXISTS (upgrade-track works-after harness, cinatra#1147)
 * ----------------------------------------------------------------
 * The load-bearing A2A streaming surface is a *pair* of node/TS halves that
 * must stay wire-compatible across a node / `@a2a-js/sdk` bump:
 *
 *   emit side  — `toSseResponse` (this repo) turns an AsyncGenerator of
 *                JSON-RPC responses into a spec-compliant `text/event-stream`.
 *   parse side — `@a2a-js/sdk`'s `parseSseStream` (consumed by the real SDK
 *                client's `sendMessageStream`) reads those frames back.
 *
 * Every *other* SSE test in this package proves only one half in isolation and
 * mocks the other:
 *   - `sse-response.test.ts` string-splits `toSseResponse` output; it never
 *     feeds it through the real SDK parser.
 *   - `external-client.test.ts` fully mocks `@a2a-js/sdk/client`
 *     (`sendMessageStream = vi.fn()`), so the real parser never runs.
 *   - `external-sse-proxy.test.ts` mocks the bridge and feeds a fake generator.
 *
 * So no test drives the emit side over a real HTTP wire and consumes it with
 * the real SDK parser. This test closes that gap: it stands up a real
 * ephemeral `node:http` server that pipes genuine `toSseResponse` bytes, and
 * consumes them with the repo's real remote client (`createExternalA2AClient`
 * -> `@a2a-js/sdk` `JsonRpcTransport` -> `parseSseStream`). If a bump breaks
 * the producer/parser contract, this goes red in ordinary CI.
 *
 * It ALSO directly guards `patches/@a2a-js__sdk@0.3.13.patch` — the multi-line
 * `data:` accumulation fix in `parseSseStream`. The second case emits an event
 * whose JSON-RPC payload is split across two `data:` lines; only the patched
 * (accumulating) parser reconstructs valid JSON. If a future `@a2a-js/sdk`
 * bump silently drops the patch (the `patchedDependencies` key embeds the exact
 * version), that case fails to parse and goes red.
 *
 * SCOPE NOTE (codex-converged): this is an SSE wire/bridge contract proof —
 * the event sequence is generated, not produced by a real agent run. The
 * candidate-runtime `message/stream` works-after proof (a real agent run
 * observed over the stream) is deliberately handed to the agent-runtime major
 * lane (cinatra#1148), whose acceptance already reads "agent-run + stream", and
 * where a streaming-capable runtime can make that proof meaningful and green.
 * Infra-free: no Postgres / Redis / Docker — runs in the ordinary unit suite.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { JSONRPCResponse } from "@a2a-js/sdk";

import { toSseResponse } from "../sse-response";
import { createExternalA2AClient } from "../external-client";

// ---------------------------------------------------------------------------
// Test A2A server helpers
// ---------------------------------------------------------------------------

const AGENT_CARD_PATH = "/.well-known/agent-card.json";

/** A minimal streaming-capable AgentCard for the JSON-RPC transport. */
function makeAgentCard(baseUrl: string): Record<string, unknown> {
  return {
    protocolVersion: "0.3.0",
    name: "sse-bridge-contract-test-agent",
    description: "Deterministic SSE producer for the works-after bridge proof.",
    url: `${baseUrl}/`,
    preferredTransport: "JSONRPC",
    version: "0.0.0",
    capabilities: { streaming: true },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [],
  };
}

/** Read the whole request body as a UTF-8 string. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/** Pipe a web `Response` (from `toSseResponse`) into a node `ServerResponse`. */
async function pipeResponse(response: Response, res: ServerResponse): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((v, k) => (headers[k] = v));
  res.writeHead(response.status, headers);
  const body = response.body;
  if (!body) {
    res.end();
    return;
  }
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) res.write(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
    res.end();
  }
}

type StreamServer = { baseUrl: string; close: () => Promise<void> };

/**
 * Start an ephemeral A2A JSON-RPC server. `handleStream` receives the parsed
 * JSON-RPC request (so it can echo the request `id`, which the SDK transport
 * strictly validates) and writes the SSE response.
 */
async function startServer(
  handleStream: (rpc: { id: number | string }, res: ServerResponse) => Promise<void>,
): Promise<StreamServer> {
  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        if (req.method === "GET") {
          const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
          const card = JSON.stringify(makeAgentCard(baseUrl));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(card);
          return;
        }
        if (req.method === "POST") {
          const rpc = JSON.parse(await readBody(req)) as { id: number | string };
          await handleStream(rpc, res);
          return;
        }
        res.writeHead(405).end();
      } catch (err) {
        if (!res.headersSent) res.writeHead(500);
        res.end(String(err));
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      ),
  };
}

/** A realistic agent-run streaming sequence as JSON-RPC response frames. */
function agentRunFrames(rpcId: number | string, nonce: string): AsyncGenerator<JSONRPCResponse> {
  const taskId = randomUUID();
  const contextId = randomUUID();
  const frame = (result: unknown): JSONRPCResponse =>
    ({ jsonrpc: "2.0", id: rpcId, result }) as unknown as JSONRPCResponse;
  async function* gen(): AsyncGenerator<JSONRPCResponse> {
    // 1) working status
    yield frame({
      kind: "status-update",
      taskId,
      contextId,
      status: { state: "working" },
      final: false,
    });
    // 2) an intermediate artifact carrying the nonce
    yield frame({
      kind: "artifact-update",
      taskId,
      contextId,
      artifact: {
        artifactId: randomUUID(),
        parts: [{ kind: "text", text: `partial ${nonce}` }],
      },
    });
    // 3) terminal completion carrying the round-tripped nonce
    yield frame({
      kind: "status-update",
      taskId,
      contextId,
      final: true,
      status: {
        state: "completed",
        message: {
          kind: "message",
          role: "agent",
          messageId: randomUUID(),
          parts: [{ kind: "text", text: `done ${nonce}` }],
        },
      },
    });
  }
  return gen();
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe("SSE producer/parser bridge contract (real wire, un-mocked)", () => {
  it("round-trips an agent-run completion nonce: toSseResponse -> HTTP -> real @a2a-js/sdk parser", async () => {
    const nonce = `nonce-${randomUUID()}`;
    const server = await startServer(async (rpc, res) => {
      await pipeResponse(toSseResponse(agentRunFrames(rpc.id, nonce)), res);
    });
    try {
      const client = await createExternalA2AClient({
        agentUrl: server.baseUrl,
        agentCardPath: AGENT_CARD_PATH,
      });

      const seen: Array<Record<string, unknown>> = [];
      for await (const event of client.streamTask("go")) {
        seen.push(event as unknown as Record<string, unknown>);
      }

      // The stream terminated cleanly and delivered every frame through the
      // real SDK parser (three: working, artifact, completed).
      expect(seen).toHaveLength(3);

      const completion = seen.find(
        (e) =>
          e.kind === "status-update" &&
          (e.status as { state?: string } | undefined)?.state === "completed",
      ) as
        | { status?: { message?: { parts?: Array<{ text?: string }> } } }
        | undefined;
      expect(completion).toBeDefined();
      const text = completion?.status?.message?.parts?.[0]?.text ?? "";
      expect(text).toContain(nonce);
    } finally {
      await server.close();
    }
  });

  it("guards patches/@a2a-js__sdk@0.3.13.patch: the real parser accumulates a multi-line data: frame", async () => {
    // Emit ONE logical SSE event whose JSON-RPC payload is deliberately split
    // across two `data:` lines. Valid JSON only after the patched parser joins
    // them with `\n`. WITHOUT the patch, `parseSseStream` keeps just the last
    // `data:` line (`}}` alone) -> `JSON.parse` throws -> the stream errors and
    // this test goes red. WITH the patch, the halves reconstruct and the nonce
    // arrives. This is the direct regression guard for the multi-line `data:`
    // accumulation fix (the patch key embeds the exact SDK version, so a bump
    // that drops it fails here).
    const nonce = `nonce-${randomUUID()}`;
    const server = await startServer(async (rpc, res) => {
      const payload = JSON.stringify({
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          kind: "status-update",
          taskId: randomUUID(),
          contextId: randomUUID(),
          final: true,
          status: {
            state: "completed",
            message: {
              kind: "message",
              role: "agent",
              messageId: randomUUID(),
              parts: [{ kind: "text", text: `done ${nonce}` }],
            },
          },
        },
      });
      // Split at a STRUCTURAL JSON boundary (immediately before the top-level
      // `"result"` key, i.e. right after a comma) so a `\n` between the halves
      // is legal JSON whitespace. Each half alone is invalid JSON — the second
      // line (`"result":{...}}`) does not parse on its own — so only the
      // patched, accumulating parser reconstructs it.
      const splitAt = payload.indexOf('"result"');
      const first = payload.slice(0, splitAt);
      const second = payload.slice(splitAt);
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
      });
      res.write(`data: ${first}\ndata: ${second}\n\n`);
      res.end();
    });
    try {
      const client = await createExternalA2AClient({
        agentUrl: server.baseUrl,
        agentCardPath: AGENT_CARD_PATH,
      });
      const seen: Array<Record<string, unknown>> = [];
      for await (const event of client.streamTask("go")) {
        seen.push(event as unknown as Record<string, unknown>);
      }
      expect(seen).toHaveLength(1);
      const completion = seen[0] as {
        status?: { message?: { parts?: Array<{ text?: string }> } };
      };
      expect(completion?.status?.message?.parts?.[0]?.text ?? "").toContain(nonce);
    } finally {
      await server.close();
    }
  });
});

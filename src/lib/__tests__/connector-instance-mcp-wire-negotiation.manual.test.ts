import { appendFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import { callConnectorInstanceMcpTool, listConnectorInstanceMcpTools } from "@/lib/connector-instance-mcp-transport";

/**
 * cinatra#2218 L2d — RE-RUNNABLE LIVE WIRE PROBE against the pinned WordPress
 * mcp-adapter fixture. Gated, because it needs the booted fixture; the always-on
 * live leg rides `.github/workflows/wp-mcp-gateway-capture.yml`, and the
 * ungated in-process legs live in `connector-instance-mcp-negotiation.test.ts`.
 *
 * How to run (the harness's own documented bring-up):
 *
 *   docker compose --profile wordpress up -d wordpress wordpress-db
 *   docker exec cinatra-wordpress-1 wp --allow-root \
 *     user application-password create admin wire-proof --porcelain
 *   RUN_CONNECTOR_WIRE_PROOF=1 \
 *   WIRE_PROOF_DUMP=/tmp/wire-frames.txt \
 *   WP_BASE_URL=http://localhost:8080 \
 *   WP_MCP_BASIC_AUTH="$(printf 'admin:<the password>' | base64)" \
 *     pnpm vitest run src/lib/__tests__/connector-instance-mcp-wire-negotiation.manual.test.ts
 *
 * WHAT IT IS FOR. Every frame flows through a transparent recording proxy in
 * front of the live adapter, so the assertions read the real wire rather than
 * our own source. Its `auto`-falls-back-to-legacy assertion is designed to FAIL
 * when a future adapter pin answers `server/discover` — and that failure is the
 * signal to move the connector-instance row in
 * `docs/internals/contracts/mcp-supported-revisions.md` to the modern revision.
 * The negotiation itself needs no code change when that day comes.
 */

const ENABLED = process.env.RUN_CONNECTOR_WIRE_PROOF === "1";
const BASE_URL = process.env.WP_BASE_URL ?? "http://localhost:8080";
const BASIC_AUTH = process.env.WP_MCP_BASIC_AUTH ?? "";
const MCP_ROUTE = process.env.WP_MCP_ROUTE ?? "/wp-json/mcp/mcp-adapter-default-server";

type ProxyFrame = {
  method: string;
  requestHeaders: Record<string, string | undefined>;
  requestBody: unknown;
  status: number;
  responseHeaders: Record<string, string | undefined>;
  responseBody: string;
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (raw += c));
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

/** A transparent logging proxy in front of the live adapter. Forwards verbatim;
 * records both directions. */
async function startRecordingProxy(target: string): Promise<{
  url: string;
  frames: ProxyFrame[];
  close: () => Promise<void>;
}> {
  const frames: ProxyFrame[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const raw = await readBody(req);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string" && k !== "host" && k !== "connection" && k !== "content-length") headers[k] = v;
      }
      const upstream = await fetch(target, {
        method: req.method,
        headers,
        ...(raw ? { body: raw } : {}),
      });
      const text = await upstream.text();
      const responseHeaders: Record<string, string> = {};
      upstream.headers.forEach((v, k) => (responseHeaders[k] = v));

      let requestBody: unknown = raw;
      try {
        requestBody = raw ? JSON.parse(raw) : undefined;
      } catch {
        /* keep the raw text */
      }
      frames.push({
        method: req.method ?? "",
        requestHeaders: { ...(req.headers as Record<string, string | undefined>) },
        requestBody,
        status: upstream.status,
        responseHeaders,
        responseBody: text,
      });

      const passthrough: Record<string, string> = {};
      for (const [k, v] of Object.entries(responseHeaders)) {
        if (!["content-encoding", "transfer-encoding", "content-length", "connection"].includes(k)) {
          passthrough[k] = v;
        }
      }
      res.writeHead(upstream.status, passthrough).end(text);
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    frames,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Append the recorded frame sequence to the file named by `WIRE_PROOF_DUMP`, so
 * a run can be quoted verbatim in a PR body rather than paraphrased. (A file
 * rather than the console: the root suite's setup writes enough to stdout to
 * bury it.) */
function dumpFrames(label: string, frames: ProxyFrame[]): void {
  const target = process.env.WIRE_PROOF_DUMP;
  if (!target) return;
  const lines = [`--- ${label} — ${frames.length} HTTP frames ---`];
  frames.forEach((f, i) => {
    const methods = jsonRpcMethods([f]).join(",") || "(no jsonrpc method)";
    const sess = f.requestHeaders["mcp-session-id"];
    const ver = f.requestHeaders["mcp-protocol-version"];
    lines.push(
      `[${i + 1}] --> ${f.method} ${methods}` +
        (ver ? ` mcp-protocol-version:${ver}` : "") +
        (sess ? ` mcp-session-id:${sess}` : ""),
    );
    lines.push(`[${i + 1}] <-- ${f.status} ${f.responseBody.slice(0, 200)}`);
  });
  appendFileSync(target, lines.join("\n") + "\n\n");
}

function jsonRpcMethods(frames: ProxyFrame[]): string[] {
  return frames.flatMap((f) => {
    const list = Array.isArray(f.requestBody) ? f.requestBody : [f.requestBody];
    return list
      .map((m) => (m && typeof m === "object" ? (m as { method?: unknown }).method : undefined))
      .filter((m): m is string => typeof m === "string");
  });
}

describe.skipIf(!ENABLED)("LIVE — connector-instance transport vs the pinned WordPress mcp-adapter", () => {
  it("the peer is a SESSIONFUL 2025-era server: it refuses BOTH a bare tools/list and the modern probe", async () => {
    const target = `${BASE_URL}${MCP_ROUTE}`;
    const auth = { Authorization: `Basic ${BASIC_AUTH}`, "Content-Type": "application/json" };

    const bare = await fetch(target, {
      method: "POST",
      headers: { ...auth, Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(bare.status).toBe(400);
    expect(await bare.text()).toContain("Missing Mcp-Session-Id header");

    const probe = await fetch(target, {
      method: "POST",
      headers: {
        ...auth,
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "server/discover",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "probe-1",
        method: "server/discover",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    // The pinned adapter does NOT implement 2026-07-28.
    expect(probe.status).toBe(400);
    expect(await probe.text()).toContain("Missing Mcp-Session-Id header");
  });

  it("`{ mode: 'auto' }` probes, is refused, falls back, and completes tools/list on the live peer", async () => {
    const proxy = await startRecordingProxy(`${BASE_URL}${MCP_ROUTE}`);
    try {
      const tools = await listConnectorInstanceMcpTools({
        endpoint: proxy.url,
        authHeader: `Basic ${BASIC_AUTH}`,
      });
      expect(tools.length).toBeGreaterThan(0);
      expect(tools.map((t) => t.name)).toContain("mcp-adapter-execute-ability");

      dumpFrames("{ mode: 'auto' } vs the pinned adapter — listTools", proxy.frames);
      const methods = jsonRpcMethods(proxy.frames);
      expect(methods).toContain("server/discover");
      expect(methods).toContain("initialize");
      expect(methods.indexOf("server/discover")).toBeLessThan(methods.indexOf("initialize"));

      // The probe was REFUSED — the assertion that flips when the pin moves.
      const probeFrame = proxy.frames.find((f) => jsonRpcMethods([f]).includes("server/discover"));
      expect(probeFrame?.status).toBe(400);
      expect(probeFrame?.responseBody).toContain("Missing Mcp-Session-Id header");

      // The peer minted a session and the LIBRARY replayed it.
      const initFrame = proxy.frames.find((f) => jsonRpcMethods([f]).includes("initialize"));
      const sessionId = initFrame?.responseHeaders["mcp-session-id"];
      expect(sessionId).toBeTruthy();
      const listFrame = proxy.frames.find((f) => jsonRpcMethods([f]).includes("tools/list"));
      expect(listFrame?.requestHeaders["mcp-session-id"]).toBe(sessionId);

      // AC4 on the LIVE wire: the id the real peer minted reaches no result.
      expect(JSON.stringify(tools)).not.toContain(sessionId);
    } finally {
      await proxy.close();
    }
  });

  it("a real tools/call round-trips, and the live session id reaches no application value", async () => {
    const proxy = await startRecordingProxy(`${BASE_URL}${MCP_ROUTE}`);
    try {
      const result = await callConnectorInstanceMcpTool({
        endpoint: proxy.url,
        authHeader: `Basic ${BASIC_AUTH}`,
        name: "mcp-adapter-discover-abilities",
        arguments: {},
      });
      expect(result).toBeTruthy();

      dumpFrames("{ mode: 'auto' } vs the pinned adapter — callTool", proxy.frames);
      const initFrame = proxy.frames.find((f) => jsonRpcMethods([f]).includes("initialize"));
      const sessionId = initFrame?.responseHeaders["mcp-session-id"];
      expect(sessionId).toBeTruthy();
      expect(JSON.stringify(result)).not.toContain(sessionId);
    } finally {
      await proxy.close();
    }
  });
});

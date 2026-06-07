// Twenty CRM client used by the bootstrap proof script.
//
// Why this file exists:
// - The proof needs minimal, deterministic HTTP/MCP access to Twenty.
// - We deliberately avoid pulling in the heavyweight cinatra packages here so the
//   proof can run in CI without bringing up the cinatra app at all.
// - All header/session/retry semantics live here in one place.
//
// Auth: API-key bearer (Twenty OAuth doesn't support client_credentials).
//
// Three transports are exposed:
//   1. REST    — for /healthz and other unauthenticated probes.
//   2. GraphQL — for the Core API and the Metadata API.
//   3. MCP     — JSON-RPC over POST /mcp with Bearer auth, supporting both
//                application/json and text/event-stream response modes.

import { randomUUID } from "node:crypto";

const DEFAULT_TIMEOUT_MS = 30_000;
const RETRY_BACKOFFS_MS = [250, 500, 1000];

function redactBearer(headers) {
  if (!headers || typeof headers !== "object") return headers;
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (/^authorization$/i.test(k) && typeof v === "string") {
      const last4 = v.slice(-4);
      out[k] = `Bearer ****${last4}`;
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function maskToken(token) {
  if (!token || typeof token !== "string") return "(none)";
  if (token.length <= 8) return "****";
  return `****${token.slice(-4)}`;
}

export class TwentyClient {
  /**
   * @param {Object} options
   * @param {string} options.baseUrl   e.g. http://localhost:3300
   * @param {string} [options.apiKey]  Bearer JWT minted by workspace:generate-api-key
   * @param {Function} [options.logger] (level, msg, extra?) => void
   */
  constructor({ baseUrl, apiKey, logger } = {}) {
    if (!baseUrl) throw new Error("TwentyClient: baseUrl is required");
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey || null;
    this.sessionId = randomUUID();
    this.logger =
      logger ||
      ((level, msg) => {
        const ts = new Date().toISOString();
        process.stdout.write(`[${ts}] [twenty-client] [${level}] ${msg}\n`);
      });
  }

  setApiKey(apiKey) {
    this.apiKey = apiKey;
  }

  // ------------- low-level fetch with bounded retries -------------

  async _fetchWithRetry(url, init, { retries = RETRY_BACKOFFS_MS } = {}) {
    let lastErr;
    const attempts = retries.length + 1;
    for (let i = 0; i < attempts; i++) {
      try {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), init.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        const res = await fetch(url, { ...init, signal: ac.signal });
        clearTimeout(t);
        if (res.status >= 500 && i < retries.length) {
          this.logger(
            "warn",
            `HTTP ${res.status} from ${url} — retrying in ${retries[i]}ms (attempt ${i + 1}/${attempts})`,
          );
          await new Promise((r) => setTimeout(r, retries[i]));
          continue;
        }
        return res;
      } catch (err) {
        lastErr = err;
        const code = err && (err.code || err.cause?.code);
        const transient =
          code === "ECONNREFUSED" ||
          code === "ECONNRESET" ||
          code === "UND_ERR_SOCKET" ||
          err.name === "AbortError";
        if (!transient || i >= retries.length) throw err;
        this.logger(
          "warn",
          `${err.name || "Error"}: ${err.message} on ${url} — retrying in ${retries[i]}ms (attempt ${i + 1}/${attempts})`,
        );
        await new Promise((r) => setTimeout(r, retries[i]));
      }
    }
    throw lastErr || new Error(`unknown fetch failure on ${url}`);
  }

  // ------------- REST -------------

  async restGet(path, { headers = {}, timeoutMs } = {}) {
    const url = `${this.baseUrl}${path}`;
    const res = await this._fetchWithRetry(url, {
      method: "GET",
      headers: this._authedHeaders(headers),
      timeoutMs,
    });
    return res;
  }

  async healthcheck() {
    const res = await this._fetchWithRetry(`${this.baseUrl}/healthz`, {
      method: "GET",
      timeoutMs: 5000,
    });
    return res.status === 200;
  }

  // ------------- GraphQL (Core + Metadata) -------------

  async graphql(endpoint, query, variables) {
    if (!this.apiKey) {
      throw new Error("TwentyClient.graphql requires an apiKey");
    }
    const url = `${this.baseUrl}${endpoint}`;
    const res = await this._fetchWithRetry(url, {
      method: "POST",
      headers: this._authedHeaders({
        "Content-Type": "application/json",
        Accept: "application/json",
      }),
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `GraphQL ${endpoint} failed: HTTP ${res.status} ${res.statusText}\n${text}`,
      );
    }
    const body = await res.json();
    if (body.errors && body.errors.length > 0) {
      const msgs = body.errors
        .map((e) => {
          const extras = e.extensions
            ? ` [${e.extensions.code || ""}] ${JSON.stringify(e.extensions).slice(0, 600)}`
            : "";
          return `${e.message}${extras}`;
        })
        .join("\n  ");
      const err = new Error(`GraphQL ${endpoint} returned errors:\n  ${msgs}`);
      err.graphqlErrors = body.errors;
      throw err;
    }
    return body.data;
  }

  graphqlCore(query, variables) {
    return this.graphql("/graphql", query, variables);
  }

  graphqlMetadata(query, variables) {
    return this.graphql("/metadata", query, variables);
  }

  // ------------- MCP JSON-RPC -------------

  /**
   * One MCP JSON-RPC call. Twenty's `/mcp` controller accepts both
   * application/json single-response and text/event-stream streaming responses
   * (mcp-core.controller.ts). We send Accept: both, prefer JSON, and only follow
   * the SSE path when the server flips into it.
   */
  async mcpRpc(method, params = {}, { acceptSse = false } = {}) {
    if (!this.apiKey) throw new Error("TwentyClient.mcpRpc requires an apiKey");
    const id = randomUUID();
    const body = { jsonrpc: "2.0", id, method, params };
    const headers = this._authedHeaders({
      "Content-Type": "application/json",
      Accept: acceptSse
        ? "text/event-stream, application/json"
        : "application/json, text/event-stream",
      "Mcp-Session-Id": this.sessionId,
    });
    const res = await this._fetchWithRetry(`${this.baseUrl}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      // Ensure no bearer accidentally appears in MCP error dumps. The body
      // should never contain the bearer, but we redact defensively.
      const safe = this.apiKey ? text.replaceAll(this.apiKey, maskToken(this.apiKey)) : text;
      throw new Error(
        `MCP ${method} failed: HTTP ${res.status} ${res.statusText}\n${safe}`,
      );
    }
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("text/event-stream")) {
      return this._readSseToJson(res);
    }
    const json = await res.json();
    if (json.error) {
      throw new Error(
        `MCP ${method} returned JSON-RPC error: ${json.error.code} ${json.error.message}`,
      );
    }
    return json.result;
  }

  async _readSseToJson(res) {
    // Twenty's writeSseEvent emits one "data: <json>\n\n" frame per logical
    // message. We collect frames until the response stream ends, then return
    // the last frame's result (or surface an error).
    const text = await res.text();
    const frames = [];
    for (const block of text.split(/\r?\n\r?\n/)) {
      const dataLine = block
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      const payload = dataLine.slice("data:".length).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        frames.push(JSON.parse(payload));
      } catch {
        /* ignore unparseable frames; MCP only emits JSON */
      }
    }
    if (frames.length === 0) {
      throw new Error("MCP SSE: no JSON frames in stream");
    }
    const last = frames[frames.length - 1];
    if (last.error) {
      throw new Error(
        `MCP SSE returned JSON-RPC error: ${last.error.code} ${last.error.message}`,
      );
    }
    return last.result;
  }

  async mcpInitialize() {
    return this.mcpRpc("initialize", {
      protocolVersion: "2025-03-26",
      clientInfo: { name: "cinatra-twenty-bootstrap-proof", version: "0.0.0" },
      capabilities: {},
    });
  }

  async mcpToolsList() {
    return this.mcpRpc("tools/list", {});
  }

  async mcpToolsCall(name, args = {}) {
    return this.mcpRpc("tools/call", { name, arguments: args });
  }

  // ------------- helpers -------------

  _authedHeaders(extra = {}) {
    const headers = { ...extra };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;
    return headers;
  }

  describe() {
    return {
      baseUrl: this.baseUrl,
      apiKey: maskToken(this.apiKey),
      sessionId: this.sessionId,
    };
  }
}

export { redactBearer };

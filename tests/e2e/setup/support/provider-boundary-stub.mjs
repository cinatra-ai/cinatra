/**
 * PROVIDER HTTP-BOUNDARY STUB + EGRESS LEDGER for the setup-flow acceptance
 * suite (cinatra#2392, epic #2385 S7). Descends from the S6 render-proof stub
 * (evidence/2093-s6-setup/drivers/provider-boundary-stub.mjs), extended with
 * the `/v1/responses` assistant-turn arm the post-setup acceptance drives.
 *
 * Loaded into the REAL dev/prod server via `NODE_OPTIONS=--import`, so it wraps
 * `globalThis.fetch` BEFORE Next.js captures it. Everything inside the app —
 * server actions, the S3 commit machine, connector code, Postgres, the rendered
 * UI, the assistant runtime — is real. The ONLY thing replaced is the outbound
 * HTTP boundary to the two provider hosts, which is exactly where the
 * connectors' own probe suites stub. No live provider key is required.
 *
 * TWO JOBS:
 *   1. answer `api.openai.com` / `api.anthropic.com` from a scripted table
 *      whose arms are flipped at runtime through `control.json` (no restart —
 *      one boot drives every flow);
 *   2. APPEND every provider-host request to an egress ledger. The ledger is
 *      what makes "the OpenAI path performs ZERO Anthropic egress" a MEASURED
 *      claim: the spec assertions read the recorded calls.
 *
 * The ledger records method + host + path + a request-body fingerprint only.
 * Headers are NEVER recorded — the `x-api-key` / `Authorization` header rides
 * every one of these calls and this file is committed to a PUBLIC repo.
 *
 * Control flags (tests/e2e/setup/support/instance-state.ts flips these):
 *   phase            — free-text label stamped onto ledger entries
 *   openaiKeyValid   — false => OpenAI answers 401 (key-save failure arm)
 *   anthropicKeyValid— false => Anthropic answers 401
 *   probeAccept      — false => /v1/messages rejects container.skills (400)
 */
import { appendFileSync, readFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const DIR =
  process.env.LANE_STUB_DIR ??
  path.join(process.cwd(), "test-results", "setup-acceptance-stub");

/** The sentinel the stubbed assistant turn answers with — specs assert it. */
const TURN_SENTINEL = "CINATRA_SETUP_ACCEPTANCE_OK";

mkdirSync(DIR, { recursive: true });
const LEDGER = path.join(DIR, process.env.LANE_LEDGER ?? "egress.jsonl");
const CONTROL = path.join(DIR, "control.json");

const PROVIDER_HOSTS = new Set(["api.openai.com", "api.anthropic.com"]);

function control() {
  try {
    return JSON.parse(readFileSync(CONTROL, "utf8"));
  } catch {
    return {};
  }
}

function record(entry) {
  try {
    appendFileSync(LEDGER, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
  } catch {
    /* the ledger must never break the app under proof */
  }
}

/**
 * Resolve the request payload from EITHER shape `fetch` accepts: an
 * `(input, init)` pair whose `init.body` is a string, or a `Request` first
 * argument carrying the body itself. Reading only `init.body` silently
 * fingerprinted `{}` for a `Request`-shaped caller, which made a streaming
 * `/v1/responses` call fall through to the non-SSE arm and recorded a null
 * `container.skills` reference on the Anthropic probe.
 *
 * Returns a parsed object, or `{}` when there is nothing parseable — the
 * caller only ever needs a fingerprint, never the full payload.
 */
async function readBody(input, init) {
  const raw =
    typeof init?.body === "string"
      ? init.body
      : input && typeof input === "object" && typeof input.clone === "function"
        ? await input
            .clone()
            .text()
            .catch(() => "")
        : "";
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Remote state the stub keeps so the skills lifecycle is COHERENT across calls
// (create -> the id the host then probes -> delete), rather than each call
// answering in isolation.
const skills = new Map(); // id -> { versions: string[] }
let seq = 0;

const realFetch = globalThis.fetch;

globalThis.fetch = async function stubbedFetch(input, init) {
  let url;
  try {
    url = new URL(typeof input === "string" ? input : (input?.url ?? String(input)));
  } catch {
    return realFetch(input, init);
  }
  if (!PROVIDER_HOSTS.has(url.hostname)) return realFetch(input, init);

  const method = (init?.method ?? (typeof input === "object" ? input?.method : null) ?? "GET").toUpperCase();
  const ctl = control();
  const phase = ctl.phase ?? "unlabelled";

  // --- OpenAI ------------------------------------------------------------
  if (url.hostname === "api.openai.com") {
    if (ctl.openaiKeyValid === false) {
      record({ phase, provider: "openai", method, path: url.pathname, outcome: "401 invalid-key" });
      return json({ error: { message: "Incorrect API key provided." } }, 401);
    }
    if (url.pathname === "/v1/models" && method === "GET") {
      record({ phase, provider: "openai", method, path: url.pathname, outcome: "200 model-list" });
      return json({
        object: "list",
        // The build-known OpenAI catalog (packages/agents llm-provider-policy),
        // so any default-model resolution sees the same ids a real account
        // would expose.
        data: [
          { id: "gpt-5.5", object: "model" },
          { id: "gpt-5.4", object: "model" },
          { id: "gpt-5.4-mini", object: "model" },
          { id: "gpt-4.1", object: "model" },
          { id: "gpt-4.1-mini", object: "model" },
        ],
      });
    }
    // THE ASSISTANT TURN. The chat adapter streams
    // (`client.responses.stream()` — extensions/cinatra-ai/openai-connector/
    // src/adapter/openai-adapter.ts), so a `stream: true` body gets a real
    // Responses SSE event sequence; non-streaming callers get the JSON body
    // (`output_text` first — readResponseText in the connector).
    if (url.pathname === "/v1/responses" && method === "POST") {
      const wantsStream = (await readBody(input, init)).stream === true;
      const id = `resp_setup2392_${++seq}`;
      const msgId = `msg_setup2392_${seq}`;
      const finalResponse = {
        id,
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        status: "completed",
        model: "gpt-5.5",
        output_text: TURN_SENTINEL,
        output: [
          {
            type: "message",
            id: msgId,
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: TURN_SENTINEL, annotations: [] }],
          },
        ],
        usage: { input_tokens: 4, output_tokens: 4, total_tokens: 8 },
        error: null,
        incomplete_details: null,
      };
      record({
        phase,
        provider: "openai",
        method,
        path: url.pathname,
        outcome: wantsStream ? "200 sse-stream" : "200 response",
      });
      if (!wantsStream) return json(finalResponse);

      let s = 0;
      const events = [
        { type: "response.created", sequence_number: ++s, response: { ...finalResponse, status: "in_progress", output: [], output_text: "" } },
        { type: "response.in_progress", sequence_number: ++s, response: { ...finalResponse, status: "in_progress", output: [], output_text: "" } },
        { type: "response.output_item.added", sequence_number: ++s, output_index: 0, item: { type: "message", id: msgId, role: "assistant", status: "in_progress", content: [] } },
        { type: "response.content_part.added", sequence_number: ++s, item_id: msgId, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
        { type: "response.output_text.delta", sequence_number: ++s, item_id: msgId, output_index: 0, content_index: 0, delta: TURN_SENTINEL, logprobs: [] },
        { type: "response.output_text.done", sequence_number: ++s, item_id: msgId, output_index: 0, content_index: 0, text: TURN_SENTINEL, logprobs: [] },
        { type: "response.content_part.done", sequence_number: ++s, item_id: msgId, output_index: 0, content_index: 0, part: { type: "output_text", text: TURN_SENTINEL, annotations: [] } },
        { type: "response.output_item.done", sequence_number: ++s, output_index: 0, item: finalResponse.output[0] },
        { type: "response.completed", sequence_number: ++s, response: finalResponse },
      ];
      const body = events
        .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
        .join("");
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    record({ phase, provider: "openai", method, path: url.pathname, outcome: "200 generic" });
    return json({});
  }

  // --- Anthropic ---------------------------------------------------------
  if (ctl.anthropicKeyValid === false) {
    record({ phase, provider: "anthropic", method, path: url.pathname, outcome: "401 invalid-key" });
    return json(
      { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } },
      401,
    );
  }
  // POST /v1/skills — create a custom skill (multipart).
  if (url.pathname === "/v1/skills" && method === "POST") {
    const id = `skill_setup2392_${++seq}`;
    skills.set(id, { versions: ["v1"] });
    record({ phase, provider: "anthropic", method, path: url.pathname, outcome: `201 created ${id}` });
    return json({ id, latest_version: "v1" });
  }
  // GET /v1/skills — list (collision reconciliation walk).
  if (url.pathname === "/v1/skills" && method === "GET") {
    record({ phase, provider: "anthropic", method, path: url.pathname, outcome: "200 list" });
    return json({ data: [], has_more: false });
  }
  // POST /v1/skills/<id>/versions — new revision of an existing skill.
  let m = url.pathname.match(/^\/v1\/skills\/([^/]+)\/versions$/);
  if (m && method === "POST") {
    const entry = skills.get(decodeURIComponent(m[1])) ?? { versions: [] };
    const version = `v${entry.versions.length + 1}`;
    entry.versions.push(version);
    skills.set(decodeURIComponent(m[1]), entry);
    record({ phase, provider: "anthropic", method, path: url.pathname, outcome: `201 ${version}` });
    return json({ version });
  }
  // GET /v1/skills/<id>/versions — GC walk before delete.
  if (m && method === "GET") {
    const entry = skills.get(decodeURIComponent(m[1]));
    record({ phase, provider: "anthropic", method, path: url.pathname, outcome: entry ? "200 versions" : "404" });
    if (!entry) return new Response("", { status: 404 });
    return json({ data: entry.versions.map((v) => ({ version: v })), has_more: false });
  }
  // DELETE /v1/skills/<id>[/versions/<v>] — disposable-probe reclamation.
  m = url.pathname.match(/^\/v1\/skills\/([^/]+)(?:\/versions\/([^/]+))?$/);
  if (m && method === "DELETE") {
    const id = decodeURIComponent(m[1]);
    if (m[2]) {
      const entry = skills.get(id);
      if (entry) entry.versions = entry.versions.filter((v) => v !== decodeURIComponent(m[2]));
    } else {
      skills.delete(id);
    }
    record({ phase, provider: "anthropic", method, path: url.pathname, outcome: "204 deleted" });
    return new Response("", { status: 204 });
  }
  // POST /v1/messages — the native-skills probe AND the assistant turn.
  // `probeAccept:false` reproduces a workspace that rejects container.skills.
  if (url.pathname === "/v1/messages" && method === "POST") {
    let ref = null;
    const s = (await readBody(input, init))?.container?.skills?.[0];
    if (s) ref = { skill_id: s.skill_id, version: s.version, type: s.type };
    const accept = ctl.probeAccept !== false;
    record({
      phase,
      provider: "anthropic",
      method,
      path: url.pathname,
      containerSkillsRef: ref,
      outcome: accept ? "200 accepted" : "400 rejected",
    });
    if (!accept) {
      return json(
        {
          type: "error",
          error: {
            type: "invalid_request_error",
            message:
              "container.skills is not enabled for this workspace. Enable the skills beta for this API key before referencing a custom skill.",
          },
        },
        400,
      );
    }
    return json({
      id: `msg_setup2392_${++seq}`,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: TURN_SENTINEL }],
      stop_reason: "end_turn",
      usage: { input_tokens: 4, output_tokens: 4 },
    });
  }

  record({ phase, provider: "anthropic", method, path: url.pathname, outcome: "200 generic" });
  return json({});
};

console.log(`[setup-acceptance-stub] installed — ledger ${LEDGER}`);

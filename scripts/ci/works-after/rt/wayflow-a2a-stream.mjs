#!/usr/bin/env node
// Wayflow works-after A2A STREAM round-trip probe (cinatra#1148).
//
// Companion to rt/wayflow-a2a-send.mjs. Where the send probe proves the
// BLOCKING message/send path, this drives the STREAMING path: it POSTs an A2A
// `message/stream` to the echo agent mounted by the candidate wayflow runtime,
// reads the Server-Sent-Events response, and asserts (a) the stream reaches a
// terminal `completed` status and (b) the round-tripped nonce surfaces in an
// AGENT output (the EndNode sentinel DataPart `__cinatra_endnode_outputs__`,
// and/or a rendered agent text part / artifact) — NOT merely echoed back as the
// user input.
//
// Rationale (cinatra#1148 acceptance-detail): streaming is a distinct,
// load-bearing surface — the `@a2a-js/sdk` multi-line-SSE `data:` handling
// exists precisely because that path broke — and the host-side packages/a2a
// SSE tests MOCK the streaming bridge, so they never exercise the candidate
// runtime's stream surface. This arm boots the real bumped runtime and drives
// its native fasta2a SSE stream.
//
// SSE framing (A2A spec / fasta2a): frames are separated by a blank line; each
// frame carries one or more `data:` lines whose concatenation is a JSON-RPC
// response envelope `{ jsonrpc, id, result: <event> }`. `result.kind` is one of
// `task` | `status-update` | `artifact-update` | `message`; the terminal event
// is marked `final: true`. Multi-line `data:` within a single frame is joined
// with "\n" before parsing (mirrors the @a2a-js multi-line-SSE fix).
//
// Env: WAYFLOW_BASE_URL (required), WAYFLOW_AGENT_PATH (required, e.g.
//      /agents/cinatra-works-after/echo-proof), WORKS_AFTER_NONCE (required).

const BASE = process.env.WAYFLOW_BASE_URL;
const AGENT = process.env.WAYFLOW_AGENT_PATH;
const NONCE = process.env.WORKS_AFTER_NONCE;
if (!BASE || !AGENT || !NONCE) {
  console.error("wayflow-a2a-stream: WAYFLOW_BASE_URL, WAYFLOW_AGENT_PATH and WORKS_AFTER_NONCE are required");
  process.exit(2);
}

const url = `${BASE.replace(/\/$/, "")}${AGENT}/`;
const payload = {
  jsonrpc: "2.0",
  id: 1,
  method: "message/stream",
  params: {
    message: {
      kind: "message",
      role: "user",
      messageId: `wa-stream-${Date.now()}`,
      // The Cinatra dispatcher's shape: a single text part whose text is JSON.
      parts: [{ kind: "text", text: JSON.stringify({ echo_nonce: NONCE, cinatra_run_id: "works-after-stream" }) }],
    },
    configuration: { acceptedOutputModes: ["text"] },
  },
};

const res = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "text/event-stream" },
  body: JSON.stringify(payload),
  signal: AbortSignal.timeout(60_000),
});

if (!res.ok) {
  const errText = await res.text().catch(() => "");
  console.error(`wayflow-a2a-stream: HTTP ${res.status} from ${url}: ${errText.slice(0, 400)}`);
  process.exit(1);
}
const ctype = res.headers.get("content-type") || "";
if (!/text\/event-stream/i.test(ctype)) {
  const errText = await res.text().catch(() => "");
  console.error(
    `wayflow-a2a-stream: expected text/event-stream, got '${ctype}'. Body: ${errText.slice(0, 400)}`,
  );
  process.exit(1);
}

// --- Read the whole SSE body, split into frames, parse each JSON-RPC envelope.
const raw = await res.text();
// Frames are separated by a blank line. Tolerate \r\n.
const frames = raw.split(/\r?\n\r?\n/).map((f) => f.trim()).filter(Boolean);

const events = [];
for (const frame of frames) {
  // A frame may carry multiple `data:` lines — concatenate with "\n" per the
  // SSE spec (this is exactly the multi-line-`data:` case the @a2a-js fix
  // covers). Ignore `id:`/`event:`/comment lines.
  const dataLines = frame
    .split(/\r?\n/)
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).replace(/^ /, ""));
  if (dataLines.length === 0) continue;
  const jsonText = dataLines.join("\n");
  let env;
  try {
    env = JSON.parse(jsonText);
  } catch {
    console.error(`wayflow-a2a-stream: non-JSON SSE data frame: ${jsonText.slice(0, 300)}`);
    process.exit(1);
  }
  if (env?.error) {
    console.error(`wayflow-a2a-stream: JSON-RPC error in stream: ${JSON.stringify(env.error).slice(0, 400)}`);
    process.exit(1);
  }
  if (env?.result !== undefined) events.push(env.result);
}

if (events.length === 0) {
  console.error(`wayflow-a2a-stream: SSE stream carried no result events. Raw: ${raw.slice(0, 400)}`);
  process.exit(1);
}

// --- Terminal state: the A2A stream MUST end with the canonical terminal — a
// `status-update` carrying BOTH `state: "completed"` AND `final: true`. A stream
// that surfaces a `completed` snapshot but never emits the `final: true`
// terminator (or closes early) is a broken streaming surface and must FAIL: the
// proper end-of-stream marker is exactly what a runtime bump can regress. Roles
// are matched STRICTLY (`=== "agent"`) so a role-less/malformed or echoed-user
// message can never be counted as agent output.
let completedFinal = false; // saw the canonical completed + final:true terminal
let lastState;
let sawFinal = false;
// --- Collect AGENT output parts across every event kind.
const outputParts = []; // parts that originate from the agent/flow output
for (const ev of events) {
  const kind = ev?.kind;
  if (kind === "task") {
    lastState = ev?.status?.state ?? lastState;
    for (const m of Array.isArray(ev?.history) ? ev.history : []) {
      if (m?.role === "agent") for (const p of m?.parts ?? []) outputParts.push(p);
    }
    for (const a of Array.isArray(ev?.artifacts) ? ev.artifacts : []) {
      for (const p of a?.parts ?? []) outputParts.push(p);
    }
    if (ev?.status?.message?.role === "agent") {
      for (const p of ev?.status?.message?.parts ?? []) outputParts.push(p);
    }
  } else if (kind === "status-update") {
    lastState = ev?.status?.state ?? lastState;
    if (ev?.final === true) sawFinal = true;
    if (ev?.final === true && ev?.status?.state === "completed") completedFinal = true;
    const msg = ev?.status?.message;
    if (msg?.role === "agent") for (const p of msg?.parts ?? []) outputParts.push(p);
  } else if (kind === "artifact-update") {
    // Artifacts are agent-produced output (no role field); always agent output.
    for (const p of ev?.artifact?.parts ?? []) outputParts.push(p);
  } else if (kind === "message") {
    if (ev?.role === "agent") for (const p of ev?.parts ?? []) outputParts.push(p);
  }
}

if (!completedFinal) {
  console.error(
    `wayflow-a2a-stream: stream did not reach the canonical terminal (a status-update with state 'completed' AND final:true) — last state '${lastState ?? "<none>"}', sawFinal=${sawFinal}. Events: ${JSON.stringify(events).slice(0, 700)}`,
  );
  process.exit(1);
}

// --- Assert the nonce surfaced in an AGENT output part (structured EndNode
// sentinel preferred; agent text/artifact fallback). Mirrors the send probe:
// a whole-body substring match would falsely pass on the echoed user input.
let endnodeNonce;
for (const p of outputParts) {
  const out = p?.kind === "data" ? p?.data?.__cinatra_endnode_outputs__ : undefined;
  if (out && Object.prototype.hasOwnProperty.call(out, "echo_nonce")) {
    endnodeNonce = String(out.echo_nonce);
  }
}

if (endnodeNonce !== undefined) {
  if (endnodeNonce !== NONCE) {
    console.error(
      `wayflow-a2a-stream: EndNode output echo_nonce='${endnodeNonce}' != sent nonce '${NONCE}'. Events: ${JSON.stringify(events).slice(0, 800)}`,
    );
    process.exit(1);
  }
  console.log(
    `wayflow-a2a-stream OK — A2A message/stream reached 'completed'; EndNode structured output echo_nonce matched the sent nonce '${NONCE}' over ${events.length} SSE event(s).`,
  );
  process.exit(0);
}

const textCarriesNonce = outputParts.some(
  (p) => p?.kind === "text" && typeof p?.text === "string" && p.text.includes(NONCE),
);
if (!textCarriesNonce) {
  console.error(
    `wayflow-a2a-stream: nonce '${NONCE}' did not surface in any AGENT output over the stream (no __cinatra_endnode_outputs__ sentinel and no agent text/artifact part carried it) — the stream completed but produced no nonce-bearing output. Events: ${JSON.stringify(events).slice(0, 800)}`,
  );
  process.exit(1);
}
console.log(
  `wayflow-a2a-stream OK — A2A message/stream reached 'completed'; agent output carried the sent nonce '${NONCE}' over ${events.length} SSE event(s) (no structured sentinel on this build).`,
);
process.exit(0);

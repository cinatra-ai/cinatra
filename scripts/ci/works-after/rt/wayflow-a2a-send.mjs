#!/usr/bin/env node
// Wayflow works-after A2A round-trip probe (cinatra#352).
//
// Sends ONE A2A message/send (blocking) to the echo agent mounted by the
// candidate wayflow runtime and asserts the task reaches `completed` with the
// round-tripped nonce surfaced (the EndNode output sentinel DataPart
// __cinatra_endnode_outputs__, and/or the rendered echo text). Runs from the
// HOST against the runtime's loopback host port.
//
// Env: WAYFLOW_BASE_URL (required), WAYFLOW_AGENT_PATH (required, e.g.
//      /agents/cinatra-works-after/echo-proof), WORKS_AFTER_NONCE (required).

const BASE = process.env.WAYFLOW_BASE_URL;
const AGENT = process.env.WAYFLOW_AGENT_PATH;
const NONCE = process.env.WORKS_AFTER_NONCE;
if (!BASE || !AGENT || !NONCE) {
  console.error("wayflow-a2a-send: WAYFLOW_BASE_URL, WAYFLOW_AGENT_PATH and WORKS_AFTER_NONCE are required");
  process.exit(2);
}

const url = `${BASE.replace(/\/$/, "")}${AGENT}/`;
const payload = {
  jsonrpc: "2.0",
  id: 1,
  method: "message/send",
  params: {
    message: {
      kind: "message",
      role: "user",
      messageId: `wa-${Date.now()}`,
      // The Cinatra dispatcher's shape: a single text part whose text is JSON.
      parts: [{ kind: "text", text: JSON.stringify({ echo_nonce: NONCE, cinatra_run_id: "works-after" }) }],
    },
    configuration: { blocking: true, acceptedOutputModes: ["text"] },
  },
};

const res = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
  signal: AbortSignal.timeout(60_000),
});
const text = await res.text();
if (!res.ok) {
  console.error(`wayflow-a2a-send: HTTP ${res.status} from ${url}: ${text.slice(0, 400)}`);
  process.exit(1);
}
let body;
try {
  body = JSON.parse(text);
} catch {
  console.error(`wayflow-a2a-send: non-JSON response: ${text.slice(0, 300)}`);
  process.exit(1);
}
const state = body?.result?.status?.state;
if (state !== "completed") {
  console.error(`wayflow-a2a-send: task state '${state}', expected 'completed'. Body: ${JSON.stringify(body).slice(0, 600)}`);
  process.exit(1);
}

// Assert the nonce surfaced in the AGENT OUTPUT — NOT anywhere in the body.
// The user message (history[0]) echoes the nonce back as input, so a whole-body
// substring match would pass even if the flow produced no output (a false green
// hiding a broken runtime). The runtime surfaces the EndNode's resolved outputs
// as a structured DataPart under `__cinatra_endnode_outputs__` (agent role); the
// OutputMessageNode also renders `works-after echo: <nonce>` as an agent text
// part. Require the STRUCTURED EndNode output to carry the exact nonce (the real
// "the flow ran and surfaced its declared output" proof); fall back to an
// agent-role text part only if the runtime build omits the sentinel.
const history = Array.isArray(body?.result?.history) ? body.result.history : [];
const agentMsgs = history.filter((m) => m?.role === "agent");

let endnoteNonce;
for (const m of agentMsgs) {
  for (const p of m?.parts ?? []) {
    const out = p?.kind === "data" ? p?.data?.__cinatra_endnode_outputs__ : undefined;
    if (out && Object.prototype.hasOwnProperty.call(out, "echo_nonce")) {
      endnoteNonce = String(out.echo_nonce);
    }
  }
}

if (endnoteNonce !== undefined) {
  if (endnoteNonce !== NONCE) {
    console.error(
      `wayflow-a2a-send: EndNode output echo_nonce='${endnoteNonce}' != sent nonce '${NONCE}'. Body: ${JSON.stringify(body).slice(0, 800)}`,
    );
    process.exit(1);
  }
  console.log(
    `wayflow-a2a-send OK — A2A message/send → completed task; EndNode structured output echo_nonce matched the sent nonce '${NONCE}'.`,
  );
  process.exit(0);
}

// Fallback: no structured sentinel on this build — require an AGENT-role text
// part to carry the nonce (still proves the flow produced output, not just that
// the input echoed back).
const agentTextCarriesNonce = agentMsgs.some((m) =>
  (m?.parts ?? []).some((p) => p?.kind === "text" && typeof p?.text === "string" && p.text.includes(NONCE)),
);
if (!agentTextCarriesNonce) {
  console.error(
    `wayflow-a2a-send: nonce '${NONCE}' did not surface in any AGENT output (no __cinatra_endnode_outputs__ sentinel and no agent text part carried it) — the task completed but produced no nonce-bearing output. Body: ${JSON.stringify(body).slice(0, 800)}`,
  );
  process.exit(1);
}
console.log(
  `wayflow-a2a-send OK — A2A message/send → completed task; agent text output carried the sent nonce '${NONCE}' (no structured sentinel on this build).`,
);
process.exit(0);

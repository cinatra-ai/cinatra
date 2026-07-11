#!/usr/bin/env node
// Wayflow works-after A2A STREAM round-trip probe (cinatra#1148).
//
// Companion to rt/wayflow-a2a-send.mjs. Where the send probe proves the
// BLOCKING message/send path, this drives the STREAMING path — but it is
// CAPABILITY-AWARE (owner decision cinatra#1148, Option B):
//
//   1. It first reads the runtime's A2A agent card
//      ({agentPath}/.well-known/agent-card.json) and inspects
//      `capabilities.streaming`.
//   2. When the card declares streaming = false (or omits it), the runtime does
//      NOT ship a message/stream surface: the arm records an explicit
//      "not applicable — runtime declares no streaming" result (exit 0, LOUD log
//      line) rather than failing on a surface that is legitimately absent.
//   3. When the card declares streaming = true, the full stream round-trip is
//      REQUIRED: it POSTs an A2A `message/stream`, reads the Server-Sent-Events
//      response, and asserts (a) the stream reaches the canonical terminal (a
//      `status-update` with state `completed` AND `final: true`) and (b) the
//      round-tripped nonce surfaces in an AGENT output (the EndNode sentinel
//      DataPart `__cinatra_endnode_outputs__`, and/or a rendered agent text part
//      / artifact) — NOT merely echoed back as the user input, with roles matched
//      STRICTLY (`=== "agent"`).
//   4. CARD-CONSISTENCY: if the card CLAIMS streaming = true and the round-trip
//      fails for any reason, the arm FAILS (exit 1) — it is NEVER downgraded to
//      "not applicable". A runtime that advertises a surface must deliver it.
//
// Rationale (cinatra#1148 acceptance-detail): streaming is a distinct,
// load-bearing surface — the `@a2a-js/sdk` multi-line-SSE `data:` handling
// exists precisely because that path broke — and the host-side packages/a2a
// SSE tests MOCK the streaming bridge, so they never exercise the candidate
// runtime's stream surface. This arm boots the real bumped runtime and drives
// its native fasta2a SSE stream WHEN the runtime advertises it.
//
// SSE framing (A2A spec / fasta2a): frames are separated by a blank line; each
// frame carries one or more `data:` lines whose concatenation is a JSON-RPC
// response envelope `{ jsonrpc, id, result: <event> }`. `result.kind` is one of
// `task` | `status-update` | `artifact-update` | `message`; the terminal event
// is marked `final: true`. Multi-line `data:` within a single frame is joined
// with "\n" before parsing (mirrors the @a2a-js multi-line-SSE fix).
//
// Env (CLI mode): WAYFLOW_BASE_URL (required), WAYFLOW_AGENT_PATH (required,
//      e.g. /agents/cinatra-works-after/echo-proof), WORKS_AFTER_NONCE
//      (required).
//
// The pure pieces (fetchAgentCard, streamRoundTrip, runStreamArm) are exported
// so the works-after unit suite can exercise all three branches against a
// fixture HTTP server without booting a container.

import { pathToFileURL } from "node:url";

const DEFAULT_TIMEOUT_MS = 60_000;

// Thrown by the card fetch and the round-trip on any protocol / assertion
// failure. runStreamArm() maps these to the correct exit code + branch.
export class StreamProbeError extends Error {}

function trimBase(base) {
  return String(base).replace(/\/$/, "");
}

// --- Read the runtime's A2A agent card for {agentPath} and return the parsed
// card object. Throws StreamProbeError on a non-2xx or non-JSON response (a
// runtime that already answered message/send but cannot serve its own card is
// broken — the caller treats a card-read failure as a hard failure, never n/a).
export async function fetchAgentCard({ base, agentPath, signal } = {}) {
  const url = `${trimBase(base)}${agentPath}/.well-known/agent-card.json`;
  let res;
  try {
    res = await fetch(url, { headers: { accept: "application/json" }, signal });
  } catch (e) {
    throw new StreamProbeError(`agent-card fetch to ${url} threw: ${e?.message ?? e}`);
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new StreamProbeError(`agent-card HTTP ${res.status} from ${url}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new StreamProbeError(`agent-card at ${url} was not JSON: ${text.slice(0, 300)}`);
  }
}

// --- Drive the message/stream SSE round-trip and assert the terminal state +
// nonce round-trip. Returns { eventCount, matchedVia } on success; throws
// StreamProbeError on ANY failure (HTTP, framing, terminal, nonce).
export async function streamRoundTrip({ base, agentPath, nonce, signal } = {}) {
  const url = `${trimBase(base)}${agentPath}/`;
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
        parts: [{ kind: "text", text: JSON.stringify({ echo_nonce: nonce, cinatra_run_id: "works-after-stream" }) }],
      },
      configuration: { acceptedOutputModes: ["text"] },
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(payload),
    signal: signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new StreamProbeError(`HTTP ${res.status} from ${url}: ${errText.slice(0, 400)}`);
  }
  const ctype = res.headers.get("content-type") || "";
  if (!/text\/event-stream/i.test(ctype)) {
    const errText = await res.text().catch(() => "");
    throw new StreamProbeError(`expected text/event-stream, got '${ctype}'. Body: ${errText.slice(0, 400)}`);
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
      throw new StreamProbeError(`non-JSON SSE data frame: ${jsonText.slice(0, 300)}`);
    }
    if (env?.error) {
      throw new StreamProbeError(`JSON-RPC error in stream: ${JSON.stringify(env.error).slice(0, 400)}`);
    }
    if (env?.result !== undefined) events.push(env.result);
  }

  if (events.length === 0) {
    throw new StreamProbeError(`SSE stream carried no result events. Raw: ${raw.slice(0, 400)}`);
  }

  // --- Terminal state: the A2A stream MUST end with the canonical terminal — a
  // `status-update` carrying BOTH `state: "completed"` AND `final: true`. A
  // stream that surfaces a `completed` snapshot but never emits the `final: true`
  // terminator (or closes early) is a broken streaming surface and must FAIL:
  // the proper end-of-stream marker is exactly what a runtime bump can regress.
  // Roles are matched STRICTLY (`=== "agent"`) so a role-less/malformed or
  // echoed-user message can never be counted as agent output.
  let completedFinal = false; // saw the canonical completed + final:true terminal
  let lastState;
  let sawFinal = false;
  let finalIndex = -1; // index of the FIRST final:true result event
  // --- Collect output parts. `sentinelParts` are all agent-ORIGIN parts eligible
  // to carry the structured EndNode sentinel (strict agent-role messages AND
  // artifacts, which are agent-produced by definition and never user input).
  // `agentTextParts` are STRICTLY agent-role message parts only — the plain-text
  // nonce fallback consults this narrower set so a role-less part can never be
  // counted as agent text output (mirrors the send probe's strict-role rule).
  const sentinelParts = [];
  const agentTextParts = [];
  events.forEach((ev, i) => {
    const kind = ev?.kind;
    if (kind === "task") {
      lastState = ev?.status?.state ?? lastState;
      for (const m of Array.isArray(ev?.history) ? ev.history : []) {
        if (m?.role === "agent") for (const p of m?.parts ?? []) { sentinelParts.push(p); agentTextParts.push(p); }
      }
      for (const a of Array.isArray(ev?.artifacts) ? ev.artifacts : []) {
        for (const p of a?.parts ?? []) sentinelParts.push(p);
      }
      if (ev?.status?.message?.role === "agent") {
        for (const p of ev?.status?.message?.parts ?? []) { sentinelParts.push(p); agentTextParts.push(p); }
      }
    } else if (kind === "status-update") {
      lastState = ev?.status?.state ?? lastState;
      if (ev?.final === true) { sawFinal = true; if (finalIndex === -1) finalIndex = i; }
      if (ev?.final === true && ev?.status?.state === "completed") completedFinal = true;
      const msg = ev?.status?.message;
      if (msg?.role === "agent") for (const p of msg?.parts ?? []) { sentinelParts.push(p); agentTextParts.push(p); }
    } else if (kind === "artifact-update") {
      // Artifacts are agent-produced output (no role field); sentinel-eligible.
      for (const p of ev?.artifact?.parts ?? []) sentinelParts.push(p);
    } else if (kind === "message") {
      if (ev?.final === true) { sawFinal = true; if (finalIndex === -1) finalIndex = i; }
      if (ev?.role === "agent") for (const p of ev?.parts ?? []) { sentinelParts.push(p); agentTextParts.push(p); }
    }
  });

  if (!completedFinal) {
    throw new StreamProbeError(
      `stream did not reach the canonical terminal (a status-update with state 'completed' AND final:true) — last state '${lastState ?? "<none>"}', sawFinal=${sawFinal}. Events: ${JSON.stringify(events).slice(0, 700)}`,
    );
  }
  // The final:true event MUST actually terminate the stream — any result event
  // after it means the runtime did not honour the terminator (a broken streaming
  // surface a bump can regress). Reject events emitted after the terminal.
  if (finalIndex !== -1 && finalIndex !== events.length - 1) {
    throw new StreamProbeError(
      `stream emitted ${events.length - 1 - finalIndex} result event(s) AFTER the final:true terminator (index ${finalIndex} of ${events.length}) — final:true must terminate the stream. Events: ${JSON.stringify(events).slice(0, 700)}`,
    );
  }

  // --- Assert the nonce surfaced in an AGENT output part (structured EndNode
  // sentinel preferred; strict-agent-role text fallback). Mirrors the send probe:
  // a whole-body substring match would falsely pass on the echoed user input.
  let endnodeNonce;
  for (const p of sentinelParts) {
    const out = p?.kind === "data" ? p?.data?.__cinatra_endnode_outputs__ : undefined;
    if (out && Object.prototype.hasOwnProperty.call(out, "echo_nonce")) {
      endnodeNonce = String(out.echo_nonce);
    }
  }

  if (endnodeNonce !== undefined) {
    if (endnodeNonce !== nonce) {
      throw new StreamProbeError(
        `EndNode output echo_nonce='${endnodeNonce}' != sent nonce '${nonce}'. Events: ${JSON.stringify(events).slice(0, 800)}`,
      );
    }
    return { eventCount: events.length, matchedVia: "endnode-sentinel" };
  }

  const textCarriesNonce = agentTextParts.some(
    (p) => p?.kind === "text" && typeof p?.text === "string" && p.text.includes(nonce),
  );
  if (!textCarriesNonce) {
    throw new StreamProbeError(
      `nonce '${nonce}' did not surface in any AGENT output over the stream (no __cinatra_endnode_outputs__ sentinel and no strict agent-role text part carried it) — the stream completed but produced no nonce-bearing agent output. Events: ${JSON.stringify(events).slice(0, 800)}`,
    );
  }
  return { eventCount: events.length, matchedVia: "agent-text" };
}

// --- Capability-aware orchestration of the stream arm. Returns
// { code, applicable } and NEVER throws:
//   - card unreadable                        → { code: 1, applicable: null }  (runtime broken)
//   - streaming present but NON-boolean      → { code: 1, applicable: null }  (MALFORMED card)
//   - streaming === false OR absent          → { code: 0, applicable: false } (n/a, LOUD log)
//   - streaming === true + round-trip OK     → { code: 0, applicable: true }
//   - streaming === true + round-trip FAILS  → { code: 1, applicable: true }  (card-consistency)
export async function runStreamArm({ base, agentPath, nonce, signal, log = console.log, err = console.error } = {}) {
  let card;
  try {
    card = await fetchAgentCard({ base, agentPath, signal });
  } catch (e) {
    err(`wayflow-a2a-stream: could not read the runtime agent card — cannot decide streaming capability: ${e?.message ?? e}`);
    return { code: 1, applicable: null };
  }

  // capabilities.streaming is a BOOLEAN in the A2A card. n/a is permitted ONLY
  // when it is explicitly `false` or entirely ABSENT (undefined). A present but
  // non-boolean value ("true", null, 0, …) is a MALFORMED card and must HARD-FAIL
  // — it must never be silently downgraded to n/a (that would false-green a
  // broken/garbage card).
  const streaming = card?.capabilities?.streaming;
  if (streaming !== true && streaming !== false && streaming !== undefined) {
    err(
      `wayflow-a2a-stream: runtime agent card has a MALFORMED capabilities.streaming=${JSON.stringify(streaming)} (expected a boolean) — cannot decide the streaming capability; failing rather than recording a false n/a.`,
    );
    return { code: 1, applicable: null };
  }
  if (streaming !== true) {
    log(
      `wayflow-a2a-stream: NOT APPLICABLE — runtime agent card declares capabilities.streaming=${JSON.stringify(streaming)} (no message/stream surface); recording n/a and skipping the stream round-trip (owner Option B, cinatra#1148). This is a PASS.`,
    );
    return { code: 0, applicable: false };
  }

  // The card advertises streaming — the round-trip is REQUIRED (card-consistency:
  // a claimed surface that fails is a FAILURE, never downgraded to n/a).
  try {
    const { eventCount, matchedVia } = await streamRoundTrip({ base, agentPath, nonce, signal });
    log(
      `wayflow-a2a-stream OK — card advertises streaming:true and A2A message/stream reached 'completed' + final:true; nonce '${nonce}' matched via ${matchedVia} over ${eventCount} SSE event(s).`,
    );
    return { code: 0, applicable: true };
  } catch (e) {
    err(
      `wayflow-a2a-stream: card declares capabilities.streaming=true but the message/stream round-trip FAILED (card-consistency violation — a runtime that advertises streaming MUST deliver it): ${e?.message ?? e}`,
    );
    return { code: 1, applicable: true };
  }
}

// --- CLI entrypoint (skipped when imported by the unit suite).
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const BASE = process.env.WAYFLOW_BASE_URL;
  const AGENT = process.env.WAYFLOW_AGENT_PATH;
  const NONCE = process.env.WORKS_AFTER_NONCE;
  if (!BASE || !AGENT || !NONCE) {
    console.error("wayflow-a2a-stream: WAYFLOW_BASE_URL, WAYFLOW_AGENT_PATH and WORKS_AFTER_NONCE are required");
    process.exit(2);
  }
  const { code } = await runStreamArm({ base: BASE, agentPath: AGENT, nonce: NONCE });
  process.exit(code);
}

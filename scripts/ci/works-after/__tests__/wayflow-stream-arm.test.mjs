// Unit tests for the CAPABILITY-AWARE wayflow message/stream arm (cinatra#1148,
// owner Option B). Fixture-level: a tiny in-process HTTP server stands in for the
// candidate runtime — NO container boot. Exercises the three branches of
// runStreamArm() plus the card-unreadable hard-fail edge:
//
//   1. card capabilities.streaming = false  → NOT APPLICABLE, exit 0 (a PASS).
//   2. card streaming = true + a valid SSE round-trip → REQUIRED and passes, exit 0.
//   3. card streaming = true + a broken SSE round-trip → card-consistency FAIL, exit 1
//      (NEVER downgraded to n/a).
//   4. card unreadable (runtime broken) → hard FAIL, exit 1.
//
// Run: node --test scripts/ci/works-after/__tests__/*.test.mjs (== npm run works-after:test)

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  runStreamArm,
  fetchAgentCard,
  streamRoundTrip,
  StreamProbeError,
} from "../rt/wayflow-a2a-stream.mjs";

const AGENT_PATH = "/agents/cinatra-works-after/echo-proof";

// Silence the arm's own log/err in the passing paths; capture lines for asserts.
function collector() {
  const lines = [];
  return { sink: (...a) => lines.push(a.join(" ")), lines };
}

// Build a runtime stub. `card` is the agent-card JSON; `sse(nonce)` returns the
// SSE body string for a POST message/stream (omit to reject the POST). The card
// route can be disabled to simulate a broken runtime.
async function withRuntime({ card, sse, cardStatus = 200 }, fn) {
  const server = createServer(async (req, res) => {
    const url = req.url || "";
    if (req.method === "GET" && url.endsWith("/.well-known/agent-card.json")) {
      if (cardStatus !== 200) {
        res.writeHead(cardStatus).end("nope");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(card));
      return;
    }
    if (req.method === "POST" && url === `${AGENT_PATH}/`) {
      // Read the request so we can echo the sent nonce back in the SSE.
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const sentNonce = JSON.parse(parsed.params.message.parts[0].text).echo_nonce;
      if (!sse) {
        res.writeHead(404).end("no stream surface");
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" }).end(sse(sentNonce));
      return;
    }
    res.writeHead(404).end("not found");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// A well-formed terminal SSE: a working snapshot then a completed + final:true
// status-update whose agent message carries the EndNode sentinel with the nonce.
function goodSse(nonce) {
  const working = { jsonrpc: "2.0", id: 1, result: { kind: "task", status: { state: "working" } } };
  const terminal = {
    jsonrpc: "2.0",
    id: 1,
    result: {
      kind: "status-update",
      final: true,
      status: {
        state: "completed",
        message: {
          role: "agent",
          parts: [{ kind: "data", data: { __cinatra_endnode_outputs__: { echo_nonce: nonce } } }],
        },
      },
    },
  };
  return `data: ${JSON.stringify(working)}\n\ndata: ${JSON.stringify(terminal)}\n\n`;
}

// A broken stream: reaches 'completed' but NEVER emits final:true — exactly the
// regression the terminal assertion exists to catch.
function brokenSse() {
  const snap = {
    jsonrpc: "2.0",
    id: 1,
    result: { kind: "status-update", final: false, status: { state: "completed" } },
  };
  return `data: ${JSON.stringify(snap)}\n\n`;
}

// A stream where the canonical completed+final:true event is followed by MORE
// result events (state:working) — the terminator did not actually terminate.
function finalThenMoreSse(nonce) {
  const terminal = {
    jsonrpc: "2.0",
    id: 1,
    result: {
      kind: "status-update",
      final: true,
      status: {
        state: "completed",
        message: {
          role: "agent",
          parts: [{ kind: "data", data: { __cinatra_endnode_outputs__: { echo_nonce: nonce } } }],
        },
      },
    },
  };
  const after = { jsonrpc: "2.0", id: 1, result: { kind: "status-update", final: false, status: { state: "working" } } };
  return `data: ${JSON.stringify(terminal)}\n\ndata: ${JSON.stringify(after)}\n\n`;
}

test("branch 1 — card streaming:false → NOT APPLICABLE (exit 0, loud n/a log)", async () => {
  await withRuntime(
    { card: { capabilities: { streaming: false, pushNotifications: false } } /* no sse: POST would 404 */ },
    async (base) => {
      const { sink, lines } = collector();
      const r = await runStreamArm({ base, agentPath: AGENT_PATH, nonce: "n-1", log: sink, err: sink });
      assert.equal(r.code, 0, "streaming:false must be a PASS");
      assert.equal(r.applicable, false, "must record not-applicable");
      assert.ok(
        lines.some((l) => /NOT APPLICABLE/.test(l) && /streaming=false/.test(l)),
        `expected a loud n/a log line, got: ${lines.join(" | ")}`,
      );
    },
  );
});

test("branch 1b — card omits capabilities.streaming → NOT APPLICABLE (exit 0)", async () => {
  await withRuntime({ card: { capabilities: { pushNotifications: false } } }, async (base) => {
    const { sink } = collector();
    const r = await runStreamArm({ base, agentPath: AGENT_PATH, nonce: "n-1b", log: sink, err: sink });
    assert.equal(r.code, 0);
    assert.equal(r.applicable, false);
  });
});

// An artifact-update (role-LESS, agent-origin) carrying the structured EndNode
// sentinel, plus a bare completed+final terminal. The sentinel must be honoured.
function artifactSentinelSse(nonce) {
  const artifact = {
    jsonrpc: "2.0",
    id: 1,
    result: {
      kind: "artifact-update",
      artifact: { parts: [{ kind: "data", data: { __cinatra_endnode_outputs__: { echo_nonce: nonce } } }] },
    },
  };
  const terminal = { jsonrpc: "2.0", id: 1, result: { kind: "status-update", final: true, status: { state: "completed" } } };
  return `data: ${JSON.stringify(artifact)}\n\ndata: ${JSON.stringify(terminal)}\n\n`;
}

// A completed+final stream whose ONLY nonce carrier is role-LESS artifact TEXT
// (no structured sentinel, no agent-role text). The strict-role text fallback
// must REJECT this — a role-less part is not agent text output.
function artifactTextOnlySse(nonce) {
  const artifact = {
    jsonrpc: "2.0",
    id: 1,
    result: { kind: "artifact-update", artifact: { parts: [{ kind: "text", text: `echo ${nonce}` }] } },
  };
  const terminal = { jsonrpc: "2.0", id: 1, result: { kind: "status-update", final: true, status: { state: "completed" } } };
  return `data: ${JSON.stringify(artifact)}\n\ndata: ${JSON.stringify(terminal)}\n\n`;
}

test("branch 2b — artifact-borne structured sentinel is honoured (exit 0)", async () => {
  await withRuntime(
    { card: { capabilities: { streaming: true } }, sse: artifactSentinelSse },
    async (base) => {
      const { sink, lines } = collector();
      const r = await runStreamArm({ base, agentPath: AGENT_PATH, nonce: "n-2b", log: sink, err: sink });
      assert.equal(r.code, 0, `artifact sentinel should pass, logs: ${lines.join(" | ")}`);
      assert.equal(r.applicable, true);
    },
  );
});

test("branch 3d — role-less artifact TEXT alone does NOT satisfy the strict-role fallback (exit 1)", async () => {
  await withRuntime(
    { card: { capabilities: { streaming: true } }, sse: artifactTextOnlySse },
    async (base) => {
      const { sink } = collector();
      const r = await runStreamArm({ base, agentPath: AGENT_PATH, nonce: "n-3d", log: sink, err: sink });
      assert.equal(r.code, 1, "role-less artifact text must not count as agent text output");
      assert.equal(r.applicable, true);
    },
  );
});

test("branch 2 — card streaming:true + valid round-trip → REQUIRED and passes (exit 0)", async () => {
  await withRuntime(
    { card: { capabilities: { streaming: true, pushNotifications: false } }, sse: goodSse },
    async (base) => {
      const { sink, lines } = collector();
      const r = await runStreamArm({ base, agentPath: AGENT_PATH, nonce: "n-2", log: sink, err: sink });
      assert.equal(r.code, 0, `expected pass, logs: ${lines.join(" | ")}`);
      assert.equal(r.applicable, true, "streaming:true is an applicable/ran result");
      assert.ok(lines.some((l) => /OK/.test(l) && /completed/.test(l)), "expected an OK log");
    },
  );
});

test("branch 3 — card streaming:true + broken round-trip → CARD-CONSISTENCY FAIL (exit 1, never n/a)", async () => {
  await withRuntime(
    { card: { capabilities: { streaming: true, pushNotifications: false } }, sse: brokenSse },
    async (base) => {
      const { sink, lines } = collector();
      const r = await runStreamArm({ base, agentPath: AGENT_PATH, nonce: "n-3", log: sink, err: sink });
      assert.equal(r.code, 1, "a claimed-but-broken streaming surface MUST fail");
      assert.equal(r.applicable, true, "must NOT be downgraded to not-applicable");
      assert.ok(
        lines.some((l) => /card-consistency/i.test(l)),
        `expected a card-consistency failure log, got: ${lines.join(" | ")}`,
      );
    },
  );
});

test("branch 3b — streaming:true + nonce mismatch → CARD-CONSISTENCY FAIL (exit 1)", async () => {
  await withRuntime(
    {
      card: { capabilities: { streaming: true, pushNotifications: false } },
      sse: () => goodSse("a-different-nonce"),
    },
    async (base) => {
      const { sink } = collector();
      const r = await runStreamArm({ base, agentPath: AGENT_PATH, nonce: "n-3b", log: sink, err: sink });
      assert.equal(r.code, 1);
      assert.equal(r.applicable, true);
    },
  );
});

test("edge — MALFORMED capabilities.streaming ('true' string) → hard FAIL, never n/a (exit 1)", async () => {
  await withRuntime({ card: { capabilities: { streaming: "true" } } }, async (base) => {
    const { sink, lines } = collector();
    const r = await runStreamArm({ base, agentPath: AGENT_PATH, nonce: "n-m", log: sink, err: sink });
    assert.equal(r.code, 1, "a non-boolean streaming value must NOT be downgraded to n/a");
    assert.equal(r.applicable, null);
    assert.ok(lines.some((l) => /MALFORMED/.test(l)), `expected a malformed-card log, got: ${lines.join(" | ")}`);
  });
});

test("branch 3c — streaming:true + result events AFTER final:true terminator → CARD-CONSISTENCY FAIL (exit 1)", async () => {
  await withRuntime(
    { card: { capabilities: { streaming: true } }, sse: finalThenMoreSse },
    async (base) => {
      const { sink } = collector();
      const r = await runStreamArm({ base, agentPath: AGENT_PATH, nonce: "n-3c", log: sink, err: sink });
      assert.equal(r.code, 1, "final:true must terminate the stream — trailing events are a failure");
      assert.equal(r.applicable, true);
    },
  );
});

test("edge — agent card unreadable (runtime broken) → hard FAIL (exit 1, applicable null)", async () => {
  await withRuntime({ card: {}, cardStatus: 500 }, async (base) => {
    const { sink, lines } = collector();
    const r = await runStreamArm({ base, agentPath: AGENT_PATH, nonce: "n-e", log: sink, err: sink });
    assert.equal(r.code, 1, "a runtime that cannot serve its own card is broken");
    assert.equal(r.applicable, null);
    assert.ok(lines.some((l) => /could not read the runtime agent card/.test(l)));
  });
});

// Unit-level guards on the exported pieces (no server needed for the error type).
test("fetchAgentCard throws StreamProbeError on a non-200 card", async () => {
  await withRuntime({ card: {}, cardStatus: 404 }, async (base) => {
    await assert.rejects(
      () => fetchAgentCard({ base, agentPath: AGENT_PATH }),
      (e) => e instanceof StreamProbeError,
    );
  });
});

test("streamRoundTrip throws StreamProbeError when the terminal final:true is missing", async () => {
  await withRuntime(
    { card: { capabilities: { streaming: true } }, sse: brokenSse },
    async (base) => {
      await assert.rejects(
        () => streamRoundTrip({ base, agentPath: AGENT_PATH, nonce: "n-x" }),
        (e) => e instanceof StreamProbeError && /canonical terminal/.test(e.message),
      );
    },
  );
});

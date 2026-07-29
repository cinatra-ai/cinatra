/**
 * PROVIDER HTTP-BOUNDARY STUB + EGRESS LEDGER (cinatra#2093 S6 render proof).
 *
 * Loaded into the REAL dev server with `node --import`, so it wraps `globalThis.fetch`
 * BEFORE Next.js captures it. Everything inside the app — the server actions, the
 * readiness saga, the connector code, Postgres, the rendered UI — is real. The ONLY
 * thing replaced is the outbound HTTP boundary to the two provider hosts, which is
 * exactly where the connectors' own probe suites stub (`fetch` at the process
 * boundary, asserting the request that would go on the wire). No live provider key
 * is available in this lane, so a live round-trip is not possible here; see PROOF.md.
 *
 * TWO JOBS:
 *   1. answer `api.openai.com` / `api.anthropic.com` from a scripted table whose
 *      arms are flipped at runtime through a control file (no server restart, so a
 *      single boot drives every flow);
 *   2. APPEND EVERY provider-host request to an egress ledger. That ledger is what
 *      makes "the OpenAI path performs ZERO Anthropic egress" a MEASURED claim
 *      rather than a comment: the assertion reads the recorded calls.
 *
 * The ledger records method + host + path + a request-body fingerprint only.
 * Headers are NEVER recorded — the `x-api-key` / `Authorization` header rides every
 * one of these calls and this file is committed to a PUBLIC repo.
 */
import { appendFileSync, readFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const DIR = process.env.LANE_STUB_DIR;
if (!DIR) {
  console.warn("[boundary-stub] LANE_STUB_DIR unset — stub NOT installed");
} else {
  mkdirSync(DIR, { recursive: true });
  const LEDGER = path.join(DIR, "egress.jsonl");
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

  function json(body, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  // Remote state the stub keeps so the skills lifecycle is COHERENT across calls
  // (create -> the id the host then probes -> delete), rather than each call
  // answering in isolation.
  const skills = new Map(); // id -> { versions: string[], displayTitle }
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
      if (url.pathname === "/v1/models" && method === "GET") {
        record({ phase, provider: "openai", method, path: url.pathname, outcome: "200 model-list" });
        if (ctl.openaiKeyValid === false) {
          return json({ error: { message: "Incorrect API key provided." } }, 401);
        }
        return json({
          object: "list",
          // The build-known OpenAI catalog (packages/agents llm-provider-policy),
          // so the form's default-model select resolves the same ids a real
          // account would expose.
          data: [
            { id: "gpt-5.5", object: "model" },
            { id: "gpt-5.4", object: "model" },
            { id: "gpt-5.4-mini", object: "model" },
            { id: "gpt-4.1", object: "model" },
            { id: "gpt-4.1-mini", object: "model" },
          ],
        });
      }
      record({ phase, provider: "openai", method, path: url.pathname, outcome: "200 generic" });
      return json({});
    }

    // --- Anthropic ---------------------------------------------------------
    // POST /v1/skills — create a custom skill (multipart).
    if (url.pathname === "/v1/skills" && method === "POST") {
      const id = `skill_lane2093_${++seq}`;
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
    // POST /v1/messages — THE PROBE. `container.skills` acceptance is the whole
    // question S6's readiness saga exists to ask, so the arm is control-flipped:
    // `probeAccept:false` reproduces a workspace that rejects the request.
    if (url.pathname === "/v1/messages" && method === "POST") {
      let ref = null;
      try {
        const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
        const s = body?.container?.skills?.[0];
        if (s) ref = { skill_id: s.skill_id, version: s.version, type: s.type };
      } catch {
        /* fingerprint only */
      }
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
        id: "msg_lane2093",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "max_tokens",
        usage: { input_tokens: 4, output_tokens: 1 },
      });
    }

    record({ phase, provider: "anthropic", method, path: url.pathname, outcome: "200 generic" });
    return json({});
  };

  console.log(`[boundary-stub] installed — ledger ${path.join(DIR, "egress.jsonl")}`);
}

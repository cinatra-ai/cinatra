/**
 * PROVIDER EGRESS OBSERVER + LEDGER (cinatra#2094 S7 acceptance item 3a).
 *
 * Descends from S6's `evidence/2093-s6-setup/drivers/provider-boundary-stub.mjs`
 * and keeps its ledger contract, with ONE deliberate change:
 *
 *   S6 had no provider key, so its preload ANSWERED provider requests from a
 *   scripted table. This lane HAS the org keys, so nothing is answered here —
 *   every provider request is FORWARDED to the real host and merely RECORDED.
 *   Both arms therefore run LIVE, and the "the OpenAI path performs zero
 *   Anthropic egress" claim stays a MEASUREMENT (the assertion reads this
 *   ledger) instead of becoming an artifact of the stub's own routing.
 *
 * Loaded with `node --import` so it wraps `globalThis.fetch` BEFORE Next.js
 * captures it. Everything inside the app is real; this only observes the wire.
 *
 * LEAK GATE: the ledger records method + host + path + status + a coarse
 * body FINGERPRINT only. Headers are NEVER recorded — the `x-api-key` /
 * `Authorization` header rides every one of these calls and this file and its
 * ledgers are committed to a PUBLIC repo. Remote skill ids are recorded because
 * they are not secrets, but no request or response BODY is ever stored verbatim.
 */
import { appendFileSync, readFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const DIR = process.env.LANE_LEDGER_DIR;
if (!DIR) {
  console.warn("[egress-observer] LANE_LEDGER_DIR unset — observer NOT installed");
} else {
  mkdirSync(DIR, { recursive: true });
  const LEDGER = path.join(DIR, process.env.LANE_LEDGER ?? "egress.jsonl");
  const CONTROL = path.join(DIR, "control.json");
  const PROVIDER_HOSTS = new Set([
    "api.openai.com",
    "api.anthropic.com",
    "generativelanguage.googleapis.com",
  ]);

  function phase() {
    try {
      return JSON.parse(readFileSync(CONTROL, "utf8")).phase ?? "unlabelled";
    } catch {
      return "unlabelled";
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
   * Coarse, NON-reversible shape summary of a request body. Used to tell a
   * `container.skills` probe apart from an ordinary message without storing
   * prompt text. Only structural facts are kept.
   */
  function fingerprint(body) {
    if (typeof body !== "string") return null;
    try {
      const parsed = JSON.parse(body);
      const containerSkills = parsed?.container?.skills;
      return {
        model: typeof parsed?.model === "string" ? parsed.model : null,
        hasContainer: Boolean(parsed?.container),
        containerSkillCount: Array.isArray(containerSkills) ? containerSkills.length : null,
        // Both halves of each reference — the S6 proof asserted on exactly this.
        containerSkillRefs: Array.isArray(containerSkills)
          ? containerSkills.map((s) => ({ skill_id: s?.skill_id, version: s?.version, type: s?.type }))
          : null,
        toolTypes: Array.isArray(parsed?.tools)
          ? parsed.tools.map((t) => t?.type ?? t?.function?.name ?? "unnamed")
          : null,
        messageCount: Array.isArray(parsed?.messages) ? parsed.messages.length : null,
        stream: parsed?.stream === true,
      };
    } catch {
      return { unparsed: true };
    }
  }

  const realFetch = globalThis.fetch;

  globalThis.fetch = async function observedFetch(input, init) {
    let url;
    try {
      url = new URL(typeof input === "string" ? input : (input?.url ?? String(input)));
    } catch {
      return realFetch(input, init);
    }
    if (!PROVIDER_HOSTS.has(url.hostname)) return realFetch(input, init);

    const method = (
      init?.method ??
      (typeof input === "object" ? input?.method : null) ??
      "GET"
    ).toUpperCase();
    const provider =
      url.hostname === "api.openai.com"
        ? "openai"
        : url.hostname === "api.anthropic.com"
          ? "anthropic"
          : "gemini";
    const body = init?.body;
    const fp = typeof body === "string" ? fingerprint(body) : body ? { nonString: true } : null;
    const started = Date.now();

    // PASS THROUGH to the real provider. Nothing is answered locally.
    let res, err;
    try {
      res = await realFetch(input, init);
    } catch (e) {
      err = e;
    }
    record({
      phase: phase(),
      provider,
      method,
      path: url.pathname,
      status: res?.status ?? null,
      ms: Date.now() - started,
      fingerprint: fp,
      ...(err ? { networkError: err instanceof Error ? err.message : String(err) } : {}),
    });
    if (err) throw err;
    return res;
  };

  console.log(`[egress-observer] installed (PASS-THROUGH) — ledger ${LEDGER}`);
}

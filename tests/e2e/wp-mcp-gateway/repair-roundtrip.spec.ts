// Live REPAIR ROUND-TRIP suite for the WP MCP gateway (cinatra#2286 S10,
// deliverable 7 — the #2044 acceptance row "visual before/after renders for a
// repair round-trip" made drivable on the pinned community-stack fixture).
//
// Runs INSIDE the capture workflow (wp-mcp-gateway-capture.yml) via `node --test`
// against the BOOTED pinned fixture, exactly like equivalence.spec.ts (Node 24
// strips the type annotations; no toolchain install). The operator box never
// boots; without a live fixture (WP_BASE_URL / WP_MCP_BASIC_AUTH) every case
// SKIPS — it can never red normal CI.
//
// WHAT IT PROVES, against the real pinned WordPress stack: the WP-side leg of
// the CMS repair round trip. The wordpress-agent producer's repair re-drives
// its staged write through the connector's keyed content write — on the wire
// that is `ewpa/update-post` via the gateway execute triad, the exact ability
// the connector's content-review gate keys (`CONTENT_REVIEW_TARGET_ABILITIES`).
// This suite drives that leg end to end:
//
//   R1 produce   — a draft post is created (the flawed base production a
//                  reviewer will request changes on).
//   R2 repair    — the reviewer's requested changes are applied through
//                  `ewpa/update-post` (the re-staged write the repair run's
//                  tool call performs when the approved apply releases).
//   R3 read-back — the post reads back with the repaired fields, and the
//                  DRAFT status is preserved (a repair never demotes or
//                  publishes as a side effect — the producer's no-demote
//                  contract, observed on the wire).
//   R4 stability — a second independent read-back returns the same repaired
//                  state (durable, not transient).
//
// The CINATRA-side leg (request-changes → producer_repair route → dispatch →
// completion → repaired capture → re-review → approve → effect release) is
// proven on a real Postgres by
// packages/agents/src/__tests__/lifecycle-repair-cms-roundtrip.integration.test.ts
// (the agents-integration-db CI job); its row is recorded in the verdict file
// this suite writes, per the S9 program-acceptance evidence convention.
//
// A FAIL verdict is recorded honestly with the observed detail — each test only
// ASSERTS liveness (the gateway was reachable); the PASS/FAIL verdict is DATA,
// so a FAIL never reds the capture run — only an unreachable gateway does
// (same discipline as equivalence.spec.ts).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { buildProvenance, CANONICAL_PROVENANCE_KEYS, sha256OfFile } from "./provenance.mjs";

const BASE: string = (process.env.WP_BASE_URL || "").replace(/\/+$/, "");
const AUTH: string = process.env.WP_MCP_BASIC_AUTH || "";
const HAVE_FIXTURE: boolean = Boolean(BASE && AUTH);
const REPO_ROOT: string = process.env.CAPTURE_REPO_ROOT || process.cwd();
const CAPTURES_DIR: string = path.join(
  REPO_ROOT,
  "tests/e2e/wp-mcp-gateway/captures/program-acceptance",
);
const RUN_URL: string = process.env.CAPTURE_RUN_URL || "";
const COMMIT: string = process.env.CAPTURE_COMMIT || "";
const DEFAULT_URL = `${BASE}/wp-json/mcp/mcp-adapter-default-server`;
const skipOpts = HAVE_FIXTURE ? {} : { skip: "no live fixture (WP_BASE_URL/WP_MCP_BASIC_AUTH unset)" };

// The reviewer's scenario: the base production carries a verbose headline and a
// placeholder excerpt line; the requested changes tighten the headline and fix
// the excerpt wording. The repaired values are exact-match targets for R3/R4.
const BASE_TITLE = "WP MCP gateway repair round-trip — the original, overly long working headline (#2286)";
const BASE_CONTENT =
  "<p>Original body paragraph for the repair round-trip fixture.</p>\n<p>TODO-EXCERPT: placeholder wording the reviewer flags.</p>";
const REPAIRED_TITLE = "Repair round-trip — tightened headline (#2286)";
const REPAIRED_CONTENT =
  "<p>Original body paragraph for the repair round-trip fixture.</p>\n<p>Reviewer-approved excerpt wording, applied by the producer repair.</p>";

// --- minimal handshake-aware JSON-RPC (mirrors equivalence.spec.ts; kept
//     inline for the same reason it is inline there: the freshness-gate-hashed
//     producers must not be perturbed) --------------------------------------
let __id = 0;
const nextId = () => ++__id;
const norm = (s: unknown) => String(s || "").toLowerCase().replace(/[\s_/-]+/g, "");

function parseSse(text: string): any[] {
  const out: any[] = [];
  for (const line of text.split(/\n/)) {
    const m = line.match(/^data:\s?(.*)$/);
    if (!m) continue;
    try {
      out.push(JSON.parse(m[1]));
    } catch {
      /* ignore */
    }
  }
  return out;
}

async function postJsonRpc(url: string, body: any, sessionId?: string | null): Promise<any> {
  const headers: Record<string, string> = {
    Authorization: `Basic ${AUTH}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
    clearTimeout(timer);
    const rawText = await res.text();
    const ct = res.headers.get("content-type") || "";
    const newSession = res.headers.get("mcp-session-id") || sessionId || null;
    let parsed: any = null;
    if (ct.includes("text/event-stream")) {
      const msgs = parseSse(rawText);
      parsed = msgs.find((m) => m && m.id === body.id) || msgs[msgs.length - 1] || null;
    } else if (rawText) {
      try {
        parsed = JSON.parse(rawText);
      } catch {
        parsed = null;
      }
    }
    return { status: res.status, rawText, parsed, sessionId: newSession };
  } catch (err: any) {
    return { status: 0, rawText: "", parsed: null, sessionId: sessionId || null, error: String(err?.message || err) };
  }
}

const ctx: { session: string | null; exec: string; getInfo: string } = {
  session: null,
  exec: "mcp-adapter-execute-ability",
  getInfo: "mcp-adapter-get-ability-info",
};

async function ensureSession(): Promise<void> {
  if (ctx.session) return;
  const init = await postJsonRpc(DEFAULT_URL, {
    jsonrpc: "2.0",
    id: nextId(),
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cinatra-wp-mcp-repair-roundtrip", version: "1.0.0" } },
  });
  ctx.session = init.sessionId;
  if (init.parsed && !init.parsed.error) {
    await postJsonRpc(DEFAULT_URL, { jsonrpc: "2.0", method: "notifications/initialized", params: {} }, ctx.session);
  }
}

/** Unwrap an execute-ability / get-ability-info tools/call response. */
function unwrap(resp: any): { ok: boolean; data: any; error: any; isError: boolean; raw: any; contentText: string | null } {
  const r = resp?.parsed?.result;
  if (!r) return { ok: false, data: null, error: resp?.parsed?.error || resp?.error || "no result", isError: true, raw: resp, contentText: null };
  const txt = r.content?.[0]?.text;
  const contentText = typeof txt === "string" ? txt : null;
  const sc = r.structuredContent;
  if (sc && typeof sc === "object") {
    return { ok: sc.success !== false && !r.isError, data: sc.data ?? sc, error: sc.error ?? (r.isError ? contentText : null), isError: Boolean(r.isError), raw: r, contentText };
  }
  let parsed: any = null;
  if (contentText) {
    try {
      parsed = JSON.parse(contentText);
    } catch {
      parsed = contentText;
    }
  }
  return { ok: !r.isError, data: parsed?.data ?? parsed, error: parsed?.error ?? (r.isError ? contentText : null), isError: Boolean(r.isError), raw: r, contentText };
}

async function execAbility(abilityId: string, params: Record<string, unknown>): Promise<any> {
  await ensureSession();
  return postJsonRpc(
    DEFAULT_URL,
    { jsonrpc: "2.0", id: nextId(), method: "tools/call", params: { name: ctx.exec, arguments: { ability_name: abilityId, parameters: params } } },
    ctx.session,
  );
}

async function abilityInfo(abilityId: string): Promise<{ inputSchema: any; props: string[]; raw: any }> {
  await ensureSession();
  const resp = await postJsonRpc(
    DEFAULT_URL,
    { jsonrpc: "2.0", id: nextId(), method: "tools/call", params: { name: ctx.getInfo, arguments: { ability_name: abilityId } } },
    ctx.session,
  );
  const info = unwrap(resp).data || {};
  const schema = info.input_schema;
  const properties = schema && !Array.isArray(schema) && schema.properties ? schema.properties : {};
  return { inputSchema: schema ?? null, props: Object.keys(properties), raw: resp };
}

/** Pick the property name from `props` that best matches one of `wants`. */
function pickProp(props: string[], wants: string[], fallback: string): string {
  for (const w of wants) {
    const hit = props.find((p) => norm(p) === norm(w));
    if (hit) return hit;
  }
  for (const w of wants) {
    const hit = props.find((p) => norm(p).includes(norm(w)) || norm(w).includes(norm(p)));
    if (hit) return hit;
  }
  return fallback;
}

/** Authenticated REST read-back (context=edit) — the independent verification
 * read, same device equivalence.spec.ts uses for its status read-back. */
async function readPostBack(postId: number): Promise<{ title: string | null; content: string | null; status: string | null } | null> {
  const rb = await fetch(`${BASE}/wp-json/wp/v2/posts/${postId}?context=edit`, {
    headers: { Authorization: `Basic ${AUTH}` },
  });
  if (!rb.ok) return null;
  const json = (await rb.json()) as any;
  return {
    title: json?.title?.raw ?? json?.title?.rendered ?? null,
    content: json?.content?.raw ?? json?.content?.rendered ?? null,
    status: json?.status ?? null,
  };
}

type Verdict = {
  item: string;
  verdict: "PASS" | "FAIL" | "PENDING_GATE";
  evidence: string;
  detail?: unknown;
};
const verdicts: Verdict[] = [];
const record = (v: Verdict) => verdicts.push(v);

/** The wordpress-agent release under proof, identified by the `resolvedSha`
 * the committed dev lock pins — never a milestone-version literal. */
function pinnedWordPressAgentSha(): string | null {
  try {
    const lock = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "cinatra-dev-extensions.lock.json"), "utf8"),
    ) as { packages?: Array<{ packageName: string; resolvedSha: string }> };
    return lock.packages?.find((p) => p.packageName === "@cinatra-ai/wordpress-agent")?.resolvedSha ?? null;
  } catch {
    return null;
  }
}

let postId: number | null = null;
let repairApplied = false;
let firstReadBack: { title: string | null; content: string | null; status: string | null } | null = null;

before(async () => {
  if (!HAVE_FIXTURE) return;
  const list = await postJsonRpc(DEFAULT_URL, { jsonrpc: "2.0", id: nextId(), method: "tools/list", params: {} });
  await ensureSession();
  const listed = list.parsed?.result?.tools?.length
    ? list.parsed.result.tools
    : (await postJsonRpc(DEFAULT_URL, { jsonrpc: "2.0", id: nextId(), method: "tools/list", params: {} }, ctx.session)).parsed?.result?.tools || [];
  const find = (id: string) => (listed.find((t: any) => norm(t.name) === norm(id)) || {}).name;
  ctx.exec = find("mcp-adapter/execute-ability") || ctx.exec;
  ctx.getInfo = find("mcp-adapter/get-ability-info") || ctx.getInfo;
});

after(() => {
  if (!HAVE_FIXTURE) return;
  // The cinatra-side leg's row — recorded HERE, unconditionally, so a FAIL
  // early-return in R3/R4 can never drop it from the committed evidence.
  record({
    item: "repair-roundtrip/cinatra-lifecycle-leg (request-changes → producer_repair → completion → repaired capture → approve → release)",
    verdict: "PENDING_GATE",
    evidence: "packages/agents/src/__tests__/lifecycle-repair-cms-roundtrip.integration.test.ts",
    detail: {
      reason:
        "DB-backed leg — executes in the agents-integration-db CI job (real Postgres) of the PR that carries it; " +
        "the authoring box cannot boot a database by standing rule, so this row records the executor honestly " +
        "instead of fabricating a local result.",
      runsIn: "build-image.yml → agents-integration-db (gated set)",
      routesOffManifest:
        "@cinatra-ai/wordpress-agent cinatra.lifecycle.repairCapable=true at the lock-pinned release " +
        (pinnedWordPressAgentSha() ?? "(dev lock unreadable at capture time)"),
    },
  });
  mkdirSync(CAPTURES_DIR, { recursive: true });
  const provenance: Record<string, unknown> = buildProvenance(REPO_ROOT, {
    runUrl: RUN_URL,
    commit: COMMIT,
    keys: [...CANONICAL_PROVENANCE_KEYS],
  });
  // This spec's own hash, so the committed evidence names the exact producer
  // that wrote it (this file is deliberately NOT part of the canonical
  // freshness-gate hash set — it is a program-acceptance producer, and its
  // output lives under captures/program-acceptance/ like the S9 evidence).
  provenance.repairRoundtripSpecSha256 = sha256OfFile(
    path.join(REPO_ROOT, "tests/e2e/wp-mcp-gateway/repair-roundtrip.spec.ts"),
  );
  provenance.hashingConvention =
    "sha256OfFile / sha256OfTree from tests/e2e/wp-mcp-gateway/provenance.mjs — computed fresh on the capture runner at write time";
  const doc = {
    schemaVersion: 1,
    description:
      "cinatra#2286 S10 (deliverable 7) — repair round-trip on the pinned community-stack fixture (#2016 S1). " +
      "WP-side leg driven live via the gateway execute triad against the booted pinned WordPress: produce (draft) → " +
      "reviewer-requested changes applied through ewpa/update-post (the connector's content-review-keyed write the " +
      "producer repair re-drives) → read-back of the repaired fields with draft status preserved → stability re-read. " +
      "The cinatra-side leg (changes_requested → producer_repair route off the lock-pinned wordpress-agent manifest → " +
      "dispatch → CMS completion drain → repaired capture → re-review approve → effect release → read-back binding) " +
      "runs on a real Postgres in packages/agents/src/__tests__/lifecycle-repair-cms-roundtrip.integration.test.ts " +
      "(the agents-integration-db CI job) and is cited as its own row below, per the S9 evidence convention " +
      "(do-not-duplicate-assertions).",
    exposureMode: "triad-only",
    determinedAt: new Date().toISOString(),
    runUrl: RUN_URL,
    verdicts,
    provenance,
  };
  writeFileSync(path.join(CAPTURES_DIR, "repair-roundtrip-verdicts.json"), JSON.stringify(doc, null, 2) + "\n");
});

// R1 — the base production: a DRAFT post with the flawed headline + excerpt.
test("REPAIR R1: base production — draft post created via ewpa/create-post", skipOpts, async () => {
  const info = await abilityInfo("ewpa/create-post");
  const titleK = pickProp(info.props, ["title", "post_title"], "title");
  const contentK = pickProp(info.props, ["content", "post_content"], "content");
  const statusK = pickProp(info.props, ["status", "post_status"], "status");
  const params: Record<string, unknown> = {};
  params[titleK] = BASE_TITLE;
  params[contentK] = BASE_CONTENT;
  params[statusK] = "draft";
  const resp = await execAbility("ewpa/create-post", params);
  assert.notEqual(resp.status, 0, "gateway unreachable for ewpa/create-post");
  const u = unwrap(resp);
  const data = u.data || {};
  const id = Number(data.id ?? data.ID ?? data.post_id ?? data.postId ?? NaN);
  postId = Number.isFinite(id) ? id : null;
  const pass = u.ok && postId != null;
  record({
    item: "repair-roundtrip/base-production",
    verdict: pass ? "PASS" : "FAIL",
    evidence: "captures/program-acceptance/repair-roundtrip-verdicts.json",
    detail: { postId, sentParams: params, ok: u.ok, error: u.error },
  });
});

// R2 — the producer repair's re-staged write: the reviewer's requested changes
// applied through ewpa/update-post (the content-review-keyed write).
test("REPAIR R2: requested changes applied via ewpa/update-post (the re-staged write)", skipOpts, async () => {
  const info = await abilityInfo("ewpa/update-post");
  const idK = pickProp(info.props, ["post_id", "id", "postId"], "post_id");
  const titleK = pickProp(info.props, ["title", "post_title"], "title");
  const contentK = pickProp(info.props, ["content", "post_content"], "content");
  const params: Record<string, unknown> = {};
  params[idK] = postId;
  params[titleK] = REPAIRED_TITLE;
  params[contentK] = REPAIRED_CONTENT;
  // Deliberately NO status field: the repair applies the requested changes and
  // must not demote or publish as a side effect (the producer's no-demote
  // contract) — R3 verifies the draft status survived.
  const resp = await execAbility("ewpa/update-post", params);
  assert.notEqual(resp.status, 0, "gateway unreachable for ewpa/update-post");
  const u = unwrap(resp);
  repairApplied = Boolean(u.ok && !u.isError);
  record({
    item: "repair-roundtrip/repair-update",
    verdict: postId != null && repairApplied ? "PASS" : "FAIL",
    evidence: "captures/program-acceptance/repair-roundtrip-verdicts.json",
    detail: { postId, schemaProps: info.props, sentKeys: { idK, titleK, contentK }, ok: u.ok, isError: u.isError, error: u.error },
  });
});

// R3 — read-back: the repaired fields landed exactly; draft status preserved.
// Per this suite's contract, verdicts are DATA: a missing post id or a non-OK
// read-back records a FAIL verdict and returns — it never throws, so only an
// unreachable gateway can red the capture run.
test("REPAIR R3: read-back returns the repaired fields with draft status preserved", skipOpts, async () => {
  if (postId == null) {
    record({
      item: "repair-roundtrip/read-back",
      verdict: "FAIL",
      evidence: "captures/program-acceptance/repair-roundtrip-verdicts.json",
      detail: { reason: "no post id from R1 (base production reported an ability-level failure)", postId: null },
    });
    return;
  }
  firstReadBack = await readPostBack(postId);
  if (firstReadBack == null) {
    record({
      item: "repair-roundtrip/read-back",
      verdict: "FAIL",
      evidence: "captures/program-acceptance/repair-roundtrip-verdicts.json",
      detail: { reason: "read-back returned no post (non-OK REST response)", postId },
    });
    return;
  }
  const rb = firstReadBack;
  const titleOk = typeof rb.title === "string" && rb.title.includes(REPAIRED_TITLE);
  const contentOk = typeof rb.content === "string" && rb.content.includes("Reviewer-approved excerpt wording");
  const placeholderGone = typeof rb.content === "string" && !rb.content.includes("TODO-EXCERPT");
  const statusOk = rb.status === "draft";
  const pass = repairApplied && titleOk && contentOk && placeholderGone && statusOk;
  record({
    item: "repair-roundtrip/read-back",
    verdict: pass ? "PASS" : "FAIL",
    evidence: "captures/program-acceptance/repair-roundtrip-verdicts.json",
    detail: { postId, readBack: rb, titleOk, contentOk, placeholderGone, statusOk },
  });
});

// R4 — stability: a second independent read returns the same repaired state.
// Same verdicts-are-DATA discipline as R3: FAIL verdict + return, never a throw.
test("REPAIR R4: a second read-back returns the same repaired state (durable)", skipOpts, async () => {
  if (postId == null) {
    record({
      item: "repair-roundtrip/read-back-stability",
      verdict: "FAIL",
      evidence: "captures/program-acceptance/repair-roundtrip-verdicts.json",
      detail: { reason: "no post id from R1 (base production reported an ability-level failure)", postId: null },
    });
    return;
  }
  const second = await readPostBack(postId);
  if (second == null) {
    record({
      item: "repair-roundtrip/read-back-stability",
      verdict: "FAIL",
      evidence: "captures/program-acceptance/repair-roundtrip-verdicts.json",
      detail: { reason: "second read-back returned no post (non-OK REST response)", postId },
    });
    return;
  }
  const stable =
    firstReadBack != null &&
    second.title === firstReadBack.title &&
    second.content === firstReadBack.content &&
    second.status === firstReadBack.status;
  record({
    item: "repair-roundtrip/read-back-stability",
    verdict: stable ? "PASS" : "FAIL",
    evidence: "captures/program-acceptance/repair-roundtrip-verdicts.json",
    detail: { postId, first: firstReadBack, second },
  });
});

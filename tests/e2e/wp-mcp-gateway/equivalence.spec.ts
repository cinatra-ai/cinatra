// Live equivalence suite for the WP MCP gateway (issue #2016, S1 §5).
//
// Runs INSIDE the capture workflow (wp-mcp-gateway-capture.yml) via `node --test`
// against the BOOTED pinned fixture — Node 24 strips the type annotations, so no
// vitest/toolchain install is needed and the wordpress-only boot job stays lean.
// The operator box never boots; this file is authored here and executed only on a
// runner. Without a live fixture (WP_BASE_URL / WP_MCP_BASIC_AUTH) every case
// SKIPS — it can never red normal CI.
//
// It drives each of the four VERIFY abilities through the mcp-adapter gateway and
// asserts behaviour parity with the internal blog-publish pipeline contract
// (src/lib/blog/wordpress.ts + packages/sdk-extensions blog-connector-contract),
// then writes captures/verify-verdicts.json. The exposure mode is TRIAD-ONLY
// (see EXPOSURE-MODE.md), so abilities are invoked via
// execute-ability(ability_name, parameters) and inspected via get-ability-info.
//
// A FAIL verdict is a VALID deliverable (design §5): it is recorded with a
// fallback that names another site ability, an S6 site-side config filter, or an
// upstream contribution — NEVER re-authoring a cinatra ability (AC, absolute).
// Each test asserts only LIVENESS (the gateway was reachable); the PASS/FAIL
// verdict is DATA, so a FAIL never reds the capture run — only an unreachable
// gateway does.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { buildProvenance, CANONICAL_PROVENANCE_KEYS } from "./provenance.mjs";

const BASE: string = (process.env.WP_BASE_URL || "").replace(/\/+$/, "");
const AUTH: string = process.env.WP_MCP_BASIC_AUTH || "";
const HAVE_FIXTURE: boolean = Boolean(BASE && AUTH);
const REPO_ROOT: string = process.env.CAPTURE_REPO_ROOT || process.cwd();
const CAPTURES_DIR: string = path.join(REPO_ROOT, "tests/e2e/wp-mcp-gateway/captures");
const RUN_URL: string = process.env.CAPTURE_RUN_URL || "";
const COMMIT: string = process.env.CAPTURE_COMMIT || "";
const DEFAULT_URL = `${BASE}/wp-json/mcp/mcp-adapter-default-server`;
const skipOpts = HAVE_FIXTURE ? {} : { skip: "no live fixture (WP_BASE_URL/WP_MCP_BASIC_AUTH unset)" };

// A 1x1 transparent PNG — enough to prove a base64 media upload round-trips.
const PNG_1x1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const ELEMENTOR_DATA = JSON.stringify([
  {
    id: "a1b2c3d",
    elType: "section",
    settings: {},
    elements: [
      {
        id: "e4f5g6h",
        elType: "column",
        settings: { _column_size: 100 },
        elements: [
          { id: "i7j8k9l", elType: "widget", widgetType: "heading", settings: { title: "Fixture heading (#2016)" } },
        ],
      },
    ],
  },
]);

// --- minimal handshake-aware JSON-RPC (mirrors the producer; kept inline so the
//     producer's sha256 — which the freshness gate pins — is not perturbed) ----
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
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cinatra-wp-mcp-equivalence", version: "1.0.0" } },
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

/** Pull a posts array out of whatever shape ewpa/get-posts returns. */
function extractPosts(data: any): any[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    for (const k of ["posts", "items", "results", "data", "rows"]) if (Array.isArray(data[k])) return data[k];
    for (const v of Object.values(data)) if (Array.isArray(v) && v.length && typeof v[0] === "object") return v;
  }
  return [];
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

type Verdict = {
  item: string;
  verdict: "PASS" | "FAIL";
  evidence: string;
  detail?: unknown;
  fallback?: unknown;
};
const verdicts: Verdict[] = [];
const record = (v: Verdict) => verdicts.push(v);

// Fallbacks (only attached on FAIL). Each names another site ability, an S6
// site-side config filter, or an upstream contribution — never a cinatra ability.
const FALLBACK = {
  createPost: { kind: "s6-config-filter", rationale: "if draft-at-creation is rejected, add an S6 site-side config filter or use an alternate ewpa site ability; upstream contribution to enable-abilities-for-mcp otherwise" },
  uploadImage: { kind: "upstream-contribution", rationale: "if the ewpa/upload-image schema is URL-only, contribute base64+MIME input upstream to enable-abilities-for-mcp, or add an S6 site-side config filter — never by adding a cinatra ability" },
  updateMeta: { kind: "s6-config-filter", rationale: "if _elementor_data is blocklisted, add an S6 site-side config filter to allowlist the protected meta key, or use an alternate site ability; upstream contribution otherwise" },
  getPosts: { kind: "alternate-site-ability", rationale: "if publish-status filtering or newest-first ordering is unsupported, use an alternate ewpa site ability or an S6 site-side config filter; upstream contribution otherwise" },
} as const;

let sharedPostId: number | null = null;

before(async () => {
  if (!HAVE_FIXTURE) return;
  // Resolve the exact triad wire-names from the live default server, then session.
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
  mkdirSync(CAPTURES_DIR, { recursive: true });
  const provenance = buildProvenance(REPO_ROOT, {
    runUrl: RUN_URL,
    commit: COMMIT,
    keys: [...CANONICAL_PROVENANCE_KEYS, "equivalenceSha256"],
  });
  const doc = {
    schemaVersion: 1,
    description: "WP MCP gateway VERIFY verdicts (#2016 S1 §5) — ewpa/* abilities driven via the gateway execute triad against the booted pinned fixture; a FAIL names its fallback, never a cinatra ability.",
    exposureMode: "triad-only",
    determinedAt: new Date().toISOString(),
    runUrl: RUN_URL,
    verdicts,
    provenance,
  };
  writeFileSync(path.join(CAPTURES_DIR, "verify-verdicts.json"), JSON.stringify(doc, null, 2) + "\n");
});

// VERIFY 1 — ewpa/create-post accepts DRAFT status at creation.
// Internal contract: BlogDraftCreatePayload.status === "draft" (draft-at-creation).
test("VERIFY ewpa/create-post accepts draft status at creation", skipOpts, async () => {
  const info = await abilityInfo("ewpa/create-post");
  const titleK = pickProp(info.props, ["title", "post_title"], "title");
  const contentK = pickProp(info.props, ["content", "post_content"], "content");
  const statusK = pickProp(info.props, ["status", "post_status"], "status");
  const params: Record<string, unknown> = {};
  params[titleK] = "WP MCP gateway VERIFY — draft-at-creation (#2016)";
  params[contentK] = "Created via ewpa/create-post with status=draft to prove draft-at-creation parity.";
  params[statusK] = "draft";
  const resp = await execAbility("ewpa/create-post", params);
  assert.notEqual(resp.status, 0, "gateway unreachable for ewpa/create-post");
  const u = unwrap(resp);
  const data = u.data || {};
  const postId = Number(data.id ?? data.ID ?? data.post_id ?? data.postId ?? NaN);
  sharedPostId = Number.isFinite(postId) ? postId : null;
  let readBackStatus: string | null = data.status ?? data.post_status ?? null;
  if (sharedPostId && !readBackStatus) {
    const rb = await fetch(`${BASE}/wp-json/wp/v2/posts/${sharedPostId}?context=edit`, { headers: { Authorization: `Basic ${AUTH}` } });
    if (rb.ok) readBackStatus = ((await rb.json()) as any).status ?? null;
  }
  const pass = u.ok && readBackStatus === "draft";
  record({
    item: "ewpa/create-post",
    verdict: pass ? "PASS" : "FAIL",
    evidence: "captures/verify-verdicts.json",
    detail: { inputSchemaProps: info.props, sentParams: params, postId: sharedPostId, readBackStatus, ok: u.ok, error: u.error, result: u.raw },
    ...(pass ? {} : { fallback: FALLBACK.createPost }),
  });
});

// VERIFY 2 — ewpa/upload-image input mode (base64 vs URL). TWO-GATE (design §5,
// codex MAJOR-6): (1) schema gate FAILS if the inputSchema lacks base64-bytes +
// MIME-type inputs (a URL-only schema is a FAIL, not a test to rewrite); (2) only
// then execute with base64 and require a media id + source URL back.
test("VERIFY ewpa/upload-image input mode satisfies base64+MIME media upload", skipOpts, async () => {
  const info = await abilityInfo("ewpa/upload-image");
  const propsNorm = info.props.map((p) => norm(p));
  const schemaText = JSON.stringify(info.inputSchema || {}).toLowerCase();
  const hasBase64 = propsNorm.some((p) => p.includes("base64") || p.includes("bytes") || p.includes("data")) || schemaText.includes("base64");
  const hasMime = propsNorm.some((p) => p.includes("mime") || p.includes("type") || p.includes("contenttype")) || schemaText.includes("mime");
  const hasUrlOnly = (propsNorm.some((p) => p.includes("url") || p.includes("src")) || schemaText.includes("url")) && !hasBase64;

  // Gate 1 — schema.
  if (!hasBase64 || !hasMime) {
    record({
      item: "ewpa/upload-image",
      verdict: "FAIL",
      evidence: "captures/verify-verdicts.json",
      detail: { gate: "schema", reason: "inputSchema lacks base64-bytes and/or MIME-type inputs (internal contract requires uploadMedia({imageBase64,imageMimeType}))", urlOnly: hasUrlOnly, inputSchemaProps: info.props, inputSchema: info.inputSchema },
      fallback: FALLBACK.uploadImage,
    });
    assert.ok(true); // schema-gate FAIL is a recorded verdict, not an error.
    return;
  }
  // Gate 2 — execution with base64.
  const b64K = pickProp(info.props, ["image_base64", "base64", "data", "bytes"], "image_base64");
  const mimeK = pickProp(info.props, ["mime_type", "mime", "content_type", "type"], "mime_type");
  const nameK = pickProp(info.props, ["filename", "file_name", "name", "title"], "filename");
  const params: Record<string, unknown> = {};
  params[b64K] = PNG_1x1_BASE64;
  params[mimeK] = "image/png";
  params[nameK] = "wp-mcp-gateway-verify.png";
  const resp = await execAbility("ewpa/upload-image", params);
  assert.notEqual(resp.status, 0, "gateway unreachable for ewpa/upload-image");
  const u = unwrap(resp);
  const data = u.data || {};
  const mediaId = data.id ?? data.ID ?? data.media_id ?? data.attachment_id ?? null;
  const sourceUrl = data.source_url ?? data.sourceUrl ?? data.url ?? data.guid ?? null;
  const pass = u.ok && mediaId != null && Boolean(sourceUrl);
  record({
    item: "ewpa/upload-image",
    verdict: pass ? "PASS" : "FAIL",
    evidence: "captures/verify-verdicts.json",
    detail: { gate: "execution", schemaProps: info.props, sentKeys: { b64K, mimeK, nameK }, mediaId, sourceUrl, ok: u.ok, error: u.error, result: u.raw },
    ...(pass ? {} : { fallback: FALLBACK.uploadImage }),
  });
});

// VERIFY 3 — ewpa/update-post-meta meta-key blocklist verdict for _elementor_data.
// Highest-risk: underscore-prefixed "protected" meta is commonly blocklisted.
test("VERIFY ewpa/update-post-meta accepts _elementor_data (not blocklisted)", skipOpts, async () => {
  // Ensure a target post exists (reuse VERIFY-1's, else create one).
  if (!sharedPostId) {
    const created = unwrap(await execAbility("ewpa/create-post", { title: "WP MCP gateway VERIFY — meta target (#2016)", content: "meta target", status: "draft" }));
    const d = created.data || {};
    const id = Number(d.id ?? d.ID ?? d.post_id ?? NaN);
    sharedPostId = Number.isFinite(id) ? id : null;
  }
  const info = await abilityInfo("ewpa/update-post-meta");
  const idK = pickProp(info.props, ["post_id", "id", "postId"], "post_id");
  const keyK = pickProp(info.props, ["meta_key", "key"], "meta_key");
  const valK = pickProp(info.props, ["meta_value", "value"], "meta_value");
  const params: Record<string, unknown> = {};
  params[idK] = sharedPostId;
  params[keyK] = "_elementor_data";
  params[valK] = ELEMENTOR_DATA;
  const resp = await execAbility("ewpa/update-post-meta", params);
  assert.notEqual(resp.status, 0, "gateway unreachable for ewpa/update-post-meta");
  const u = unwrap(resp);
  const errText = JSON.stringify(u.error || "").toLowerCase();
  const blocklisted = /blocklist|blacklist|not allowed|protected|forbidden|denied|disallow/.test(errText);
  const pass = u.ok && !blocklisted && !u.isError;
  record({
    item: "ewpa/update-post-meta",
    verdict: pass ? "PASS" : "FAIL",
    evidence: "captures/verify-verdicts.json",
    detail: { postId: sharedPostId, metaKey: "_elementor_data", schemaProps: info.props, ok: u.ok, isError: u.isError, error: u.error, blocklisted, result: u.raw },
    ...(pass ? {} : { fallback: FALLBACK.updateMeta }),
  });
});

// VERIFY 4 — ewpa/get-posts publish-status filter + newest-first ordering.
// Decisive multi-post seed (seed-content.php): "Newer Published" (5d ago) must
// sort first, "Older Published" (40d ago) second, "Draft Post" excluded.
test("VERIFY ewpa/get-posts supports publish-status filter + newest-first ordering", skipOpts, async () => {
  const info = await abilityInfo("ewpa/get-posts");
  const statusK = pickProp(info.props, ["status", "post_status"], "status");
  const orderbyK = pickProp(info.props, ["orderby", "order_by"], "orderby");
  const orderK = pickProp(info.props, ["order"], "order");
  const countK = pickProp(info.props, ["numberposts", "posts_per_page", "per_page", "perpage", "limit", "number"], "numberposts");
  const titleOf = (p: any) => String(p?.title?.rendered ?? p?.post_title ?? p?.title ?? p?.name ?? "");
  const statusOf = (p: any) => String(p?.status ?? p?.post_status ?? "");
  // Try the discovered params in a few value-forms (string vs array status,
  // numeric vs string count) — same params, correct value shape — and use the
  // first attempt that returns published posts. A plain {} call is recorded as a
  // diagnostic (does the ability return ANY posts at all?).
  const base = { [orderbyK]: "date", [orderK]: "desc" } as Record<string, unknown>;
  const attempts: Array<Record<string, unknown>> = [
    { ...base, [statusK]: "publish", [countK]: 20 },
    { ...base, [statusK]: "publish", [countK]: "20" },
    { ...base, [statusK]: ["publish"], [countK]: 20 },
    { ...base, [statusK]: "publish" },
  ];
  const diag = unwrap(await execAbility("ewpa/get-posts", {}));
  const tried: any[] = [];
  let chosen: { params: Record<string, unknown>; u: any; list: any[] } | null = null;
  for (const params of attempts) {
    const resp = await execAbility("ewpa/get-posts", params);
    assert.notEqual(resp.status, 0, "gateway unreachable for ewpa/get-posts");
    const u = unwrap(resp);
    const list = extractPosts(u.data);
    tried.push({ params, ok: u.ok, isError: u.isError, error: u.error, count: list.length, contentText: (u.contentText || "").slice(0, 400) });
    if (list.length > 0) {
      chosen = { params, u, list };
      break;
    }
  }
  const list = chosen?.list ?? [];
  const titles = list.map(titleOf);
  const idxNewer = titles.findIndex((t) => /newer published/i.test(t));
  const idxOlder = titles.findIndex((t) => /older published/i.test(t));
  const draftIncluded = titles.some((t) => /gateway — draft post/i.test(t)) || list.some((p) => statusOf(p) === "draft");
  const orderingOk = idxNewer >= 0 && idxOlder >= 0 && idxNewer < idxOlder;
  const filterOk = list.length > 0 && !draftIncluded;
  const pass = Boolean(chosen?.u.ok) && orderingOk && filterOk;
  record({
    item: "ewpa/get-posts",
    verdict: pass ? "PASS" : "FAIL",
    evidence: "captures/verify-verdicts.json",
    detail: {
      schemaProps: info.props,
      chosenParams: chosen?.params ?? null,
      attempts: tried,
      diagnosticNoFilterCount: extractPosts(diag.data).length,
      diagnosticContentText: (diag.contentText || "").slice(0, 400),
      returnedTitles: titles,
      idxNewer,
      idxOlder,
      draftExcluded: !draftIncluded,
      orderingOk,
      filterOk,
    },
    ...(pass ? {} : { fallback: FALLBACK.getPosts }),
  });
});

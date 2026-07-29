#!/usr/bin/env node
/**
 * Live annotation-transport capture producer for the WP MCP gateway
 * (issue #2016, S1, C3 — completes the C0 scaffold).
 *
 * Runs ONLY on a runner against the booted pinned fixture (docker/wordpress,
 * wordpress profile) — never on the operator box. It authenticates with the
 * per-run app-password (HTTP Basic, buildBasicAuthHeader scheme) and writes
 * VERBATIM JSON-RPC / MCP-SDK transcripts to ./captures/, each carrying a
 * `provenance` block (tests/e2e/wp-mcp-gateway/provenance.mjs) so the required
 * freshness gate can prove the committed captures are not stale vs the pins /
 * fixture plugin / this producer / the api-map (design §3).
 *
 * The six annotation-transport sub-claims (design §3):
 *   (a) raw tools/list on BOTH the default server and the dedicated
 *       fixturelabs-server; assert readOnly/destructive hints present on the
 *       read/write/destructive trio.
 *   (b) MCP SDK Client.listTools() (StreamableHTTP, SSE fallback) per server;
 *       serialize tools[].annotations — proves the SDK layer preserves hints.
 *   (c) gateway triad tools/call using the exact ability ids from
 *       captures/adapter-0.5.0-api-map.json (discover / get-info / execute).
 *   (d) eafm annotation coverage incl. delete / search-replace / code-snippet.
 *   (e) fixturelabs-server unannotated / malformed / contradictory tools, as
 *       emitted (raw, no normalization).
 *   (f) HARD: every fixturelabs/* trio ability is DISCOVERABLE through the
 *       eafm/default aggregator — as an individual tools/list entry (first-class
 *       exposure) OR via the discover-abilities triad (triad-only exposure). If
 *       NEITHER, the capture FAILS (activation/discovery-lifecycle bug — apply
 *       the design §1.3 fallback: post-activation flush / EAFM refresh).
 *
 * Exit code: 0 when the capture completed and the hard sub-claim (f) held (a
 * recorded annotation-content nuance in a/b/d/e is a FINDING, never a failure —
 * annotations are hints, design §8/S5). 1 only on a hard-(f) failure or a total
 * infrastructure failure (the default server's tools/list is unreachable). On
 * exit 1 the transcripts written so far are STILL uploaded (`if: always()`), so
 * a red run is always diagnosable from the artifact.
 *
 * Env contract (mirrors the bring-up producer + capture-permissions precedent):
 *   WP_BASE_URL        — base URL of the booted fixture (e.g. http://localhost:8080)
 *   WP_MCP_BASIC_AUTH  — base64("admin:<app-password>"), minted per-run (no secret)
 *   CAPTURE_RUN_URL    — the Actions run URL (provenance)
 *   CAPTURE_COMMIT     — the head sha (provenance)
 *   CAPTURE_REPO_ROOT  — repo root for provenance hashing (default: cwd)
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildProvenance } from "./provenance.mjs";

const REPO_ROOT = process.env.CAPTURE_REPO_ROOT || process.cwd();
const CAPTURES_DIR =
  process.env.CAPTURES_DIR || path.join(REPO_ROOT, "tests/e2e/wp-mcp-gateway/captures");
const RUN_URL = process.env.CAPTURE_RUN_URL || "";
const COMMIT = process.env.CAPTURE_COMMIT || "";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "cinatra-wp-mcp-capture", version: "1.0.0" };

// The fixturelabs abilities the fixture registers (docker/wordpress/fixture-plugin).
const FIXTURELABS_TRIO = ["fixturelabs/note-get", "fixturelabs/note-set", "fixturelabs/note-delete"];
const FIXTURELABS_EDGE = [
  "fixturelabs/note-get-unannotated",
  "fixturelabs/note-get-malformed",
  "fixturelabs/note-get-contradictory",
];
const FIXTURELABS_ALL = [...FIXTURELABS_TRIO, ...FIXTURELABS_EDGE];

// eafm coverage abilities of interest (design §3d) — WP-core abilities eafm surfaces.
const EAFM_COVERAGE_HINTS = ["delete", "search-replace", "search_replace", "code-snippet", "code_snippet"];

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`capture-annotations: missing required env ${name}`);
    process.exit(1);
  }
  return value;
}

let __id = 0;
const nextId = () => ++__id;

/** Read the committed api-map (bring-up-resolved names/routes). */
function readApiMap() {
  const p = path.join(CAPTURES_DIR, "adapter-0.5.0-api-map.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/** Parse an SSE body into the JSON-RPC messages it carries. */
function parseSse(text) {
  const messages = [];
  for (const block of text.split(/\n\n/)) {
    for (const line of block.split(/\n/)) {
      const m = line.match(/^data:\s?(.*)$/);
      if (!m) continue;
      try {
        messages.push(JSON.parse(m[1]));
      } catch {
        /* non-JSON data line — ignore */
      }
    }
  }
  return messages;
}

/**
 * POST one JSON-RPC message. Returns the raw text + parsed JSON-RPC result and
 * carries the Mcp-Session-Id forward. Handles both application/json and
 * text/event-stream responses. Never throws (records the error instead).
 */
async function postJsonRpc(url, auth, body, sessionId) {
  const headers = {
    Authorization: `Basic ${auth}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const rawText = await res.text();
    const ct = res.headers.get("content-type") || "";
    const newSession = res.headers.get("mcp-session-id") || sessionId || null;
    let parsed = null;
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
    return {
      request: body,
      status: res.status,
      contentType: ct,
      rawText,
      parsed,
      sessionId: newSession,
    };
  } catch (err) {
    return {
      request: body,
      status: 0,
      contentType: "",
      rawText: "",
      parsed: null,
      sessionId: sessionId || null,
      error: String(err && err.message ? err.message : err),
    };
  }
}

/** Full MCP handshake (initialize + initialized). Returns { sessionId, init }. */
async function initSession(url, auth) {
  const init = await postJsonRpc(url, auth, {
    jsonrpc: "2.0",
    id: nextId(),
    method: "initialize",
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    },
  });
  const sessionId = init.sessionId;
  if (init.parsed && !init.parsed.error) {
    await postJsonRpc(
      url,
      auth,
      { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      sessionId,
    );
  }
  return { sessionId, init };
}

/**
 * Raw tools/list — try a bare call first (lenient servers), fall back to a full
 * handshake (spec-strict servers). Returns { tools, via, sessionId, transcripts }.
 */
async function rawToolsList(url, auth) {
  const bare = await postJsonRpc(url, auth, {
    jsonrpc: "2.0",
    id: nextId(),
    method: "tools/list",
    params: {},
  });
  if (Array.isArray(bare.parsed?.result?.tools)) {
    return { tools: bare.parsed.result.tools, via: "bare", sessionId: bare.sessionId, transcripts: [bare] };
  }
  const { sessionId, init } = await initSession(url, auth);
  const listed = await postJsonRpc(
    url,
    auth,
    { jsonrpc: "2.0", id: nextId(), method: "tools/list", params: {} },
    sessionId,
  );
  return {
    tools: Array.isArray(listed.parsed?.result?.tools) ? listed.parsed.result.tools : [],
    via: "handshake",
    sessionId,
    transcripts: [bare, init, listed],
  };
}

/** Normalize a tool identifier (lowercase, strip separators) for EXACT matching. */
const norm = (s) => String(s || "").toLowerCase().replace(/[\s_/-]+/g, "");

/**
 * Does a tools/list entry correspond to ability id `abilityId`? EXACT
 * normalized-equality of the FULL id vs the FULL tool name (the mcp-adapter wire
 * convention maps `ns/ability` → `ns-ability`, so norm collapses both to the
 * same token). Substring/prefix matching is DELIBERATELY avoided: `note-get` is
 * a prefix of `note-get-unannotated`, so a loose matcher would mis-bind the
 * edge-case tools to the plain read tool (§3e).
 */
function toolMatchesAbility(tool, abilityId) {
  const target = norm(abilityId);
  const candidates = [tool?.name, tool?._meta?.ability, tool?.meta?.ability];
  return candidates.some((c) => {
    const cn = norm(c);
    return cn && cn === target;
  });
}

/**
 * Is `abilityId` (or its mcp-adapter wire form, `ns/ability` -> `ns-ability`)
 * present in raw text `haystack` as a WHOLE token — never merely as a prefix of
 * a longer id? Used ONLY for the advisory (f) discover-abilities fallback,
 * where there is no structured tool list to run `toolMatchesAbility` against —
 * just the raw JSON-RPC response text.
 *
 * cinatra#2104: the previous fallback did
 * `norm(haystack).includes(norm(abilityId))`. `norm()` strips `-` and `/`, so
 * `norm("fixturelabs/note-get")` -> `fixturelabsnoteget`, which IS a substring
 * of `norm("fixturelabs/note-get-unannotated")` -> `fixturelabsnotegetunannotated`.
 * A discover payload listing only the edge variant would then falsely report
 * the plain trio ability as discoverable, letting the HARD sub-claim (f) pass
 * on evidence that doesn't exist. A trailing negative-lookahead boundary
 * (`(?![\w-])`) rules that out: the match cannot be immediately followed by a
 * word character or `-`, so `note-get` no longer matches inside
 * `note-get-unannotated`, while `note-get` at a genuine word boundary (end of
 * string, followed by a quote/comma/brace/etc.) still matches.
 */
function matchesAsWholeToken(haystack, abilityId) {
  const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const wire = abilityId.replace("/", "-");
  const hasBoundaryMatch = (needle) => new RegExp(`${escapeRegExp(needle)}(?![\\w-])`).test(haystack);
  return hasBoundaryMatch(abilityId) || hasBoundaryMatch(wire);
}

function writeCapture(name, payload, keys) {
  const provenance = buildProvenance(REPO_ROOT, { runUrl: RUN_URL, commit: COMMIT, keys });
  const body = { schemaVersion: 1, ...payload, provenance };
  const out = path.join(CAPTURES_DIR, name);
  writeFileSync(out, JSON.stringify(body, null, 2) + "\n");
  return out;
}

async function tryListToolsSdk(url, auth) {
  // (b) MCP SDK — StreamableHTTP first, SSE fallback. Dynamic import so a
  // missing SDK degrades this ONE sub-claim to a recorded finding (the raw
  // path (a) carries the authoritative annotation proof).
  let Client, StreamableHTTPClientTransport, SSEClientTransport;
  try {
    ({ Client } = await import("@modelcontextprotocol/sdk/client/index.js"));
    ({ StreamableHTTPClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/streamableHttp.js"
    ));
    ({ SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js"));
  } catch (err) {
    return { sdkAvailable: false, error: `SDK import failed: ${String(err?.message || err)}` };
  }
  const headers = { Authorization: `Basic ${auth}` };
  const attempt = async (transportName) => {
    const transport =
      transportName === "streamable-http"
        ? new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } })
        : new SSEClientTransport(new URL(url), {
            requestInit: { headers },
            eventSourceInit: { fetch: (u, init) => fetch(u, { ...init, headers: { ...init?.headers, ...headers } }) },
          });
    const client = new Client(CLIENT_INFO, { capabilities: {} });
    await client.connect(transport);
    const res = await client.listTools();
    await client.close();
    return res;
  };
  try {
    const res = await attempt("streamable-http");
    return { sdkAvailable: true, transport: "streamable-http", tools: res.tools };
  } catch (streamErr) {
    try {
      const res = await attempt("sse");
      return {
        sdkAvailable: true,
        transport: "sse",
        streamableError: String(streamErr?.message || streamErr),
        tools: res.tools,
      };
    } catch (sseErr) {
      return {
        sdkAvailable: true,
        transport: null,
        error: `both transports failed — streamable: ${String(streamErr?.message || streamErr)}; sse: ${String(sseErr?.message || sseErr)}`,
      };
    }
  }
}

async function main() {
  const baseUrl = requireEnv("WP_BASE_URL").replace(/\/+$/, "");
  const auth = requireEnv("WP_MCP_BASIC_AUTH");
  mkdirSync(CAPTURES_DIR, { recursive: true });

  const apiMap = readApiMap();
  const defaultRoute = apiMap?.defaultServer?.restRoute || "/wp-json/mcp/mcp-adapter-default-server";
  const defaultServerUrl = `${baseUrl}${defaultRoute}`;
  const fixtureServerUrl = `${baseUrl}/wp-json/fixturelabs/fixturelabs-server`;
  const triadIds = (apiMap?.gatewayTriad?.tools || []).map((t) => t.toolAbilityId);

  const findings = [];
  const hardFailures = [];
  const note = (msg) => {
    console.log(`capture-annotations: ${msg}`);
    findings.push(msg);
  };

  console.log(`capture-annotations (C3) — default=${defaultServerUrl} fixture=${fixtureServerUrl}`);

  // --- (a) raw tools/list on BOTH servers -------------------------------------
  const defaultList = await rawToolsList(defaultServerUrl, auth);
  const fixtureList = await rawToolsList(fixtureServerUrl, auth);
  const defaultTools = defaultList.tools;
  const fixtureTools = fixtureList.tools;

  if (defaultTools.length === 0 && !defaultList.transcripts.some((t) => t.status === 200 || t.status === 202)) {
    // Total infra failure on the authoritative aggregator — nothing to capture.
    writeCapture("annotations-a-raw-tools-list.json", {
      subClaim: "a",
      description: "raw tools/list on default + fixturelabs-server",
      defaultServer: { url: defaultServerUrl, via: defaultList.via, transcripts: defaultList.transcripts, tools: defaultTools },
      fixtureServer: { url: fixtureServerUrl, via: fixtureList.via, transcripts: fixtureList.transcripts, tools: fixtureTools },
    });
    console.error("capture-annotations: FATAL — default server tools/list unreachable; see annotations-a-raw-tools-list.json");
    process.exit(1);
  }

  // Assert (record) that the read/write/destructive trio carries hints on whichever
  // server lists them individually (annotations are hints — a miss is a FINDING).
  const trioHintReport = {};
  for (const abilityId of FIXTURELABS_TRIO) {
    const onFixture = fixtureTools.find((t) => toolMatchesAbility(t, abilityId));
    const onDefault = defaultTools.find((t) => toolMatchesAbility(t, abilityId));
    const tool = onFixture || onDefault;
    const ann = tool?.annotations || null;
    trioHintReport[abilityId] = {
      listedOnFixtureServer: Boolean(onFixture),
      listedOnDefaultServer: Boolean(onDefault),
      toolName: tool?.name || null,
      annotations: ann,
      hasReadOnlyHint: ann ? "readOnlyHint" in ann : false,
      hasDestructiveHint: ann ? "destructiveHint" in ann : false,
    };
    if (tool && !(ann && ("readOnlyHint" in ann || "destructiveHint" in ann))) {
      note(`(a) FINDING: ${abilityId} listed as \`${tool.name}\` but carries no readOnlyHint/destructiveHint`);
    }
  }
  writeCapture("annotations-a-raw-tools-list.json", {
    subClaim: "a",
    description: "raw tools/list on default + fixturelabs-server; readOnly/destructive hints on the trio",
    defaultServer: { url: defaultServerUrl, via: defaultList.via, transcripts: defaultList.transcripts, tools: defaultTools },
    fixtureServer: { url: fixtureServerUrl, via: fixtureList.via, transcripts: fixtureList.transcripts, tools: fixtureTools },
    trioHintReport,
  });

  // --- (b) MCP SDK Client.listTools() per server ------------------------------
  const sdkDefault = await tryListToolsSdk(defaultServerUrl, auth);
  const sdkFixture = await tryListToolsSdk(fixtureServerUrl, auth);
  if (sdkDefault.sdkAvailable === false) note(`(b) FINDING: ${sdkDefault.error} — raw path (a) carries the annotation proof`);
  writeCapture("annotations-b-sdk-listtools.json", {
    subClaim: "b",
    description: "MCP SDK Client.listTools() (StreamableHTTP + SSE fallback); tools[].annotations preserved",
    defaultServer: { url: defaultServerUrl, ...sdkDefault },
    fixtureServer: { url: fixtureServerUrl, ...sdkFixture },
  });

  // --- (c) gateway triad tools/call using the api-map ability ids -------------
  const triadCalls = [];
  const { sessionId: defSession } = await initSession(defaultServerUrl, auth);
  const triadProbe = {
    "mcp-adapter/discover-abilities": {},
    "mcp-adapter/get-ability-info": { ability_name: "fixturelabs/note-get" },
    "mcp-adapter/execute-ability": { ability_name: "fixturelabs/note-get", parameters: {} },
  };
  for (const abilityId of triadIds.length ? triadIds : Object.keys(triadProbe)) {
    const tool = defaultTools.find((t) => toolMatchesAbility(t, abilityId));
    const toolName = tool?.name || abilityId;
    const resp = await postJsonRpc(
      defaultServerUrl,
      auth,
      {
        jsonrpc: "2.0",
        id: nextId(),
        method: "tools/call",
        params: { name: toolName, arguments: triadProbe[abilityId] || {} },
      },
      defSession,
    );
    triadCalls.push({ abilityId, toolName, listedOnDefault: Boolean(tool), arguments: triadProbe[abilityId] || {}, response: resp });
  }
  writeCapture("annotations-c-gateway-triad.json", {
    subClaim: "c",
    description: "gateway triad tools/call (discover / get-info / execute) using adapter-0.5.0-api-map.json ids",
    triadIds,
    calls: triadCalls,
  });

  // --- (d) eafm annotation coverage incl delete / search-replace / code-snippet
  // Any first-class tool whose name matches a coverage hint (present only under
  // first-class exposure)...
  const coverageFirstClass = defaultTools
    .filter((t) => EAFM_COVERAGE_HINTS.some((h) => norm(t?.name).includes(norm(h))))
    .map((t) => ({ name: t.name, annotations: t.annotations || null }));
  // ...plus, in triad-only exposure, the coverage abilities' annotations live
  // behind get-ability-info — fetch them directly so coverage is captured
  // regardless of exposure mode (design §3d).
  const getInfoTool =
    defaultTools.find((t) => toolMatchesAbility(t, "mcp-adapter/get-ability-info"))?.name || "mcp-adapter-get-ability-info";
  const COVERAGE_ABILITIES = ["ewpa/delete-post", "ewpa/search-replace", "ewpa/create-code-snippet"];
  const coverageViaGetInfo = {};
  for (const abilityId of COVERAGE_ABILITIES) {
    const resp = await postJsonRpc(
      defaultServerUrl,
      auth,
      { jsonrpc: "2.0", id: nextId(), method: "tools/call", params: { name: getInfoTool, arguments: { ability_name: abilityId } } },
      defSession,
    );
    let info = resp.parsed?.result?.structuredContent || null;
    if (!info) {
      const txt = resp.parsed?.result?.content?.[0]?.text;
      if (txt) {
        try {
          info = JSON.parse(txt);
        } catch {
          info = null;
        }
      }
    }
    coverageViaGetInfo[abilityId] = {
      found: Boolean(info),
      annotations: info?.meta?.annotations ?? null,
      response: resp,
    };
  }
  const anyCoverage = coverageFirstClass.length > 0 || Object.values(coverageViaGetInfo).some((c) => c.found);
  if (!anyCoverage) note("(d) FINDING: no delete/search-replace/code-snippet coverage resolved (neither first-class nor via get-ability-info)");
  writeCapture("annotations-d-eafm-coverage.json", {
    subClaim: "d",
    description: "eafm annotation coverage incl delete / search-replace / code-snippet (2.0.20)",
    coverageHints: EAFM_COVERAGE_HINTS,
    exposureNote:
      "triad-only exposure: coverage abilities are not first-class tools; their annotations are captured via get-ability-info",
    firstClassMatches: coverageFirstClass,
    coverageViaGetInfo,
    allDefaultToolNames: defaultTools.map((t) => t.name),
  });

  // --- (e) edge-case tools as emitted (raw, no normalization) -----------------
  const edgeReport = {};
  for (const abilityId of FIXTURELABS_EDGE) {
    const onFixture = fixtureTools.find((t) => toolMatchesAbility(t, abilityId));
    const onDefault = defaultTools.find((t) => toolMatchesAbility(t, abilityId));
    const tool = onFixture || onDefault;
    edgeReport[abilityId] = tool
      ? { toolName: tool.name, annotationsAsEmitted: tool.annotations ?? null, source: onFixture ? "fixturelabs-server" : "default-server" }
      : { toolName: null, annotationsAsEmitted: null, source: null, note: "not listed as an individual tool (may be triad-only exposure)" };
  }
  writeCapture("annotations-e-edge-cases.json", {
    subClaim: "e",
    description: "fixturelabs-server unannotated / malformed / contradictory tools, as emitted (raw)",
    edgeReport,
  });

  // --- (f) HARD: fixturelabs trio DISCOVERABLE via the eafm/default aggregator
  // Individual tools/list entry (first-class) OR via discover-abilities (triad-only).
  const discoverAbilityId = triadIds.find((id) => id.includes("discover")) || "mcp-adapter/discover-abilities";
  const discoverTool = defaultTools.find((t) => toolMatchesAbility(t, discoverAbilityId));
  const discoverResp = await postJsonRpc(
    defaultServerUrl,
    auth,
    {
      jsonrpc: "2.0",
      id: nextId(),
      method: "tools/call",
      params: { name: discoverTool?.name || discoverAbilityId, arguments: {} },
    },
    defSession,
  );
  const discoverText = JSON.stringify(discoverResp.parsed ?? discoverResp.rawText ?? "");
  const surfacing = {};
  let firstClassCount = 0;
  for (const abilityId of FIXTURELABS_ALL) {
    const individual = defaultTools.find((t) => toolMatchesAbility(t, abilityId));
    const viaDiscover = matchesAsWholeToken(discoverText, abilityId);
    if (individual) firstClassCount++;
    surfacing[abilityId] = {
      firstClassOnDefault: Boolean(individual),
      toolName: individual?.name || null,
      viaDiscoverAbilities: Boolean(viaDiscover),
      discoverable: Boolean(individual || viaDiscover),
    };
  }
  const trioNotDiscoverable = FIXTURELABS_TRIO.filter((id) => !surfacing[id].discoverable);
  if (trioNotDiscoverable.length > 0) {
    hardFailures.push(
      `(f) HARD FAIL: fixturelabs trio not discoverable via the eafm/default aggregator (neither first-class nor via discover-abilities): ${trioNotDiscoverable.join(", ")}. ` +
        `Apply the design §1.3 fallback (post-activation flush / EAFM refresh hook) or document the lifecycle.`,
    );
  }
  writeCapture("annotations-f-fixturelabs-surfacing.json", {
    subClaim: "f",
    description: "HARD: every fixturelabs/* trio ability discoverable through the eafm/default aggregator",
    defaultServerUrl,
    discover: { abilityId: discoverAbilityId, toolName: discoverTool?.name || null, response: discoverResp },
    surfacing,
    hardFailures,
  });

  // --- exposure-mode determination (§4) ---------------------------------------
  // first-class ⇒ the fixturelabs abilities appear as their OWN tools/list
  // entries on the default/eafm server; triad-only ⇒ only the gateway triad
  // appears and abilities are reached via execute(ability_id, args).
  const mode = firstClassCount > 0 ? "first-class" : "triad-only";
  writeCapture(
    "exposure-mode.json",
    {
      versions: { wp: apiMap?.pinnedTuple?.wp || "6.9", mcpAdapter: apiMap?.pinnedTuple?.mcpAdapter || "0.5.0", eafm: apiMap?.pinnedTuple?.eafm || "2.0.20" },
      mode,
      evidence: "annotations-a-raw-tools-list.json",
      rationale:
        mode === "first-class"
          ? `${firstClassCount} fixturelabs/* abilities appear as individual tools[].name on the default/eafm server`
          : "no fixturelabs/* abilities appear as individual tools; only the gateway triad is listed — abilities are reachable via execute(ability_id)",
      determinedAt: new Date().toISOString(),
      runUrl: RUN_URL,
    },
  );

  // --- capture index / summary ------------------------------------------------
  const passed = hardFailures.length === 0;
  writeCapture("capture-index.json", {
    description: "WP MCP gateway annotation-transport capture index (#2016 S1 §3)",
    baseUrl,
    defaultServerUrl,
    fixtureServerUrl,
    exposureMode: mode,
    subClaims: {
      a: "annotations-a-raw-tools-list.json",
      b: "annotations-b-sdk-listtools.json",
      c: "annotations-c-gateway-triad.json",
      d: "annotations-d-eafm-coverage.json",
      e: "annotations-e-edge-cases.json",
      f: "annotations-f-fixturelabs-surfacing.json",
    },
    findings,
    hardFailures,
    passed,
  });

  if (!passed) {
    console.error("capture-annotations: HARD FAILURE(S):");
    for (const h of hardFailures) console.error(`  - ${h}`);
    console.error("Transcripts were written and will be uploaded (if: always()). Exiting 1.");
    process.exit(1);
  }
  console.log(`capture-annotations: OK — exposure mode = ${mode}; ${findings.length} finding(s) recorded. Transcripts in ${CAPTURES_DIR}`);
}

// CLI entry guard (same convention as scripts/audit/wp-gateway-capture-freshness.mjs):
// only auto-run the live capture when this file is executed directly, so an
// offline unit test can `import` the pure matching helpers below without
// tripping requireEnv()'s process.exit(1) (no WP_BASE_URL in a test process).
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((err) => {
    console.error(`capture-annotations: unexpected error: ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  });
}

export { norm, toolMatchesAbility, matchesAsWholeToken };

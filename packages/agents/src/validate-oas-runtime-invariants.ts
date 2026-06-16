/**
 * Hermetic OAS runtime-invariant validator.
 *
 * Catches at vitest/CI time the same class of live-runtime mount bugs:
 * 9 agents failing to mount with the masked
 * `TypeError: ValueError: 'error' required in context`.
 *
 * The existing `validate-agent-json.ts` covers JSON Schema shape, llm-bridge
 * wiring, secrets, untrusted URLs, llm-provider policy. It does NOT enforce
 * pyagentspec's runtime invariants. This module fills that gap with five
 * deterministic scans, each producing `ReviewFinding[]` entries with a
 * stable code so failures point at a precise pattern operators can fix.
 *
 * All five scans are SEVERITY: BLOCKER — they describe runtime mount
 * failures, not stylistic concerns. Legacy patterns that are runtime-valid
 * (e.g. agents that declare `agent_run_id` directly everywhere instead of
 * the canonical `cinatra_run_id → agent_run_id` DFE bridge) are passed
 * without warning — this validator catches breakage, not style migration.
 *
 * Invariants enforced (codes used in findings):
 *   OAS-RUNTIME-001 — ApiNode placeholder/inputs parity mismatch
 *   OAS-RUNTIME-002 — JS-style ternary placeholder in Jinja template
 *   OAS-RUNTIME-003 — integer literal default declared as `"type":"number"`
 *   OAS-RUNTIME-004 — `agent_run_id` propagation broken
 *   OAS-RUNTIME-005 — EndNode output has no upstream source
 *   OAS-RUNTIME-006 — `/api/llm-bridge` ApiNode lacks `data.cinatra_llm` in source
 *   OAS-RUNTIME-007 — `/api/llm-bridge` ApiNode lacks `data.toolbox_ids` in source
 *   OAS-RUNTIME-008 — `A2AAgent` used for internal/in-process composition (agent_url
 *                     points back into this Cinatra instance). A2A is the
 *                     cross-instance/external protocol; internal sub-agent
 *                     composition must use `FlowNode` subflow inlining or a
 *                     deterministic MCP primitive. See docs/developing-agents.md
 *                     for the canonical inlining pattern.
 *
 * See `docs/developing-agents.md` "pyagentspec constraints when authoring
 * oas.json" for the human-readable description of each pattern.
 */

import type { ReviewFinding } from "./validate-agent-json";

// pyagentspec's exact placeholder regex from
// `pyagentspec/templating.TEMPLATE_PLACEHOLDER_REGEXP`. Filtered
// placeholders (`{{ x | tojson }}`), dotted forms (`{{ obj.field }}`),
// and JS-ternaries (`{{ x ? a : b }}`) are intentionally INVISIBLE — the
// inferred placeholder set match must mirror pyagentspec exactly.
const PLACEHOLDER_REGEX = /\{\{\s*(\w+)\s*\}\}/g;

// `docker/wayflow/agent_loader.py::_substitute_placeholders` substitutes
// uppercase placeholders against `os.environ` BEFORE pyagentspec sees the
// OAS. Mirror that filter here: any all-caps identifier matching this
// regex is treated as an env-var, not as a flow input descriptor.
// Identifier syntax: starts with uppercase letter or underscore; remaining
// chars are uppercase letters, digits, or underscore (matches the regex in
// agent_loader.py).
const ENV_VAR_PLACEHOLDER = /^[A-Z_][A-Z0-9_]*$/;

// JS-style ternary inside Jinja `{{ ... }}` placeholders is broken twice:
// (a) Jinja conditional syntax uses `if/else`, not `? :`; (b) the names
// inside the ternary are invisible to the placeholder regex above.
//
// Detected with a linear single-pass scanner instead of a backtracking regex.
// The previous form `/\{\{[^}]*\?[^}]*:[^}]*\}\}/g` has three adjacent
// unbounded `[^}]*` groups and is polynomial (O(n^2)) on adversarial input such
// as `"{{".repeat(n)` or `"{{" + "a?".repeat(n)`. This scanner runs over
// untrusted, author-submitted agent OAS string values (via `walkStrings`), so
// that blowup is a reachable ReDoS (js/polynomial-redos, eng#196).
//
// `findJsTernaryPlaceholder` is behaviorally identical to the old regex
// (verified by an 800k-case fuzz, including the exact matched substring): it
// finds each `{{ ... }}` placeholder body (which, like `[^}]*`, may not contain
// `}`) and reports the first whose body has a `?` followed later by a `:`.
function findJsTernaryPlaceholder(text: string): string | null {
  let i = 0;
  const n = text.length;
  while (i < n) {
    const open = text.indexOf("{{", i);
    if (open === -1) return null;
    let j = open + 2;
    while (j < n && text[j] !== "}") j++;
    if (j + 1 < n && text[j] === "}" && text[j + 1] === "}") {
      const inner = text.slice(open + 2, j);
      const q = inner.indexOf("?");
      if (q !== -1 && inner.indexOf(":", q + 1) !== -1) {
        return text.slice(open, j + 2);
      }
      // Not a ternary placeholder; keep scanning for a `{{` start after this one.
      i = open + 2;
    } else {
      // No `}}` close before the next `}` (or end of string). The span
      // [open, j) contains no `}`, so no `{{` start within it can close either;
      // jump past the scanned span to preserve linear time.
      i = Math.max(j, open + 2);
    }
  }
  return null;
}

// Strings sourced from these ApiNode fields produce pyagentspec's inferred
// placeholder set. Mirrors `ApiNode._get_inferred_inputs()` in the upstream
// implementation.
const APINODE_PLACEHOLDER_SOURCES = [
  "url",
  "http_method",
  "api_spec_uri",
  "data",
  "query_params",
  "headers",
] as const;

// ---------------------------------------------------------------------------
// Public entry — one scan per invariant; the wrapper that orchestrates them
// and the integration into `validateOasAgentJson` live below.
// ---------------------------------------------------------------------------

export function scanOasForRuntimeInvariantFindings(
  parsed: Record<string, unknown>,
): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  findings.push(...scanForJsTernaryPlaceholders(parsed));
  findings.push(...scanForFloatPropertyIntegerDefault(parsed));
  findings.push(...scanForCinatraLlmInSource(parsed));
  findings.push(...scanForToolboxIdsInSource(parsed));
  findings.push(...scanForInternalA2aAgentMisuse(parsed));
  // Placeholder/inputs parity + agent_run_id propagation + EndNode source
  // all walk the per-Flow graph, so we compose them per-Flow component.
  for (const flow of iterFlowComponents(parsed)) {
    findings.push(...scanApiNodePlaceholderInputsParity(flow));
    findings.push(...scanAgentRunIdPropagation(flow));
    findings.push(...scanEndNodeOutputSources(flow));
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Invariant 1 — ApiNode placeholder/inputs parity (OAS-RUNTIME-001).
// ---------------------------------------------------------------------------

function scanApiNodePlaceholderInputsParity(
  flow: FlowComponent,
): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  for (const node of flow.apiNodes) {
    // Parity only applies when `inputs` is explicitly declared on the
    // ApiNode. If absent, pyagentspec auto-infers every placeholder name
    // as a string input — no parity check is meaningful.
    if (!node.inputsExplicit) continue;
    const inferredPlaceholders = inferPlaceholderSet(node.placeholderSourceText);
    const declared = new Set(node.inputTitles);

    const missing = setDiff(inferredPlaceholders, declared);
    const extra = setDiff(declared, inferredPlaceholders);

    if (missing.size > 0) {
      findings.push({
        code: "OAS-RUNTIME-001",
        severity: "blocker",
        message:
          `ApiNode "${node.id}" references {{ ${[...missing].join(" }}, {{ ")} }} ` +
          `via url/data/query_params/headers but does not declare ` +
          `[${[...missing].map((t) => `"${t}"`).join(", ")}] in inputs[]. ` +
          `pyagentspec will reject this at mount: ` +
          `"received a property titled '<name>' but expected only properties with the titles: [...]". ` +
          `Either add the missing input(s) to the ApiNode inputs[], or remove ` +
          `the unmatched {{ ... }} placeholder(s) from the template body. ` +
          `(Filtered placeholders like {{ x | tojson }} are invisible to ` +
          `pyagentspec's regex — use a {# pyagentspec-input-hint: {{ name }} #} ` +
          `comment sentinel to expose the names while preserving the filter; ` +
          `see docs/developing-agents.md.)`,
        location: `$referenced_components.${node.id} (Flow "${flow.flowId}")`,
        source: "deterministic",
      });
    }
    if (extra.size > 0) {
      findings.push({
        code: "OAS-RUNTIME-001",
        severity: "blocker",
        message:
          `ApiNode "${node.id}" declares ` +
          `[${[...extra].map((t) => `"${t}"`).join(", ")}] in inputs[] but ` +
          `the template body has no matching bare {{ name }} placeholder for ` +
          `${[...extra].map((t) => `"${t}"`).join(" / ")}. pyagentspec will reject ` +
          `this at mount: "ApiNode component received a property titled '<name>' " +
          "but expected only properties with the titles: [...]". Either remove ` +
          `the dead input(s) from inputs[], OR if the value is actually used ` +
          `via a filter (e.g. {{ ${[...extra][0]} | tojson }}), add a ` +
          `{# pyagentspec-input-hint: {{ ${[...extra][0]} }} #} comment sentinel ` +
          `to the template body. (Comment sentinels are invisible at render time ` +
          `but match pyagentspec's regex; see docs/developing-agents.md.)`,
        location: `$referenced_components.${node.id} (Flow "${flow.flowId}")`,
        source: "deterministic",
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Invariant 2 — JS-ternary placeholders (OAS-RUNTIME-002).
// ---------------------------------------------------------------------------

function scanForJsTernaryPlaceholders(
  parsed: Record<string, unknown>,
): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  walkStrings(parsed, (text, path) => {
    const match = findJsTernaryPlaceholder(text);
    if (match !== null) {
      findings.push({
        code: "OAS-RUNTIME-002",
        severity: "blocker",
        message:
          `Found JS-style ternary inside Jinja placeholder at ${path}: ` +
          `"${match}". This is broken twice — (a) Jinja conditional ` +
          `syntax uses {{ a if cond else b }}, not the JS \`? :\` form, ` +
          `so rendering raises a TemplateSyntaxError at runtime; (b) the ` +
          `names inside the ternary are invisible to pyagentspec's ` +
          `placeholder regex, so inputs declared in inputs[] will look ` +
          `"extra" and pyagentspec will reject the ApiNode at mount. ` +
          `Rewrite as {{ ' Title: ' + title if title else '' }} and (if ` +
          `the variable is still declared in inputs[]) add a ` +
          `{# pyagentspec-input-hint: {{ name }} #} comment sentinel. See ` +
          `docs/developing-agents.md.`,
        location: path,
        source: "deterministic",
      });
    }
  });
  return findings;
}

// ---------------------------------------------------------------------------
// Invariant 3 — FloatProperty integer-default mismatch (OAS-RUNTIME-003).
// ---------------------------------------------------------------------------

function scanForFloatPropertyIntegerDefault(
  parsed: Record<string, unknown>,
): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  walkPropertyDescriptors(parsed, (descriptor, path) => {
    if (descriptor.type !== "number") return;
    if (!("default" in descriptor)) return;
    const d = descriptor.default;
    if (typeof d !== "number") return;
    if (!Number.isInteger(d)) return;
    const title =
      typeof descriptor.title === "string" ? descriptor.title : "<unknown>";
    findings.push({
      code: "OAS-RUNTIME-003",
      severity: "blocker",
      message:
        `Property "${title}" at ${path} declares "type":"number" with an ` +
        `integer literal default (${d}). pyagentspec maps "type":"number" ` +
        `to FloatProperty, and constructing FloatProperty(default_value=${d}) ` +
        `with an integer literal raises "Error when initializing: ` +
        `FloatProperty(...)" at mount. Change "type":"integer" (preferred ` +
        `when the field semantically holds a count), or supply a float ` +
        `default (e.g. ${d}.0). Applies to inputs[], outputs[], EndNode ` +
        `passthroughs, and ApiNode inputs/outputs equally — a single ` +
        `missed location is enough to fail the mount. See docs/developing-agents.md.`,
      location: path,
      source: "deterministic",
    });
  });
  return findings;
}

// ---------------------------------------------------------------------------
// Invariant 6 — cinatra_llm in source for every /api/llm-bridge ApiNode
// (OAS-RUNTIME-006).
//
// WayFlow's loader reads source OAS directly. The
// compile-time `injectCinatraLlmIntoApiNodes` (oas-compiler.ts) only runs
// during `agent_source_compile` / `agent_source_publish`. If the source
// OAS lacks `data.cinatra_llm` on a `/api/llm-bridge` ApiNode, the
// runtime body sent to the bridge has no provider hint → bridge falls
// through to the OpenAI default route (`dispatch.kind === "passthrough"`).
// That route depends on the Cinatra MCP tool list being reachable; when
// the operator's MCP tunnel is down, the bridge returns HTTP 500 with
// `424 Failed Dependency — Error retrieving tool list from MCP server`.
//
// Agents that need a specific provider/capability (e.g. media-transcript
// → Gemini media_input) MUST declare `data.cinatra_llm` directly in
// source. Generic OpenAI agents should too — declaring the provider in
// source makes the dependency on MCP availability explicit and lets the
// bridge skip the toolbox-resolution path for non-`cinatra-mcp` tools.
//
// Architectural rule: source OAS must be runtime-complete.
// Compiler/publisher transforms can validate, normalize, or backfill for
// publication, but cannot be the only place required runtime fields appear.
// ---------------------------------------------------------------------------

function scanForCinatraLlmInSource(
  parsed: Record<string, unknown>,
): ReviewFinding[] {
  // The rule only fires when the agent declares top-level
  // `metadata.cinatra.llm` — that's the trigger for the compile-time
  // `injectCinatraLlmIntoApiNodes` pass. Without top-level llm, the
  // agent legitimately uses the bridge's passthrough OpenAI default,
  // and there's nothing for compile-time to inject. The architectural
  // rule bans "compile-time is the only place required runtime fields
  // appear"; if there's no compile-time injection expected, the rule has
  // nothing to enforce.
  const topLevelLlm = (parsed.metadata as
    | { cinatra?: { llm?: unknown } }
    | undefined)?.cinatra?.llm;
  if (!isPlainObject(topLevelLlm)) return [];

  const findings: ReviewFinding[] = [];
  walkBridgeApiNodes(parsed, (node, path) => {
    const data = isPlainObject(node.data)
      ? (node.data as Record<string, unknown>)
      : null;
    const hasCinatraLlm =
      data !== null && isPlainObject(data.cinatra_llm);
    if (hasCinatraLlm) return;
    const id =
      typeof node.id === "string" ? node.id : (node.name as string) ?? "<unknown>";
    findings.push({
      code: "OAS-RUNTIME-006",
      severity: "blocker",
      message:
        `ApiNode "${id}" at ${path} targets /api/llm-bridge and the agent ` +
        `declares top-level metadata.cinatra.llm, but the ApiNode does ` +
        `not carry data.cinatra_llm in source. WayFlow loads source OAS ` +
        `directly; the compile-time ` +
        `injectCinatraLlmIntoApiNodes pass only runs during ` +
        `agent_source_compile/publish and never reaches the runtime body. ` +
        `Add data.cinatra_llm: { preferredProvider, preferredModel, ` +
        `capabilityRequired? } to the ApiNode's data block matching the ` +
        `top-level metadata.cinatra.llm declaration. See ` +
        `packages/agents/src/__tests__/source-oas-cinatra-llm-injection.test.ts ` +
        `for the contract.`,
      location: path,
      source: "deterministic",
    });
  });
  return findings;
}

function walkBridgeApiNodes(
  parsed: Record<string, unknown>,
  visit: (node: Record<string, unknown>, path: string) => void,
): void {
  function go(node: unknown, path: string): void {
    if (!isPlainObject(node)) return;
    const o = node as Record<string, unknown>;
    if (o.component_type === "ApiNode") {
      const url = o.url;
      if (typeof url === "string" && url.includes("/api/llm-bridge")) {
        visit(o, path);
      }
    }
    const refs = o.$referenced_components;
    if (isPlainObject(refs)) {
      for (const [k, v] of Object.entries(refs as Record<string, unknown>)) {
        go(v, `${path}.$referenced_components.${k}`);
      }
    }
    // Subflow on a FlowNode
    const subflow = o.subflow;
    if (isPlainObject(subflow)) {
      go(subflow, `${path}.subflow`);
    }
  }
  go(parsed, "$");
}

// ---------------------------------------------------------------------------
// Invariant 7 — toolbox_ids in source for every /api/llm-bridge ApiNode
// (OAS-RUNTIME-007). Same shape as OAS-RUNTIME-006 for cinatra_llm —
// `propagateToolboxesIntoApiNodes` (oas-compiler.ts) runs only at
// compile time, but WayFlow loads source. Without `data.toolbox_ids`
// in source, the bridge defaults to `["cinatra-mcp"]` and the agent's
// declared toolbox restriction (e.g. `["web_search"]`) is silently
// lost — bridge then shapes the full ~130-primitive MCP suite into the
// LLM call instead of the narrow set the author intended.
//
// Only fires when top-level `metadata.cinatra.toolboxes` is declared
// (the trigger for compile-time propagation). Agents that don't declare
// toolboxes are passthrough to the default and unaffected.
// ---------------------------------------------------------------------------

function scanForToolboxIdsInSource(
  parsed: Record<string, unknown>,
): ReviewFinding[] {
  const topLevel = (parsed.metadata as
    | { cinatra?: { toolboxes?: unknown } }
    | undefined)?.cinatra?.toolboxes;
  if (!Array.isArray(topLevel) || topLevel.length === 0) return [];
  if (!topLevel.every((t) => typeof t === "string")) return [];

  const findings: ReviewFinding[] = [];
  walkBridgeApiNodes(parsed, (node, path) => {
    const data = isPlainObject(node.data)
      ? (node.data as Record<string, unknown>)
      : null;
    const hasToolboxIds =
      data !== null && Array.isArray(data.toolbox_ids);
    if (hasToolboxIds) return;
    const id =
      typeof node.id === "string" ? node.id : (node.name as string) ?? "<unknown>";
    findings.push({
      code: "OAS-RUNTIME-007",
      severity: "blocker",
      message:
        `ApiNode "${id}" at ${path} targets /api/llm-bridge and the agent ` +
        `declares top-level metadata.cinatra.toolboxes, but the ApiNode ` +
        `does not carry data.toolbox_ids in source. WayFlow loads source ` +
        `OAS directly; the compile-time ` +
        `propagateToolboxesIntoApiNodes pass only runs during ` +
        `agent_source_compile/publish and never reaches the runtime body. ` +
        `Without source-side data.toolbox_ids, the bridge defaults to ` +
        `["cinatra-mcp"] and your declared toolbox restriction is silently ` +
        `lost. Add data.toolbox_ids: [...] to the ApiNode's data block ` +
        `matching the top-level metadata.cinatra.toolboxes declaration.`,
      location: path,
      source: "deterministic",
    });
  });
  return findings;
}

// ---------------------------------------------------------------------------
// Invariant 8 — Internal A2AAgent misuse (OAS-RUNTIME-008).
//
// A2A is the cross-instance / external agent protocol. Using `A2AAgent` for
// INTERNAL sub-agent composition inside the same WayFlow process is wrong
// for two reasons:
//   1. wayflowcore's AgentExecutionStep explicitly rejects typed `outputs`
//      on AgentNodes wrapping A2AAgent ("Only Agent, ManagerWorkers and
//      Swarm in AgentExecutionStep supports setting outputs ... A2AAgent ...
//      set the outputs to None"). The topology cannot return typed findings
//      to a parent flow.
//   2. It's wasted indirection — HTTP round-trip + serialization + another
//      deserialization for components already loaded in the same process.
//
// Canonical replacement patterns (use one):
//   - `FlowNode` with a subflow that vendors the child's Flow content with
//     prefixed node IDs (email-outreach-agent has working examples).
//   - A deterministic MCP primitive that orchestrates the call (TypeScript
//     handler that invokes child agents in-process and returns a structured
//     result). Best when the parent is a thin orchestrator with no HITL
//     surface of its own.
//
// Scope: blocker fires only when the A2AAgent's `agent_url` points back into
// the same Cinatra instance (internal composition). External / cross-
// instance A2A is the legitimate use case and is left untouched — the
// scanner does NOT globally ban A2AAgent.
//
// Internal-URL signals (any one triggers the blocker):
//   - `{{CINATRA_BASE_URL}}` template placeholder
//   - `localhost`, `127.0.0.1`, `0.0.0.0`, `::1` host (IPv4 + IPv6 loopback)
//   - `host.docker.internal` (docker-compose self-call)
//   - the `/api/a2a/agents/...` route prefix (ANY host) — this is Cinatra's
//     own internal A2A proxy route gated by CINATRA_BRIDGE_TOKEN; external
//     A2A traffic NEVER reaches it (per https://docs.cinatra.ai/references/platform/cross-instance-collaboration/).
//     A tunnel/public hostname pointing at this prefix
//     is still same-instance internal composition.
//   - relative URLs starting with `/api/a2a/agents/` (no scheme)
//
// External cross-instance A2A uses different route shapes (typically
// `/api/a2a` at the root, not `/api/a2a/agents/<vendor>/<slug>`) — the
// scanner does NOT touch those.
// ---------------------------------------------------------------------------

const INTERNAL_A2A_HOST_PATTERNS: RegExp[] = [
  /\{\{\s*CINATRA_BASE_URL\s*\}\}/,
  /https?:\/\/localhost(?::\d+)?(?:\/|$)/i,
  /https?:\/\/127\.0\.0\.1(?::\d+)?(?:\/|$)/i,
  /https?:\/\/0\.0\.0\.0(?::\d+)?(?:\/|$)/i,
  /https?:\/\/\[::1\](?::\d+)?(?:\/|$)/i,
  /https?:\/\/host\.docker\.internal(?::\d+)?(?:\/|$)/i,
];

const CINATRA_A2A_ROUTE_PREFIX = "/api/a2a/agents/";

function isInternalA2aUrl(agentUrl: string): "internal" | "external" {
  for (const pattern of INTERNAL_A2A_HOST_PATTERNS) {
    if (pattern.test(agentUrl)) return "internal";
  }
  // The Cinatra A2A route prefix is internal-composition plumbing regardless
  // of host. Per https://docs.cinatra.ai/references/platform/cross-instance-collaboration/, external A2A
  // traffic uses `/api/a2a` (no `/agents/` segment) and `/api/a2a/agents/`
  // is gated by CINATRA_BRIDGE_TOKEN — it's an internal WayFlow proxy.
  // A tunnel/public-host URL targeting this prefix is the realistic
  // failure mode the scanner is meant to stop. Treat as blocker.
  if (agentUrl.includes(CINATRA_A2A_ROUTE_PREFIX)) return "internal";
  return "external";
}

function scanForInternalA2aAgentMisuse(
  parsed: Record<string, unknown>,
): ReviewFinding[] {
  const findings: ReviewFinding[] = [];

  // Walk every object/array position so inline A2AAgent declarations under
  // AgentNode.agent, nodes[], subflow refs, etc. are caught — not just the
  // canonical $referenced_components keying. The OAS author can place an
  // A2AAgent anywhere in the tree; the scanner must follow.
  function visit(node: unknown, path: string): void {
    if (Array.isArray(node)) {
      node.forEach((item, idx) => visit(item, `${path}[${idx}]`));
      return;
    }
    if (!isPlainObject(node)) return;
    const o = node as Record<string, unknown>;

    if (o.component_type === "A2AAgent") {
      const agentUrl = typeof o.agent_url === "string" ? o.agent_url : "";
      const classification = isInternalA2aUrl(agentUrl);
      const id =
        typeof o.id === "string" ? o.id : (o.name as string) ?? "<unknown>";

      if (classification === "internal") {
        findings.push({
          code: "OAS-RUNTIME-008",
          severity: "blocker",
          message:
            `A2AAgent "${id}" at ${path} targets an internal URL (` +
            `${agentUrl || "<empty agent_url>"}). A2A is the cross-instance/` +
            `external protocol; internal sub-agent composition must use ` +
            `FlowNode subflow inlining (the email-outreach-agent pattern) ` +
            `or a deterministic MCP primitive. wayflowcore's ` +
            `AgentExecutionStep explicitly rejects typed outputs on AgentNodes ` +
            `wrapping A2AAgent, so this topology cannot return findings to a ` +
            `parent flow. See packages/agents/src/validate-oas-runtime-invariants.ts ` +
            `OAS-RUNTIME-008 ` +
            `for the architectural rule.`,
          location: path,
          source: "deterministic",
        });
      }
    }

    // Recurse into every key/value (not just $referenced_components).
    for (const [k, v] of Object.entries(o)) {
      visit(v, `${path}.${k}`);
    }
  }

  visit(parsed, "$");
  return findings;
}

// ---------------------------------------------------------------------------
// Invariant 4 — agent_run_id propagation (OAS-RUNTIME-004).
// ---------------------------------------------------------------------------

function scanAgentRunIdPropagation(flow: FlowComponent): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  for (const node of flow.apiNodes) {
    const placeholders = inferPlaceholderSet(node.placeholderSourceText);
    if (!placeholders.has("agent_run_id")) continue;

    // Two runtime-valid shapes:
    //   (a) Canonical email-outreach pattern:
    //       Flow.inputs has `cinatra_run_id`,
    //       StartNode.inputs has `cinatra_run_id`,
    //       a DFE maps start.cinatra_run_id → <node.id>.agent_run_id,
    //       ApiNode.inputs declares `agent_run_id`.
    //   (b) Legacy direct shape:
    //       Flow.inputs has `agent_run_id`,
    //       StartNode.inputs has `agent_run_id`,
    //       a DFE maps start.agent_run_id → <node.id>.agent_run_id,
    //       ApiNode.inputs declares `agent_run_id`.
    // We accept either at runtime; both work with execution.ts cinatra_run_id
    // injection because legacy agents are still mounted by the existing
    // bridge wiring. This validator catches BROKEN propagation only.

    // Step 1: if inputs[] is explicitly declared, agent_run_id must be in it.
    // (When inputs[] is absent, pyagentspec auto-infers agent_run_id as a
    // string input — no declaration is required.)
    const apiInputs = new Set(node.inputTitles);
    if (node.inputsExplicit && !apiInputs.has("agent_run_id")) {
      findings.push({
        code: "OAS-RUNTIME-004",
        severity: "blocker",
        message:
          `ApiNode "${node.id}" references {{ agent_run_id }} in its template ` +
          `body but does not declare "agent_run_id" in inputs[]. ` +
          `pyagentspec will reject this at mount with the same "expected only ` +
          `properties with the titles: [...]" error as a normal parity break ` +
          `(OAS-RUNTIME-001). Add { "title": "agent_run_id", "type": "string" } ` +
          `to the ApiNode inputs[], and ensure a DataFlowEdge sources it from ` +
          `the StartNode (canonical pattern uses ` +
          `start.cinatra_run_id → ${node.id}.agent_run_id; any bundled ` +
          `flow agent's cinatra/oas.json shows the shape).`,
        location: `$referenced_components.${node.id} (Flow "${flow.flowId}")`,
        source: "deterministic",
      });
      continue;
    }

    // Step 2: there must be a DFE feeding agent_run_id into this ApiNode —
    // UNLESS the ApiNode's `agent_run_id` input has an explicit `default`
    // value, in which case pyagentspec accepts a missing DFE and uses the
    // default at runtime. (Many agents declare `"default": ""` defensively;
    // this is runtime-valid and the canonical auditor-agent pattern.)
    const hasInputDefault =
      node.inputsExplicit && node.inputDefaults.has("agent_run_id");
    if (hasInputDefault) continue;
    const dfeInto = flow.dfes.filter(
      (e) =>
        e.destinationNodeRef === node.id && e.destinationInput === "agent_run_id",
    );
    if (dfeInto.length === 0) {
      findings.push({
        code: "OAS-RUNTIME-004",
        severity: "blocker",
        message:
          `ApiNode "${node.id}" declares "agent_run_id" in inputs[] but no ` +
          `DataFlowEdge feeds it. The Flow loader will reject this at mount ` +
          `with "the flow requires the input descriptor ... because some step ` +
          `requires it but that is not available in the StartStep". Add a ` +
          `DataFlowEdge whose destination_node is "${node.id}" and ` +
          `destination_input is "agent_run_id", sourcing it from the StartNode ` +
          `output (either start.cinatra_run_id — canonical email-outreach ` +
          `pattern — or start.agent_run_id — legacy variant).`,
        location: `$referenced_components.${node.id} (Flow "${flow.flowId}")`,
        source: "deterministic",
      });
      continue;
    }

    // Step 3: the DFE source must be a real StartNode-declared input,
    // either `cinatra_run_id` (canonical) or `agent_run_id` (legacy).
    const startInputs = flow.startNode ? new Set(flow.startNode.inputTitles) : new Set<string>();
    const flowInputs = new Set(flow.flowInputTitles);
    let satisfied = false;
    for (const e of dfeInto) {
      if (e.sourceNodeRef !== flow.startNodeRef) continue;
      const src = e.sourceOutput;
      if (
        (src === "cinatra_run_id" || src === "agent_run_id") &&
        startInputs.has(src) &&
        flowInputs.has(src)
      ) {
        satisfied = true;
        break;
      }
    }
    if (!satisfied) {
      findings.push({
        code: "OAS-RUNTIME-004",
        severity: "blocker",
        message:
          `ApiNode "${node.id}" agent_run_id DataFlowEdge does not resolve to a ` +
          `StartNode output backed by a matching Flow input. The DFE must source ` +
          `from the StartNode (component_ref="${flow.startNodeRef}") with ` +
          `source_output "cinatra_run_id" (canonical email-outreach pattern) or ` +
          `"agent_run_id" (legacy variant), and that name must appear in BOTH ` +
          `the Flow root inputs[] AND the StartNode inputs[]. ` +
          `Flow inputs: [${[...flowInputs].join(", ")}]. ` +
          `StartNode inputs: [${[...startInputs].join(", ")}].`,
        location: `$referenced_components.${node.id} (Flow "${flow.flowId}")`,
        source: "deterministic",
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Invariant 5 — EndNode output sources (OAS-RUNTIME-005).
// ---------------------------------------------------------------------------

function scanEndNodeOutputSources(flow: FlowComponent): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  if (!flow.endNode) return findings;
  const flowInputTitles = new Set(flow.flowInputTitles);
  const startInputTitles = flow.startNode
    ? new Set(flow.startNode.inputTitles)
    : new Set<string>();

  for (const output of flow.endNode.outputTitles) {
    // (a) DFE feeds this output directly.
    const dfeIntoEnd = flow.dfes.some(
      (e) =>
        e.destinationNodeRef === flow.endNodeRef &&
        e.destinationInput === output,
    );
    if (dfeIntoEnd) continue;
    // (b) Same-named Flow input that trickles through StartNode (start.X → end.X
    // requires StartNode to declare it; the pyagentspec graph tolerates the
    // missing explicit edge in many cases as the loader auto-binds names).
    if (flowInputTitles.has(output) && startInputTitles.has(output)) continue;
    findings.push({
      code: "OAS-RUNTIME-005",
      severity: "blocker",
      message:
        `EndNode declares output "${output}" but no DataFlowEdge sources it ` +
        `and no same-named Flow input is available via the StartNode. ` +
        `pyagentspec's Flow loader will reject this at mount with: ` +
        `"the flow requires the input descriptor ... because some step requires ` +
        `it but that is not available in the StartStep". Three fixes by ` +
        `preference: (a) wire an explicit DataFlowEdge from the upstream node ` +
        `that actually produces "${output}"; (b) declare "${output}" in Flow ` +
        `inputs + StartNode inputs and add a DataFlowEdge start.${output} → ` +
        `end.${output} for trivial pass-through; (c) if nothing produces the ` +
        `value, drop "${output}" from the EndNode outputs[] AND Flow outputs[]. ` +
        `See docs/developing-agents.md.`,
      location: `$referenced_components.${flow.endNodeRef} (Flow "${flow.flowId}")`,
      source: "deterministic",
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Graph extraction — builds a normalized view of one Flow component
// (the top-level Flow, plus any subflows nested under $referenced_components).
// ---------------------------------------------------------------------------

interface FlowComponent {
  flowId: string;
  flowInputTitles: string[];
  startNodeRef: string;
  startNode: { inputTitles: string[] } | null;
  endNodeRef: string;
  endNode: { outputTitles: string[] } | null;
  apiNodes: Array<{
    id: string;
    inputTitles: string[];
    inputDefaults: Map<string, unknown>;
    inputsExplicit: boolean;
    placeholderSourceText: string;
  }>;
  dfes: Array<{
    sourceNodeRef: string;
    sourceOutput: string;
    destinationNodeRef: string;
    destinationInput: string;
  }>;
}

function* iterFlowComponents(
  parsed: Record<string, unknown>,
): Generator<FlowComponent, void, unknown> {
  // Recursive subflow traversal. Walk the tree of Flow components rooted
  // at `parsed`, yielding every Flow at every depth.
  // A `visited` set protects against `$referenced_components` cycles
  // (`$component_ref` can in principle point at a Flow that already
  // appeared higher in the tree).
  const visited = new Set<object>();
  yield* walkFlows(parsed, visited);
}

function* walkFlows(
  node: unknown,
  visited: Set<object>,
): Generator<FlowComponent, void, unknown> {
  if (!isPlainObject(node)) return;
  if (visited.has(node)) return;
  visited.add(node);

  if (node.component_type === "Flow") {
    const flow = extractFlow(node as Record<string, unknown>);
    if (flow) yield flow;
  }

  // Descend into $referenced_components (where nested Flow components +
  // their own subflows live).
  const refs = (node as Record<string, unknown>).$referenced_components;
  if (isPlainObject(refs)) {
    for (const value of Object.values(refs)) {
      yield* walkFlows(value, visited);
    }
  }

  // pyagentspec also allows a FlowNode component to embed a subflow
  // directly under a `subflow` field. Descend into that branch too —
  // catches nested-FlowNode cases that don't live under
  // $referenced_components.
  const subflow = (node as Record<string, unknown>).subflow;
  if (isPlainObject(subflow)) {
    yield* walkFlows(subflow, visited);
  }
}

function extractFlow(
  raw: Record<string, unknown>,
): FlowComponent | null {
  const flowId =
    typeof raw.id === "string" ? raw.id : (raw.name as string) ?? "<unknown>";
  const flowInputs = Array.isArray(raw.inputs) ? raw.inputs : [];
  const flowInputTitles = flowInputs
    .filter(isPlainObject)
    .map((i) => i.title as string)
    .filter((t): t is string => typeof t === "string");

  const startNodeRef = resolveComponentRef(raw.start_node) ?? "start";
  const endNodes = listEndNodes(raw);
  const endNodeRef = endNodes[0]?.id ?? "end";

  const refs = isPlainObject(raw.$referenced_components)
    ? (raw.$referenced_components as Record<string, unknown>)
    : {};

  const startNode = isPlainObject(refs[startNodeRef])
    ? extractIoNode(refs[startNodeRef] as Record<string, unknown>)
    : null;
  const endNode = endNodes[0] ?? null;

  const apiNodes: FlowComponent["apiNodes"] = [];
  for (const [id, value] of Object.entries(refs)) {
    if (!isPlainObject(value)) continue;
    if ((value as Record<string, unknown>).component_type !== "ApiNode") continue;
    const apiNode = value as Record<string, unknown>;
    // pyagentspec auto-infers placeholder names as string-typed inputs when
    // the `inputs` field is ABSENT from the OAS. Parity (OAS-RUNTIME-001)
    // applies only when `inputs` is explicitly declared as an array — even
    // an empty `inputs: []` is an explicit assertion. See email-outreach
    // context_setup for the canonical "no inputs[]" reference.
    const inputsField = apiNode.inputs;
    const inputsExplicit = Array.isArray(inputsField);
    const inputTitles: string[] = [];
    const inputDefaults = new Map<string, unknown>();
    if (inputsExplicit) {
      for (const raw of inputsField as unknown[]) {
        if (!isPlainObject(raw)) continue;
        const desc = raw as Record<string, unknown>;
        if (typeof desc.title !== "string") continue;
        inputTitles.push(desc.title);
        if ("default" in desc) inputDefaults.set(desc.title, desc.default);
      }
    }
    apiNodes.push({
      id,
      inputTitles,
      inputDefaults,
      inputsExplicit,
      placeholderSourceText: serializeApiNodePlaceholderSources(apiNode),
    });
  }

  const dfesRaw = Array.isArray(raw.data_flow_connections)
    ? raw.data_flow_connections
    : [];
  const dfes = dfesRaw
    .filter(isPlainObject)
    .filter(
      (e) => (e as Record<string, unknown>).component_type === "DataFlowEdge",
    )
    .map((e) => {
      const o = e as Record<string, unknown>;
      return {
        sourceNodeRef: resolveComponentRef(o.source_node) ?? "<unknown>",
        sourceOutput: typeof o.source_output === "string" ? o.source_output : "",
        destinationNodeRef:
          resolveComponentRef(o.destination_node) ?? "<unknown>",
        destinationInput:
          typeof o.destination_input === "string" ? o.destination_input : "",
      };
    });

  return {
    flowId,
    flowInputTitles,
    startNodeRef,
    startNode,
    endNodeRef,
    endNode: endNode
      ? { outputTitles: endNode.outputs.map((o) => o.title) }
      : null,
    apiNodes,
    dfes,
  };
}

function extractIoNode(
  raw: Record<string, unknown>,
): { inputTitles: string[] } | null {
  const inputs = Array.isArray(raw.inputs) ? raw.inputs : [];
  const inputTitles = inputs
    .filter(isPlainObject)
    .map((i) => i.title as string)
    .filter((t): t is string => typeof t === "string");
  return { inputTitles };
}

function listEndNodes(
  raw: Record<string, unknown>,
): Array<{ id: string; outputs: Array<{ title: string }> }> {
  const refs = isPlainObject(raw.$referenced_components)
    ? (raw.$referenced_components as Record<string, unknown>)
    : {};
  const result: Array<{ id: string; outputs: Array<{ title: string }> }> = [];
  for (const [id, value] of Object.entries(refs)) {
    if (!isPlainObject(value)) continue;
    const v = value as Record<string, unknown>;
    if (v.component_type !== "EndNode") continue;
    const outputs = Array.isArray(v.outputs) ? v.outputs : [];
    const outputTitles = outputs
      .filter(isPlainObject)
      .map((o) => (o as Record<string, unknown>).title)
      .filter((t): t is string => typeof t === "string")
      .map((t) => ({ title: t }));
    result.push({ id, outputs: outputTitles });
  }
  return result;
}

function serializeApiNodePlaceholderSources(
  apiNode: Record<string, unknown>,
): string {
  const parts: string[] = [];
  for (const key of APINODE_PLACEHOLDER_SOURCES) {
    const value = apiNode[key];
    if (value === undefined) continue;
    // Serialize JSON so nested fields like `data.user` and `headers["X-Foo"]`
    // contribute their string values. pyagentspec walks the same nested
    // structures; JSON.stringify gives a stable text representation that
    // catches every placeholder regardless of nesting depth.
    parts.push(JSON.stringify(value));
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Utilities.
// ---------------------------------------------------------------------------

function inferPlaceholderSet(text: string): Set<string> {
  const result = new Set<string>();
  PLACEHOLDER_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PLACEHOLDER_REGEX.exec(text)) !== null) {
    const name = m[1];
    if (!name) continue;
    // Env-var placeholders (`{{CINATRA_BASE_URL}}`, `{{SOME_ENV}}`) are
    // substituted by agent_loader.py BEFORE pyagentspec sees the OAS,
    // so they must NOT be treated as flow input descriptors.
    if (ENV_VAR_PLACEHOLDER.test(name)) continue;
    result.add(name);
  }
  return result;
}

function setDiff<T>(a: Set<T>, b: Set<T>): Set<T> {
  const out = new Set<T>();
  for (const x of a) if (!b.has(x)) out.add(x);
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function resolveComponentRef(value: unknown): string | null {
  if (!isPlainObject(value)) return null;
  const ref = (value as Record<string, unknown>)["$component_ref"];
  return typeof ref === "string" ? ref : null;
}

function walkStrings(
  obj: unknown,
  visit: (text: string, path: string) => void,
  path = "$",
): void {
  if (typeof obj === "string") {
    visit(obj, path);
  } else if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      walkStrings(obj[i], visit, `${path}[${i}]`);
    }
  } else if (isPlainObject(obj)) {
    for (const [k, v] of Object.entries(obj)) {
      walkStrings(v, visit, `${path}.${k}`);
    }
  }
}

function walkPropertyDescriptors(
  obj: unknown,
  visit: (descriptor: { type?: unknown; default?: unknown; title?: unknown }, path: string) => void,
  path = "$",
): void {
  if (isPlainObject(obj)) {
    const o = obj as Record<string, unknown>;
    // Recognize "property descriptor" by the shape `{ title: string,
    // type: string }` — same pattern pyagentspec uses.
    if (typeof o.title === "string" && typeof o.type === "string") {
      visit(o as { type: unknown; default?: unknown; title?: unknown }, path);
    }
    for (const [k, v] of Object.entries(o)) {
      walkPropertyDescriptors(v, visit, `${path}.${k}`);
    }
  } else if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      walkPropertyDescriptors(obj[i], visit, `${path}[${i}]`);
    }
  }
}

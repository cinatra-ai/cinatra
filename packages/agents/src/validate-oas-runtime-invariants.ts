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
 *   OAS-RUNTIME-013 — HITL `InputMessageNode` gate the pinned WayFlow runtime
 *                     cannot mount (cinatra#2140). The ruled contract lives in
 *                     `docs/internals/workflows/agent-run-hitl-prompt-primitives.md`
 *                     ("Pinned-runtime contract for the gate node", cinatra#1830):
 *                     the gate is AUTHORED as `component_type:"InputMessageNode"`
 *                     with declared `inputs` fed by a `DataFlowEdge` (the host
 *                     compiler pins that literal), and the WayFlow loader shim
 *                     `_reconcile_input_message_gates` reconciles it to
 *                     `PluginInputMessageNode` + a synthesized `message_template`
 *                     at mount. That shim is CONDITIONAL — it declines to repair
 *                     some shapes, and pyagentspec then rejects the gate. This
 *                     invariant is the HOST half of that same contract, so the
 *                     two mount paths (the agent package mounted STANDALONE and
 *                     the same gate inlined as a subflow of an orchestrator)
 *                     cannot drift apart unnoticed.
 *
 * See `docs/developing-agents.md` "pyagentspec constraints when authoring
 * oas.json" for the human-readable description of each pattern.
 *
 * ---------------------------------------------------------------------------
 * ADVISORY artifact-parity family (cinatra#924) — OAS-RUNTIME-009..012.
 *
 * These are emitted by the SEPARATE `scanOasForArtifactParityFindings` export,
 * NOT by `scanOasForRuntimeInvariantFindings` above. Unlike the 001..008 mount
 * invariants (all SEVERITY: BLOCKER, aggregated into `validateOasAgentJson`),
 * the parity family is ADVISORY: every finding is SEVERITY: WARNING and the
 * scanner is wired ONLY into `/api/oas-lint/scan-all` (the fleet dashboard).
 * The genuine hard-fail for a NET-NEW malformed binding annotation is owned by
 * the compile/publish gate (oas-compiler.ts step 10b/10c, which already rejects
 * collector errors); Layer 3 only mirrors those as advisory visibility so an
 * un-migrated agent repo is never reddened by this surface. See #922 design.
 *
 *   OAS-RUNTIME-009 — a declared `cinatra.produces` extension has no runnable
 *                     materialization edge (EndNode `outputs[].cinatra.artifact`
 *                     binding or an `artifact_materialize` passthrough ApiNode).
 *   OAS-RUNTIME-010 — a passthrough object/artifact WRITE node
 *                     (objects_save / objects_update / artifact_materialize)
 *                     consumes an input with no declared DataFlowEdge.
 *   OAS-RUNTIME-011 — `metadata.cinatra.riskClass:"read_only"` on a node that
 *                     invokes a write tool (silently ungates a side effect).
 *   OAS-RUNTIME-012 — prompt prose instructing a legacy persistence primitive
 *                     (`artifact_authoring_emit` / `objects_save`); the
 *                     declarative binding replaces prompt-driven persistence.
 */

import type { ReviewFinding } from "./validate-agent-json";
import {
  collectArtifactBindingsFromOasDocument,
  collectArtifactMaterializeNodesFromOasDocument,
  ARTIFACT_MATERIALIZE_TOOL,
  AGENTS_PASSTHROUGH_URL_MARKER,
} from "./artifact-binding";
import { SIDE_EFFECT_PATTERNS } from "./trigger-infer-side-effects";

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
// that blowup is a reachable ReDoS (js/polynomial-redos).
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
  findings.push(...scanInputMessageGateMountability(parsed));
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
// Invariant 13 — HITL gate mountability on the pinned runtime (OAS-RUNTIME-013).
//
// This mirrors, on the HOST side, exactly what the WayFlow loader shim
// `_reconcile_input_message_gates` (docker/wayflow/agent_loader.py, cinatra#1830)
// can and cannot repair, so an OAS that the container refuses to mount is
// rejected at authoring/CI time instead of at boot.
//
// Every rule below is grounded in an observed pyagentspec==26.1.2 outcome
// (see docker/wayflow/tests/test_gate_mount_both_paths.py, which asserts the
// same cases against the real runtime):
//
//   declared `inputs`, plain unique identifier titles   → shim repairs, MOUNTS
//   declared `inputs` + non-identifier title            → shim declines, REJECTED
//   declared `inputs` + duplicate titles                → shim declines, REJECTED
//   declared `inputs` + a TRUTHY message_template       → shim skips, REJECTED
//   declared `inputs` + a FALSY message_template
//     (null / false / 0 / "" / [] / {})                 → shim OVERWRITES it, MOUNTS
//   declared `inputs` + a `message` (with or without a
//     matching placeholder)                             → shim repairs, MOUNTS
//   more than one declared output                       → REJECTED with or
//     without declared inputs (the one-string-output rule); the shim cannot help
//   an EMPTY declared `outputs` array                   → REJECTED ("expected a
//     property titled `user_provided_input`"). An ABSENT `outputs` field is a
//     different case: the runtime defaults it and MOUNTS, and the host compiler
//     already rejects it (MISSING_INPUT_MESSAGE_OUTPUT), so it is not repeated here.
//   a single output whose declared `type` is not
//     "string"                                          → REJECTED ("Expected an
//     output of type string, given `<type>` instead")
//   `PluginInputMessageNode` authored directly          → the RUNTIME accepts it.
//     This one rule is a HOST-contract rule rather than a mount rule: the host
//     compiler pins the `InputMessageNode` literal, so an authored
//     PluginInputMessageNode gate is invisible to it (no approval step, no
//     renderer binding) — a silently ungated side effect.
// ---------------------------------------------------------------------------

/** Jinja identifier the loader shim is willing to fold into a synthesized
 *  `message_template` — byte-identical to `_GATE_INPUT_TITLE_RE` in
 *  `docker/wayflow/agent_loader.py`. */
const GATE_INPUT_TITLE_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Python truthiness for a JSON value, because the loader shim's
 *  "already templated?" test is `bool(obj.get("message_template"))`. A falsy
 *  value there is OVERWRITTEN by the synthesized template (so the gate mounts);
 *  only a truthy one makes the shim skip the node. Mirroring JS truthiness
 *  instead would red `[]` / `{}`, which Python treats as falsy. */
function isPythonTruthy(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (value === 0 || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return Boolean(value);
}

const HITL_GATE_DOC =
  "See docs/internals/workflows/agent-run-hitl-prompt-primitives.md " +
  '("Pinned-runtime contract for the gate node", cinatra#1830/#2140).';

function scanInputMessageGateMountability(
  parsed: Record<string, unknown>,
): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  walkComponentObjects(parsed, (node, path) => {
    const componentType = node["component_type"];

    if (componentType === "PluginInputMessageNode") {
      findings.push({
        code: "OAS-RUNTIME-013",
        severity: "blocker",
        message:
          `Gate "${gateLabel(node)}" is authored as "PluginInputMessageNode". ` +
          `Do not author the reconciled form directly: the host compiler ` +
          `(packages/agents/src/oas-compiler.ts) pins ` +
          `component_type === "InputMessageNode" to detect a HITL gate, so a ` +
          `PluginInputMessageNode is invisible to it — the run gets no approval ` +
          `step and no renderer binding even though the WayFlow runtime mounts ` +
          `it happily (a SILENTLY ungated side effect). Author ` +
          `"InputMessageNode" with declared inputs[] fed by a DataFlowEdge and ` +
          `let the loader shim reconcile it at mount. ${HITL_GATE_DOC}`,
        location: path,
        source: "deterministic",
      });
      return;
    }

    if (componentType !== "InputMessageNode") return;

    // --- one-string-output rule -------------------------------------------
    // Only an EXPLICIT `outputs` array is judged here. An absent field is
    // defaulted by the runtime (it mounts) and is already rejected by the host
    // compiler, so flagging it again would be a rule this scan cannot back with
    // an observed mount failure.
    const outputs = node["outputs"];
    if (Array.isArray(outputs) && outputs.length > 1) {
      const titles = outputs.map((o) =>
        isPlainObject(o) && typeof o["title"] === "string" ? o["title"] : "<unnamed>",
      );
      findings.push({
        code: "OAS-RUNTIME-013",
        severity: "blocker",
        message:
          `InputMessageNode gate "${gateLabel(node)}" declares ${outputs.length} ` +
          `outputs [${titles.map((t) => `"${t}"`).join(", ")}]. A gate returns ` +
          `EXACTLY ONE string output — the resume payload. pyagentspec rejects a ` +
          `multi-output gate at mount ("received a property titled ` +
          `\`${titles[1]}\`, but expected only properties with the titles: ` +
          `['${titles[0]}']") and the loader shim cannot repair it. Extract the ` +
          `extra fields from the single resume payload in a post-resume node. ` +
          `${HITL_GATE_DOC}`,
        location: path,
        source: "deterministic",
      });
    } else if (Array.isArray(outputs) && outputs.length === 0) {
      findings.push({
        code: "OAS-RUNTIME-013",
        severity: "blocker",
        message:
          `InputMessageNode gate "${gateLabel(node)}" declares an EMPTY outputs[]. ` +
          `A gate must declare exactly one string output (the resume payload); ` +
          `pyagentspec rejects an output-less gate at mount ("expected a property ` +
          `titled \`user_provided_input\`, but none of the passed properties have ` +
          `this title: []"). ${HITL_GATE_DOC}`,
        location: path,
        source: "deterministic",
      });
    } else if (Array.isArray(outputs) && outputs.length === 1) {
      const only = outputs[0];
      const declaredType = isPlainObject(only) ? only["type"] : undefined;
      if (typeof declaredType === "string" && declaredType !== "string") {
        findings.push({
          code: "OAS-RUNTIME-013",
          severity: "blocker",
          message:
            `InputMessageNode gate "${gateLabel(node)}" declares its single output ` +
            `as "type":"${declaredType}". A gate output is the JSON-encoded resume ` +
            `payload and must be a string; pyagentspec rejects any other type at ` +
            `mount ("Expected an output of type string, given \`${declaredType}\` ` +
            `instead"). Parse the payload in a post-resume node. ${HITL_GATE_DOC}`,
          location: path,
          source: "deterministic",
        });
      }
    }

    // --- declared-inputs reconcilability ----------------------------------
    const inputs = node["inputs"];
    if (!Array.isArray(inputs) || inputs.length === 0) return;

    // An author-supplied `message_template` makes the shim treat the node as
    // already reconciled and skip it — the declared `inputs` then survive into
    // the runtime and the mount is rejected. Python truthiness, not JS: the shim
    // OVERWRITES a falsy message_template (null/false/0/""/[]/{}) and the gate
    // still mounts, so those must NOT be flagged.
    if (isPythonTruthy(node["message_template"])) {
      findings.push({
        code: "OAS-RUNTIME-013",
        severity: "blocker",
        message:
          `InputMessageNode gate "${gateLabel(node)}" declares inputs[] AND an ` +
          `author-supplied "message_template". The WayFlow loader shim skips a ` +
          `gate that already carries a message_template, so the declared inputs ` +
          `reach pyagentspec unreconciled and the mount is rejected ("received a ` +
          `property titled \`<name>\`, but did not expect any properties"). Drop ` +
          `the message_template and let the shim synthesize it. ${HITL_GATE_DOC}`,
        location: path,
        source: "deterministic",
      });
      return;
    }

    const titles = inputs.map((i) =>
      isPlainObject(i) && typeof i["title"] === "string" ? i["title"] : null,
    );
    const badTitles = titles.filter(
      (t): t is string | null => t === null || !GATE_INPUT_TITLE_RE.test(t),
    );
    if (badTitles.length > 0) {
      findings.push({
        code: "OAS-RUNTIME-013",
        severity: "blocker",
        message:
          `InputMessageNode gate "${gateLabel(node)}" declares input title(s) ` +
          `[${badTitles.map((t) => (t === null ? "<missing>" : `"${t}"`)).join(", ")}] ` +
          `that are not plain Jinja identifiers (/${GATE_INPUT_TITLE_RE.source}/). ` +
          `The WayFlow loader shim folds declared gate inputs into a synthesized ` +
          `message_template and refuses to do so for a title it cannot safely ` +
          `emit, so the gate stays an unreconciled InputMessageNode and ` +
          `pyagentspec rejects it at mount ("received a property titled ` +
          `\`<name>\`, but did not expect any properties"). Rename the input to a ` +
          `plain identifier. ${HITL_GATE_DOC}`,
        location: path,
        source: "deterministic",
      });
      return;
    }

    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const t of titles as string[]) {
      if (seen.has(t)) duplicates.add(t);
      seen.add(t);
    }
    if (duplicates.size > 0) {
      findings.push({
        code: "OAS-RUNTIME-013",
        severity: "blocker",
        message:
          `InputMessageNode gate "${gateLabel(node)}" declares duplicate input ` +
          `title(s) [${[...duplicates].map((t) => `"${t}"`).join(", ")}]. The ` +
          `WayFlow loader shim declines to fold duplicate titles, and pyagentspec ` +
          `rejects the gate at mount ("Found multiple instances of properties ` +
          `(inputs or outputs) with the same title in a InputMessageNode"). ` +
          `${HITL_GATE_DOC}`,
        location: path,
        source: "deterministic",
      });
    }
  });
  return findings;
}

function gateLabel(node: Record<string, unknown>): string {
  const id = node["id"];
  if (typeof id === "string" && id.length > 0) return id;
  const name = node["name"];
  if (typeof name === "string" && name.length > 0) return name;
  return "<unnamed>";
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
    /** ApiNode `url` (null when absent/non-string) — passthrough-route detection. */
    url: string | null;
    /** Literal `data.tool` selection (null when absent/non-string/templated). */
    tool: string | null;
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
    const url = typeof apiNode.url === "string" ? apiNode.url : null;
    const dataBlock = isPlainObject(apiNode.data) ? apiNode.data : null;
    const tool =
      dataBlock !== null && typeof dataBlock.tool === "string" ? dataBlock.tool : null;
    apiNodes.push({
      id,
      inputTitles,
      inputDefaults,
      inputsExplicit,
      placeholderSourceText: serializeApiNodePlaceholderSources(apiNode),
      url,
      tool,
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

// ===========================================================================
// ADVISORY artifact-parity scanner (cinatra#924) — OAS-RUNTIME-009..012.
//
// SEPARATE from `scanOasForRuntimeInvariantFindings`: this export is wired ONLY
// into `/api/oas-lint/scan-all` and emits WARNING-severity findings only, so it
// can never hard-gate a publish (scan-all re-stamps findings to the
// blocker-authorized `agent-lint-policy` source — a blocker here WOULD block, so
// warnings-only is a hard invariant of this surface). It reuses the #923 binding
// grammar as the SINGLE recognition source (no duplicate parser).
// ===========================================================================

/**
 * Passthrough object/artifact WRITE tools. Mirrors the write subset of the
 * `/api/agents/passthrough` `ALLOWED_TOOLS` (#925); read-only tools
 * (`objects_classify`) are intentionally excluded. `trigger_config_set` is
 * config plumbing, not an object/artifact write, so it is not listed.
 */
const ARTIFACT_PARITY_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "objects_save",
  "objects_update",
  ARTIFACT_MATERIALIZE_TOOL,
]);

/**
 * String fields whose NATURAL-LANGUAGE body can instruct an LLM to call a
 * persistence primitive (the legacy prose pattern the declarative binding
 * replaces). A `data.tool` value is a STRUCTURAL selection, not prose, and is
 * deliberately absent here so a legitimate `objects_save` tool node is never
 * flagged as prose. `description` is excluded — it documents intent, it does
 * not instruct the model.
 */
const PROSE_PROMPT_KEYS: ReadonlySet<string> = new Set([
  "system_prompt",
  "prompt_template",
  "instructions",
  "task",
  "taskSpec",
  "system",
  "user",
  "message",
]);

/**
 * Legacy persistence primitives whose PROSE instruction is the anti-pattern —
 * a declarative EndNode binding (`outputs[].cinatra.artifact`) or an
 * `artifact_materialize` passthrough node replaces prompt-driven persistence.
 */
const LEGACY_PERSISTENCE_PROSE_TOKENS = [
  "artifact_authoring_emit",
  "objects_save",
] as const;

/**
 * Advisory artifact-parity scan (WARNING-only). Surfaced fleet-wide via
 * `/api/oas-lint/scan-all`. `opts.produces` = the sibling package.json
 * `cinatra.produces` extension ids (null/undefined ⇒ unknown ⇒ the coverage
 * check is skipped; grammar/dataflow/riskClass/prose checks still run).
 */
export function scanOasForArtifactParityFindings(
  parsed: Record<string, unknown>,
  opts?: { produces?: readonly string[] | null },
): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const produces = opts?.produces ?? null;

  // OAS-RUNTIME-009 — declared production ⇒ runnable materialization edge.
  // Single grammar source: the #923 collectors.
  const bindingResult = collectArtifactBindingsFromOasDocument(parsed, { produces });
  const materializeResult = collectArtifactMaterializeNodesFromOasDocument(parsed, {
    produces,
  });

  // (a) Advisory mirror of the grammar errors the compile/publish gate
  // HARD-BLOCKS (oas-compiler step 10b/10c). WARNING here — Layer 3 is advisory.
  for (const err of [...bindingResult.errors, ...materializeResult.errors]) {
    findings.push({
      code: "OAS-RUNTIME-009",
      severity: "warning",
      message:
        `Artifact binding / artifact_materialize annotation is invalid and does not ` +
        `count as a materialization edge (the compile/publish gate rejects it as a ` +
        `hard error): ${err}`,
      source: "deterministic",
    });
  }

  // (b) Coverage — each declared produces extension needs at least one valid
  // edge. WARNING (produces-without-materialization; existing repos trip this).
  if (produces != null) {
    const covered = new Set<string>();
    for (const b of bindingResult.bindings) covered.add(b.binding.extension);
    for (const n of materializeResult.nodes) covered.add(n.extension);
    for (const ext of produces) {
      if (covered.has(ext)) continue;
      findings.push({
        code: "OAS-RUNTIME-009",
        severity: "warning",
        message:
          `package.json cinatra.produces declares "${ext}" but the OAS has no runnable ` +
          `materialization edge for it. Add an EndNode output binding ` +
          `(outputs[].cinatra.artifact with extension "${ext}") or an artifact_materialize ` +
          `passthrough ApiNode targeting "${ext}". Until migrated, the declared artifact is ` +
          `never persisted at run completion. (Advisory now; the publish contract flips this ` +
          `to a republish BLOCK once the fleet migration completes — cinatra#924.)`,
        source: "deterministic",
      });
    }
  }

  // OAS-RUNTIME-010 — passthrough write nodes must have declared dataflow deps.
  for (const flow of iterFlowComponents(parsed)) {
    findings.push(...scanPassthroughWriteDataflow(flow));
  }

  // OAS-RUNTIME-011 (riskClass mislabel) + OAS-RUNTIME-012 (legacy prose) walk
  // the whole component tree — a node can carry metadata.cinatra.riskClass at any
  // depth, and prose can live in any prompt field.
  findings.push(...scanRiskClassMislabels(parsed));
  findings.push(...scanLegacyPersistenceProse(parsed));

  return findings;
}

// OAS-RUNTIME-010 — every passthrough object/artifact write node feeds each of
// its consumed inputs from a declared DataFlowEdge (or an input default). Mirrors
// the DFE-into checks of OAS-RUNTIME-004/005. WARNING-only.
function scanPassthroughWriteDataflow(flow: FlowComponent): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  for (const node of flow.apiNodes) {
    if (node.url === null || !node.url.includes(AGENTS_PASSTHROUGH_URL_MARKER)) continue;
    if (node.tool === null || !ARTIFACT_PARITY_WRITE_TOOLS.has(node.tool)) continue;
    // Parity only meaningful when inputs[] is explicitly declared; an absent
    // inputs[] means pyagentspec auto-infers, and there is no declared input to
    // require an edge for.
    if (!node.inputsExplicit) continue;
    const placeholders = inferPlaceholderSet(node.placeholderSourceText);
    for (const input of node.inputTitles) {
      // Only inputs actually consumed as a bare {{ name }} flow variable in the
      // node body require a sourcing edge; a defaulted input is self-satisfying.
      if (!placeholders.has(input)) continue;
      if (node.inputDefaults.has(input)) continue;
      const hasDfe = flow.dfes.some(
        (e) => e.destinationNodeRef === node.id && e.destinationInput === input,
      );
      if (hasDfe) continue;
      findings.push({
        code: "OAS-RUNTIME-010",
        severity: "warning",
        message:
          `Passthrough write node "${node.id}" (tool "${node.tool}") consumes input ` +
          `"${input}" but no DataFlowEdge sources it and it has no default. A persistence ` +
          `write should have a declared dataflow dependency edge for every input it writes ` +
          `from, so the run's provenance graph is complete. Add a DataFlowEdge whose ` +
          `destination_node is "${node.id}" and destination_input is "${input}".`,
        location: `$referenced_components.${node.id} (Flow "${flow.flowId}")`,
        source: "deterministic",
      });
    }
  }
  return findings;
}

// OAS-RUNTIME-011 — a node labeled read_only that invokes a write tool. The
// Trigger/HITL gate reads riskClass to decide gating; a read_only label on a
// write silently ungates a side effect. WARNING-only (the #924 ratchet keeps
// this advisory day one — blog-pipeline's seam writes trip it).
function scanRiskClassMislabels(parsed: Record<string, unknown>): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  walkComponentObjects(parsed, (node, path) => {
    const meta = isPlainObject(node.metadata) ? node.metadata : null;
    const cin = meta && isPlainObject(meta.cinatra) ? meta.cinatra : null;
    const riskClass = cin && typeof cin.riskClass === "string" ? cin.riskClass : null;
    if (riskClass !== "read_only") return;

    const data = isPlainObject(node.data) ? node.data : null;
    const tool = data && typeof data.tool === "string" ? data.tool : null;
    if (tool === null) return;
    const isWriteTool =
      ARTIFACT_PARITY_WRITE_TOOLS.has(tool) ||
      SIDE_EFFECT_PATTERNS.some((rx) => rx.test(tool));
    if (!isWriteTool) return;

    const id = typeof node.id === "string" ? node.id : "<unknown>";
    findings.push({
      code: "OAS-RUNTIME-011",
      severity: "warning",
      message:
        `Node "${id}" at ${path} declares metadata.cinatra.riskClass:"read_only" but invokes ` +
        `write tool "${tool}". A side-effecting write must not be labeled read_only — the ` +
        `Trigger/HITL gate uses riskClass to decide gating, so a read_only label silently ` +
        `ungates the write. Set an accurate write riskClass (e.g. "write_safe", or a ` +
        `side-effecting class the approval gate recognizes).`,
      location: path,
      source: "deterministic",
    });
  });
  return findings;
}

// OAS-RUNTIME-012 — prompt PROSE instructing a legacy persistence primitive.
// The declarative binding replaces prompt-driven persistence; a straggler emit
// racing the declarative materializer double-writes. WARNING-only.
function scanLegacyPersistenceProse(
  parsed: Record<string, unknown>,
): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  walkKeyedStrings(parsed, (key, text, path) => {
    if (!PROSE_PROMPT_KEYS.has(key)) return;
    for (const token of LEGACY_PERSISTENCE_PROSE_TOKENS) {
      if (!text.includes(token)) continue;
      findings.push({
        code: "OAS-RUNTIME-012",
        severity: "warning",
        message:
          `Prompt field "${key}" at ${path} instructs the model to call the legacy ` +
          `persistence primitive "${token}". The declarative EndNode artifact binding ` +
          `(outputs[].cinatra.artifact) or an artifact_materialize passthrough node ` +
          `replaces prompt-driven persistence — a prompt-driven emit racing the declarative ` +
          `materializer double-writes. Remove the persistence instruction from the prompt and ` +
          `declare the output via its binding instead.`,
        location: path,
        source: "deterministic",
      });
      break; // one finding per field
    }
  });
  return findings;
}

/**
 * Visit every plain-object node in the tree (component-shaped or not), with its
 * `$`-rooted path. Used by the riskClass scan, which must find riskClass on a
 * node at any depth. Cycle-safe via a visited set (`$component_ref` graphs can
 * in principle revisit an object).
 */
function walkComponentObjects(
  root: Record<string, unknown>,
  visit: (node: Record<string, unknown>, path: string) => void,
): void {
  const seen = new Set<object>();
  function go(value: unknown, path: string): void {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) go(value[i], `${path}[${i}]`);
      return;
    }
    if (!isPlainObject(value)) return;
    if (seen.has(value)) return;
    seen.add(value);
    visit(value, path);
    for (const [k, v] of Object.entries(value)) go(v, `${path}.${k}`);
  }
  go(root, "$");
}

/**
 * Visit every string-valued property with its immediate KEY and `$`-rooted path.
 * The key lets the prose scan target only prompt fields (unlike `walkStrings`,
 * which loses the key context).
 */
function walkKeyedStrings(
  root: unknown,
  visit: (key: string, text: string, path: string) => void,
  key = "$",
  path = "$",
): void {
  if (typeof root === "string") {
    visit(key, root, path);
  } else if (Array.isArray(root)) {
    for (let i = 0; i < root.length; i++) {
      walkKeyedStrings(root[i], visit, key, `${path}[${i}]`);
    }
  } else if (isPlainObject(root)) {
    for (const [k, v] of Object.entries(root)) {
      walkKeyedStrings(v, visit, k, `${path}.${k}`);
    }
  }
}

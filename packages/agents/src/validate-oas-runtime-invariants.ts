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
 *   OAS-RUNTIME-014 — a HIDDEN Flow input the run can never carry
 *                     (cinatra#3003). Two notions of "must be supplied" meet
 *                     at dispatch: the RUNTIME demands every input without a
 *                     `default` in the start message, while the APP collects
 *                     only the fields named in the StartNode's
 *                     `metadata.cinatra.required`. A package that declares an
 *                     input `metadata.cinatra.hidden` (no operator will EVER
 *                     be shown it) and gives it no `default` (the runtime
 *                     demands it anyway) contradicts itself: the only way out
 *                     is a platform supplier — the set in
 *                     `scripts/extensions/platform-supplied-flow-inputs.mjs`,
 *                     shared with the dispatcher that writes them. Without
 *                     one, the package installs, arms a schedule, fires, and
 *                     only THEN dies with `Cannot start conversation because
 *                     of missing inputs "<name>"` — naming an input nobody
 *                     was shown. Scoped to HIDDEN inputs on purpose: a VISIBLE
 *                     input is present in the compiled schema, so a caller
 *                     that can see it (the `agent_run` tool, chat extraction,
 *                     the API) can still pre-supply it.
 *   OAS-RUNTIME-015 — a model-bridge step's declared tool list. A model-bridge
 *                     ApiNode may carry `metadata.cinatra.tools`: a list of
 *                     distinct lower-case tool names of the application. The
 *                     finding names the node and its path when the list is
 *                     not of that form, when the key sits on a node that is not
 *                     a model-bridge step (the key is read on model-bridge
 *                     steps only), or when two model-bridge steps share one id
 *                     and one of them declares (a declaration is read by the
 *                     step's id). A flow that declares nothing yields no
 *                     finding of this code.
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
  collectArtifactImageNodesFromOasDocument,
  collectArtifactMaterializeNodesFromOasDocument,
  ARTIFACT_MATERIALIZE_TOOL,
  ARTIFACT_PAGE_CAPTURE_TOOL,
  AGENTS_PASSTHROUGH_URL_MARKER,
} from "./artifact-binding";
import { SIDE_EFFECT_PATTERNS } from "./trigger-infer-side-effects";
import {
  PLATFORM_SUPPLIED_FLOW_INPUTS,
  isExemptFromUnsatisfiableInputCheck,
  isOnVisibleInputInstallBaseline,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — dependency-free .mjs data module (allowJs)
} from "../../../scripts/extensions/platform-supplied-flow-inputs.mjs";

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
  findings.push(...scanForStepToolDeclarations(parsed));
  findings.push(...scanForInternalA2aAgentMisuse(parsed));
  findings.push(...scanInputMessageGateMountability(parsed));
  // Placeholder/inputs parity + agent_run_id propagation + EndNode source
  // all walk the per-Flow graph, so we compose them per-Flow component.
  for (const flow of iterFlowComponents(parsed)) {
    findings.push(...scanApiNodePlaceholderInputsParity(flow));
    findings.push(...scanAgentRunIdPropagation(flow));
    findings.push(...scanEndNodeOutputSources(flow));
  }
  findings.push(...scanOasForVisibleInputContractFindings(parsed));
  // OAS-RUNTIME-014 scans the START-CONVERSATION surface only — the TOP-LEVEL
  // Flow. That is the one input set the A2A start message has to satisfy. A
  // nested subflow's inputs are fed by its parent's DataFlowEdges, never by the
  // start message, so the same shape there is not a dispatch failure
  // (OAS-RUNTIME-005 owns unsourced subflow inputs).
  if (parsed.component_type === "Flow") {
    const rootFlow = extractFlow(parsed);
    if (rootFlow) {
      findings.push(
        ...scanUnsatisfiableFlowInputs(
          rootFlow,
          describeAgentForFindings(parsed),
          resolvePackageName(parsed),
        ),
      );
    }
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
  walkApiNodes(parsed, (node, path) => {
    const url = node.url;
    if (typeof url === "string" && url.includes("/api/llm-bridge")) {
      visit(node, path);
    }
  });
}

/** Every ApiNode of a flow document, nested subflows included, whatever its target. */
function walkApiNodes(
  parsed: Record<string, unknown>,
  visit: (node: Record<string, unknown>, path: string) => void,
): void {
  function go(node: unknown, path: string): void {
    if (!isPlainObject(node)) return;
    const o = node as Record<string, unknown>;
    if (o.component_type === "ApiNode") {
      visit(o, path);
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
    // Supported parallel flows may inline Flow objects instead of referencing
    // them from $referenced_components. Keep their indexed paths in findings.
    if (o.component_type === "ParallelFlowNode" && Array.isArray(o.subflows)) {
      o.subflows.forEach((inlineFlow, index) => {
        go(inlineFlow, `${path}.subflows[${index}]`);
      });
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
// Invariant 15 — a model-bridge step's declared tool list (OAS-RUNTIME-015).
//
// A model-bridge ApiNode may carry `metadata.cinatra.tools`: the list of the
// application's tools the step uses. The list is read by the step's id and
// validated with the flow. Names are checked for their form only; which names
// the application serves is decided where the tools are served.
// ---------------------------------------------------------------------------

export type StepToolDeclaration =
  | { kind: "undeclared" }
  | { kind: "declared"; tools: string[] }
  | { kind: "invalid"; reason: string };

function isModelBridgeApiNode(node: Record<string, unknown>): boolean {
  return (
    node.component_type === "ApiNode" &&
    typeof node.url === "string" &&
    node.url.includes("/api/llm-bridge")
  );
}

function carriesStepToolKey(node: Record<string, unknown>): boolean {
  const metadata = node.metadata;
  if (!isPlainObject(metadata)) return false;
  const cinatra = metadata.cinatra;
  if (!isPlainObject(cinatra)) return false;
  return Object.prototype.hasOwnProperty.call(cinatra, "tools");
}

/**
 * Reads the tool list a node declares under `metadata.cinatra.tools`.
 * `undeclared`: the node carries no such key. `declared`: a list of distinct,
 * non-empty, lower-case names without whitespace, kept in written order (an
 * empty list declares no tools). `invalid`: anything else, with a short reason.
 */
export function readStepToolDeclaration(node: unknown): StepToolDeclaration {
  if (!isPlainObject(node) || !carriesStepToolKey(node)) {
    return { kind: "undeclared" };
  }
  const value = ((node.metadata as Record<string, unknown>).cinatra as Record<
    string,
    unknown
  >).tools;
  if (!Array.isArray(value)) {
    return { kind: "invalid", reason: "the value is not a list" };
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") {
      return { kind: "invalid", reason: "an entry is not a text value" };
    }
    if (entry.trim() === "") {
      return { kind: "invalid", reason: "an entry is empty or blank" };
    }
    if (/\s/.test(entry)) {
      return { kind: "invalid", reason: `the entry "${entry}" contains whitespace` };
    }
    if (entry !== entry.toLowerCase()) {
      return { kind: "invalid", reason: `the entry "${entry}" contains upper-case letters` };
    }
    if (seen.has(entry)) {
      return { kind: "invalid", reason: `the entry "${entry}" is written more than once` };
    }
    seen.add(entry);
  }
  return { kind: "declared", tools: [...(value as string[])] };
}

/**
 * Reads the declaration of the model-bridge step with the given id from a flow
 * document, nested subflows included. When several model-bridge steps carry the
 * id, the result is `invalid` if any one is, otherwise the names common to every
 * declared list; a step that declares nothing adds no name.
 */
export function findStepToolDeclaration(
  document: unknown,
  stepId: string,
): StepToolDeclaration {
  if (!isPlainObject(document)) return { kind: "undeclared" };
  const declared: string[][] = [];
  let invalid: StepToolDeclaration | null = null;
  walkBridgeApiNodes(document, (node) => {
    if (node.id !== stepId) return;
    const reading = readStepToolDeclaration(node);
    if (reading.kind === "invalid") invalid = invalid ?? reading;
    else if (reading.kind === "declared") declared.push(reading.tools);
  });
  if (invalid) return invalid;
  if (declared.length === 0) return { kind: "undeclared" };
  const [first, ...rest] = declared;
  return {
    kind: "declared",
    tools: first!.filter((name) => rest.every((list) => list.includes(name))),
  };
}

/**
 * Whether a flow document holds an ApiNode with the given id, nested subflows
 * included, whatever its target (cinatra#3745: the step a run's executing-source
 * proof names must be a step of the run's bound graph).
 */
export function hasApiNodeStep(document: unknown, stepId: string): boolean {
  if (!isPlainObject(document) || typeof stepId !== "string" || stepId === "") return false;
  let found = false;
  walkApiNodes(document, (node) => {
    if (node.id === stepId) found = true;
  });
  return found;
}

export type PublishingAncestorReading =
  | { kind: "resolved"; nodeId: string }
  | { kind: "unresolved" }
  | { kind: "ambiguous" }
  | { kind: "not_publishing"; nodeId: string };

/** The node kinds that can be the publishing action (the compiler's and the loader's set). */
const PUBLISHING_ACTION_KINDS = new Set(["ApiNode", "AgentNode", "FlowNode", "ParallelFlowNode"]);

/**
 * The top-level node of a flow document whose subtree holds the ApiNode step
 * with the given id (cinatra#3745). A publish decision is recorded only for a
 * top-level node that declares `metadata.cinatra.publishes: true`, keyed by its
 * key in the root `$referenced_components` (the compiler's
 * `collectPublishingSteps` and the loader's gate insertion), so the decision
 * that covers a step nested in a subflow is the decision of that ancestor. A
 * top-level step is its own ancestor.
 *
 * The walk starts at each top-level node (the root `nodes` list) and follows
 * `$referenced_components`, `subflow`, `subflows`, `nodes` and `start_node`; a
 * `$component_ref` resolves to the innermost enclosing `$referenced_components`
 * that holds its key. `unresolved`: no top-level node holds the step.
 * `ambiguous`: more than one does. `not_publishing`: the one that holds it does
 * not declare `publishes: true` (the JSON boolean) on a node of an action kind.
 */
export function findPublishingAncestor(document: unknown, stepId: string): PublishingAncestorReading {
  if (!isPlainObject(document) || typeof stepId !== "string" || stepId === "") return { kind: "unresolved" };
  const rootRefs = isPlainObject(document.$referenced_components) ? document.$referenced_components : {};
  const topLevel: string[] = [];
  for (const entry of Array.isArray(document.nodes) ? document.nodes : []) {
    const ref = resolveComponentRef(entry);
    if (ref !== null && Object.prototype.hasOwnProperty.call(rootRefs, ref) && !topLevel.includes(ref)) topLevel.push(ref);
  }
  const holdsStep = (start: unknown): boolean => {
    const seen = new Set<unknown>();
    const stack: Array<[unknown, Array<Record<string, unknown>>]> = [[start, [rootRefs]]];
    while (stack.length > 0) {
      const [value, scopes] = stack.pop()!;
      if (!isPlainObject(value) || seen.has(value)) continue;
      seen.add(value);
      const ref = resolveComponentRef(value);
      if (ref !== null) {
        for (let i = scopes.length - 1; i >= 0; i--) {
          if (Object.prototype.hasOwnProperty.call(scopes[i], ref)) {
            stack.push([scopes[i]![ref], scopes.slice(0, i + 1)]);
            break;
          }
        }
        continue;
      }
      if (value.component_type === "ApiNode" && value.id === stepId) return true;
      const refs = value.$referenced_components;
      const inner = isPlainObject(refs) ? [...scopes, refs] : scopes;
      if (isPlainObject(refs)) for (const child of Object.values(refs)) stack.push([child, inner]);
      for (const key of ["subflow", "start_node"]) stack.push([value[key], inner]);
      for (const key of ["subflows", "nodes"]) {
        const list = value[key];
        if (Array.isArray(list)) for (const child of list) stack.push([child, inner]);
      }
    }
    return false;
  };
  const holders = topLevel.filter((key) => holdsStep(rootRefs[key]));
  if (holders.length === 0) return { kind: "unresolved" };
  if (holders.length > 1) return { kind: "ambiguous" };
  const nodeId = holders[0]!;
  const node = rootRefs[nodeId] as Record<string, unknown>;
  const metadata = isPlainObject(node.metadata) ? node.metadata : null;
  const cinatra = metadata && isPlainObject(metadata.cinatra) ? metadata.cinatra : null;
  const publishes = cinatra !== null && cinatra.publishes === true;
  if (!publishes || typeof node.component_type !== "string" || !PUBLISHING_ACTION_KINDS.has(node.component_type)) {
    return { kind: "not_publishing", nodeId };
  }
  return { kind: "resolved", nodeId };
}

function scanForStepToolDeclarations(
  parsed: Record<string, unknown>,
): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const idOf = (node: Record<string, unknown>): string =>
    typeof node.id === "string" ? node.id : (node.name as string) ?? "<unknown>";

  // (a) a model-bridge step whose declaration is not of the accepted form,
  // and the ids the model-bridge steps carry.
  const stepsById = new Map<string, Array<{ path: string; declares: boolean }>>();
  walkBridgeApiNodes(parsed, (node, path) => {
    const reading = readStepToolDeclaration(node);
    if (reading.kind === "invalid") {
      findings.push({
        code: "OAS-RUNTIME-015",
        severity: "blocker",
        message:
          `ApiNode "${idOf(node)}" at ${path} targets /api/llm-bridge and its ` +
          `metadata.cinatra.tools declaration is not accepted: ${reading.reason}. ` +
          `The form is metadata.cinatra.tools: a list of distinct lower-case ` +
          `tool names of the application.`,
        location: path,
        source: "deterministic",
      });
    }
    if (typeof node.id === "string") {
      const steps = stepsById.get(node.id) ?? [];
      steps.push({ path, declares: reading.kind === "declared" });
      stepsById.set(node.id, steps);
    }
  });

  // (b) the key on a node that is not a model-bridge step. The top-level
  // document is not a step and is left as it is read elsewhere.
  function walkOtherNodes(node: unknown, path: string, isRoot: boolean): void {
    if (!isPlainObject(node)) return;
    if (!isRoot && !isModelBridgeApiNode(node) && carriesStepToolKey(node)) {
      findings.push({
        code: "OAS-RUNTIME-015",
        severity: "blocker",
        message:
          `Node "${idOf(node)}" at ${path} carries metadata.cinatra.tools; the ` +
          `key is read on model-bridge steps only (an ApiNode whose url targets ` +
          `/api/llm-bridge). Declare the tools on the model-bridge step that uses them.`,
        location: path,
        source: "deterministic",
      });
    }
    const refs = node.$referenced_components;
    if (isPlainObject(refs)) {
      for (const [k, v] of Object.entries(refs)) {
        walkOtherNodes(v, `${path}.$referenced_components.${k}`, false);
      }
    }
    if (isPlainObject(node.subflow)) {
      walkOtherNodes(node.subflow, `${path}.subflow`, false);
    }
    if (node.component_type === "ParallelFlowNode" && Array.isArray(node.subflows)) {
      node.subflows.forEach((inlineFlow, index) => {
        walkOtherNodes(inlineFlow, `${path}.subflows[${index}]`, false);
      });
    }
  }
  walkOtherNodes(parsed, "$", true);

  // (c) model-bridge steps that share an id while one of them declares: a
  // declaration is read by the step's id, so each such step needs its own.
  for (const [id, steps] of stepsById) {
    if (steps.length < 2 || !steps.some((s) => s.declares)) continue;
    findings.push({
      code: "OAS-RUNTIME-015",
      severity: "blocker",
      message:
        `Model-bridge steps share the id "${id}" (${steps
          .map((s) => s.path)
          .join(", ")}) and at least one of them declares metadata.cinatra.tools. ` +
        `A step's declaration is read by its id, so each model-bridge step that ` +
        `declares tools carries an id of its own.`,
      location: steps[0]!.path,
      source: "deterministic",
    });
  }
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

/** A counter of the steps rule 013's review-step check takes (cinatra#4150). */
interface RuleWork {
  steps: number;
}

/**
 * The root flow as rule 013's review-step check reads it (cinatra#4150), built
 * ONCE per document, and only when the document has a marked gate. Every part
 * is one pass over its own list: the root `nodes`, the
 * `control_flow_connections`, the `data_flow_connections` (indexed by their
 * destination node and input), the start inputs, and the control graph's
 * dominator tree. A gate then costs only the edges into its own targets input,
 * and each feeder an O(1) dominance query.
 */
interface ReviewStepGraph {
  rootRefs: Record<string, unknown>;
  /** The root flow's own nodes (its `nodes` list), by object, with their keys. */
  rootKeyOf: Map<unknown, string>;
  rootKeys: Set<string>;
  /** The root flow's start inputs (`startInputsOfFlow`, the rule 004 and 005 share). */
  startInputs: Set<string>;
  start: string | null;
  /** False when an entry of `control_flow_connections` is no readable ControlFlowEdge, or the flow has no start node. */
  readable: boolean;
  /**
   * Preorder and postorder numbers of the dominator tree of the control graph,
   * for the nodes reachable from the start node: `a` dominates `b` exactly when
   * pre(a) <= pre(b) and post(b) <= post(a).
   */
  pre: Map<string, number>;
  post: Map<string, number>;
  /** The DataFlowEdges, by `${destination node}\0${destination input}`. */
  fedBy: Map<string, Array<{ from: string | null; output: unknown }>>;
  /** Port names per root node key (memoized; null: a ParallelFlowNode beyond the budget). */
  ports: Map<string, Set<string> | null>;
  /** Output titles per resolved subflow object (memoized). */
  subflowPorts: Map<object, Set<string>>;
  /** What resolving ParallelFlowNode ports may still cost (see `rootNodePorts`). */
  parallelBudget: number;
  work: RuleWork;
}

/**
 * The names that are start inputs of the flow: its own
 * `inputs` AND its StartNode's `inputs` declare it. A value reaches a step from
 * the start message only for such a name (rules 004, 005 and 013 read this one
 * helper).
 */
function startInputsOfFlow(flow: FlowComponent): Set<string> {
  const startTitles = new Set(flow.startNode?.inputTitles ?? []);
  return new Set(flow.flowInputTitles.filter((t) => startTitles.has(t)));
}

function buildReviewStepGraph(parsed: Record<string, unknown>, work: RuleWork): ReviewStepGraph {
  const rootRefs = isPlainObject(parsed["$referenced_components"]) ? parsed["$referenced_components"] : {};
  const rootKeyOf = new Map<unknown, string>();
  const rootKeys = new Set<string>();
  let parallelBudget = 0;
  for (const entry of Array.isArray(parsed["nodes"]) ? parsed["nodes"] : []) {
    work.steps++;
    parallelBudget++;
    const ref = resolveComponentRef(entry);
    if (ref === null || !Object.prototype.hasOwnProperty.call(rootRefs, ref) || rootKeys.has(ref)) continue;
    rootKeys.add(ref);
    rootKeyOf.set(rootRefs[ref], ref);
    const n = rootRefs[ref];
    if (isPlainObject(n) && n["component_type"] === "ParallelFlowNode" && Array.isArray(n["subflows"])) {
      parallelBudget += n["subflows"].length;
    }
  }
  const rootFlow = extractFlow(parsed);
  const startInputs = rootFlow ? startInputsOfFlow(rootFlow) : new Set<string>();

  // The control graph the compiler orders its steps by (oas-compiler.ts step
  // 5, `readFlowControlTopology`): every edge from `from_node` to `to_node`,
  // each branch of a branching node an edge of its own. The compiler's schema
  // accepts only a ControlFlowEdge with both node references.
  const start = resolveComponentRef(parsed["start_node"]);
  const controls = parsed["control_flow_connections"];
  let readable = Array.isArray(controls) && start !== null;
  const index = new Map<string, number>();
  const keys: string[] = [];
  const succ: number[][] = [];
  const idOf = (key: string): number => {
    let i = index.get(key);
    if (i === undefined) {
      i = keys.length;
      index.set(key, i);
      keys.push(key);
      succ.push([]);
    }
    return i;
  };
  if (readable) {
    idOf(start!);
    for (const e of controls as unknown[]) {
      work.steps++;
      const from = isPlainObject(e) ? resolveComponentRef(e["from_node"]) : null;
      const to = isPlainObject(e) ? resolveComponentRef(e["to_node"]) : null;
      if (!isPlainObject(e) || e["component_type"] !== "ControlFlowEdge" || from === null || to === null) {
        readable = false;
        break;
      }
      succ[idOf(from)]!.push(idOf(to));
    }
    parallelBudget += (controls as unknown[]).length;
  }
  const pre = new Map<string, number>();
  const post = new Map<string, number>();
  if (readable) {
    const order = dominatorTreeOrder(succ, work);
    for (let i = 0; i < keys.length; i++) {
      if (order.pre[i]! >= 0) {
        pre.set(keys[i]!, order.pre[i]!);
        post.set(keys[i]!, order.post[i]!);
      }
    }
  }

  const fedBy = new Map<string, Array<{ from: string | null; output: unknown }>>();
  const dataEdges = Array.isArray(parsed["data_flow_connections"]) ? parsed["data_flow_connections"] : [];
  for (const e of dataEdges) {
    work.steps++;
    if (!isPlainObject(e) || e["component_type"] !== "DataFlowEdge") continue;
    const to = resolveComponentRef(e["destination_node"]);
    const input = e["destination_input"];
    if (to === null || typeof input !== "string") continue;
    const k = `${to}\u0000${input}`;
    let list = fedBy.get(k);
    if (list === undefined) fedBy.set(k, (list = []));
    list.push({ from: resolveComponentRef(e["source_node"]), output: e["source_output"] });
  }
  parallelBudget += dataEdges.length;

  return {
    rootRefs, rootKeyOf, rootKeys, startInputs, start, readable, pre, post, fedBy,
    ports: new Map(), subflowPorts: new Map(), parallelBudget, work,
  };
}

/**
 * Preorder and postorder numbers, by node index, of the dominator tree of the
 * graph `succ` rooted at index 0 (-1 for an unreachable node). The immediate
 * dominators come from the algorithm of Lengauer and Tarjan with path
 * compression, O(E log V); the depth-first search and the compression are
 * iterative, so a long chain does not exhaust the call stack.
 */
function dominatorTreeOrder(succ: number[][], work: RuleWork): { pre: Int32Array; post: Int32Array } {
  const size = succ.length;
  const dfn = new Int32Array(size).fill(-1);
  const vertex: number[] = [];
  const parent: number[] = [];
  // Depth-first numbering from the start node.
  const stack: Array<[number, number]> = [[0, 0]];
  dfn[0] = 0;
  vertex.push(0);
  parent.push(-1);
  while (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    const [v, at] = top;
    const out = succ[v]!;
    if (at >= out.length) {
      stack.pop();
      continue;
    }
    top[1] = at + 1;
    work.steps++;
    const w = out[at]!;
    if (dfn[w] === -1) {
      dfn[w] = vertex.length;
      vertex.push(w);
      parent.push(dfn[v]!);
      stack.push([w, 0]);
    }
  }
  const n = vertex.length;
  // Predecessors in depth-first numbers, reachable nodes only.
  const preds: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    for (const w of succ[vertex[i]!]!) {
      work.steps++;
      if (dfn[w]! >= 0) preds[dfn[w]!]!.push(i);
    }
  }
  const semi = Array.from({ length: n }, (_, i) => i);
  const label = Array.from({ length: n }, (_, i) => i);
  const ancestor = new Array<number>(n).fill(-1);
  const idom = new Array<number>(n).fill(0);
  const bucket: number[][] = Array.from({ length: n }, () => []);
  const path: number[] = [];
  const evaluate = (v: number): number => {
    if (ancestor[v] === -1) return v;
    let x = v;
    while (ancestor[ancestor[x]!] !== -1) {
      work.steps++;
      path.push(x);
      x = ancestor[x]!;
    }
    while (path.length > 0) {
      const y = path.pop()!;
      const a = ancestor[y]!;
      if (semi[label[a]!]! < semi[label[y]!]!) label[y] = label[a]!;
      ancestor[y] = ancestor[a]!;
    }
    return label[v]!;
  };
  for (let w = n - 1; w >= 1; w--) {
    for (const v of preds[w]!) {
      work.steps++;
      const u = evaluate(v);
      if (semi[u]! < semi[w]!) semi[w] = semi[u]!;
    }
    bucket[semi[w]!]!.push(w);
    const p = parent[w]!;
    ancestor[w] = p;
    for (const v of bucket[p]!) {
      work.steps++;
      const u = evaluate(v);
      idom[v] = semi[u]! < semi[v]! ? u : p;
    }
    bucket[p] = [];
  }
  for (let w = 1; w < n; w++) {
    if (idom[w] !== semi[w]) idom[w] = idom[idom[w]!]!;
  }
  // Pre- and postorder of the dominator tree.
  const children: number[][] = Array.from({ length: n }, () => []);
  for (let w = 1; w < n; w++) children[idom[w]!]!.push(w);
  const pre = new Int32Array(size).fill(-1);
  const post = new Int32Array(size).fill(-1);
  let clock = 0;
  const walk: Array<[number, number]> = [[0, 0]];
  pre[vertex[0]!] = clock++;
  while (walk.length > 0) {
    const top = walk[walk.length - 1]!;
    const [v, at] = top;
    if (at >= children[v]!.length) {
      post[vertex[v]!] = clock++;
      walk.pop();
      continue;
    }
    top[1] = at + 1;
    work.steps++;
    const c = children[v]![at]!;
    pre[vertex[c]!] = clock++;
    walk.push([c, 0]);
  }
  return { pre, post };
}

/**
 * The output ports of a node of the root flow, the ports a DataFlowEdge reads
 * (cinatra#4150, rule 013). The loader hands the flow to pyagentspec, which
 * joins an edge only between declared ports: a node's explicit `outputs` list
 * (entries by `title`) is its ports. Without that list a StartNode offers its
 * `inputs`, and a FlowNode or ParallelFlowNode the `outputs` of its
 * subflow(s); a FlowNode or ParallelFlowNode that lists its outputs still gets
 * a value only for a port its subflow(s) declare. Any other kind offers only
 * its explicit list. A StartNode's port carries a value only for a start
 * input of the root flow (`startInputsOfFlow`).
 *
 * Every node and every subflow is read once (memoized). A ParallelFlowNode's
 * ports are the union over its distinct subflows; subflows shared by many
 * ParallelFlowNodes could make those unions cost more than the document's
 * size, so their total cost is capped at a budget linear in the document
 * (`parallelBudget`: the root nodes, their subflow references, the control and
 * data edges, plus each distinct subflow's outputs when it is first read). A ParallelFlowNode beyond the budget is reported
 * (null), never accepted.
 */
function rootNodePorts(g: ReviewStepGraph, key: string): Set<string> | null {
  const known = g.ports.get(key);
  if (known !== undefined) return known;
  const node = g.rootRefs[key];
  const titles = (list: unknown): Set<string> => {
    const out = new Set<string>();
    if (Array.isArray(list)) {
      for (const p of list) {
        g.work.steps++;
        if (isPlainObject(p) && typeof p["title"] === "string") out.add(p["title"]);
      }
    }
    return out;
  };
  let ports = new Set<string>();
  if (isPlainObject(node)) {
    const explicit = Array.isArray(node["outputs"]) ? titles(node["outputs"]) : null;
    const ownRefs = isPlainObject(node["$referenced_components"]) ? node["$referenced_components"] : {};
    const flowOf = (value: unknown): Record<string, unknown> | null => {
      const ref = resolveComponentRef(value);
      const resolved = ref === null ? value
        : Object.prototype.hasOwnProperty.call(ownRefs, ref) ? ownRefs[ref]
          : Object.prototype.hasOwnProperty.call(g.rootRefs, ref) ? g.rootRefs[ref] : null;
      return isPlainObject(resolved) ? resolved : null;
    };
    const portsOf = (flow: Record<string, unknown>): Set<string> => {
      let s = g.subflowPorts.get(flow);
      if (s === undefined) {
        g.subflowPorts.set(flow, (s = titles(flow["outputs"])));
        // A subflow read for the first time adds its own size to the budget.
        g.parallelBudget += s.size;
      }
      return s;
    };
    const kind = node["component_type"];
    let fromSubflows: Set<string> | null = null;
    if (kind === "FlowNode") {
      const flow = flowOf(node["subflow"]);
      fromSubflows = flow ? portsOf(flow) : new Set();
    } else if (kind === "ParallelFlowNode") {
      fromSubflows = new Set();
      const distinct = new Set<Record<string, unknown>>();
      for (const s of Array.isArray(node["subflows"]) ? node["subflows"] : []) {
        g.work.steps++;
        const flow = flowOf(s);
        if (flow) distinct.add(flow);
      }
      for (const flow of distinct) {
        const own = portsOf(flow);
        g.parallelBudget -= own.size;
        if (g.parallelBudget < 0) {
          g.ports.set(key, null);
          return null;
        }
        for (const t of own) { g.work.steps++; fromSubflows.add(t); }
      }
    }
    if (fromSubflows !== null) {
      ports = explicit === null ? fromSubflows : new Set([...explicit].filter((t) => fromSubflows!.has(t)));
    } else if (explicit !== null) {
      ports = explicit;
    } else if (kind === "StartNode") {
      ports = titles(node["inputs"]);
    }
    if (kind === "StartNode") ports = new Set([...ports].filter((t) => g.startInputs.has(t)));
  }
  g.ports.set(key, ports);
  return ports;
}

/**
 * Rule 013's review-step check for one component (cinatra#4150): the finding
 * text, or null when the gate gets its targets. `graph` builds the root-flow
 * reading once, on the first marked component.
 */
function reviewStepTargetsMissing(
  node: Record<string, unknown>,
  graph: () => ReviewStepGraph,
): string | null {
  // The compiler puts the marker on a compiled step only for a node of the
  // ROOT flow (its steps are the root `nodes`; a FlowNode carries a nested
  // gate's surfaceGateInputKeys, never its artifactReviewTargetsInput), and
  // execution routes to the review only on that compiled field. The
  // application then reads the targets by the marker's input name from the
  // gate's pause message first, then from the run's start parameters
  // (resolveDeclaredReviewTargets). The loader renders a gate's declared
  // inputs into its pause message only when the gate sets
  // surfaceGateInputs === true, and an input that no DataFlowEdge feeds from
  // a declared output of a root-flow node renders as null, which the reader
  // takes as absent. The start parameters hold the root flow's start inputs.
  // On either road the gate pauses only when the run reaches it: it must be
  // reachable from the start node along the control edges. Every other shape
  // opens no review.
  const cin = (node["metadata"] as Record<string, unknown>)["cinatra"] as Record<string, unknown>;
  const target = (cin["artifactReview"] as Record<string, unknown>)["targetsInput"];
  if (typeof target !== "string" || target === "") {
    return `the marker does not name an input (it must be a non-empty text)`;
  }
  if (node["component_type"] !== "InputMessageNode") {
    return `it is a "${String(node["component_type"])}", not an InputMessageNode`;
  }
  const g = graph();
  const gateKey = g.rootKeyOf.get(node);
  if (gateKey === undefined) {
    return `it is not a node of the root flow; the compiler does not carry the marker ` +
      `through a FlowNode, so a review gate inside a nested flow opens no artifact review`;
  }
  if (gateKey === g.start) {
    return `it is the root flow's start node; a review gate must be a step the start node leads to`;
  }
  if (!g.readable) {
    return `the root flow's control_flow_connections cannot be read (each entry must be a ` +
      `ControlFlowEdge with from_node and to_node, and the flow needs a start_node), so ` +
      `nothing shows that the gate runs and that its targets arrive before it`;
  }
  if (!g.pre.has(gateKey)) {
    return `no control path of the root flow leads from its start node to the gate, so the ` +
      `gate never runs`;
  }
  if (g.startInputs.has(target)) return null;
  if (cin["surfaceGateInputs"] !== true) {
    return `it does not set metadata.cinatra.surfaceGateInputs: true and "${target}" is not a start input of the flow`;
  }
  const declared = Array.isArray(node["inputs"]) &&
    node["inputs"].some((i) => isPlainObject(i) && i["title"] === target);
  if (!declared) return `"${target}" is not one of its declared inputs nor a start input of the flow`;
  // A fed input has a value at the pause only when its source has run: the
  // source must dominate the gate in the root control graph.
  const sources = new Set<string>();
  let overBudget = false;
  for (const { from, output } of g.fedBy.get(`${gateKey}\u0000${target}`) ?? []) {
    g.work.steps++;
    if (from === null || from === gateKey || !g.rootKeys.has(from) || typeof output !== "string") continue;
    const ports = rootNodePorts(g, from);
    if (ports === null) { overBudget = true; continue; }
    if (!ports.has(output)) continue;
    const pf = g.pre.get(from);
    if (pf !== undefined && pf <= g.pre.get(gateKey)! && g.post.get(gateKey)! <= g.post.get(from)!) return null;
    sources.add(from);
  }
  if (sources.size === 0) {
    if (overBudget) {
      return `its input "${target}" is fed only through a ParallelFlowNode whose subflows ` +
        `take more work to resolve than the document's size allows, so nothing shows that ` +
        `the input gets a value`;
    }
    return `no DataFlowEdge of the root flow feeds its input "${target}" from an output ` +
      `that a node of the root flow declares, so the loader renders the input as ` +
      `null and the review has no targets`;
  }
  return `a control path of the root flow reaches the gate without passing through ` +
    `${[...sources].map((s) => `"${s}"`).join(", ")}, the step(s) feeding "${target}", so the ` +
    `input can be null when the gate pauses and the review has no targets`;
}

/** Whether a component carries the artifact-review marker (`metadata.cinatra.artifactReview.targetsInput`). */
function hasReviewMarker(node: Record<string, unknown>): boolean {
  const meta = isPlainObject(node["metadata"]) ? node["metadata"] : null;
  const cin = meta && isPlainObject(meta["cinatra"]) ? meta["cinatra"] : null;
  const review = cin && isPlainObject(cin["artifactReview"]) ? cin["artifactReview"] : null;
  return review !== null && Object.prototype.hasOwnProperty.call(review, "targetsInput");
}

/**
 * Test seam (cinatra#4150): rule 013's findings for `parsed` with the steps
 * its review-step check took, to prove the check's work stays linear in the
 * document.
 */
export function measureReviewStepRule(parsed: Record<string, unknown>): {
  findings: ReviewFinding[];
  steps: number;
} {
  const work: RuleWork = { steps: 0 };
  const findings = scanInputMessageGateMountability(parsed, work);
  return { findings, steps: work.steps };
}

function scanInputMessageGateMountability(
  parsed: Record<string, unknown>,
  work: RuleWork = { steps: 0 },
): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  let built: ReviewStepGraph | null = null;
  const graph = () => (built ??= buildReviewStepGraph(parsed, work));
  walkComponentObjects(parsed, (node, path) => {
    const componentType = node["component_type"];

    // --- artifact-review gate gets its targets (cinatra#4150) ---------------
    if (hasReviewMarker(node)) {
      const missing = reviewStepTargetsMissing(node, graph);
      if (missing) {
        findings.push({
          code: "OAS-RUNTIME-013",
          severity: "blocker",
          message:
            `Gate "${gateLabel(node)}" declares metadata.cinatra.artifactReview.targetsInput ` +
            `but ${missing}. The pause message then carries no review targets, ` +
            `so the application opens no artifact review. A review gate is an ` +
            `InputMessageNode of the root flow that the start node reaches along the ` +
            `control edges, whose targets input is a start input of the root flow ` +
            `(declared by the flow and its StartNode), or that sets surfaceGateInputs: true ` +
            `and declares the targets input, fed by a DataFlowEdge from an output of a ` +
            `root-flow node that every control path from the start node passes before the gate. ` +
            `${HITL_GATE_DOC}`,
          location: path,
          source: "deterministic",
        });
      }
    }

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
    const startFed = startInputsOfFlow(flow);
    let satisfied = false;
    for (const e of dfeInto) {
      if (e.sourceNodeRef !== flow.startNodeRef) continue;
      const src = e.sourceOutput;
      if ((src === "cinatra_run_id" || src === "agent_run_id") && startFed.has(src)) {
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
  const startFed = startInputsOfFlow(flow);

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
    if (startFed.has(output)) continue;
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
// Invariant 14 — a declared Flow input the run can never carry
// (OAS-RUNTIME-014, cinatra#3003).
// ---------------------------------------------------------------------------

/**
 * Name the offending package as `vendor/package@version`, read from the OAS's
 * own `metadata.cinatra`. Falls back to the Flow `id` (the package name by
 * convention) so a finding ALWAYS names something an operator can act on, even
 * for an OAS that omits the optional `packageVersion`.
 */
function describeAgentForFindings(parsed: Record<string, unknown>): string {
  const metadata = isPlainObject(parsed.metadata)
    ? (parsed.metadata as Record<string, unknown>)
    : {};
  const cinatra = isPlainObject(metadata.cinatra)
    ? (metadata.cinatra as Record<string, unknown>)
    : {};
  const name =
    typeof cinatra.packageName === "string" && cinatra.packageName
      ? cinatra.packageName
      : typeof parsed.id === "string" && parsed.id
        ? parsed.id
        : "<unknown agent>";
  const version =
    typeof cinatra.packageVersion === "string" && cinatra.packageVersion
      ? `@${cinatra.packageVersion}`
      : "";
  return `${name}${version}`;
}

/**
 * A HIDDEN input is satisfiable at dispatch through exactly three doors:
 *   (a) it declares a `default` — the runtime accepts a start message without
 *       it and substitutes the default;
 *   (b) the PLATFORM writes it unprompted — the shared set in
 *       `scripts/extensions/platform-supplied-flow-inputs.mjs`, which is the
 *       same constant `buildWayflowInitialMessagePayload` keys its writes off;
 *   (c) a KNOWN CALLER always pre-supplies it, recorded as a bounded
 *       per-(package, input) exemption in that same module.
 *
 * `metadata.cinatra.required` is deliberately NOT a door. Naming a hidden input
 * required does not get it collected — `execution.ts`'s `pendingFields` drops
 * every `x-hidden` field before it checks presence, and neither the `agent_run`
 * tool nor the published agent tools enforce a template's required list — so
 * honouring it here would silence the check without making the run satisfiable.
 *
 * A hidden input through none of these is dead on arrival: the package installs,
 * arms a schedule, the tick fires, a child run is created, and the runtime
 * refuses the conversation naming an input nobody was ever shown. Catch it
 * here, where the message can name the agent and the field.
 *
 * The FLOW's own `inputs` is the authoritative descriptor: pyagentspec starts
 * the conversation from it, so a default there — not on the StartNode copy the
 * host compiler reads — is what makes the runtime accept an omission.
 */
function scanUnsatisfiableFlowInputs(
  flow: FlowComponent,
  agentLabel: string,
  packageName: string,
): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  for (const title of flow.startHidden) {
    if (!flow.flowInputTitles.includes(title)) continue;
    if (flow.flowInputDefaults.has(title)) continue;
    if (PLATFORM_SUPPLIED_FLOW_INPUTS.includes(title)) continue;
    if (isExemptFromUnsatisfiableInputCheck(packageName, title)) continue;
    findings.push({
      code: "OAS-RUNTIME-014",
      severity: "blocker",
      message:
        `${agentLabel}: hidden Flow input "${title}" can never be supplied ` +
        `at run time. It is in the StartNode's metadata.cinatra.hidden (so no ` +
        `operator is ever shown it), the Flow declares it with no "default" ` +
        `(so the runtime demands it in the start message anyway), and it is ` +
        `not one of the inputs the platform writes unprompted ` +
        `(${PLATFORM_SUPPLIED_FLOW_INPUTS.join(", ")}). A run of this agent ` +
        `arms, fires, reaches the runtime and is refused there with ` +
        `\`Cannot start conversation because of missing inputs ` +
        `"${title}"\`, before any model call. Fix with ONE of: (a) give the ` +
        `Flow input a "default" — \`"default": ""\` is the shape every other ` +
        `bundled runtime agent uses for its hidden inputs (mirror it onto the ` +
        `StartNode descriptor, whose inputs and outputs pyagentspec requires to ` +
        `stay equal); (b) drop it from the Flow inputs[] if nothing consumes ` +
        `it; (c) if one specific caller always pre-supplies it on the run, ` +
        `record that as a bounded exemption in ` +
        `scripts/extensions/platform-supplied-flow-inputs.mjs. Naming it in ` +
        `metadata.cinatra.required does NOT work: the setup loop drops every ` +
        `hidden field whether or not it is required. See ` +
        `docs/developing-agents.md.`,
      location: `inputs[] "${title}" (Flow "${flow.flowId}")`,
      source: "deterministic",
    });
  }
  return findings;
}

/**
 * Titles of the input descriptors that declare an explicit `default`.
 *
 * `"default" in input` — not a truthiness test. `"default": ""` is the
 * canonical hidden-input declaration across the bundled runtime agent set, and
 * a falsy-but-present default satisfies the runtime exactly like any other.
 */
function extractDefaultedTitles(rawInputs: unknown): Set<string> {
  if (!Array.isArray(rawInputs)) return new Set();
  return new Set(
    rawInputs
      .filter(isPlainObject)
      .filter((i) => "default" in i)
      .map((i) => i.title)
      .filter((t): t is string => typeof t === "string"),
  );
}

/** The bare package name, for the per-(package, input) exemption lookup. */
function resolvePackageName(parsed: Record<string, unknown>): string {
  const metadata = isPlainObject(parsed.metadata)
    ? (parsed.metadata as Record<string, unknown>)
    : {};
  const cinatra = isPlainObject(metadata.cinatra)
    ? (metadata.cinatra as Record<string, unknown>)
    : {};
  if (typeof cinatra.packageName === "string" && cinatra.packageName) {
    return cinatra.packageName;
  }
  return typeof parsed.id === "string" ? parsed.id : "";
}

/**
 * One list out of the StartNode's `metadata.cinatra` — `required` (the APP's
 * list, the only fields the setup loop collects; `oas-compiler.ts` step 7
 * copies it verbatim into the compiled `inputSchema.required`) or `hidden`
 * (the fields marked `x-hidden` and never rendered).
 */
function extractStartStringList(
  rawStartNode: unknown,
  key: "required" | "hidden",
): string[] {
  if (!isPlainObject(rawStartNode)) return [];
  const metadata = (rawStartNode as Record<string, unknown>).metadata;
  if (!isPlainObject(metadata)) return [];
  const cinatra = (metadata as Record<string, unknown>).cinatra;
  if (!isPlainObject(cinatra)) return [];
  const list = (cinatra as Record<string, unknown>)[key];
  if (!Array.isArray(list)) return [];
  return list.filter((t): t is string => typeof t === "string");
}

// ---------------------------------------------------------------------------
// Graph extraction — builds a normalized view of one Flow component
// (the top-level Flow, plus any subflows nested under $referenced_components).
// ---------------------------------------------------------------------------

interface FlowComponent {
  flowId: string;
  flowInputTitles: string[];
  /**
   * Titles of the Flow inputs that declare an explicit `default`. The RUNTIME
   * accepts a start message without these; every other declared input must
   * arrive in the message or `start_conversation` refuses (OAS-RUNTIME-014).
   */
  flowInputDefaults: Set<string>;
  startNodeRef: string;
  startNode: { inputTitles: string[] } | null;
  /**
   * The StartNode's `metadata.cinatra.required` — the APP's list, the only
   * fields the setup loop collects (`oas-compiler.ts` step 7 copies it into the
   * compiled `inputSchema.required`). Empty when the node declares none.
   */
  startRequired: string[];
  /**
   * The StartNode's `metadata.cinatra.hidden` — the fields the compiler marks
   * `x-hidden` and the setup form never renders (`oas-compiler.ts` step 7).
   */
  startHidden: string[];
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
  const flowInputDefaults = extractDefaultedTitles(raw.inputs);

  const startNodeRef = resolveComponentRef(raw.start_node) ?? "start";
  const endNodes = listEndNodes(raw);
  const endNodeRef = endNodes[0]?.id ?? "end";

  const refs = isPlainObject(raw.$referenced_components)
    ? (raw.$referenced_components as Record<string, unknown>)
    : {};

  const startNode = isPlainObject(refs[startNodeRef])
    ? extractIoNode(refs[startNodeRef] as Record<string, unknown>)
    : null;
  const startRequired = extractStartStringList(refs[startNodeRef], "required");
  const startHidden = extractStartStringList(refs[startNodeRef], "hidden");
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
    flowInputDefaults,
    startNodeRef,
    startNode,
    startRequired,
    startHidden,
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
  // cinatra#4223: the page capture files an artifact — a write.
  ARTIFACT_PAGE_CAPTURE_TOOL,
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
  opts?: {
    produces?: readonly string[] | null;
    /** The sibling package.json `cinatra.dependsOn` artifact-extension ids —
     *  the second half of "neither declares nor depends on" (enabler 0.16).
     *  Null/undefined ⇒ unknown. */
    dependsOn?: readonly string[] | null;
    /** The registered OWNER of a scanned type id (cinatra#3597) — threaded to
     *  `scanOasForUndeclaredTypeSaves`; null/undefined ⇒ the id's own reading. */
    resolveTypeOwner?: ((typeId: string) => string | null) | null;
  },
): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const produces = opts?.produces ?? null;

  // OAS-RUNTIME-009 — declared production ⇒ runnable materialization edge.
  // Single grammar source: the #923 collectors.
  const bindingResult = collectArtifactBindingsFromOasDocument(parsed, { produces });
  const materializeResult = collectArtifactMaterializeNodesFromOasDocument(parsed, {
    produces,
  });
  const imageResult = collectArtifactImageNodesFromOasDocument(parsed, { produces });

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
    for (const n of imageResult.nodes) covered.add(n.extension);
    for (const ext of produces) {
      if (covered.has(ext)) continue;
      findings.push({
        code: "OAS-RUNTIME-009",
        severity: "warning",
        message:
          `package.json cinatra.produces declares "${ext}" but the OAS has no runnable ` +
          `materialization edge for it. Add an EndNode output binding ` +
          `(outputs[].cinatra.artifact with extension "${ext}"), an artifact_materialize ` +
          `passthrough ApiNode targeting "${ext}", or an artifact_image_generate or ` +
          `artifact_page_capture passthrough ` +
          `step filing "${ext}". Until migrated, the declared artifact is ` +
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

  // OAS-RUNTIME-013 — a step that saves a type the agent neither declares nor
  // depends on (enabler 0.16 of `PLAN: Agents Lifecycle (C)`).
  findings.push(
    ...scanOasForUndeclaredTypeSaves(parsed, {
      produces,
      dependsOn: opts?.dependsOn ?? null,
      resolveTypeOwner: opts?.resolveTypeOwner ?? null,
    }),
  );

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

// ===========================================================================
// OAS-RUNTIME-013 — THE COMPILER HALF OF THE UNOWNED-TYPE REFUSAL
// (enabler 0.16 of `PLAN: Agents Lifecycle (C)`, cinatra#3028 / epic #3023).
//
// THE PLAN'S SENTENCE, VERBATIM: "the compiler flags an agent whose steps save
// to a type it neither declares nor depends on — the dynamic-type namespace
// resolves nowhere by design."
//
// WHY IT READS THE NODE'S WHOLE BODY. A passthrough save names its type in one
// of several places — a `data.typeHint`, a `data.type`, an input default, a
// nested body field — and pyagentspec walks all of them alike. Scanning the
// SERIALIZED node body (the same text the placeholder inference already reads)
// plus the declared input defaults finds a literal type id wherever the author
// put it, and a templated type (`{{ ... }}`) yields no literal, so nothing is
// invented for it.
//
// WARNING-ONLY, like every other finding on this advisory surface: the surface's
// own hard invariant (`/api/oas-lint/scan-all` re-stamps to a blocker-authorized
// source) is that nothing here blocks a publish. The plan's gates land in warn
// mode and turn blocking with the fleet's declarations wave; this finding is
// counted, not enforced, on exactly that schedule.
// ===========================================================================

/** A namespaced object-type id literal (`@scope/pkg:local`). The same grammar
 *  `OBJECT_TYPE_NAMESPACE_RE` states, applied as a scanner over free text. */
const OBJECT_TYPE_ID_LITERAL_RE = /@[\w-]+\/[\w-]+:[\w-]+/g;

/** The defining extension package of a namespaced object-type id. */
function definerOfTypeId(typeId: string): string | null {
  const colon = typeId.lastIndexOf(":");
  return colon > 0 ? typeId.slice(0, colon) : null;
}

/** The two permanently-tombstoned dynamic prefixes, restated as a local
 *  predicate so this scanner stays free of the objects package's graph. */
function isDynamicNamespaceTypeId(typeId: string): boolean {
  return typeId.startsWith("@dynamic/types:") || typeId.startsWith("@cinatra-ai/dynamic:");
}

/**
 * Flag every passthrough write step that names an object type the agent neither
 * declares as produced nor declares a dependency on.
 *
 * `produces` and `dependsOn` are the agent's own two declarations. When BOTH are
 * unknown (null), the scan says nothing: there is no declaration to measure the
 * save against, and inventing one would flag every agent in the fleet.
 */
export function scanOasForUndeclaredTypeSaves(
  parsed: Record<string, unknown>,
  opts?: {
    produces?: readonly string[] | null;
    dependsOn?: readonly string[] | null;
    /**
     * The OWNER of a scanned type id, from its registration (cinatra#3597). An
     * artifact type id LOOKS like `@vendor/package:type`, but five shipped packs
     * register types whose id namespace is not their package name, so this
     * scanner would otherwise advise the author of such a pack's consumer to
     * declare a package that does not exist. When this resolver names an owner,
     * THAT owner is measured against the declarations and the id's namespace is
     * not consulted; when it names none — an author's machine where nothing is
     * installed — the reading is the id's own, because this surface is
     * warning-only and must not start flagging every type whose owner it cannot
     * see. Passed IN: the scanner stays free of the objects package's graph.
     */
    resolveTypeOwner?: ((typeId: string) => string | null) | null;
  },
): ReviewFinding[] {
  const produces = opts?.produces ?? null;
  const dependsOn = opts?.dependsOn ?? null;
  if (produces === null && dependsOn === null) return [];
  const declared = new Set<string>([...(produces ?? []), ...(dependsOn ?? [])]);

  const findings: ReviewFinding[] = [];
  for (const flow of iterFlowComponents(parsed)) {
    for (const node of flow.apiNodes) {
      if (node.url === null || !node.url.includes(AGENTS_PASSTHROUGH_URL_MARKER)) continue;
      if (node.tool === null || !ARTIFACT_PARITY_WRITE_TOOLS.has(node.tool)) continue;

      const haystacks = [node.placeholderSourceText];
      for (const value of node.inputDefaults.values()) {
        if (typeof value === "string") haystacks.push(value);
      }
      const seen = new Set<string>();
      for (const text of haystacks) {
        OBJECT_TYPE_ID_LITERAL_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = OBJECT_TYPE_ID_LITERAL_RE.exec(text)) !== null) {
          const typeId = m[0];
          if (seen.has(typeId)) continue;
          seen.add(typeId);
          const definer = opts?.resolveTypeOwner?.(typeId) ?? definerOfTypeId(typeId);
          if (definer !== null && declared.has(definer)) continue;
          const reason = isDynamicNamespaceTypeId(typeId)
            ? "dynamic-namespace"
            : "undeclared-definer";
          findings.push({
            code: "OAS-RUNTIME-013",
            severity: "warning",
            message:
              `Step "${node.id}" (tool "${node.tool}") saves object type "${typeId}", which this ` +
              `agent neither declares in cinatra.produces nor depends on (reason: ${reason}). ` +
              (reason === "dynamic-namespace"
                ? `The dynamic-type namespace resolves to no extension by design, so the save is ` +
                  `refused at the write boundary with that reason. Save to a type an installed ` +
                  `artifact extension declares, or stop persisting the value — a projection is a ` +
                  `deterministic, non-persisting step.`
                : `Declare "${definer ?? typeId}" in cinatra.produces or as an artifact dependency, ` +
                  `or save to a type this agent already declares.`),
            location: `$referenced_components.${node.id} (Flow "${flow.flowId}")`,
            source: "deterministic",
          });
        }
      }
    }
  }
  return findings;
}


/**
 * cinatra#3759: a root Flow input not collected by setup needs a declared
 * default. Installers pass their actual package identity; OAS metadata cannot
 * impersonate one of the bounded legacy package/input pairs.
 */
export function scanOasForVisibleInputContractFindings(
  parsed: Record<string, unknown>,
  packageName = resolvePackageName(parsed),
): ReviewFinding[] {
  if (parsed.component_type !== "Flow") return [];
  const flow = extractFlow(parsed);
  if (!flow) return [];
  const findings: ReviewFinding[] = [];
  const agentLabel = packageName || describeAgentForFindings(parsed);
  for (const title of flow.flowInputTitles) {
    if (flow.startHidden.includes(title) || flow.startRequired.includes(title)) continue;
    if (flow.flowInputDefaults.has(title) || PLATFORM_SUPPLIED_FLOW_INPUTS.includes(title)) continue;
    if (isOnVisibleInputInstallBaseline(packageName, title)) continue;
    findings.push({
      code: "visible_input_setup_omission",
      severity: "blocker",
      message: `${agentLabel}: visible Flow input "${title}" has no default and is not declared required in the StartNode's metadata.cinatra.required. Setup cannot ask for it as a required field. Declare it required or give the Flow and StartNode input an explicit default before installing.`,
      location: `inputs[] "${title}" (Flow "${flow.flowId}")`,
      source: "deterministic",
    });
  }
  return findings;
}

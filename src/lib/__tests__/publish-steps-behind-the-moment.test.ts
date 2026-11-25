// EVERY PUBLISHING ACTION OF AN INSTALLED PACK SITS BEHIND THE PRE-PUBLISH MOMENT (cinatra#4150, acceptance item 7).
//
// Item 7 has two halves. publish-pack-names-border.test.ts holds the half "no core file names a publish pack". This
// file holds the other half: each installed agent pack's flow is compiled with the real compiler, and
//   (1) every node that can make a publishing call is declared a publishing step, so the runtime stops the run in front
//       of it at the host's publish gate; and
//   (2) every declared publishing step can be put behind that gate, and each call it makes goes to a host route that
//       refuses the call until a person released the decision (publishCallAllowed).
//
// The definitions are the host's own, never a pack's name:
//   - a publishing step is a top-level node with `metadata.cinatra.publishes: true`, as the compiler lists it in
//     `publishingSteps` (packages/agents/src/oas-compiler.ts, collectPublishingSteps);
//   - a publishing tool is a tool the MCP boundary holds for the person's recorded decision on a run
//     (needsRecordedDecision, src/lib/authz/mcp-boundary.ts): a name of OUTWARD_EFFECT_TOOL_NAMES, OR a tool whose
//     registration declares `outward`. The second half is read the way the host reads it: every connector MCP module
//     the generated manifest lists is loaded by the host's own loader (loadConnectorMcpModules,
//     src/lib/connector-mcp-registration.server.ts) and registered into a recording server, and each registration's
//     config goes through the planner's own reader (readDeclaredOutward, packages/mcp-server/src/capability-plan.ts,
//     the reader planPrimitiveRegistration uses for `declaredOutward`).
// A node can make a publishing call when
//   (a) it is a passthrough step whose `data.tool` is a publishing tool, or
//   (b) it is a model-bridge step whose tool list (`metadata.cinatra.tools`, read by readStepToolDeclaration) names a
//       publishing tool, or
//   (c) it is a model-bridge step with no tool list in a pack whose manifest consumes a publishing tool
//       (cinatra.consumes): the pack grants the step that tool. An explicit `publishes: false` does not clear it.
// A bridge or passthrough node is one whose url is exactly one of the compiler's two routes (PUBLISH_CALL_ROUTES in
// oas-compiler.ts); any other address is outside the publish hold, since WayFlow calls it itself. The compiler refuses
// such an address only on a declared publishing step (PUBLISH_CALL_UNCHECKED); on any other node it compiles, so the
// audit reports it, OUTSIDE_HOLD, unless it is a host route of HOST_ROUTES_OUTSIDE_THE_HOLD (each reviewed, and its
// source checked to name no publishing tool and call no host primitive).
// A node inside a subflow makes the call for the top-level node that holds it, since only a top-level node can carry
// the declaration (the runtime puts the gate in front of a top-level node only).
//
// A model-bridge step with no tool list in a pack that consumes no publishing tool is not "safe by declaration". The
// host offers it every tool of its toolboxes: the bridge keeps an undeclared step policy unrestricted
// (packages/llm/src/index.ts, restrictMcpServerOffer), and a run's self-MCP tool carries no allowlist
// (packages/llm/src/mcp-access.ts, buildLlmMcpServerToolForAgentRun). It is classified by what the host does:
//   - offered only the self-MCP toolbox (`data.toolbox_ids` absent, the bridge's default, or naming only `cinatra-mcp`
//     and built-ins): HELD. Every call goes to /api/mcp on the run's frame: the step's token carries the run id, and a
//     step with a verified source never gets the run-less machine bearer (src/app/api/llm-bridge/route.ts,
//     buildMachineToolWithDurableBinding); a run-bound step without a verified source is offered no tool at all
//     (readRunPolicyBeforeProvider). On that frame enforceMcpBoundary refuses every publishing tool, a registration-
//     outward one included (needsRecordedDecision). The repository case calls the real boundary for every publishing
//     tool of the tree on a run frame to pin that refusal; heldSteps lists the steps that rely on it;
//   - offered any other MCP toolbox, or toolbox ids the host cannot read: a finding, UNHELD, since the boundary does
//     not stand between such a step and that toolbox;
//   - offered no MCP toolbox (an empty list, or built-ins only): no MCP tool, nothing to classify.
// The audit reads what the runtime reads: the source as mounted, with no compile-time pass (the compiler's propagation
// of `metadata.cinatra.toolboxes` into `data.toolbox_ids` changes only the compiled copy; WayFlow loads the source), and
// it applies the bridge's own default and split of `toolbox_ids` (resolveBridgeToolboxIds,
// src/app/api/llm-bridge/_llm-dispatch.ts, which the bridge route calls).
//
// A tool a step names that the host does not know is its own finding, UNKNOWN_TOOL: an unknown name is never read as
// "not publishing". For a model-bridge list, known means classified for the boundary (PRIMITIVE_CLASSIFICATIONS) or
// registered by a connector module; for a passthrough step, on the passthrough route's allowlist (ALLOWED_TOOLS, read
// from the route's source with each set it spreads imported from its own module; a spread the census does not read
// fails the file). An extension whose
// source declares `outward` but whose package has no connector MCP module in the generated manifest (so the loader
// above cannot read its registration) is a finding too, OUTWARD_UNREAD: a plain text search of its source, the only
// reading possible without booting the app.
//
// RED-FIRST: the fixture cases plant a node that can publish without the declaration (each of (a), (b), (c), a tool
// that is outward by its registration only, one inside a subflow), an unknown tool name, and a declared step that calls
// past the host's routes; each must give a finding. The repository case reads the pinned tree. A pinned pack that does
// not meet the rule today is listed in PINNED_PACKS_NOT_YET_MET with its pin and its exact findings; the entry applies
// only at that pin, and an entry whose pack now meets the rule fails the case, so the list can only shrink.
//
// The repository case needs the materialized `extensions/` tree (`node scripts/ci/sync-dev-extensions.mjs --pinned`);
// without it the case is skipped, unless CINATRA_REQUIRE_EXTENSIONS=1 is set, as in publish-pack-names-border.test.ts.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  __resetRegistryCacheForTests,
  checkExecutedPublishingCallRoutes,
  compileOasAgentJson,
  PUBLISH_ADDRESS_KEY,
  PUBLISH_GATE_INPUT_RE,
  PUBLISH_BRIDGE_ROUTE,
  PUBLISH_CALL_ROUTES,
  PUBLISH_PASSTHROUGH_ROUTE,
} from "../../../packages/agents/src/oas-compiler";
import { resolveBridgeToolboxIds } from "../../app/api/llm-bridge/_llm-dispatch";
import { readStepToolDeclaration } from "../../../packages/agents/src/validate-oas-runtime-invariants";
import { decisionBlocksDispatch, readDeclaredOutward } from "../../../packages/mcp-server/src/capability-plan";
import { enforceMcpBoundary, OUTWARD_EFFECT_TOOL_NAMES, RECORDED_DECISION_REQUIRED_REASON } from "../authz/mcp-boundary";
import * as auditModule from "../authz/audit";
import { lookupPrimitiveClassification } from "../authz/inventory-augment";

const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const GATE_PREFIX = "cinatra_publish_gate__";
const PARITY_FIXTURE = path.join(REPO_ROOT, "docker", "wayflow", "tests", "fixtures", "publish_gate_parity.json");

type Json = Record<string, unknown>;
type Ref = { $component_ref?: unknown };

const isObject = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const cinatraOf = (node: Json): Json => {
  const meta = node.metadata;
  return isObject(meta) && isObject(meta.cinatra) ? meta.cinatra : {};
};
// A host bridge or passthrough node is one whose url is exactly the compiler's route (PUBLISH_CALL_ROUTES, the routes
// whose call the host checks); a url that merely contains a route's path is another address.
const isBridge = (node: Json) => node.component_type === "ApiNode" && node.url === PUBLISH_BRIDGE_ROUTE;
const isPassthrough = (node: Json) => node.component_type === "ApiNode" && node.url === PUBLISH_PASSTHROUGH_ROUTE;
const HOST_PREFIX = "{{CINATRA_BASE_URL}}";

/**
 * Host routes a flow may call outside the publish hold, each reviewed: none reaches a publishing tool. The repository
 * case checks that each route's source names no publishing tool of the census and calls no host primitive.
 */
export const HOST_ROUTES_OUTSIDE_THE_HOLD: Record<string, string> = {
  "/api/context-resolve": "resolves the trusted context candidates of a run's gate",
  "/api/context-finalize": "revalidates a context selection and writes its audit rows",
  "/api/oas-lint/scan-all": "returns the lint findings of the policy agent",
};

/** What the host knows about tools: the names registrations declare outward, and every name a connector registers. */
export type ToolCensus = {
  outwardByRegistration: ReadonlySet<string>;
  registered: ReadonlySet<string>;
  /** Every tool name the passthrough route allows (passthroughAllowlist). */
  passthrough: ReadonlySet<string>;
};

/** The census of a list of registrations, each config read by the planner's own outward reader. */
export function censusFrom(registrations: Array<{ name: string; config: unknown }>, passthrough: ReadonlySet<string>): ToolCensus {
  return {
    outwardByRegistration: new Set(registrations.filter((r) => readDeclaredOutward(r.config) !== null).map((r) => r.name)),
    registered: new Set(registrations.map((r) => r.name)),
    passthrough,
  };
}

const isPublishingTool = (census: ToolCensus, tool: string) =>
  OUTWARD_EFFECT_TOOL_NAMES.has(tool) || census.outwardByRegistration.has(tool);
/** A name the MCP boundary can serve: classified by the host, or registered by a connector. */
const isKnownTool = (census: ToolCensus, tool: string) =>
  lookupPrimitiveClassification(tool) !== undefined || census.registered.has(tool) || OUTWARD_EFFECT_TOOL_NAMES.has(tool);

/** The string literals and the spread names of a `new Set([ ... ]);` constructor in a source file. */
function setSource(file: string, opener: string): { literals: string[]; spreads: string[] } {
  const text = readFileSync(path.join(REPO_ROOT, file), "utf8");
  const start = text.indexOf(opener);
  if (start < 0) throw new Error(`${file}: ${opener} not found`);
  const body = text.slice(start + opener.length, text.indexOf("]);", start)).replace(/\/\/[^\n]*/g, "");
  return {
    literals: [...body.matchAll(/"([a-z0-9_-]+)"/g)].map((m) => m[1]!),
    spreads: [...body.matchAll(/\.\.\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!),
  };
}

const PASSTHROUGH_ROUTE = "src/app/api/agents/passthrough/route.ts";
/**
 * Each set the passthrough route spreads into its allowlist, imported from the module the route imports it from. A
 * spread not named here makes passthroughAllowlist throw, so a new spread cannot be missed.
 */
const PASSTHROUGH_SPREADS: Record<string, () => Promise<ReadonlySet<string>>> = {
  EXTENSION_SCOPED_TOOLS: async () => (await import("../extension-scoped-tools")).EXTENSION_SCOPED_TOOLS,
  RUN_FOLDER_TOOLS: async () => (await import("../run-folder-tools")).RUN_FOLDER_TOOLS,
};

/**
 * The passthrough route's allowlist (src/app/api/agents/passthrough/route.ts, ALLOWED_TOOLS). The route does not
 * export the set, so its constructor is read from the route's source: its string literals, and each set it spreads,
 * imported from its own module.
 */
export async function passthroughAllowlist(): Promise<{ tools: ReadonlySet<string>; spreads: string[] }> {
  const { literals, spreads } = setSource(PASSTHROUGH_ROUTE, "const ALLOWED_TOOLS = new Set([");
  const tools = new Set(literals);
  for (const name of spreads) {
    const load = PASSTHROUGH_SPREADS[name];
    if (!load) throw new Error(`${PASSTHROUGH_ROUTE}: ALLOWED_TOOLS spreads ${name}, which this census does not read`);
    for (const t of await load()) tools.add(t);
  }
  return { tools, spreads };
}

/** The MCP toolboxes the bridge gives a step whose request names none: its default. */
const DEFAULT_MCP_TOOLBOXES = new Set(resolveBridgeToolboxIds(undefined).mcp);

/** The publishing tools a pack's manifest consumes (cinatra.consumes[].primitive). */
export function consumedPublishingTools(pkg: Json, census: ToolCensus): string[] {
  const consumes = isObject(pkg.cinatra) ? pkg.cinatra.consumes : undefined;
  if (!Array.isArray(consumes)) return [];
  return consumes
    .map((c) => (isObject(c) ? c.primitive : undefined))
    .filter((p): p is string => typeof p === "string" && isPublishingTool(census, p));
}

type Reading = { publishing: string[]; unknown: string[]; unheld: string[]; held: string[]; outside: string[] };
const emptyReading = (): Reading => ({ publishing: [], unknown: [], unheld: [], held: [], outside: [] });

/**
 * The MCP toolboxes the bridge offers a model step: its `data.toolbox_ids` after the compiler's propagation, less the
 * provider built-ins; the bridge defaults an absent list to the self-MCP toolbox (llm-bridge/route.ts, toolbox_ids).
 */
function mcpToolboxesOf(node: Json): string[] | null {
  const ids = isObject(node.data) ? node.data.toolbox_ids : undefined;
  if (ids !== undefined && (!Array.isArray(ids) || !ids.every((t) => typeof t === "string"))) return null;
  return resolveBridgeToolboxIds(ids as string[] | undefined).mcp;
}

/** Why a single component can make a publishing call, and the tool names it names that the host does not know. */
function readComponent(node: Json, consumed: string[], census: ToolCensus): Reading {
  const out = emptyReading();
  const id = typeof node.id === "string" ? node.id : "?";
  // Any address other than the compiler's two routes is outside the publish hold: WayFlow calls it itself.
  if (Object.prototype.hasOwnProperty.call(node, "url") && !PUBLISH_CALL_ROUTES.has(node.url as string)) {
    const url = typeof node.url === "string" ? node.url : "";
    const hostPath = url.startsWith(`${HOST_PREFIX}/`) ? url.slice(HOST_PREFIX.length) : null;
    if (hostPath === null) out.outside.push(`${id} calls a url outside the host, which no publish hold covers`);
    else if (!Object.prototype.hasOwnProperty.call(HOST_ROUTES_OUTSIDE_THE_HOLD, hostPath)) {
      out.outside.push(`${id} calls the host route ${hostPath}, which does not check a publishing call and is not reviewed`);
    }
  }
  if (node.component_type === "A2AAgent" || Object.keys(node).some((k) => k !== "url" && PUBLISH_ADDRESS_KEY.test(k))) {
    out.outside.push(`${id} calls a remote agent or address, which no publish hold covers`);
  }
  if (isPassthrough(node)) {
    const tool = isObject(node.data) ? node.data.tool : undefined;
    if (typeof tool === "string") {
      if (!census.passthrough.has(tool)) out.unknown.push(`${id} names the tool ${tool}, which the passthrough route does not allow`);
      else if (isPublishingTool(census, tool)) out.publishing.push(`${id} calls the publishing tool ${tool}`);
    }
  }
  if (isBridge(node)) {
    const declaration = readStepToolDeclaration(node);
    if (declaration.kind === "declared") {
      for (const t of declaration.tools.filter((x) => !isKnownTool(census, x))) out.unknown.push(`${id} lists the unknown tool ${t}`);
      const named = declaration.tools.filter((t) => isKnownTool(census, t) && isPublishingTool(census, t));
      if (named.length > 0) out.publishing.push(`${id} lists the publishing tool ${named.join(", ")}`);
    } else if (declaration.kind === "invalid") {
      out.unknown.push(`${id} has a tool list the host cannot read`);
    } else {
      // No tool list: the bridge keeps every tool its toolboxes offer (see the header).
      const toolboxes = mcpToolboxesOf(node);
      if (toolboxes === null) {
        out.unheld.push(`${id} has no tool list and toolbox ids the host cannot read`);
      } else if (toolboxes.some((t) => !DEFAULT_MCP_TOOLBOXES.has(t))) {
        const other = toolboxes.filter((t) => !DEFAULT_MCP_TOOLBOXES.has(t));
        out.unheld.push(`${id} has no tool list and is offered the toolbox ${other.join(", ")}, which the MCP boundary does not hold`);
      } else if (toolboxes.length > 0) {
        if (consumed.length > 0) {
          out.publishing.push(`${id} has no tool list and the pack consumes the publishing tool ${consumed.join(", ")}`);
        } else {
          out.held.push(`${id} has no tool list; every publishing tool of the self-MCP toolbox is refused on its run's frame`);
        }
      }
    }
  }
  return out;
}

/** Every reading in the subtree of a top-level node; references resolve in the flow's components. */
function readSubtree(start: unknown, refs: Json, consumed: string[], census: ToolCensus): Reading {
  const out = emptyReading();
  const seen = new Set<unknown>();
  const stack: unknown[] = [start];
  while (stack.length > 0) {
    const value = stack.pop();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      stack.push(...value);
      continue;
    }
    const o = value as Json;
    const ref = (o as Ref).$component_ref;
    if (typeof ref === "string" && isObject(refs[ref])) stack.push(refs[ref]);
    if (typeof o.component_type === "string") {
      const r = readComponent(o, consumed, census);
      out.publishing.push(...r.publishing);
      out.unknown.push(...r.unknown);
      out.unheld.push(...r.unheld);
      out.held.push(...r.held);
      out.outside.push(...r.outside);
    }
    for (const v of Object.values(o)) stack.push(v);
  }
  return out;
}

/**
 * The findings for one compiled flow. `publishingSteps` is the compiler's list; `rawSource` is the flow text the
 * runtime executes.
 */
type FlowArgs = { oas: Json; pkg: Json; rawSource: string; publishingSteps: string[]; census: ToolCensus };

/** The reading of each top-level node, over the source as the runtime mounts it. */
function readFlow({ oas: source, pkg, census }: FlowArgs): { topLevel: string[]; refs: Json; readings: Map<string, Reading> } {
  const oas = source;
  const refs = isObject(oas.$referenced_components) ? oas.$referenced_components : {};
  const topLevel = (Array.isArray(oas.nodes) ? oas.nodes : [])
    .map((n) => (isObject(n) ? (n as Ref).$component_ref : undefined))
    .filter((id): id is string => typeof id === "string");
  const consumed = consumedPublishingTools(pkg, census);
  return { topLevel, refs, readings: new Map(topLevel.map((id) => [id, readSubtree(refs[id], refs, consumed, census)])) };
}

/** The undeclared top-level nodes whose model steps rely on the boundary's run-frame refusal (see the header). */
export function heldSteps(args: FlowArgs): string[] {
  const declared = new Set(args.publishingSteps);
  return [...readFlow(args).readings].filter(([id]) => !declared.has(id)).flatMap(([id, r]) => r.held.map((h) => `HELD ${id}: ${h}`));
}

export function publishingFindings(args: FlowArgs): string[] {
  const { oas, rawSource, publishingSteps } = args;
  const findings: string[] = [];
  const { topLevel, refs, readings } = readFlow(args);
  const declared = new Set(publishingSteps);

  // (1) every node that can make a publishing call is a declared publishing step; an unknown tool is never "not
  // publishing", and a model step offered a toolbox the boundary does not hold is never passed.
  for (const id of topLevel) {
    const reading = readings.get(id)!;
    for (const u of reading.unknown) findings.push(`UNKNOWN_TOOL ${id}: ${u}`);
    if (reading.publishing.length > 0 && !declared.has(id)) {
      findings.push(`UNDECLARED ${id}: ${reading.publishing.join("; ")}`);
    }
    if (reading.unheld.length > 0 && !declared.has(id)) findings.push(`UNHELD ${id}: ${reading.unheld.join("; ")}`);
    if (reading.outside.length > 0 && !declared.has(id)) findings.push(`OUTSIDE_HOLD ${id}: ${reading.outside.join("; ")}`);
  }

  // (2) every declared step can be put behind the gate, and its calls go to a host route that checks the decision.
  const declaredInSource = topLevel.filter((id) => isObject(refs[id]) && cinatraOf(refs[id] as Json).publishes === true);
  if (JSON.stringify(declaredInSource) !== JSON.stringify(publishingSteps)) {
    findings.push(`STEPS ${JSON.stringify(publishingSteps)} differ from the declared nodes ${JSON.stringify(declaredInSource)}`);
  }
  findings.push(...gateRefusals(oas, publishingSteps));
  const routes = checkExecutedPublishingCallRoutes(rawSource);
  if (!routes.ok) findings.push(`UNCHECKED_CALL ${routes.error}`);
  return findings;
}

/**
 * Why the runtime loader could not insert the stop in front of a declared step: the acceptance conditions of
 * _insert_publish_gates (docker/wayflow/agent_loader.py), stated once here. The loader also refuses a malformed or
 * misplaced flag and a reserved id; the compiler refuses those (collectPublishingSteps), and an input name that is not a
 * plain identifier (checkPublishGateInputs, whose PUBLISH_GATE_INPUT_RE this reuses). One condition is the audit's own,
 * stricter than the loader: a declared start node, which a run enters without passing the stop. The real loader runs
 * over every pinned pack in docker/wayflow/tests/test_repo_agents_load.py (_runtime_preload).
 */
function gateRefusals(oas: Json, steps: readonly string[]): string[] {
  if (steps.length === 0) return [];
  const out: string[] = [];
  const refs = isObject(oas.$referenced_components) ? oas.$referenced_components : {};
  const listOf = (key: string): Json[] | null => {
    const v = oas[key];
    if (v === undefined || v === null) return [];
    return Array.isArray(v) ? (v as Json[]) : null;
  };
  const refOf = (v: unknown) => (isObject(v) && typeof v.$component_ref === "string" ? v.$component_ref : undefined);
  const control = listOf("control_flow_connections");
  const data = listOf("data_flow_connections");
  if (control === null || data === null) return ["NO_GATE the flow: an edge list is not a list"];
  control.forEach((e, i) => {
    if (!refOf(e?.from_node) || !refOf(e?.to_node)) out.push(`NO_GATE the flow: control edge #${i} is not an inline edge between node references`);
  });
  data.forEach((e, i) => {
    if (!refOf(e?.source_node) || !refOf(e?.destination_node) || typeof e?.source_output !== "string" || typeof e?.destination_input !== "string") {
      out.push(`NO_GATE the flow: data edge #${i} is not an inline edge between node references`);
    }
  });
  // A declared node referenced anywhere but the root nodes and edges, or a nested definition under its id.
  const allowed = new Set<string>();
  (Array.isArray(oas.nodes) ? oas.nodes : []).forEach((_, i) => allowed.add(`nodes.${i}`));
  control.forEach((_, i) => ["from_node", "to_node"].forEach((k) => allowed.add(`control_flow_connections.${i}.${k}`)));
  data.forEach((_, i) => ["source_node", "destination_node"].forEach((k) => allowed.add(`data_flow_connections.${i}.${k}`)));
  const outside = new Set<string>();
  const walk = (v: unknown, at: string[]) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, [...at, String(i)]));
    if (!isObject(v)) return;
    const ref = refOf(v);
    if (ref && steps.includes(ref) && !allowed.has(at.join("."))) outside.add(ref);
    for (const [k, x] of Object.entries(v)) {
      if (k === "$referenced_components" && at.length > 0 && isObject(x)) for (const s of steps) if (s in x) outside.add(s);
      walk(x, [...at, k]);
    }
  };
  walk(oas, []);
  const startRef = refOf(oas.start_node);
  for (const step of steps) {
    if (step === startRef) out.push(`NO_GATE ${step}: it is the start node`);
    if (outside.has(step)) out.push(`NO_GATE ${step}: it is referenced outside the root flow's nodes and edges`);
    if (!control.some((e) => refOf(e?.to_node) === step)) out.push(`NO_GATE ${step}: no control edge leads into it`);
    const feeds = data.filter((e) => refOf(e?.destination_node) === step);
    if (feeds.length === 0) out.push(`NO_GATE ${step}: no data edge leads into it`);
    if (feeds.some((e) => typeof e.destination_input !== "string" || !PUBLISH_GATE_INPUT_RE.test(e.destination_input))) {
      out.push(`NO_GATE ${step}: an input fed into it is not a plain identifier`);
    }
    if (Object.prototype.hasOwnProperty.call(refs, `${GATE_PREFIX}${step}`)) out.push(`NO_GATE ${step}: the pack holds the gate's id`);
  }
  return out;
}

let tempDir = "";
beforeEach(() => {
  __resetRegistryCacheForTests();
  tempDir = mkdtempSync(path.join(tmpdir(), "publish-behind-moment-"));
});
afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = "";
});

/** Compile with the real compiler and return the findings. */
async function check(packageName: string, oasFile: string, pkg: Json, census: ToolCensus): Promise<string[]> {
  const rawSource = readFileSync(oasFile, "utf8");
  const res = await compileOasAgentJson({ packageName, oasSourcePath: oasFile, registryPath: path.join(tempDir, "components.json") });
  if (!res.ok) return [`COMPILE ${res.error}`];
  return publishingFindings({ oas: JSON.parse(rawSource) as Json, pkg, rawSource, publishingSteps: res.value.publishingSteps, census });
}

// ---------------------------------------------------------------------------
// Fixtures: the LinkedIn publish shape of the shared parity fixture, changed one way per case.
// ---------------------------------------------------------------------------

type Flow = { nodes: Ref[]; $referenced_components: Record<string, Json>; [k: string]: unknown };

/** The passthrough route's allowlist, read once for the fixtures and the pinned tree. */
let PASSTHROUGH: { tools: ReadonlySet<string>; spreads: string[] } = { tools: new Set(), spreads: [] };
/** A connector that registers a read tool and a tool that is outward by its registration only. */
let FIXTURE_CENSUS: ToolCensus = { outwardByRegistration: new Set(), registered: new Set(), passthrough: new Set() };
beforeAll(async () => {
  PASSTHROUGH = await passthroughAllowlist();
  FIXTURE_CENSUS = censusFrom([
    { name: "fixture_site_tool_write", config: { title: "fixture_site_tool_write", outward: {} } },
    { name: "fixture_site_tool_read", config: { title: "fixture_site_tool_read" } },
  ], PASSTHROUGH.tools);
});

/**
 * The proof a held step relies on: the real boundary, on an agent run's frame (a platform admin, so no role rule
 * decides), refuses each tool with an ENFORCED denial: one that decisionBlocksDispatch (capability-plan.ts) reads as
 * stopping dispatch. Both dispatchers decide with that one predicate (the runtime server's tool wrapper, the in-process
 * self-invocation; each has a case in its own test file that a blocking denial does not reach the handler and a
 * non-blocking one does); every other decision dispatches. So each tool must
 * answer `allowed: false`, `shouldBlock: true`, and the expected reason: the recorded decision for a tool the host
 * classifies, unclassified for one it does not (refused before that rule). The dispatchers themselves are not driven
 * here: on a run frame each first proves the run's executing source against the run store.
 */
async function boundaryOnRunFrame(
  tools: Array<{ name: string; declaresOutward: boolean }>,
  decide: typeof enforceMcpBoundary = enforceMcpBoundary,
): Promise<string[]> {
  const spy = vi.spyOn(auditModule, "logAuditEvent").mockResolvedValue(undefined);
  try {
    const served: string[] = [];
    for (const { name, declaresOutward } of tools) {
      const decision = await decide({
        primitiveName: name,
        ctx: { orgId: "org-1", userId: "admin-1", platformRole: "platform_admin", runId: "run-1" },
        declaresOutward,
      } as Parameters<typeof enforceMcpBoundary>[0]);
      const expected = lookupPrimitiveClassification(name) ? RECORDED_DECISION_REQUIRED_REASON : "unclassified_primitive";
      if (!decisionBlocksDispatch(decision) || decision.reason !== expected) served.push(`${name}: ${JSON.stringify(decision)}`);
    }
    return served;
  } finally {
    spy.mockRestore();
  }
}

function linkedinShape(): Flow {
  const parity = JSON.parse(readFileSync(PARITY_FIXTURE, "utf8")) as { flows: Array<{ name: string; flow: Flow }> };
  const flow = JSON.parse(JSON.stringify(parity.flows.find((f) => f.name === "linkedin-publish-shape")!.flow)) as Flow;
  // The parity fixture's runtime test answers every call itself; here each node calls the host route it calls in a pack.
  flow.$referenced_components.publish!.url = PUBLISH_BRIDGE_ROUTE;
  for (const [id, tool] of [["read_post_record", "artifacts_get"], ["read_post_text", "artifacts_get"], ["write_address", "objects_update"]]) {
    const node = flow.$referenced_components[id!]!;
    node.url = PUBLISH_PASSTHROUGH_ROUTE;
    node.data = { ...(isObject(node.data) ? node.data : {}), tool, agent_run_id: "{{cinatra_run_id}}" };
  }
  return flow;
}
function setPublishes(node: Json, value: boolean | undefined) {
  const meta = (isObject(node.metadata) ? node.metadata : (node.metadata = {})) as Json;
  const cinatra = (isObject(meta.cinatra) ? meta.cinatra : (meta.cinatra = {})) as Json;
  if (value === undefined) delete cinatra.publishes;
  else cinatra.publishes = value;
}
async function checkFixture(flow: Flow, pkg: Json = { name: "@cinatra-ai/publish-fixture-agent" }): Promise<string[]> {
  const file = path.join(tempDir, "oas.json");
  writeFileSync(file, JSON.stringify(flow, null, 2));
  return check("@cinatra-ai/publish-fixture-agent", file, pkg, FIXTURE_CENSUS);
}
const CONSUMES_POST = { name: "@cinatra-ai/publish-fixture-agent", cinatra: { consumes: [{ primitive: "linkedin_post_publish", requirement: "required" }] } };
const findingsOf = (oas: Json, publishingSteps: string[], pkg: Json = {}) =>
  publishingFindings({ oas, pkg, rawSource: JSON.stringify(oas), publishingSteps, census: FIXTURE_CENSUS });

describe("item 7: a node that can publish is declared and sits behind the moment (fixtures)", () => {
  it("the census reads a registration's outward declaration with the planner's reader", () => {
    expect([...FIXTURE_CENSUS.outwardByRegistration]).toEqual(["fixture_site_tool_write"]);
    expect([...FIXTURE_CENSUS.registered].sort()).toEqual(["fixture_site_tool_read", "fixture_site_tool_write"]);
  });

  it("the parity fixture's declared publish step passes", async () => {
    expect(await checkFixture(linkedinShape(), CONSUMES_POST)).toEqual([]);
  });

  it("(c) the same model-bridge step without the declaration, in a pack that consumes the post tool, is refused", async () => {
    const flow = linkedinShape();
    setPublishes(flow.$referenced_components.publish!, undefined);
    expect(await checkFixture(flow, CONSUMES_POST)).toEqual([
      "UNDECLARED publish: publish has no tool list and the pack consumes the publishing tool linkedin_post_publish",
    ]);
  });

  it("(c) a model-bridge step with no tool list and no publishing tool in the manifest is classified held, never passed silently", async () => {
    const flow = linkedinShape();
    setPublishes(flow.$referenced_components.publish!, undefined);
    expect(await checkFixture(flow)).toEqual([]);
    expect(heldSteps({ oas: flow as unknown as Json, pkg: {}, rawSource: "", publishingSteps: [], census: FIXTURE_CENSUS })).toEqual([
      "HELD publish: publish has no tool list; every publishing tool of the self-MCP toolbox is refused on its run's frame",
    ]);
    expect(await boundaryOnRunFrame([
      ...[...OUTWARD_EFFECT_TOOL_NAMES].map((name) => ({ name, declaresOutward: false })),
      ...[...FIXTURE_CENSUS.outwardByRegistration].map((name) => ({ name, declaresOutward: true })),
    ])).toEqual([]);
  });

  it("the boundary census accepts only a denial that stops dispatch: the right reason without shouldBlock fails it", async () => {
    const tools = [
      { name: "linkedin_post_publish", declaresOutward: false },
      { name: "fixture_site_tool_write", declaresOutward: true },
    ];
    const reasonOf = (name: string) => (lookupPrimitiveClassification(name) ? RECORDED_DECISION_REQUIRED_REASON : "unclassified_primitive");
    const notBlocking: typeof enforceMcpBoundary = async (req) => ({ allowed: false, reason: reasonOf(req.primitiveName), shouldBlock: false });
    const allowed: typeof enforceMcpBoundary = async () => ({ allowed: true });
    const blocking: typeof enforceMcpBoundary = async (req) => ({ allowed: false, reason: reasonOf(req.primitiveName), shouldBlock: true });
    expect(await boundaryOnRunFrame(tools, notBlocking)).toHaveLength(2);
    expect(await boundaryOnRunFrame(tools, allowed)).toHaveLength(2);
    expect(await boundaryOnRunFrame(tools, blocking)).toEqual([]);
  });

  it("(c) a model-bridge step with no tool list offered another MCP toolbox is UNHELD; built-ins only, or none, offer no MCP tool", async () => {
    const flow = linkedinShape();
    const publish = flow.$referenced_components.publish!;
    setPublishes(publish, undefined);
    publish.data = { ...(publish.data as Json), toolbox_ids: ["web_search", "cinatra-mcp", "fixture-site-mcp"] };
    expect(await checkFixture(flow)).toEqual([
      "UNHELD publish: publish has no tool list and is offered the toolbox fixture-site-mcp, which the MCP boundary does not hold",
    ]);
    const held = () => heldSteps({ oas: flow as unknown as Json, pkg: {}, rawSource: "", publishingSteps: [], census: FIXTURE_CENSUS });
    publish.data = { ...(publish.data as Json), toolbox_ids: ["web_search"] };
    expect(await checkFixture(flow)).toEqual([]);
    expect(held()).toEqual([]);
    publish.data = { ...(publish.data as Json), toolbox_ids: ["fixture-site-mcp"] };
    setPublishes(publish, true);
    expect(await checkFixture(flow)).toEqual([]);
  });

  it("the runtime reads the source as mounted: flow-level toolboxes the compiler propagates do not narrow what the bridge gives a step", async () => {
    const flow = linkedinShape();
    const publish = flow.$referenced_components.publish!;
    setPublishes(publish, undefined);
    delete (publish.data as Json).toolbox_ids;
    cinatraOf(flow as Json).toolboxes = ["web_search"];
    // The bridge defaults a step without toolbox_ids to the self-MCP toolbox, so the consumed post tool is reachable.
    expect(await checkFixture(flow, CONSUMES_POST)).toEqual([
      "UNDECLARED publish: publish has no tool list and the pack consumes the publishing tool linkedin_post_publish",
    ]);
    // With the narrowing in the source itself, the step is offered no MCP toolbox.
    publish.data = { ...(publish.data as Json), toolbox_ids: ["web_search"] };
    expect(await checkFixture(flow, CONSUMES_POST)).toEqual([]);
  });

  it("(c) an explicit false does not clear a step that can make the call", async () => {
    const flow = linkedinShape();
    setPublishes(flow.$referenced_components.publish!, false);
    expect(await checkFixture(flow, CONSUMES_POST)).toEqual([
      "UNDECLARED publish: publish has no tool list and the pack consumes the publishing tool linkedin_post_publish",
    ]);
  });

  it("(c) a tool outward by its registration only, granted by the manifest to a step with no list: undeclared it is refused, declared it passes", async () => {
    const flow = linkedinShape();
    const publish = flow.$referenced_components.publish!;
    const pkg = { name: "@cinatra-ai/publish-fixture-agent", cinatra: { consumes: [{ primitive: "fixture_site_tool_write", requirement: "required" }] } };
    setPublishes(publish, undefined);
    expect(await checkFixture(flow, pkg)).toEqual([
      "UNDECLARED publish: publish has no tool list and the pack consumes the publishing tool fixture_site_tool_write",
    ]);
    setPublishes(publish, true);
    expect(await checkFixture(flow, pkg)).toEqual([]);
  });

  it("(c) a model-bridge step whose tool list leaves the publishing tools out is not a publishing call", async () => {
    const flow = linkedinShape();
    const publish = flow.$referenced_components.publish!;
    setPublishes(publish, false);
    (cinatraOf(publish) as Json).tools = ["artifacts_get", "fixture_site_tool_read"];
    expect(await checkFixture(flow, CONSUMES_POST)).toEqual([]);
  });

  it("(b) a model-bridge step that lists the post tool without the declaration is refused", async () => {
    const flow = linkedinShape();
    const publish = flow.$referenced_components.publish!;
    setPublishes(publish, undefined);
    (cinatraOf(publish) as Json).tools = ["linkedin_post_publish"];
    expect(await checkFixture(flow)).toEqual(["UNDECLARED publish: publish lists the publishing tool linkedin_post_publish"]);
  });

  it("(b) a tool that is outward by its registration only: listed undeclared it is refused, declared it passes", async () => {
    const flow = linkedinShape();
    const publish = flow.$referenced_components.publish!;
    expect(OUTWARD_EFFECT_TOOL_NAMES.has("fixture_site_tool_write")).toBe(false);
    setPublishes(publish, false);
    (cinatraOf(publish) as Json).tools = ["fixture_site_tool_write"];
    expect(await checkFixture(flow)).toEqual(["UNDECLARED publish: publish lists the publishing tool fixture_site_tool_write"]);
    setPublishes(publish, true);
    expect(await checkFixture(flow)).toEqual([]);
  });

  it("(a) a passthrough step that calls the test-send tool without the declaration is refused; declared, it passes", async () => {
    const flow = linkedinShape();
    const publish = flow.$referenced_components.publish!;
    publish.url = "{{CINATRA_BASE_URL}}/api/agents/passthrough";
    publish.data = { tool: "email_test_delivery_run_send", input: "{}", agent_run_id: "{{cinatra_run_id}}" };
    setPublishes(publish, undefined);
    expect(await checkFixture(flow)).toEqual(["UNDECLARED publish: publish calls the publishing tool email_test_delivery_run_send"]);
    setPublishes(publish, true);
    expect(await checkFixture(flow)).toEqual([]);
  });

  it("the passthrough census is the route's whole allowlist: its literals and every set it spreads", async () => {
    expect(PASSTHROUGH.spreads.sort()).toEqual(Object.keys(PASSTHROUGH_SPREADS).sort());
    for (const tool of ["dashboards_create", "extension_tool", "run_folder_read", "run_folder_write", "run_folder_list"]) {
      expect(FIXTURE_CENSUS.passthrough.has(tool), tool).toBe(true);
    }
    const flow = linkedinShape();
    const publish = flow.$referenced_components.publish!;
    publish.url = "{{CINATRA_BASE_URL}}/api/agents/passthrough";
    publish.data = { tool: "run_folder_read", input: "{}", agent_run_id: "{{cinatra_run_id}}" };
    setPublishes(publish, undefined);
    expect(await checkFixture(flow)).toEqual([]);
  });

  it("a passthrough step that calls a known tool that is not outward needs no declaration", async () => {
    const flow = linkedinShape();
    const publish = flow.$referenced_components.publish!;
    publish.url = "{{CINATRA_BASE_URL}}/api/agents/passthrough";
    publish.data = { tool: "artifacts_get", input: "{}", agent_run_id: "{{cinatra_run_id}}" };
    setPublishes(publish, undefined);
    expect(await checkFixture(flow)).toEqual([]);
  });

  it("a tool name the host does not know is its own finding, never read as not publishing", async () => {
    const flow = linkedinShape();
    const publish = flow.$referenced_components.publish!;
    setPublishes(publish, false);
    (cinatraOf(publish) as Json).tools = ["fixture_site_tool_wirte"];
    expect(await checkFixture(flow)).toEqual(["UNKNOWN_TOOL publish: publish lists the unknown tool fixture_site_tool_wirte"]);
    publish.url = "{{CINATRA_BASE_URL}}/api/agents/passthrough";
    publish.data = { tool: "no_such_tool", input: "{}", agent_run_id: "{{cinatra_run_id}}" };
    delete (cinatraOf(publish) as Json).tools;
    expect(await checkFixture(flow)).toEqual([
      "UNKNOWN_TOOL publish: publish names the tool no_such_tool, which the passthrough route does not allow",
    ]);
    publish.data = { tool: "linkedin_post_publish", input: "{}", agent_run_id: "{{cinatra_run_id}}" };
    expect(await checkFixture(flow)).toEqual([
      "UNKNOWN_TOOL publish: publish names the tool linkedin_post_publish, which the passthrough route does not allow",
    ]);
  });

  it("a publishing call inside a subflow needs the declaration on the top-level node that holds it", () => {
    const inner = { component_type: "Flow", nodes: [{ component_type: "ApiNode", id: "post", url: "{{CINATRA_BASE_URL}}/api/agents/passthrough", data: { tool: "email_test_delivery_run_send" } }] };
    const oas: Json = {
      nodes: [{ $component_ref: "wrap" }],
      $referenced_components: { wrap: { component_type: "FlowNode", id: "wrap", subflow: { $component_ref: "inner" } }, inner },
    };
    expect(findingsOf(oas, [])).toEqual(["UNDECLARED wrap: post calls the publishing tool email_test_delivery_run_send"]);
  });

  it("an undeclared node whose url only contains the bridge path is outside the hold: the compiler takes it, the audit refuses it", async () => {
    const flow = linkedinShape();
    const publish = flow.$referenced_components.publish!;
    setPublishes(publish, undefined);
    publish.url = "https://api.example.com/api/llm-bridge";
    expect(await checkFixture(flow)).toEqual([
      "OUTSIDE_HOLD publish: publish calls a url outside the host, which no publish hold covers",
    ]);
    publish.url = "{{CINATRA_BASE_URL}}/api/llm-bridge-copy";
    expect(await checkFixture(flow)).toEqual([
      "OUTSIDE_HOLD publish: publish calls the host route /api/llm-bridge-copy, which does not check a publishing call and is not reviewed",
    ]);
    publish.url = "{{CINATRA_BASE_URL}}/api/context-resolve";
    expect(await checkFixture(flow)).toEqual([]);
    publish.url = "https://api.example.com/api/llm-bridge";
    setPublishes(publish, true);
    expect((await checkFixture(flow))[0]).toMatch(/^COMPILE PUBLISH_CALL_UNCHECKED: /);
  });

  it("a declared step whose call goes past the host's routes is refused, by the compiler and by the executed-source check", async () => {
    const flow = linkedinShape();
    flow.$referenced_components.publish!.url = "https://api.linkedin.example/v2/posts";
    const findings = await checkFixture(flow, CONSUMES_POST);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatch(/^COMPILE PUBLISH_CALL_UNCHECKED: /);
    expect(findingsOf(flow as unknown as Json, ["publish"], CONSUMES_POST)).toEqual([
      expect.stringMatching(/^UNCHECKED_CALL PUBLISH_CALL_UNCHECKED: /),
    ]);
  });

  it("a declared step fed under a name that is not a plain identifier cannot be held: the compiler refuses it, and so does the audit", async () => {
    const flow = linkedinShape();
    const edge = (flow.data_flow_connections as Json[]).find((e) => (e.destination_node as Ref).$component_ref === "publish")!;
    edge.destination_input = "post text";
    expect(await checkFixture(flow, CONSUMES_POST)).toEqual([
      'COMPILE PUBLISH_GATE_UNSUPPORTED: an input fed into publishing step "publish" is not a plain identifier, so the stop could not surface it',
    ]);
    expect(findingsOf(flow as unknown as Json, ["publish"], CONSUMES_POST)).toEqual([
      "NO_GATE publish: an input fed into it is not a plain identifier",
    ]);
  });

  it("a declared step referenced outside the root flow's nodes and edges cannot be held", () => {
    const flow = linkedinShape();
    flow.$referenced_components.wrap = { component_type: "Flow", id: "wrap", nodes: [{ $component_ref: "publish" }] };
    expect(findingsOf(flow as unknown as Json, ["publish"], CONSUMES_POST)).toEqual([
      "NO_GATE publish: it is referenced outside the root flow's nodes and edges",
    ]);
  });

  it("a declared step that no control edge reaches cannot be put behind the gate", () => {
    const flow = linkedinShape();
    const oas = JSON.parse(JSON.stringify(flow)) as Json & { control_flow_connections: Json[] };
    oas.control_flow_connections = oas.control_flow_connections.filter((e) => (e.to_node as Ref).$component_ref !== "publish");
    expect(publishingFindings({ oas, pkg: CONSUMES_POST, rawSource: JSON.stringify(flow), publishingSteps: ["publish"], census: FIXTURE_CENSUS })).toEqual([
      "NO_GATE publish: no control edge leads into it",
    ]);
  });
});

// ---------------------------------------------------------------------------
// The pinned tree.
// ---------------------------------------------------------------------------

/**
 * Pinned packs that do not meet the rule today, at their pin, with their exact findings. An entry applies only while
 * the lock pins that commit; a pack at another pin must meet the rule, and a listed pack that meets it fails the case
 * until its entry is removed. The comment names the pull request that removes the entry, where one is open.
 */
const PINNED_PACKS_NOT_YET_MET: Record<string, { pin: string; findings: string[] }> = {
  // Pinned before its publishing step was declared. Removed by cinatra#4806 (moves the pin to 52a1213e).
  "@cinatra-ai/blog-linkedin-publish-agent": {
    pin: "11753d6c4590e05ab0291e2c5309ba0239a50619",
    findings: ["UNDECLARED publish: publish has no tool list and the pack consumes the publishing tool linkedin_post_publish"],
  },
  // Sends mail through a listed tool without the declaration; its prepare step has no tool list in a pack that consumes
  // the send tool; its send step lists a status tool the boundary does not classify. No pull request yet.
  "@cinatra-ai/email-delivery-agent": {
    pin: "bf578fce2091224e3fd4ba7adde0dd91f036cdbb",
    findings: [
      "UNDECLARED prepare: prepare has no tool list and the pack consumes the publishing tool email_outreach_send_initial_start",
      "UNKNOWN_TOOL send: send lists the unknown tool email_outreach_send_initial_status",
      "UNDECLARED send: send lists the publishing tool email_outreach_send_initial_start",
    ],
  },
  // Sends the test mail from a passthrough step that is not declared publishing. Open pull request #4809 builds the
  // host plan tool for this send; the enforcement follows #4788. No pull request moves this pin yet.
  "@cinatra-ai/email-test-delivery-agent": {
    pin: "1afddbaa75b5f1e77081c5713fe49933039894a3",
    findings: ["UNDECLARED perform_test_send: perform_test_send calls the publishing tool email_test_delivery_run_send"],
  },
  // Consumes the WordPress write tool (outward by its registration only); two model-bridge steps that the self-MCP
  // toolbox reaches have no tool list and no declaration (compose_change is offered no MCP toolbox). No pull request yet.
  "@cinatra-ai/wordpress-agent": {
    pin: "b04d467bcf1433337e0f46fc5a9908f914aead84",
    findings: [
      "UNDECLARED read_page: read_page has no tool list and the pack consumes the publishing tool wordpress_site_tool_write",
      "UNDECLARED edit: edit has no tool list and the pack consumes the publishing tool wordpress_site_tool_write",
    ],
  },
};

function lockedPins(): Map<string, string> {
  const pins = new Map<string, string>();
  for (const lock of ["cinatra-dev-extensions.lock.json", "cinatra-required-extensions.lock.json"]) {
    const file = path.join(REPO_ROOT, lock);
    if (!existsSync(file)) continue;
    const doc = JSON.parse(readFileSync(file, "utf8")) as { packages?: Array<{ packageName?: unknown; resolvedSha?: unknown }> };
    for (const p of doc.packages ?? []) {
      if (typeof p.packageName === "string" && typeof p.resolvedSha === "string") pins.set(p.packageName, p.resolvedSha);
    }
  }
  return pins;
}

type Installed = { packageName: string; dir: string; pkg: Json };

/** Every installed extension: `extensions/<scope>/<name>/package.json`. */
function installedExtensions(): Installed[] {
  const extRoot = path.join(REPO_ROOT, "extensions");
  const out: Installed[] = [];
  if (!existsSync(extRoot)) return out;
  for (const scope of readdirSync(extRoot, { withFileTypes: true })) {
    if (!scope.isDirectory()) continue;
    for (const dir of readdirSync(path.join(extRoot, scope.name), { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const pkgDir = path.join(extRoot, scope.name, dir.name);
      const pkgFile = path.join(pkgDir, "package.json");
      if (!existsSync(pkgFile)) continue;
      out.push({ packageName: String((JSON.parse(readFileSync(pkgFile, "utf8")) as Json).name), dir: pkgDir, pkg: JSON.parse(readFileSync(pkgFile, "utf8")) as Json });
    }
  }
  return out.sort((a, b) => a.packageName.localeCompare(b.packageName));
}

/** Every installed agent pack with a flow. */
function installedAgentPacks(): Array<Installed & { oasFile: string }> {
  return installedExtensions()
    .filter((e) => isObject(e.pkg.cinatra) && e.pkg.cinatra.kind === "agent")
    .map((e) => ({ ...e, oasFile: path.join(e.dir, "cinatra", "oas.json") }))
    .filter((e) => existsSync(e.oasFile));
}

/** The pinned tree's census: every connector MCP module the generated manifest lists, through the host's own loader. */
async function pinnedToolCensus(): Promise<ToolCensus> {
  const { loadConnectorMcpModules } = await import("../connector-mcp-registration.server");
  const registrations: Array<{ name: string; config: unknown }> = [];
  const server = {
    registerTool: (name: string, config: unknown) => {
      registrations.push({ name, config });
      return undefined as never;
    },
    registerResource: () => undefined as never,
    registerPrompt: () => undefined as never,
    registerScreen: () => undefined,
  };
  for (const mod of await loadConnectorMcpModules()) await mod.registerCapabilities(server as never);
  return censusFrom(registrations, PASSTHROUGH.tools);
}

/** The packages whose non-test source text declares `outward:` (the fallback reading; see the header). */
function packagesDeclaringOutwardInSource(): string[] {
  const out: string[] = [];
  const walk = (dir: string): boolean => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "__tests__" || entry === "test" || entry === "tests" || entry.startsWith(".")) continue;
      const p = path.join(dir, entry);
      if (statSync(p).isDirectory()) {
        if (walk(p)) return true;
      } else if (/\.(ts|tsx|js|mjs)$/.test(entry) && !/\.test\./.test(entry) && /\boutward\s*:/.test(readFileSync(p, "utf8"))) {
        return true;
      }
    }
    return false;
  };
  for (const e of installedExtensions()) {
    const src = path.join(e.dir, "src");
    if (existsSync(src) && walk(src)) out.push(e.packageName);
  }
  return out;
}

/** The connector packages the generated manifest lists an MCP module for. */
function packagesWithManifestMcpModule(): Set<string> {
  const text = readFileSync(path.join(REPO_ROOT, "src", "lib", "generated", "extensions.server.ts"), "utf8");
  const block = text.slice(text.indexOf("GENERATED_CONNECTOR_MCP_MODULES"), text.indexOf("GENERATED_CONNECTOR_PRIMITIVE_HANDLERS"));
  return new Set([...block.matchAll(/import\("(@[^"/]+\/[^"/]+)\/mcp-module"\)/g)].map((m) => m[1]!));
}

const REQUIRE_EXTENSIONS = process.env.CINATRA_REQUIRE_EXTENSIONS === "1";
const PACKS = installedAgentPacks();

describe.skipIf(PACKS.length === 0 && !REQUIRE_EXTENSIONS)("item 7: every pinned agent pack's publishing actions sit behind the moment", () => {
  let census: ToolCensus = { outwardByRegistration: new Set(), registered: new Set(), passthrough: new Set() };
  beforeAll(async () => {
    census = await pinnedToolCensus();
  });

  it("reads the installed agent packs (the universe is not empty)", () => {
    expect(PACKS.length, "CINATRA_REQUIRE_EXTENSIONS=1 but no agent pack with a flow is installed: the sync did not run").toBeGreaterThan(0);
  });

  it("reads the registration-declared half from the connectors' own registrations (the WordPress write tool is in it)", () => {
    expect(census.registered.size).toBeGreaterThan(0);
    expect(census.outwardByRegistration.has("wordpress_site_tool_write")).toBe(true);
    expect(OUTWARD_EFFECT_TOOL_NAMES.has("wordpress_site_tool_write")).toBe(false);
  });

  it("every extension that declares outward in its source has a connector MCP module the loader reads (OUTWARD_UNREAD)", () => {
    const read = packagesWithManifestMcpModule();
    expect(packagesDeclaringOutwardInSource().filter((p) => !read.has(p)).map((p) => `OUTWARD_UNREAD ${p}`)).toEqual([]);
  });

  it("each pack compiles, declares every node that can publish, and every declared step sits behind the gate", async () => {
    const pins = lockedPins();
    const results: Record<string, string[]> = {};
    for (const p of PACKS) {
      const findings = await check(p.packageName, p.oasFile, p.pkg, census);
      const known = PINNED_PACKS_NOT_YET_MET[p.packageName];
      const knownApplies = known !== undefined && known.pin === pins.get(p.packageName);
      if (knownApplies && JSON.stringify(findings) === JSON.stringify(known.findings)) continue;
      if (knownApplies && findings.length === 0) {
        results[p.packageName] = [`meets the rule now: remove its entry from PINNED_PACKS_NOT_YET_MET`];
        continue;
      }
      if (findings.length > 0) results[p.packageName] = findings;
    }
    expect(results).toEqual({});
  });

  it("every model step classified held relies on a refusal the boundary really makes, for every publishing tool of the tree", async () => {
    const held: string[] = [];
    for (const p of PACKS) {
      const rawSource = readFileSync(p.oasFile, "utf8");
      const res = await compileOasAgentJson({ packageName: p.packageName, oasSourcePath: p.oasFile, registryPath: path.join(tempDir, "components.json") });
      if (!res.ok) continue;
      held.push(...heldSteps({ oas: JSON.parse(rawSource) as Json, pkg: p.pkg, rawSource, publishingSteps: res.value.publishingSteps, census }));
    }
    expect(held.length, "no held step: drop this case or its classification").toBeGreaterThan(0);
    expect(await boundaryOnRunFrame([
      ...[...OUTWARD_EFFECT_TOOL_NAMES].map((name) => ({ name, declaresOutward: false })),
      ...[...census.outwardByRegistration].map((name) => ({ name, declaresOutward: true })),
    ])).toEqual([]);
  });

  it("every reviewed host route outside the hold names no publishing tool and calls no host primitive in its source", () => {
    const publishing = [...OUTWARD_EFFECT_TOOL_NAMES, ...census.outwardByRegistration];
    const reaches: string[] = [];
    for (const route of Object.keys(HOST_ROUTES_OUTSIDE_THE_HOLD)) {
      const text = readFileSync(path.join(REPO_ROOT, "src", "app", route, "route.ts"), "utf8");
      for (const word of [...publishing, "callHostPrimitive", "enforceMcpBoundary"]) {
        if (text.includes(word)) reaches.push(`${route}: ${word}`);
      }
    }
    expect(reaches).toEqual([]);
  });

  it("every entry of the not-yet-met list names an installed pack", () => {
    const installed = new Set(PACKS.map((p) => p.packageName));
    expect(Object.keys(PINNED_PACKS_NOT_YET_MET).filter((n) => !installed.has(n))).toEqual([]);
  });
});

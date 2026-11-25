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
// A node inside a subflow makes the call for the top-level node that holds it, since only a top-level node can carry
// the declaration (the runtime puts the gate in front of a top-level node only).
//
// A tool a step names that the host does not know is its own finding, UNKNOWN_TOOL: an unknown name is never read as
// "not publishing". For a model-bridge list, known means classified for the boundary (PRIMITIVE_CLASSIFICATIONS) or
// registered by a connector module; for a passthrough step, on the passthrough route's allowlist. An extension whose
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

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as path from "node:path";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  __resetRegistryCacheForTests,
  checkExecutedPublishingCallRoutes,
  compileOasAgentJson,
} from "../../../packages/agents/src/oas-compiler";
import { readStepToolDeclaration } from "../../../packages/agents/src/validate-oas-runtime-invariants";
import { readDeclaredOutward } from "../../../packages/mcp-server/src/capability-plan";
import { OUTWARD_EFFECT_TOOL_NAMES } from "../authz/mcp-boundary";
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
const urlOf = (node: Json): string => (typeof node.url === "string" ? node.url : "");
const isBridge = (node: Json) => node.component_type === "ApiNode" && urlOf(node).includes("/api/llm-bridge");
const isPassthrough = (node: Json) => node.component_type === "ApiNode" && urlOf(node).includes("/api/agents/passthrough");

/** What the host knows about tools: the names registrations declare outward, and every name a connector registers. */
export type ToolCensus = { outwardByRegistration: ReadonlySet<string>; registered: ReadonlySet<string> };

/** The census of a list of registrations, each config read by the planner's own outward reader. */
export function censusFrom(registrations: Array<{ name: string; config: unknown }>): ToolCensus {
  return {
    outwardByRegistration: new Set(registrations.filter((r) => readDeclaredOutward(r.config) !== null).map((r) => r.name)),
    registered: new Set(registrations.map((r) => r.name)),
  };
}

const isPublishingTool = (census: ToolCensus, tool: string) =>
  OUTWARD_EFFECT_TOOL_NAMES.has(tool) || census.outwardByRegistration.has(tool);
/** A name the MCP boundary can serve: classified by the host, or registered by a connector. */
const isKnownTool = (census: ToolCensus, tool: string) =>
  lookupPrimitiveClassification(tool) !== undefined || census.registered.has(tool) || OUTWARD_EFFECT_TOOL_NAMES.has(tool);

/**
 * The passthrough route's allowlist (src/app/api/agents/passthrough/route.ts, ALLOWED_TOOLS, spread with
 * EXTENSION_SCOPED_TOOLS of src/lib/extension-scoped-tools.ts). Neither module loads outside the app (both import
 * server-only modules), so the string literals of the two set constructors are read from their source text.
 */
function literalSet(file: string, opener: string): string[] {
  const text = readFileSync(path.join(REPO_ROOT, file), "utf8");
  const start = text.indexOf(opener);
  if (start < 0) throw new Error(`${file}: ${opener} not found`);
  const body = text.slice(start + opener.length, text.indexOf("]);", start));
  return [...body.replace(/\/\/[^\n]*/g, "").matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]!);
}
const PASSTHROUGH_TOOLS = new Set([
  ...literalSet("src/app/api/agents/passthrough/route.ts", "const ALLOWED_TOOLS = new Set(["),
  ...literalSet("src/lib/extension-scoped-tools.ts", "export const EXTENSION_SCOPED_TOOLS = new Set<string>(["),
]);

/** The publishing tools a pack's manifest consumes (cinatra.consumes[].primitive). */
export function consumedPublishingTools(pkg: Json, census: ToolCensus): string[] {
  const consumes = isObject(pkg.cinatra) ? pkg.cinatra.consumes : undefined;
  if (!Array.isArray(consumes)) return [];
  return consumes
    .map((c) => (isObject(c) ? c.primitive : undefined))
    .filter((p): p is string => typeof p === "string" && isPublishingTool(census, p));
}

type Reading = { publishing: string[]; unknown: string[] };

/** Why a single component can make a publishing call, and the tool names it names that the host does not know. */
function readComponent(node: Json, consumed: string[], census: ToolCensus): Reading {
  const out: Reading = { publishing: [], unknown: [] };
  const id = typeof node.id === "string" ? node.id : "?";
  if (isPassthrough(node)) {
    const tool = isObject(node.data) ? node.data.tool : undefined;
    if (typeof tool === "string") {
      if (!PASSTHROUGH_TOOLS.has(tool)) out.unknown.push(`${id} names the tool ${tool}, which the passthrough route does not allow`);
      else if (isPublishingTool(census, tool)) out.publishing.push(`${id} calls the publishing tool ${tool}`);
    }
  }
  if (isBridge(node)) {
    const declaration = readStepToolDeclaration(node);
    if (declaration.kind === "declared") {
      for (const t of declaration.tools.filter((x) => !isKnownTool(census, x))) out.unknown.push(`${id} lists the unknown tool ${t}`);
      const named = declaration.tools.filter((t) => isKnownTool(census, t) && isPublishingTool(census, t));
      if (named.length > 0) out.publishing.push(`${id} lists the publishing tool ${named.join(", ")}`);
    } else if (declaration.kind === "undeclared" && consumed.length > 0) {
      out.publishing.push(`${id} has no tool list and the pack consumes the publishing tool ${consumed.join(", ")}`);
    }
  }
  return out;
}

/** Every reading in the subtree of a top-level node; references resolve in the flow's components. */
function readSubtree(start: unknown, refs: Json, consumed: string[], census: ToolCensus): Reading {
  const out: Reading = { publishing: [], unknown: [] };
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
    }
    for (const v of Object.values(o)) stack.push(v);
  }
  return out;
}

/**
 * The findings for one compiled flow. `publishingSteps` is the compiler's list; `rawSource` is the flow text the
 * runtime executes.
 */
export function publishingFindings(args: { oas: Json; pkg: Json; rawSource: string; publishingSteps: string[]; census: ToolCensus }): string[] {
  const { oas, pkg, rawSource, publishingSteps, census } = args;
  const findings: string[] = [];
  const refs = isObject(oas.$referenced_components) ? oas.$referenced_components : {};
  const topLevel = (Array.isArray(oas.nodes) ? oas.nodes : [])
    .map((n) => (isObject(n) ? (n as Ref).$component_ref : undefined))
    .filter((id): id is string => typeof id === "string");
  const consumed = consumedPublishingTools(pkg, census);
  const declared = new Set(publishingSteps);

  // (1) every node that can make a publishing call is a declared publishing step; an unknown tool is never "not publishing".
  for (const id of topLevel) {
    const reading = readSubtree(refs[id], refs, consumed, census);
    for (const u of reading.unknown) findings.push(`UNKNOWN_TOOL ${id}: ${u}`);
    if (reading.publishing.length > 0 && !declared.has(id)) {
      findings.push(`UNDECLARED ${id}: ${reading.publishing.join("; ")}`);
    }
  }

  // (2) every declared step can be put behind the gate, and its calls go to a host route that checks the decision.
  const declaredInSource = topLevel.filter((id) => isObject(refs[id]) && cinatraOf(refs[id] as Json).publishes === true);
  if (JSON.stringify(declaredInSource) !== JSON.stringify(publishingSteps)) {
    findings.push(`STEPS ${JSON.stringify(publishingSteps)} differ from the declared nodes ${JSON.stringify(declaredInSource)}`);
  }
  const startRef = isObject(oas.start_node) ? (oas.start_node as Ref).$component_ref : undefined;
  const controlEdges = Array.isArray(oas.control_flow_connections) ? (oas.control_flow_connections as Json[]) : [];
  const dataEdges = Array.isArray(oas.data_flow_connections) ? (oas.data_flow_connections as Json[]) : [];
  const into = (edges: Json[], end: string, id: string) =>
    edges.some((e) => isObject(e[end]) && (e[end] as Ref).$component_ref === id);
  for (const step of publishingSteps) {
    if (step === startRef) findings.push(`NO_GATE ${step}: it is the start node`);
    if (!into(controlEdges, "to_node", step)) findings.push(`NO_GATE ${step}: no control edge leads into it`);
    if (!into(dataEdges, "destination_node", step)) findings.push(`NO_GATE ${step}: no data edge leads into it`);
    if (Object.prototype.hasOwnProperty.call(refs, `${GATE_PREFIX}${step}`)) findings.push(`NO_GATE ${step}: the pack holds the gate's id`);
  }
  const routes = checkExecutedPublishingCallRoutes(rawSource);
  if (!routes.ok) findings.push(`UNCHECKED_CALL ${routes.error}`);
  return findings;
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

/** A connector that registers a read tool and a tool that is outward by its registration only. */
const FIXTURE_CENSUS = censusFrom([
  { name: "fixture_site_tool_write", config: { title: "fixture_site_tool_write", outward: {} } },
  { name: "fixture_site_tool_read", config: { title: "fixture_site_tool_read" } },
]);

function linkedinShape(): Flow {
  const parity = JSON.parse(readFileSync(PARITY_FIXTURE, "utf8")) as { flows: Array<{ name: string; flow: Flow }> };
  const flow = JSON.parse(JSON.stringify(parity.flows.find((f) => f.name === "linkedin-publish-shape")!.flow)) as Flow;
  flow.$referenced_components.publish!.url = "{{CINATRA_BASE_URL}}/api/llm-bridge";
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
    expect(await checkFixture(flow)).toEqual([]);
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
  // Sends the test mail through a passthrough step without the declaration. No pull request yet.
  "@cinatra-ai/email-test-delivery-agent": {
    pin: "1afddbaa75b5f1e77081c5713fe49933039894a3",
    findings: ["UNDECLARED perform_test_send: perform_test_send calls the publishing tool email_test_delivery_run_send"],
  },
  // Consumes the WordPress write tool (outward by its registration only) and its model-bridge steps have no tool list
  // and no declaration. No pull request yet.
  "@cinatra-ai/wordpress-agent": {
    pin: "b04d467bcf1433337e0f46fc5a9908f914aead84",
    findings: [
      "UNDECLARED read_page: read_page has no tool list and the pack consumes the publishing tool wordpress_site_tool_write",
      "UNDECLARED compose_change: compose_change has no tool list and the pack consumes the publishing tool wordpress_site_tool_write",
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
  return censusFrom(registrations);
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
  let census: ToolCensus = { outwardByRegistration: new Set(), registered: new Set() };
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

  it("every entry of the not-yet-met list names an installed pack", () => {
    const installed = new Set(PACKS.map((p) => p.packageName));
    expect(Object.keys(PINNED_PACKS_NOT_YET_MET).filter((n) => !installed.has(n))).toEqual([]);
  });
});

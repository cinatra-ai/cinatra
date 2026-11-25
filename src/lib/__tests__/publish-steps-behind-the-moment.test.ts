// EVERY PUBLISHING ACTION OF AN INSTALLED PACK SITS BEHIND THE PRE-PUBLISH MOMENT (cinatra#4150, acceptance item 7).
//
// Item 7 has two halves. publish-pack-names-border.test.ts holds the half "no core file names a publish pack". This
// file holds the other half: each installed agent pack's flow is compiled with the real compiler, and
//   (1) every node that makes a publishing call is declared a publishing step, so the runtime stops the run in front
//       of it at the host's publish gate; and
//   (2) every declared publishing step can be put behind that gate, and each call it makes goes to a host route that
//       refuses the call until a person released the decision (publishCallAllowed).
//
// The definitions are the host's own, never a pack's name:
//   - a publishing step is a top-level node with `metadata.cinatra.publishes: true`, as the compiler lists it in
//     `publishingSteps` (packages/agents/src/oas-compiler.ts, collectPublishingSteps);
//   - a publishing tool is a tool of the MCP boundary's outward-effect set (OUTWARD_EFFECT_TOOL_NAMES,
//     src/lib/authz/mcp-boundary.ts), which a run may call only with the person's recorded decision.
// A node makes a publishing call when
//   (a) it is a passthrough step whose `data.tool` is a publishing tool, or
//   (b) it is a model-bridge step whose tool list (`metadata.cinatra.tools`, read by readStepToolDeclaration) names a
//       publishing tool, or
//   (c) it is a model-bridge step with no tool list in a pack whose manifest consumes a publishing tool: no step list
//       limits it, so it can make that call.
// A node inside a subflow makes the call for the top-level node that holds it, since only a top-level node can carry
// the declaration (the runtime puts the gate in front of a top-level node only).
//
// What this check cannot see: a tool that is held as outward only by its registration (`declaresOutward`, for example
// the WordPress connector's site write tool), and a model-bridge step with no tool list in a pack that consumes no
// publishing tool by name. Those calls are still held at run time by the MCP boundary (needsRecordedDecision).
//
// RED-FIRST: the fixture cases plant a node that publishes without the declaration (each of (a), (b), (c), and one
// inside a subflow) and a declared step that calls past the host's routes; each must give a finding. The repository
// case reads the pinned tree. A pinned pack that does not meet the rule today is listed in PINNED_PACKS_NOT_YET_MET
// with its pin and its exact findings; the entry applies only at that pin, and an entry whose pack now meets the rule
// fails the case, so the list can only shrink.
//
// The repository case needs the materialized `extensions/` tree (`node scripts/ci/sync-dev-extensions.mjs --pinned`);
// without it the case is skipped, unless CINATRA_REQUIRE_EXTENSIONS=1 is set, as in publish-pack-names-border.test.ts.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as path from "node:path";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  __resetRegistryCacheForTests,
  checkExecutedPublishingCallRoutes,
  compileOasAgentJson,
} from "../../../packages/agents/src/oas-compiler";
import { readStepToolDeclaration } from "../../../packages/agents/src/validate-oas-runtime-invariants";
import { OUTWARD_EFFECT_TOOL_NAMES } from "../authz/mcp-boundary";

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

/** The publishing tools a pack's manifest consumes (cinatra.consumes[].primitive). */
export function consumedPublishingTools(pkg: Json): string[] {
  const consumes = isObject(pkg.cinatra) ? pkg.cinatra.consumes : undefined;
  if (!Array.isArray(consumes)) return [];
  return consumes
    .map((c) => (isObject(c) ? c.primitive : undefined))
    .filter((p): p is string => typeof p === "string" && OUTWARD_EFFECT_TOOL_NAMES.has(p));
}

/** Why a single component makes a publishing call, or null. */
function publishingCallOf(node: Json, consumed: string[]): string | null {
  if (isPassthrough(node)) {
    const tool = isObject(node.data) ? node.data.tool : undefined;
    if (typeof tool === "string" && OUTWARD_EFFECT_TOOL_NAMES.has(tool)) return `calls the publishing tool ${tool}`;
  }
  if (isBridge(node)) {
    const declaration = readStepToolDeclaration(node);
    if (declaration.kind === "declared") {
      const named = declaration.tools.filter((t) => OUTWARD_EFFECT_TOOL_NAMES.has(t));
      if (named.length > 0) return `lists the publishing tool ${named.join(", ")}`;
    } else if (declaration.kind === "undeclared" && consumed.length > 0) {
      return `has no tool list and the pack consumes the publishing tool ${consumed.join(", ")}`;
    }
  }
  return null;
}

/** Every reason the subtree of a top-level node makes a publishing call; references resolve in the flow's components. */
function publishingCallsUnder(start: unknown, refs: Json, consumed: string[]): string[] {
  const reasons: string[] = [];
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
      const why = publishingCallOf(o, consumed);
      if (why) reasons.push(`${typeof o.id === "string" ? o.id : "?"} ${why}`);
    }
    for (const v of Object.values(o)) stack.push(v);
  }
  return reasons;
}

/**
 * The findings for one compiled flow. `publishingSteps` is the compiler's list; `rawSource` is the flow text the
 * runtime executes.
 */
export function publishingFindings(args: { oas: Json; pkg: Json; rawSource: string; publishingSteps: string[] }): string[] {
  const { oas, pkg, rawSource, publishingSteps } = args;
  const findings: string[] = [];
  const refs = isObject(oas.$referenced_components) ? oas.$referenced_components : {};
  const topLevel = (Array.isArray(oas.nodes) ? oas.nodes : [])
    .map((n) => (isObject(n) ? (n as Ref).$component_ref : undefined))
    .filter((id): id is string => typeof id === "string");
  const consumed = consumedPublishingTools(pkg);
  const declared = new Set(publishingSteps);

  // (1) every node that makes a publishing call is a declared publishing step.
  for (const id of topLevel) {
    const reasons = publishingCallsUnder(refs[id], refs, consumed);
    if (reasons.length > 0 && !declared.has(id)) {
      findings.push(`UNDECLARED ${id}: ${reasons.join("; ")}`);
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
async function check(packageName: string, oasFile: string, pkg: Json): Promise<string[]> {
  const rawSource = readFileSync(oasFile, "utf8");
  const res = await compileOasAgentJson({ packageName, oasSourcePath: oasFile, registryPath: path.join(tempDir, "components.json") });
  if (!res.ok) return [`COMPILE ${res.error}`];
  return publishingFindings({ oas: JSON.parse(rawSource) as Json, pkg, rawSource, publishingSteps: res.value.publishingSteps });
}

// ---------------------------------------------------------------------------
// Fixtures: the LinkedIn publish shape of the shared parity fixture, changed one way per case.
// ---------------------------------------------------------------------------

type Flow = { nodes: Ref[]; $referenced_components: Record<string, Json>; [k: string]: unknown };

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
  return check("@cinatra-ai/publish-fixture-agent", file, pkg);
}
const CONSUMES_POST = { name: "@cinatra-ai/publish-fixture-agent", cinatra: { consumes: [{ primitive: "linkedin_post_publish", requirement: "required" }] } };

describe("item 7: a node that publishes is declared and sits behind the moment (fixtures)", () => {
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

  it("(c) an explicit false does not clear a step that can make the call", async () => {
    const flow = linkedinShape();
    setPublishes(flow.$referenced_components.publish!, false);
    expect(await checkFixture(flow, CONSUMES_POST)).toEqual([
      "UNDECLARED publish: publish has no tool list and the pack consumes the publishing tool linkedin_post_publish",
    ]);
  });

  it("(c) a model-bridge step whose tool list leaves the publishing tool out is not a publishing call", async () => {
    const flow = linkedinShape();
    const publish = flow.$referenced_components.publish!;
    setPublishes(publish, false);
    (cinatraOf(publish) as Json).tools = ["artifacts_get"];
    expect(await checkFixture(flow, CONSUMES_POST)).toEqual([]);
  });

  it("(b) a model-bridge step that lists the post tool without the declaration is refused", async () => {
    const flow = linkedinShape();
    const publish = flow.$referenced_components.publish!;
    setPublishes(publish, undefined);
    (cinatraOf(publish) as Json).tools = ["linkedin_post_publish"];
    expect(await checkFixture(flow)).toEqual(["UNDECLARED publish: publish lists the publishing tool linkedin_post_publish"]);
  });

  it("(a) a passthrough step that calls the post tool without the declaration is refused; declared, it passes", async () => {
    const flow = linkedinShape();
    const publish = flow.$referenced_components.publish!;
    publish.url = "{{CINATRA_BASE_URL}}/api/agents/passthrough";
    publish.data = { tool: "linkedin_post_publish", input: "{}", agent_run_id: "{{cinatra_run_id}}" };
    setPublishes(publish, undefined);
    expect(await checkFixture(flow)).toEqual(["UNDECLARED publish: publish calls the publishing tool linkedin_post_publish"]);
    setPublishes(publish, true);
    expect(await checkFixture(flow)).toEqual([]);
  });

  it("a passthrough step that calls a tool outside the outward-effect set needs no declaration", async () => {
    const flow = linkedinShape();
    const publish = flow.$referenced_components.publish!;
    publish.url = "{{CINATRA_BASE_URL}}/api/agents/passthrough";
    publish.data = { tool: "artifacts_get", input: "{}", agent_run_id: "{{cinatra_run_id}}" };
    setPublishes(publish, undefined);
    expect(await checkFixture(flow)).toEqual([]);
  });

  it("a publishing call inside a subflow needs the declaration on the top-level node that holds it", async () => {
    const reasons = publishingCallsUnder(
      { component_type: "FlowNode", id: "wrap", subflow: { $component_ref: "inner" } },
      { inner: { component_type: "Flow", nodes: [{ component_type: "ApiNode", id: "post", url: "{{CINATRA_BASE_URL}}/api/agents/passthrough", data: { tool: "linkedin_post_publish" } }] } },
      [],
    );
    expect(reasons).toEqual(["post calls the publishing tool linkedin_post_publish"]);
    const oas: Json = {
      nodes: [{ $component_ref: "wrap" }],
      $referenced_components: {
        wrap: { component_type: "FlowNode", id: "wrap", subflow: { $component_ref: "inner" } },
        inner: { component_type: "Flow", nodes: [{ component_type: "ApiNode", id: "post", url: "{{CINATRA_BASE_URL}}/api/agents/passthrough", data: { tool: "linkedin_post_publish" } }] },
      },
    };
    expect(publishingFindings({ oas, pkg: {}, rawSource: JSON.stringify(oas), publishingSteps: [] })).toEqual([
      "UNDECLARED wrap: post calls the publishing tool linkedin_post_publish",
    ]);
  });

  it("a declared step whose call goes past the host's routes is refused, by the compiler and by the executed-source check", async () => {
    const flow = linkedinShape();
    flow.$referenced_components.publish!.url = "https://api.linkedin.example/v2/posts";
    const findings = await checkFixture(flow, CONSUMES_POST);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatch(/^COMPILE PUBLISH_CALL_UNCHECKED: /);
    const raw = JSON.stringify(flow);
    expect(publishingFindings({ oas: flow as unknown as Json, pkg: CONSUMES_POST, rawSource: raw, publishingSteps: ["publish"] })).toEqual([
      expect.stringMatching(/^UNCHECKED_CALL PUBLISH_CALL_UNCHECKED: /),
    ]);
  });

  it("a declared step that no control edge reaches cannot be put behind the gate", async () => {
    const flow = linkedinShape();
    const raw = JSON.stringify(flow);
    const oas = JSON.parse(raw) as Json & { control_flow_connections: Json[] };
    oas.control_flow_connections = oas.control_flow_connections.filter((e) => (e.to_node as Ref).$component_ref !== "publish");
    expect(publishingFindings({ oas, pkg: CONSUMES_POST, rawSource: raw, publishingSteps: ["publish"] })).toEqual([
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
 * until its entry is removed.
 */
const PINNED_PACKS_NOT_YET_MET: Record<string, { pin: string; findings: string[] }> = {
  // Pinned before its publishing step was declared (pack PRs #65-#67 declare it; the app pin has not moved).
  "@cinatra-ai/blog-linkedin-publish-agent": {
    pin: "11753d6c4590e05ab0291e2c5309ba0239a50619",
    findings: ["UNDECLARED publish: publish has no tool list and the pack consumes the publishing tool linkedin_post_publish"],
  },
  // Sends mail through a declared step tool and has not declared the step publishing; its prepare step has no tool
  // list in a pack that consumes the send tool.
  "@cinatra-ai/email-delivery-agent": {
    pin: "bf578fce2091224e3fd4ba7adde0dd91f036cdbb",
    findings: [
      "UNDECLARED prepare: prepare has no tool list and the pack consumes the publishing tool email_outreach_send_initial_start",
      "UNDECLARED send: send lists the publishing tool email_outreach_send_initial_start",
    ],
  },
  // Sends the test mail through a passthrough step and has not declared the step publishing.
  "@cinatra-ai/email-test-delivery-agent": {
    pin: "1afddbaa75b5f1e77081c5713fe49933039894a3",
    findings: ["UNDECLARED perform_test_send: perform_test_send calls the publishing tool email_test_delivery_run_send"],
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

/** Every installed agent pack with a flow: `extensions/<scope>/<name>/{package.json,cinatra/oas.json}`. */
function installedAgentPacks(): Array<{ packageName: string; oasFile: string; pkg: Json }> {
  const extRoot = path.join(REPO_ROOT, "extensions");
  const out: Array<{ packageName: string; oasFile: string; pkg: Json }> = [];
  if (!existsSync(extRoot)) return out;
  for (const scope of readdirSync(extRoot, { withFileTypes: true })) {
    if (!scope.isDirectory()) continue;
    for (const dir of readdirSync(path.join(extRoot, scope.name), { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const pkgFile = path.join(extRoot, scope.name, dir.name, "package.json");
      const oasFile = path.join(extRoot, scope.name, dir.name, "cinatra", "oas.json");
      if (!existsSync(pkgFile) || !existsSync(oasFile)) continue;
      const pkg = JSON.parse(readFileSync(pkgFile, "utf8")) as Json;
      if (!isObject(pkg.cinatra) || pkg.cinatra.kind !== "agent") continue;
      out.push({ packageName: String(pkg.name), oasFile, pkg });
    }
  }
  return out.sort((a, b) => a.packageName.localeCompare(b.packageName));
}

const REQUIRE_EXTENSIONS = process.env.CINATRA_REQUIRE_EXTENSIONS === "1";
const PACKS = installedAgentPacks();

describe.skipIf(PACKS.length === 0 && !REQUIRE_EXTENSIONS)("item 7: every pinned agent pack's publishing actions sit behind the moment", () => {
  it("reads the installed agent packs (the universe is not empty)", () => {
    expect(PACKS.length, "CINATRA_REQUIRE_EXTENSIONS=1 but no agent pack with a flow is installed: the sync did not run").toBeGreaterThan(0);
  });

  it("each pack compiles, declares every node that publishes, and every declared step sits behind the gate", async () => {
    const pins = lockedPins();
    const results: Record<string, string[]> = {};
    for (const p of PACKS) {
      const findings = await check(p.packageName, p.oasFile, p.pkg);
      const known = PINNED_PACKS_NOT_YET_MET[p.packageName];
      const knownApplies = known !== undefined && (known.pin === pins.get(p.packageName));
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

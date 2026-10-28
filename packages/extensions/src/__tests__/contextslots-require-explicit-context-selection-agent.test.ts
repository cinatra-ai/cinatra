/**
 * Repo-wide invariant for context resolution.
 *
 * Every agent OAS that declares a non-empty `metadata.cinatra.contextSlots`
 * MUST carry real context-resolution wiring for EVERY declared slot:
 *   (1) the package manifest declares an install-blocking runtime dependency on
 *       `@cinatra-ai/context-selection-agent`, read through the host's own
 *       dependency reader (see the vocabulary note below).
 *   (2) Each slot is resolved either by an explicit, author-placed
 *       `context_<slot>` FlowNode whose inlined subflow is the real
 *       context-resolution subflow (an ApiNode hits `/api/context-resolve`),
 *       or — declaration-only — by the node the loader injects at mount (see
 *       "DECLARATION-ONLY SLOTS" below).
 *   (3) An author-placed FlowNode's `contextSlotBindings` output is
 *       DataFlowEdge-wired into a downstream node's binding input, replacing
 *       the inert `start.contextSlotBindings → consumer` bypass. The input is
 *       named as the loader names it (see "THE BINDING INPUT'S NAME" below).
 *   (4) Node order: the context FlowNode is BEFORE its consumer.
 *
 * Plus anti-stub assertions:
 *   - NO top-level `start.contextSlotBindings → consumer` bypass on any
 *     contextSlots leaf.
 *   - NO `start.contextRefs → end.contextRefs` pass-through stub on any agent.
 *   - INTERACTIVE selectors that list `context-selector` in `hitlScreens`
 *     must also have a real context FlowNode, or a declaration-only slot the
 *     loader-injected node covers (renderer is wired, not just declared).
 *
 * DEPENDENCY VOCABULARY (cinatra#2455). (1) used to read
 * `pkg.cinatra.agentDependencies[...]` directly. That npm-style map is the
 * LEGACY agent-package vocabulary; the canonical declaration is
 * `cinatra.dependencies: ExtensionDependency[]` (canonical-types.ts), and
 * `manifest-dependencies.ts` — the single reader EVERY install path uses to turn
 * a verified manifest into the edges persisted on the canonical
 * `installed_extension` row — dual-reads both, canonical winning. 111 of 111
 * companion manifests now declare the canonical array; 4 still carry the legacy
 * map alongside it; `email-outreach-agent` carries only the canonical one and so
 * failed a check that had nothing to do with its context wiring. Reading through
 * `parseManifestDependencyEdges` makes this assert what the HOST resolves rather
 * than which spelling the manifest happens to use, and it tightens the claim
 * from "the key is truthy" to "an install-blocking runtime edge exists".
 *
 * THE BINDING INPUT'S NAME (cinatra#4314). This gate used to require the literal
 * destination `contextSlotBindings` on every agent. The WayFlow loader accepts a
 * consumer input titled `contextSlotBindings` only when the definition declares
 * exactly one slot, and `<slotId>ContextSlotBindings` always
 * (docker/wayflow/context_subflow_injection.py:604-614). It refuses the bare name
 * in a multi-slot definition (:663-669), and the parent-satisfied hand-down
 * always writes the qualified name (:832). So a single-slot agent may use either
 * name, and a multi-slot agent must use the qualified name of the slot the
 * FlowNode resolves; a multi-slot agent therefore names each FlowNode
 * `context_<slotId>`, the loader's own id grammar.
 *
 * DECLARATION-ONLY SLOTS (cinatra#1194, cinatra#3032, cinatra#4314). Since
 * cinatra#1194 an author may declare a slot and place no subflow for it: the
 * loader injects the canonical context-resolution subflow at mount
 * (context_subflow_injection.py:1-4), and a parent that satisfies the slot hands
 * its pick down instead (cinatra#3032). The hand-down REQUIRES the parent's slot
 * to be injected, not author-placed (:954-973). Such a slot counts as covered by
 * the injected node only when ALL of these hold, and fails otherwise:
 *   - the agent declares the required runtime context-selection-agent edge of (1);
 *   - a work node (never the StartNode) declares the input the loader feeds; and
 *   - no DataFlowEdge already feeds that input (the loader refuses to
 *     double-wire, :674-680).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

import { parseManifestDependencyEdges } from "../manifest-dependencies";

const EXT = join(__dirname, "..", "..", "..", "..", "extensions");

const CONTEXT_SELECTION_AGENT = "@cinatra-ai/context-selection-agent";

/** The context-selection edge as the host's own reader resolves it — an
 *  install-blocking runtime requirement, in either manifest vocabulary. */
function contextSelectionEdge(pkg: unknown) {
  return parseManifestDependencyEdges(pkg).edges.find(
    (e) => e.packageName === CONTEXT_SELECTION_AGENT,
  );
}

type OasFile = { scope: string; agent: string; oasPath: string; pkgPath: string };

function discoverAgentOas(): OasFile[] {
  const out: OasFile[] = [];
  for (const scope of readdirSync(EXT)) {
    const scopeDir = join(EXT, scope);
    let agents: string[];
    try {
      agents = readdirSync(scopeDir);
    } catch {
      continue;
    }
    for (const agent of agents) {
      const oasPath = join(scopeDir, agent, "cinatra", "oas.json");
      const pkgPath = join(scopeDir, agent, "package.json");
      if (existsSync(oasPath) && existsSync(pkgPath)) {
        out.push({ scope, agent, oasPath, pkgPath });
      }
    }
  }
  return out;
}

const ALL = discoverAgentOas();

type Ref = Record<string, unknown>;
function refs(oas: Ref): Record<string, Ref> {
  return ((oas["$referenced_components"] as Record<string, Ref>) ?? {});
}
function nodeOrder(oas: Ref): string[] {
  return (((oas.nodes as Array<{ "$component_ref"?: string }>) ?? [])
    .map((n) => n["$component_ref"]).filter(Boolean)) as string[];
}
function dfes(oas: Ref): Array<Ref> {
  return ((oas.data_flow_connections as Array<Ref>) ?? []);
}

/** Detect a context FlowNode by structural signal: its subflow contains an
 *  ApiNode whose url IS the context-resolve endpoint. Independent of metadata
 *  tags, so it survives vendoring metadata trimming. Matched by EXACT equality
 *  (cinatra#2455): a substring test would classify a decoy such as
 *  `{{CINATRA_BASE_URL}}/api/context-resolve-noop`, or an off-host origin, as
 *  real context resolution. */
const CONTEXT_RESOLVE_URL = "{{CINATRA_BASE_URL}}/api/context-resolve";

function isContextFlowNode(oas: Ref, component: Ref): boolean {
  if (component.component_type !== "FlowNode") return false;
  const subRef = (component.subflow as { "$component_ref"?: string } | undefined)?.["$component_ref"];
  if (!subRef) return false;
  const sub = refs(oas)[subRef];
  if (!sub || sub.component_type !== "Flow") return false;
  const subRefs = ((sub["$referenced_components"] as Record<string, Ref>) ?? {});
  for (const c of Object.values(subRefs)) {
    if (c.component_type === "ApiNode" && c.url === CONTEXT_RESOLVE_URL) {
      return true;
    }
  }
  return false;
}

type SlotDecl = { slotId: string; selectionMode?: string };

function declaredSlots(oas: Ref): SlotDecl[] {
  const slots = (oas.metadata as { cinatra?: { contextSlots?: unknown } } | undefined)?.cinatra?.contextSlots;
  return Array.isArray(slots) ? (slots as SlotDecl[]) : [];
}

/** The binding input names the loader accepts for `slotId` (see "THE BINDING
 *  INPUT'S NAME"): the bare name only in a single-slot definition. */
function bindingInputsFor(slotIds: string[], slotId: string): string[] {
  const qualified = `${slotId}ContextSlotBindings`;
  return slotIds.length === 1 ? ["contextSlotBindings", qualified] : [qualified];
}

function hasRequiredContextSelectionEdge(pkg: unknown): boolean {
  const edge = contextSelectionEdge(pkg);
  return !!edge && edge.edgeType === "runtime" && edge.requirement === "required";
}

/** Why a declaration-only slot is NOT covered by the loader-injected node; an
 *  empty list means it is covered (see "DECLARATION-ONLY SLOTS"). */
function injectedCoverageProblems(oas: Ref, pkg: unknown, slotId: string, slotIds: string[]): string[] {
  const problems: string[] = [];
  if (!hasRequiredContextSelectionEdge(pkg)) {
    problems.push(
      `declaration-only slot ${slotId} counts as covered by the injected node only with a required runtime ${CONTEXT_SELECTION_AGENT} edge`,
    );
  }
  const names = bindingInputsFor(slotIds, slotId);
  const all = refs(oas);
  const startRef = (oas.start_node as { "$component_ref"?: string } | undefined)?.["$component_ref"] ?? "start";
  const consumers: Array<[string, string]> = [];
  for (const id of nodeOrder(oas)) {
    const c = all[id];
    if (!c || id === startRef || c.component_type === "Flow") continue;
    const titles = ((c.inputs as Array<{ title?: unknown }> | null | undefined) ?? []).map((i) => i.title);
    for (const n of names) if (titles.includes(n)) consumers.push([id, n]);
  }
  if (consumers.length === 0) {
    problems.push(`declaration-only slot ${slotId} has no consumer: no work node declares ${names.join(" or ")}`);
  }
  for (const [id, n] of consumers) {
    const fed = dfes(oas).some(
      (e) =>
        (e.destination_node as { "$component_ref"?: string } | undefined)?.["$component_ref"] === id
        && e.destination_input === n,
    );
    if (fed) problems.push(`${id}.${n} is already fed by a DataFlowEdge; the loader refuses to double-wire it`);
  }
  return problems;
}

/** Every reason the agent's context wiring is not real; empty means it is. */
function wiringProblems(oas: Ref, pkg: unknown): string[] {
  const problems: string[] = [];
  const edge = contextSelectionEdge(pkg);
  if (!edge) {
    problems.push(`must declare a ${CONTEXT_SELECTION_AGENT} dependency edge`);
  } else {
    // Install-blocking, not merely present: a peer/optional edge would let the
    // slot resolve against a sub-agent that was never installed.
    if (edge.edgeType !== "runtime") problems.push(`the ${CONTEXT_SELECTION_AGENT} edge must be runtime, not ${edge.edgeType}`);
    if (edge.requirement !== "required") problems.push(`the ${CONTEXT_SELECTION_AGENT} edge must be required, not ${edge.requirement}`);
  }

  const slotIds = declaredSlots(oas).map((s) => s.slotId);
  const all = refs(oas);
  const order = nodeOrder(oas);
  const edges = dfes(oas);
  const authorPlaced = new Set<string>();

  for (const [fnId, fn] of Object.entries(all).filter(([, c]) => isContextFlowNode(oas, c))) {
    const subRef = (fn.subflow as { "$component_ref"?: string } | undefined)?.["$component_ref"];
    const sub = all[subRef!];
    const subOut = ((sub.outputs as Array<{ title: string }> | null | undefined) ?? []).map((o) => o.title);
    if (!subOut.includes("contextSlotBindings")) {
      problems.push(`${fnId}.subflow outputs must include contextSlotBindings (not contextRefs)`);
    }
    if (subOut.includes("contextRefs")) problems.push(`${fnId}: the contextRefs stub output is forbidden`);

    const slotId = slotIds.length === 1 ? slotIds[0] : slotIds.find((id) => fnId === `context_${id}`);
    if (slotId === undefined) {
      problems.push(`${fnId} resolves no declared slot: a multi-slot agent names each context FlowNode context_<slotId>`);
      continue;
    }
    authorPlaced.add(slotId);

    const names = bindingInputsFor(slotIds, slotId);
    const bindEdge = edges.find(
      (e) =>
        (e.source_node as { "$component_ref"?: string } | undefined)?.["$component_ref"] === fnId
        && e.source_output === "contextSlotBindings"
        && names.includes(e.destination_input as string),
    );
    if (!bindEdge) {
      problems.push(`${fnId}.contextSlotBindings must feed a consumer's ${names.join(" or ")}`);
      continue;
    }
    const consumer = (bindEdge.destination_node as { "$component_ref"?: string })["$component_ref"];
    const ci = order.indexOf(fnId);
    const cj = order.indexOf(consumer!);
    if (ci < 0) problems.push(`${fnId} is not in the node order`);
    if (!(cj > ci)) problems.push(`${fnId} must come before its consumer ${consumer}`);
  }

  for (const slotId of slotIds) {
    if (!authorPlaced.has(slotId)) problems.push(...injectedCoverageProblems(oas, pkg, slotId, slotIds));
  }
  return problems;
}

/** A context FlowNode, or a declaration-only slot the injected node covers. */
function hasContextResolution(oas: Ref, pkg: unknown): boolean {
  const all = refs(oas);
  if (Object.values(all).some((c) => isContextFlowNode(oas, c))) return true;
  const slotIds = declaredSlots(oas).map((s) => s.slotId);
  return slotIds.some((id) => injectedCoverageProblems(oas, pkg, id, slotIds).length === 0);
}

describe("every contextSlots agent carries explicit context-resolution wiring", () => {
  it("discovers agent OAS files", () => {
    expect(ALL.length).toBeGreaterThan(0);
  });

  const slotted = ALL.filter((f) => {
    try {
      const oas = JSON.parse(readFileSync(f.oasPath, "utf8"));
      const slots = oas?.metadata?.cinatra?.contextSlots;
      return Array.isArray(slots) && slots.length > 0;
    } catch {
      return false;
    }
  });

  it("covers representative contextSlots agents", () => {
    const names = slotted.map((f) => f.agent);
    expect(names).toEqual(
      expect.arrayContaining([
        "email-outreach-agent",
        "blog-idea-generator-agent",
        "blog-draft-writer-agent",
        "blog-image-generator-agent",
      ]),
    );
  });

  for (const f of slotted) {
    it(`${f.scope}/${f.agent}: declares dep + explicit context FlowNode + contextSlotBindings producer`, () => {
      const oas = JSON.parse(readFileSync(f.oasPath, "utf8")) as Ref;
      const pkg = JSON.parse(readFileSync(f.pkgPath, "utf8")) as Ref;
      expect(wiringProblems(oas, pkg)).toEqual([]);
    });
  }
});

describe("anti-stub: no inert bypass / no contextRefs stub", () => {
  for (const f of ALL) {
    const oas = JSON.parse(readFileSync(f.oasPath, "utf8")) as Ref;
    const pkg = JSON.parse(readFileSync(f.pkgPath, "utf8")) as Ref;
    const slots = (oas.metadata as { cinatra?: { contextSlots?: unknown[] } } | undefined)?.cinatra?.contextSlots;
    const hasSlots = Array.isArray(slots) && slots.length > 0;
    const hitlScreens =
      (oas.metadata as { cinatra?: { hitlScreens?: string[] } } | undefined)?.cinatra?.hitlScreens ?? [];

    if (hasSlots) {
      it(`${f.scope}/${f.agent}: NO top-level start.contextSlotBindings → consumer bypass`, () => {
        const edges = dfes(oas);
        const bypass = edges.find(
          (e) =>
            (e.source_node as { "$component_ref"?: string } | undefined)?.["$component_ref"] === "start"
            && e.source_output === "contextSlotBindings"
            && e.destination_input === "contextSlotBindings",
        );
        expect(bypass, "the inert start.contextSlotBindings bypass is forbidden at top-level").toBeFalsy();
      });
    }

    it(`${f.scope}/${f.agent}: NO start.contextRefs → end.contextRefs stub`, () => {
      const edges = dfes(oas);
      const stub = edges.find(
        (e) =>
          (e.source_node as { "$component_ref"?: string } | undefined)?.["$component_ref"] === "start"
          && e.source_output === "contextRefs"
          && (e.destination_node as { "$component_ref"?: string } | undefined)?.["$component_ref"] === "end"
          && e.destination_input === "contextRefs",
      );
      expect(stub, "the start.contextRefs → end.contextRefs pass-through stub is forbidden").toBeFalsy();
    });

    const isInteractiveSelector = hasSlots
      && (slots as Array<{ selectionMode?: string }>).some(
        (s) => (s.selectionMode ?? "interactive") === "interactive",
      )
      && hitlScreens.includes("@cinatra-ai/context-selection-agent:context-selector");
    if (isInteractiveSelector) {
      it(`${f.scope}/${f.agent}: interactive context-selector hitlScreen must be backed by a context FlowNode`, () => {
        // A context FlowNode, or (cinatra#4314) a declaration-only slot that the
        // loader-injected node covers under the rules of "DECLARATION-ONLY SLOTS".
        expect(hasContextResolution(oas, pkg)).toBe(true);
      });
    }
  }
});

/* ------------------------------------------------------------------------- *
 * The amended rules still refuse (cinatra#4314). Synthetic definitions, so the
 * refusals do not move with the pins.
 * ------------------------------------------------------------------------- */

const CTX_PKG = {
  cinatra: {
    dependencies: [
      {
        packageName: CONTEXT_SELECTION_AGENT,
        edgeType: "runtime",
        requirement: "required",
        kind: "agent",
        versionConstraint: { kind: "semver-range", range: "^0.1.0" },
      },
    ],
  },
};
const NO_CTX_PKG = { cinatra: { dependencies: [] } };

const ref = (id: string) => ({ $component_ref: id });
const dfe = (src: string, out: string, dst: string, inp: string) => ({
  component_type: "DataFlowEdge",
  name: `${src}_${out}_${dst}_${inp}`,
  source_node: ref(src),
  source_output: out,
  destination_node: ref(dst),
  destination_input: inp,
});
const contextSubflow = (slotId: string) => ({
  component_type: "Flow",
  id: `context-${slotId}-subflow`,
  outputs: [{ title: "contextSlotBindings", type: "string" }],
  $referenced_components: {
    [`ctx-${slotId}-resolve_context`]: {
      component_type: "ApiNode",
      url: CONTEXT_RESOLVE_URL,
    },
  },
});

/** A synthetic agent: `placed` slots get an author-placed context FlowNode
 *  feeding `work.<input>`; every other slot is declaration-only and is
 *  consumed by `work.<slotId>ContextSlotBindings`. */
function agent(slotIds: string[], placed: Record<string, string>): Ref {
  const components: Record<string, Ref> = {
    start: { component_type: "StartNode", id: "start", inputs: [] },
    end: { component_type: "EndNode", id: "end", inputs: [] },
  };
  const inputs: Array<{ title: string }> = [];
  const edges: Ref[] = [];
  const nodes = ["start"];
  for (const [slotId, input] of Object.entries(placed)) {
    components[`context_${slotId}`] = { component_type: "FlowNode", subflow: ref(`context-${slotId}-subflow`) };
    components[`context-${slotId}-subflow`] = contextSubflow(slotId);
    nodes.push(`context_${slotId}`);
    inputs.push({ title: input });
    edges.push(dfe(`context_${slotId}`, "contextSlotBindings", "work", input));
  }
  for (const slotId of slotIds) {
    if (!(slotId in placed)) inputs.push({ title: `${slotId}ContextSlotBindings` });
  }
  components.work = { component_type: "ApiNode", id: "work", url: "{{CINATRA_BASE_URL}}/api/llm-bridge", inputs };
  nodes.push("work", "end");
  return {
    metadata: { cinatra: { contextSlots: slotIds.map((slotId) => ({ slotId, selectionMode: "interactive" })) } },
    start_node: ref("start"),
    nodes: nodes.map(ref),
    $referenced_components: components,
    data_flow_connections: edges,
  };
}

describe("the amended context-wiring rules still refuse (cinatra#4314)", () => {
  it("accepts the loader's own shapes", () => {
    expect(wiringProblems(agent(["a"], { a: "contextSlotBindings" }), CTX_PKG)).toEqual([]);
    expect(wiringProblems(agent(["a"], { a: "aContextSlotBindings" }), CTX_PKG)).toEqual([]);
    expect(wiringProblems(agent(["a", "b"], { a: "aContextSlotBindings" }), CTX_PKG)).toEqual([]);
    expect(wiringProblems(agent(["a"], {}), CTX_PKG)).toEqual([]);
  });

  it("refuses the bare name in a multi-slot agent", () => {
    expect(wiringProblems(agent(["a", "b"], { a: "contextSlotBindings" }), CTX_PKG)).toEqual([
      "context_a.contextSlotBindings must feed a consumer's aContextSlotBindings",
    ]);
  });

  it("refuses the qualified name of another slot", () => {
    expect(wiringProblems(agent(["a", "b"], { a: "bContextSlotBindings" }), CTX_PKG)).toContain(
      "context_a.contextSlotBindings must feed a consumer's aContextSlotBindings",
    );
    expect(wiringProblems(agent(["a"], { a: "bContextSlotBindings" }), CTX_PKG)).toEqual([
      "context_a.contextSlotBindings must feed a consumer's contextSlotBindings or aContextSlotBindings",
    ]);
  });

  it("refuses a declaration-only slot without the context-selection edge", () => {
    expect(wiringProblems(agent(["a"], {}), NO_CTX_PKG)).toEqual([
      `must declare a ${CONTEXT_SELECTION_AGENT} dependency edge`,
      `declaration-only slot a counts as covered by the injected node only with a required runtime ${CONTEXT_SELECTION_AGENT} edge`,
    ]);
    const optional = {
      cinatra: { dependencies: [{ ...CTX_PKG.cinatra.dependencies[0], requirement: "optional" }] },
    };
    expect(wiringProblems(agent(["a", "b"], { a: "aContextSlotBindings" }), optional)).toContain(
      `declaration-only slot b counts as covered by the injected node only with a required runtime ${CONTEXT_SELECTION_AGENT} edge`,
    );
    expect(hasContextResolution(agent(["a"], {}), NO_CTX_PKG)).toBe(false);
  });

  it("refuses a declaration-only slot that nothing consumes, or whose input is already fed", () => {
    const orphan = agent(["a"], {});
    (orphan.$referenced_components as Record<string, Ref>).work.inputs = [];
    expect(wiringProblems(orphan, CTX_PKG)).toEqual([
      "declaration-only slot a has no consumer: no work node declares contextSlotBindings or aContextSlotBindings",
    ]);
    expect(hasContextResolution(orphan, CTX_PKG)).toBe(false);

    const fed = agent(["a"], {});
    (fed.data_flow_connections as Ref[]).push(dfe("start", "aContextSlotBindings", "work", "aContextSlotBindings"));
    expect(wiringProblems(fed, CTX_PKG)).toEqual([
      "work.aContextSlotBindings is already fed by a DataFlowEdge; the loader refuses to double-wire it",
    ]);
  });

  it("refuses a context FlowNode that names no declared slot in a multi-slot agent", () => {
    const doc = agent(["a", "b"], { a: "aContextSlotBindings" });
    const all = doc.$referenced_components as Record<string, Ref>;
    all.resolve_a = all.context_a;
    delete all.context_a;
    doc.nodes = (doc.nodes as Array<{ $component_ref: string }>).map((n) =>
      n.$component_ref === "context_a" ? ref("resolve_a") : n,
    );
    expect(wiringProblems(doc, CTX_PKG)).toContain(
      "resolve_a resolves no declared slot: a multi-slot agent names each context FlowNode context_<slotId>",
    );
  });
});

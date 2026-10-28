/**
 * Repo-wide invariant for context resolution.
 *
 * Every agent OAS that declares a non-empty `metadata.cinatra.contextSlots`
 * MUST carry real context-resolution wiring for EVERY declared slot:
 *   (1) the package manifest declares an install-blocking runtime dependency on
 *       `@cinatra-ai/context-selection-agent`, read through the host's own
 *       dependency reader (see the vocabulary note below).
 *   (2) Each slot is resolved either by an explicit, author-placed context
 *       FlowNode whose inlined subflow is the real context-resolution subflow
 *       (an ApiNode hits `/api/context-resolve`) and which the loader knows
 *       by its marker (see "THE SLOT A NODE RESOLVES" below), or —
 *       declaration-only — by the node the loader injects at mount (see
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
 *   - a present `contextSlots` value the loader refuses is refused here too
 *     (see "WHAT THE LOADER REFUSES" below).
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
 * FlowNode resolves.
 *
 * THE SLOT A NODE RESOLVES (cinatra#4314). The loader knows an author-placed
 * node by its marker, `metadata.cinatra.purpose` =
 * `author-placed-context-resolution-for-<slotId>` (or the
 * `loader-injected-` form), read on the definition's own nodes and never in
 * a nested definition (:56-57, :394-429); it never reads the node's id. A
 * marked slot gets no injected node. This gate maps a context FlowNode to
 * its slot by the same marker. An unmarked context FlowNode in a single-slot
 * agent is read as that slot's node for the edge and order checks, but its
 * slot stays declaration-only, as the loader sees it; one in a multi-slot
 * agent, or one whose marker names no declared slot, is refused. A component
 * reference is read in both forms the loader reads, a plain string and
 * `{ "$component_ref": … }` (:534-538), in `start_node`, `nodes`, the
 * subflow, the control edges and the data edges.
 *
 * DECLARATION-ONLY SLOTS (cinatra#1194, cinatra#3032, cinatra#4314). Since
 * cinatra#1194 an author may declare a slot and place no subflow for it: the
 * loader injects the canonical context-resolution subflow at mount
 * (context_subflow_injection.py:1-4), and a parent that satisfies the slot hands
 * its pick down instead (cinatra#3032). The hand-down REQUIRES the parent's slot
 * to be injected, not author-placed (:954-973). Such a slot counts as covered by
 * the injected node only when ALL of these hold, and fails otherwise:
 *   - the agent declares the required runtime context-selection-agent edge of (1);
 *   - a work node declares the input the loader feeds. The StartNode never
 *     counts: the loader excludes it only on the parent-satisfied road
 *     (:903-909), and this gate asks for a work node on both roads;
 *   - no DataFlowEdge already feeds that input (the loader refuses to
 *     double-wire, :674-680); and
 *   - no node trips one of the loader's two mount refusals: a component that
 *     declares both `contextSlotBindings` and `<slotId>ContextSlotBindings`
 *     (:655-659), or, in a multi-slot agent, any component that declares the
 *     bare `contextSlotBindings` (:663-669).
 *   - the loader can inject into the definition at all (:975-1027): an owner
 *     package is found, from the definition's own
 *     `metadata.cinatra.packageName` and every FlowNode whose subflow names
 *     it, and exactly one (:475-526); the definition has
 *     `$referenced_components`, `nodes`, `control_flow_connections` and a
 *     `start_node` that is defined (:980-1000); `data_flow_connections`, if
 *     present, is an array (:1001-1005); the StartNode has an outgoing
 *     control edge (:1007-1016); and no id the injection adds
 *     (`context-<slotId>-subflow`, `context_<slotId>`, `ctx-<slotId>-<kind>`,
 *     :185-201) is already an id or a `$referenced_components` key anywhere
 *     in the document (:370-391, :1018-1027); and the hidden inputs the
 *     loader adds for each such slot (`cinatra_run_id`, `projectId`,
 *     `<slotId>ParentPackageName`, `<slotId>SlotId`) fit the definition and
 *     its StartNode: `inputs`, where present, is an array, and an input of
 *     the same title is a string, whose default is the owner package or the
 *     slot id for the last two (`_ensure_input`, :541-591, called at
 *     :1054-1063).
 * The anti-stub hitlScreen case below accepts such a covered slot as the
 * renderer's backing, as it accepts a context FlowNode.
 *
 * WHAT THE LOADER REFUSES (cinatra#4314). A present `contextSlots` value is
 * executable input: the loader refuses the mount on its first malformed
 * entry (`_validate_declared_slots`, :240-306). It must be an array of
 * objects with only the keys `slotId`, `acceptedArtifactExtensions`,
 * `selectionMode`, `resolutionMode`, `minItems`, `maxItems` and
 * `readableOnly`; a non-empty `slotId` without the template token, and no
 * duplicate; a non-empty array of non-empty `acceptedArtifactExtensions`; a
 * `selectionMode` and a `resolutionMode` from their sets; an integral
 * `minItems` >= 0 and `maxItems` >= 1 that are in order; a boolean
 * `readableOnly`. This gate refuses the same, on every road. It reads a
 * count as a JavaScript number, so it refuses a count outside the safe
 * integer range, which the loader, reading the JSON's exact integers, may
 * accept: there this gate is stricter than the loader.
 *
 * WHAT THIS GATE DOES NOT MODEL. It reads the root definition only, and it
 * does not model `parentSatisfiedContextSlots` (:309-362, :709-913): a slot a
 * parent satisfies is checked here as if the loader injected it. The
 * refusals it models are those of the root definition's own injection
 * (`_validate_declared_slots` and `_inject_into_definition` with the
 * functions it calls); a nested definition's own slots and the
 * parent-satisfied hand-down are not read.
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
function isObject(x: unknown): x is Ref {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
function refs(oas: Ref): Record<string, Ref> {
  return ((oas["$referenced_components"] as Record<string, Ref>) ?? {});
}
/** A component reference in either form the loader reads: a plain string, or
 *  `{ "$component_ref": "<id>" }` (`_component_ref`,
 *  context_subflow_injection.py:534-538). */
function componentRef(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (isObject(value)) {
    const r = value["$component_ref"];
    return typeof r === "string" ? r : undefined;
  }
  return undefined;
}
function nodeOrder(oas: Ref): string[] {
  const nodes = oas.nodes;
  return Array.isArray(nodes)
    ? nodes.map(componentRef).filter((r): r is string => r !== undefined)
    : [];
}
function dfes(oas: Ref): Array<Ref> {
  const edges = oas.data_flow_connections;
  return Array.isArray(edges) ? (edges.filter(isObject) as Ref[]) : [];
}
function metadataCinatra(node: Ref): Ref | undefined {
  const meta = node.metadata;
  if (!isObject(meta)) return undefined;
  return isObject(meta.cinatra) ? meta.cinatra : undefined;
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
  const subRef = componentRef(component.subflow);
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
  const slots = metadataCinatra(oas)?.contextSlots;
  return Array.isArray(slots) ? (slots.filter(isObject) as SlotDecl[]) : [];
}

/* The loader's reading of a PRESENT contextSlots value
 * (`_validate_declared_slots`, context_subflow_injection.py:240-306). It fails
 * the mount on the first malformed entry, so this returns at most one problem. */
const ALLOWED_SLOT_KEYS = new Set([
  "slotId",
  "acceptedArtifactExtensions",
  "selectionMode",
  "resolutionMode",
  "minItems",
  "maxItems",
  "readableOnly",
]);
const SELECTION_MODES = new Set(["interactive", "autonomous"]);
const RESOLUTION_MODES = new Set(["override", "accumulate"]);
const isIntegral = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

function slotDeclarationProblems(oas: Ref): string[] {
  const cin = metadataCinatra(oas);
  if (!cin || !("contextSlots" in cin) || cin.contextSlots === null) return [];
  const raw = cin.contextSlots;
  if (!Array.isArray(raw)) return ["metadata.cinatra.contextSlots must be an array; the loader refuses the mount"];
  const seen = new Set<string>();
  for (const [i, entry] of raw.entries()) {
    const loc = `contextSlots[${i}]`;
    const refused = (why: string) => [`${loc}: ${why}; the loader refuses the mount`];
    if (!isObject(entry)) return refused("is not an object");
    const unknown = Object.keys(entry).filter((k) => !ALLOWED_SLOT_KEYS.has(k)).sort();
    if (unknown.length > 0) return refused(`has unknown key(s) ${unknown.join(", ")}`);
    const slotId = entry.slotId;
    if (typeof slotId !== "string" || slotId === "") return refused("has a missing or empty slotId");
    if (slotId.includes("__SLOT__")) return refused("slotId contains the reserved template token");
    if (seen.has(slotId)) return refused(`duplicate slotId ${slotId}`);
    seen.add(slotId);
    const exts = entry.acceptedArtifactExtensions;
    if (!Array.isArray(exts) || exts.length === 0 || !exts.every((e) => typeof e === "string" && e !== "")) {
      return refused("acceptedArtifactExtensions must be a non-empty array of non-empty strings");
    }
    if (!SELECTION_MODES.has(entry.selectionMode as string)) return refused("invalid selectionMode");
    if (!RESOLUTION_MODES.has(entry.resolutionMode as string)) return refused("invalid resolutionMode");
    // The loader compares the JSON's integers exactly; outside the safe
    // integer range a JavaScript number is not the JSON's value, so such a
    // count is refused here, where the loader may accept it.
    for (const key of ["minItems", "maxItems"]) {
      const v = entry[key];
      if (typeof v === "number" && Number.isInteger(v) && !Number.isSafeInteger(v)) {
        return [`${loc}: ${key} is outside the safe integer range, which this gate cannot read exactly`];
      }
    }
    const min = entry.minItems;
    const max = entry.maxItems;
    if ("minItems" in entry && (!isIntegral(min) || min < 0)) return refused("invalid minItems");
    if ("maxItems" in entry && (!isIntegral(max) || max < 1)) return refused("invalid maxItems");
    if (isIntegral(min) && isIntegral(max) && min > max) return refused("minItems must be <= maxItems");
    if ("readableOnly" in entry && typeof entry.readableOnly !== "boolean") return refused("invalid readableOnly");
  }
  return [];
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

/* The loader's marker grammar (context_subflow_injection.py:56-57). */
const MARKER_PREFIXES = ["author-placed-context-resolution-for-", "loader-injected-context-resolution-for-"];
function markerOf(node: Ref): string | undefined {
  const purpose = metadataCinatra(node)?.purpose;
  if (typeof purpose !== "string") return undefined;
  for (const prefix of MARKER_PREFIXES) {
    if (purpose.startsWith(prefix) && purpose.length > prefix.length) return purpose.slice(prefix.length);
  }
  return undefined;
}
/** `_is_flow_definition` (:218-224). */
function isFlowDefinition(node: Ref): boolean {
  return typeof node.id === "string" && (
    isObject(node["$referenced_components"])
    || typeof node.start_node === "string" || isObject(node.start_node)
    || Array.isArray(node.nodes)
  );
}
/** The slots a marker carries in this definition, never in a nested definition
 *  (`_definition_local_marker_slots`, :394-429). The loader injects no subflow
 *  for these; every other declared slot is declaration-only. */
function markerSlots(oas: Ref): Set<string> {
  const slots = new Set<string>();
  const scan = (x: unknown, root: boolean): void => {
    if (Array.isArray(x)) {
      for (const v of x) scan(v, false);
      return;
    }
    if (!isObject(x)) return;
    if (!root && isFlowDefinition(x)) return;
    const slot = markerOf(x);
    if (slot !== undefined) slots.add(slot);
    for (const v of Object.values(x)) scan(v, false);
  };
  scan(oas, true);
  return slots;
}
/** Every `id` string and every `$referenced_components` key in the document
 *  (`_collect_all_ids`, :370-391). */
function allIds(doc: unknown): Set<string> {
  const ids = new Set<string>();
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) {
      for (const v of x) walk(v);
      return;
    }
    if (!isObject(x)) return;
    if (typeof x.id === "string") ids.add(x.id);
    const own = x["$referenced_components"];
    if (isObject(own)) for (const k of Object.keys(own)) ids.add(k);
    for (const v of Object.values(x)) walk(v);
  };
  walk(doc);
  return ids;
}
/** Every id the injection of `slotId` adds (`_injected_component_ids`, :185-201). */
const INJECTED_KINDS = [
  "start",
  "resolve_context",
  "select_mode",
  "emit_context_payload",
  "context_select_gate",
  "finalize_interactive",
  "finalize_autonomous",
  "end",
];
function injectedIds(slotId: string): string[] {
  return [`context-${slotId}-subflow`, `context_${slotId}`, ...INJECTED_KINDS.map((k) => `ctx-${slotId}-${k}`)];
}

/** Why the loader cannot inject the declaration-only slots `pending` into this
 *  definition at all (`_inject_into_definition`, :975-1027): no owner package
 *  (:978, `_resolve_owner_package` :475-526), an unsupported shape (:980-1005),
 *  no outgoing control edge from the StartNode (:1007-1016), an injected id
 *  that is already taken (:1018-1027), or a hidden input it cannot add
 *  (`_ensure_input`, :541-591, called at :1054-1063). Empty means it can
 *  inject. */
function injectionProblems(oas: Ref, pending: string[]): string[] {
  if (pending.length === 0) return [];
  const problems: string[] = [];
  const owners = new Set<string>();
  const own = metadataCinatra(oas)?.packageName;
  if (typeof own === "string" && own !== "") owners.add(own);
  if (typeof oas.id === "string") {
    const walk = (x: unknown): void => {
      if (Array.isArray(x)) {
        for (const v of x) walk(v);
        return;
      }
      if (!isObject(x)) return;
      const sub = x.subflow;
      if (isObject(sub) && sub["$component_ref"] === oas.id) {
        const pkg = metadataCinatra(x)?.packageName;
        if (typeof pkg === "string" && pkg !== "") owners.add(pkg);
      }
      for (const v of Object.values(x)) walk(v);
    };
    walk(oas);
  }
  if (owners.size === 0) problems.push("the loader finds no owner package for the declared slots (no metadata.cinatra.packageName)");
  if (owners.size > 1) problems.push(`the loader finds an ambiguous owner package: ${[...owners].sort().join(", ")}`);

  const all = oas["$referenced_components"];
  const cfc = oas.control_flow_connections;
  const startRef = componentRef(oas.start_node);
  if (!isObject(all) || !Array.isArray(oas.nodes) || !Array.isArray(cfc) || startRef === undefined) {
    problems.push("unsupported definition shape for injection: the loader needs $referenced_components, nodes, control_flow_connections and start_node");
    return problems;
  }
  if (!isObject(all[startRef])) problems.push(`start node ${startRef} is not defined in $referenced_components`);
  if ("data_flow_connections" in oas && !Array.isArray(oas.data_flow_connections)) {
    problems.push("data_flow_connections is not an array");
  }
  if (!cfc.some((e) => isObject(e) && componentRef(e.from_node) === startRef)) {
    problems.push(`start node ${startRef} has no outgoing control edge: the loader has nowhere to splice the context subflow`);
  }
  const taken = allIds(oas);
  const added = new Set<string>();
  for (const slotId of pending) {
    for (const id of injectedIds(slotId)) {
      if (taken.has(id) || added.has(id)) problems.push(`injected component id ${id} collides with an existing id in the document`);
      added.add(id);
    }
  }
  // The hidden inputs the loader adds for each pending slot, on the
  // definition and on its StartNode (`_ensure_input`). It reaches them only
  // with one owner package and a defined StartNode.
  const startDef = all[startRef];
  if (owners.size === 1 && isObject(startDef)) {
    const owner = [...owners][0];
    const holders: Array<[string, Ref]> = [["the definition", oas], [`start node ${startRef}`, startDef]];
    for (const [where, holder] of holders) {
      if ("inputs" in holder && !Array.isArray(holder.inputs)) {
        problems.push(`${where}: inputs is not an array; the loader refuses the injection`);
        continue;
      }
      const inputs = (holder.inputs ?? []) as unknown[];
      for (const slotId of pending) {
        const wanted: Array<[string, string | undefined]> = [
          ["cinatra_run_id", undefined],
          ["projectId", undefined],
          [`${slotId}ParentPackageName`, owner],
          [`${slotId}SlotId`, slotId],
        ];
        for (const [title, want] of wanted) {
          const existing = inputs.find((e): e is Ref => isObject(e) && e.title === title);
          if (existing === undefined) continue;
          if (existing.type !== "string") {
            problems.push(`${where}: input ${title} has type ${JSON.stringify(existing.type) ?? "none"}; the loader needs a string`);
          } else if (want !== undefined && existing.default !== want) {
            problems.push(`${where}: input ${title} has default ${JSON.stringify(existing.default) ?? "none"}; the loader needs ${JSON.stringify(want)}`);
          }
        }
      }
    }
  }
  return problems;
}

/** Why the loader-injected node does NOT cover the declaration-only slot
 *  `slotId` (see "DECLARATION-ONLY SLOTS"); an empty list means it is covered.
 *  The consumer scan mirrors `_consumer_edges_for_slot` (:594-706). */
function injectedCoverageProblems(oas: Ref, pkg: unknown, slotId: string, slotIds: string[], pending: string[]): string[] {
  const problems: string[] = [];
  if (!hasRequiredContextSelectionEdge(pkg)) {
    problems.push(
      `declaration-only slot ${slotId} counts as covered by the injected node only with a required runtime ${CONTEXT_SELECTION_AGENT} edge`,
    );
  }
  problems.push(...slotDeclarationProblems(oas), ...injectionProblems(oas, pending));
  const all = refs(oas);
  if (!isObject(all) || !Array.isArray(oas.nodes)) return problems;
  const startRef = componentRef(oas.start_node);
  const single = slotIds.length === 1;
  const qualified = `${slotId}ContextSlotBindings`;
  const inOrder = new Set(nodeOrder(oas));
  const injected = new Set(pending.flatMap(injectedIds));
  const fed = new Set(
    dfes(oas)
      .filter((e) => typeof e.destination_input === "string" && componentRef(e.destination_node) !== undefined)
      .map((e) => `${componentRef(e.destination_node)}\u0000${e.destination_input as string}`),
  );
  let consumers = 0;
  for (const [id, c] of Object.entries(all)) {
    if (injected.has(id) || !inOrder.has(id) || !isObject(c)) continue;
    if (isFlowDefinition(c) && c.component_type === "Flow") continue;
    if (!Array.isArray(c.inputs)) continue;
    const titles = new Set(c.inputs.filter(isObject).map((i) => i.title).filter((t) => typeof t === "string"));
    // The loader's two mount refusals (:655-659, :663-669) and its double-wire
    // refusal (:674-680). A refused component is still the consumer it names.
    let input: string | undefined;
    let refusal: string | undefined;
    if (titles.has("contextSlotBindings") && titles.has(qualified)) {
      refusal = `${id} declares both contextSlotBindings and ${qualified}; the loader refuses the ambiguity`;
    } else if (titles.has(qualified)) {
      input = qualified;
    } else if (titles.has("contextSlotBindings")) {
      if (single) input = "contextSlotBindings";
      else refusal = `${id} declares the bare contextSlotBindings in a multi-slot agent; the loader refuses it`;
    }
    if (refusal === undefined && input === undefined) continue;
    if (refusal !== undefined) problems.push(refusal);
    else if (fed.has(`${id}\u0000${input}`)) {
      problems.push(`${id}.${input} is already fed by a DataFlowEdge; the loader refuses to double-wire it`);
    }
    // This gate is stricter than the loader's own road: the StartNode never
    // counts as the consumer (see "DECLARATION-ONLY SLOTS").
    if (id === startRef) continue;
    consumers += 1;
  }
  if (consumers === 0) {
    problems.push(`declaration-only slot ${slotId} has no consumer: no work node declares ${bindingInputsFor(slotIds, slotId).join(" or ")}`);
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
  problems.push(...slotDeclarationProblems(oas));

  const slotIds = declaredSlots(oas).map((s) => s.slotId);
  const all = refs(oas);
  const order = nodeOrder(oas);
  const edges = dfes(oas);
  const carried = markerSlots(oas);

  for (const [fnId, fn] of Object.entries(all).filter(([, c]) => isContextFlowNode(oas, c))) {
    const subRef = componentRef(fn.subflow);
    const sub = all[subRef!];
    const subOut = ((sub.outputs as Array<{ title: string }> | null | undefined) ?? []).map((o) => o.title);
    if (!subOut.includes("contextSlotBindings")) {
      problems.push(`${fnId}.subflow outputs must include contextSlotBindings (not contextRefs)`);
    }
    if (subOut.includes("contextRefs")) problems.push(`${fnId}: the contextRefs stub output is forbidden`);

    // The loader knows an author-placed node by its marker, never by its id
    // (:394-429); an unmarked one in a single-slot agent is read as that slot's.
    const marker = markerOf(fn);
    const slotId = marker !== undefined
      ? slotIds.find((id) => id === marker)
      : slotIds.length === 1 ? slotIds[0] : undefined;
    if (slotId === undefined) {
      problems.push(`${fnId} resolves no declared slot: its metadata.cinatra.purpose marks no declared slot`);
      continue;
    }

    const names = bindingInputsFor(slotIds, slotId);
    const bindEdge = edges.find(
      (e) =>
        componentRef(e.source_node) === fnId
        && e.source_output === "contextSlotBindings"
        && names.includes(e.destination_input as string),
    );
    if (!bindEdge) {
      problems.push(`${fnId}.contextSlotBindings must feed a consumer's ${names.join(" or ")}`);
      continue;
    }
    const consumer = componentRef(bindEdge.destination_node);
    const ci = order.indexOf(fnId);
    const cj = order.indexOf(consumer!);
    if (ci < 0) problems.push(`${fnId} is not in the node order`);
    if (!(cj > ci)) problems.push(`${fnId} must come before its consumer ${consumer}`);
  }

  const pending = slotIds.filter((id) => !carried.has(id));
  for (const slotId of pending) {
    problems.push(...injectedCoverageProblems(oas, pkg, slotId, slotIds, pending));
  }
  // One message per problem: a node-wide refusal is found once per slot.
  return [...new Set(problems)];
}

/** A context FlowNode, or a declaration-only slot the injected node covers. */
function hasContextResolution(oas: Ref, pkg: unknown): boolean {
  const all = refs(oas);
  if (Object.values(all).some((c) => isContextFlowNode(oas, c))) return true;
  const slotIds = declaredSlots(oas).map((s) => s.slotId);
  const carried = markerSlots(oas);
  const pending = slotIds.filter((id) => !carried.has(id));
  return pending.some((id) => injectedCoverageProblems(oas, pkg, id, slotIds, pending).length === 0);
}

describe("every contextSlots agent carries explicit context-resolution wiring", () => {
  it("discovers agent OAS files", () => {
    expect(ALL.length).toBeGreaterThan(0);
  });

  const slotted = ALL.filter((f) => {
    try {
      const oas = JSON.parse(readFileSync(f.oasPath, "utf8"));
      const slots = oas?.metadata?.cinatra?.contextSlots;
      // The loader reads every PRESENT value (:240-306); null or absent declares
      // nothing, and so does an empty array.
      return slots !== undefined && slots !== null && !(Array.isArray(slots) && slots.length === 0);
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

/** A synthetic agent the loader mounts as is: `placed` slots get an
 *  author-placed context FlowNode, marked for its slot, feeding `work.<input>`;
 *  every other slot is declaration-only and is consumed by
 *  `work.<slotId>ContextSlotBindings`. Every slot declaration carries the
 *  fields the loader requires, the definition names its owner package, and the
 *  StartNode has a control successor. */
function agent(slotIds: string[], placed: Record<string, string>): Ref {
  const components: Record<string, Ref> = {
    start: { component_type: "StartNode", id: "start", inputs: [] },
    end: { component_type: "EndNode", id: "end", inputs: [] },
  };
  const inputs: Array<{ title: string }> = [];
  const edges: Ref[] = [];
  const nodes = ["start"];
  for (const [slotId, input] of Object.entries(placed)) {
    components[`context_${slotId}`] = {
      component_type: "FlowNode",
      metadata: { cinatra: { purpose: `author-placed-context-resolution-for-${slotId}` } },
      subflow: ref(`context-${slotId}-subflow`),
    };
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
  const control = nodes.slice(1).map((to, i) => ({
    component_type: "ControlFlowEdge",
    name: `${nodes[i]}_to_${to}`,
    from_node: ref(nodes[i]),
    to_node: ref(to),
  }));
  return {
    id: "synthetic-agent-flow",
    metadata: {
      cinatra: {
        packageName: "@cinatra-ai/synthetic-agent",
        contextSlots: slotIds.map((slotId) => ({
          slotId,
          acceptedArtifactExtensions: ["@cinatra-ai/brand-voice-artifact"],
          selectionMode: "interactive",
          resolutionMode: "override",
        })),
      },
    },
    start_node: ref("start"),
    nodes: nodes.map(ref),
    $referenced_components: components,
    control_flow_connections: control,
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
      "work declares both contextSlotBindings and bContextSlotBindings; the loader refuses the ambiguity",
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

  it("never counts the StartNode as a declaration-only slot's consumer", () => {
    const doc = agent(["a"], {});
    const all = doc.$referenced_components as Record<string, Ref>;
    all.work.inputs = [];
    all.start.inputs = [{ title: "aContextSlotBindings" }];
    expect(wiringProblems(doc, CTX_PKG)).toEqual([
      "declaration-only slot a has no consumer: no work node declares contextSlotBindings or aContextSlotBindings",
    ]);
  });

  it("asks for a runtime edge, not a peer edge that is required", () => {
    const peer = {
      cinatra: { dependencies: [{ ...CTX_PKG.cinatra.dependencies[0], edgeType: "peer" }] },
    };
    expect(wiringProblems(agent(["a"], {}), peer)).toEqual([
      `the ${CONTEXT_SELECTION_AGENT} edge must be runtime, not peer`,
      `declaration-only slot a counts as covered by the injected node only with a required runtime ${CONTEXT_SELECTION_AGENT} edge`,
    ]);
    expect(hasContextResolution(agent(["a"], {}), peer)).toBe(false);
  });

  it("keeps the old base, subflow and order assertions", () => {
    const optional = {
      cinatra: { dependencies: [{ ...CTX_PKG.cinatra.dependencies[0], requirement: "optional" }] },
    };
    expect(wiringProblems(agent(["a"], { a: "contextSlotBindings" }), optional)).toEqual([
      `the ${CONTEXT_SELECTION_AGENT} edge must be required, not optional`,
    ]);

    const noBindings = agent(["a"], { a: "contextSlotBindings" });
    (noBindings.$referenced_components as Record<string, Ref>)["context-a-subflow"].outputs = [
      { title: "selection", type: "string" },
    ];
    expect(wiringProblems(noBindings, CTX_PKG)).toEqual([
      "context_a.subflow outputs must include contextSlotBindings (not contextRefs)",
    ]);

    const stub = agent(["a"], { a: "contextSlotBindings" });
    ((stub.$referenced_components as Record<string, Ref>)["context-a-subflow"].outputs as Ref[]).push({
      title: "contextRefs",
      type: "string",
    });
    expect(wiringProblems(stub, CTX_PKG)).toEqual(["context_a: the contextRefs stub output is forbidden"]);

    const unordered = agent(["a"], { a: "contextSlotBindings" });
    unordered.nodes = (unordered.nodes as Array<{ $component_ref: string }>).filter(
      (n) => n.$component_ref !== "context_a",
    );
    expect(wiringProblems(unordered, CTX_PKG)).toEqual(["context_a is not in the node order"]);

    const late = agent(["a"], { a: "contextSlotBindings" });
    late.nodes = ["start", "work", "context_a", "end"].map(ref);
    expect(wiringProblems(late, CTX_PKG)).toEqual(["context_a must come before its consumer work"]);
  });

  it("mirrors the loader's two mount refusals on the declaration-only road", () => {
    const both = agent(["a"], {});
    (both.$referenced_components as Record<string, Ref>).work.inputs = [
      { title: "contextSlotBindings" },
      { title: "aContextSlotBindings" },
    ];
    expect(wiringProblems(both, CTX_PKG)).toEqual([
      "work declares both contextSlotBindings and aContextSlotBindings; the loader refuses the ambiguity",
    ]);

    const bare = agent(["a", "b"], {});
    (bare.$referenced_components as Record<string, Ref>).side = {
      component_type: "ApiNode",
      id: "side",
      url: "{{CINATRA_BASE_URL}}/api/llm-bridge",
      inputs: [{ title: "contextSlotBindings" }],
    };
    (bare.nodes as Ref[]).splice(1, 0, ref("side"));
    expect(wiringProblems(bare, CTX_PKG)).toEqual([
      "side declares the bare contextSlotBindings in a multi-slot agent; the loader refuses it",
    ]);
  });
});

/* ------------------------------------------------------------------------- *
 * What the loader itself refuses, the gate refuses too (cinatra#4314). Each
 * case reads the loader's own rule in docker/wayflow/context_subflow_injection.py.
 * ------------------------------------------------------------------------- */

describe("the gate refuses what the loader refuses (cinatra#4314)", () => {
  const slot = (doc: Ref) => ((doc.metadata as Ref).cinatra as Ref).contextSlots as Ref[];
  const components = (doc: Ref) => doc.$referenced_components as Record<string, Ref>;

  it("refuses a slot declaration the loader refuses", () => {
    const cases: Array<[(doc: Ref) => void, string]> = [
      [(d) => { delete slot(d)[0].acceptedArtifactExtensions; }, "contextSlots[0]: acceptedArtifactExtensions must be a non-empty array of non-empty strings; the loader refuses the mount"],
      [(d) => { slot(d)[0].acceptedArtifactExtensions = []; }, "contextSlots[0]: acceptedArtifactExtensions must be a non-empty array of non-empty strings; the loader refuses the mount"],
      [(d) => { slot(d)[0].acceptedArtifactExtensions = [""]; }, "contextSlots[0]: acceptedArtifactExtensions must be a non-empty array of non-empty strings; the loader refuses the mount"],
      [(d) => { delete slot(d)[0].resolutionMode; }, "contextSlots[0]: invalid resolutionMode; the loader refuses the mount"],
      [(d) => { delete slot(d)[0].selectionMode; }, "contextSlots[0]: invalid selectionMode; the loader refuses the mount"],
      [(d) => { slot(d)[0].selectionMode = "manual"; }, "contextSlots[0]: invalid selectionMode; the loader refuses the mount"],
      [(d) => { slot(d)[0].label = "Voice"; }, "contextSlots[0]: has unknown key(s) label; the loader refuses the mount"],
      [(d) => { slot(d)[0].slotId = ""; }, "contextSlots[0]: has a missing or empty slotId; the loader refuses the mount"],
      [(d) => { slot(d)[0].slotId = "a__SLOT__"; }, "contextSlots[0]: slotId contains the reserved template token; the loader refuses the mount"],
      [(d) => { slot(d).push({ ...slot(d)[0] }); }, "contextSlots[1]: duplicate slotId a; the loader refuses the mount"],
      [(d) => { slot(d)[0].minItems = -1; }, "contextSlots[0]: invalid minItems; the loader refuses the mount"],
      [(d) => { slot(d)[0].minItems = 1.5; }, "contextSlots[0]: invalid minItems; the loader refuses the mount"],
      [(d) => { slot(d)[0].maxItems = 0; }, "contextSlots[0]: invalid maxItems; the loader refuses the mount"],
      [(d) => { slot(d)[0].maxItems = true; }, "contextSlots[0]: invalid maxItems; the loader refuses the mount"],
      [(d) => { slot(d)[0].minItems = 3; slot(d)[0].maxItems = 2; }, "contextSlots[0]: minItems must be <= maxItems; the loader refuses the mount"],
      [(d) => { slot(d)[0].readableOnly = "yes"; }, "contextSlots[0]: invalid readableOnly; the loader refuses the mount"],
      [(d) => { slot(d)[0] = "a" as unknown as Ref; }, "contextSlots[0]: is not an object; the loader refuses the mount"],
    ];
    for (const [change, problem] of cases) {
      const doc = agent(["a"], {});
      change(doc);
      expect(wiringProblems(doc, CTX_PKG)).toContain(problem);
      expect(hasContextResolution(doc, CTX_PKG)).toBe(false);
      // The loader reads the declaration before it looks for any marker, so an
      // author-placed slot is refused the same way.
      const placed = agent(["a"], { a: "contextSlotBindings" });
      change(placed);
      expect(wiringProblems(placed, CTX_PKG)).toContain(problem);
    }
    const notArray = agent(["a"], {});
    ((notArray.metadata as Ref).cinatra as Ref).contextSlots = { slotId: "a" };
    expect(wiringProblems(notArray, CTX_PKG)).toContain(
      "metadata.cinatra.contextSlots must be an array; the loader refuses the mount",
    );
  });

  it("refuses a declaration-only slot the loader cannot inject", () => {
    const cases: Array<[(doc: Ref) => void, string]> = [
      [(d) => { delete ((d.metadata as Ref).cinatra as Ref).packageName; }, "the loader finds no owner package for the declared slots (no metadata.cinatra.packageName)"],
      [(d) => {
        components(d).wrapper = {
          component_type: "FlowNode",
          metadata: { cinatra: { packageName: "@cinatra-ai/other-agent" } },
          subflow: ref("synthetic-agent-flow"),
        };
      }, "the loader finds an ambiguous owner package: @cinatra-ai/other-agent, @cinatra-ai/synthetic-agent"],
      [(d) => { delete d.control_flow_connections; }, "unsupported definition shape for injection: the loader needs $referenced_components, nodes, control_flow_connections and start_node"],
      [(d) => { delete d.start_node; }, "unsupported definition shape for injection: the loader needs $referenced_components, nodes, control_flow_connections and start_node"],
      [(d) => { delete components(d).start; }, "start node start is not defined in $referenced_components"],
      [(d) => { (d.control_flow_connections as Ref[]).shift(); }, "start node start has no outgoing control edge: the loader has nowhere to splice the context subflow"],
      [(d) => { components(d).context_a = { component_type: "ApiNode", id: "context_a", url: "{{CINATRA_BASE_URL}}/api/llm-bridge" }; }, "injected component id context_a collides with an existing id in the document"],
      [(d) => { components(d)["ctx-a-start"] = { component_type: "StartNode", inputs: [] }; }, "injected component id ctx-a-start collides with an existing id in the document"],
      [(d) => { components(d).work.data = { step: { id: "context-a-subflow" } }; }, "injected component id context-a-subflow collides with an existing id in the document"],
    ];
    for (const [change, problem] of cases) {
      const doc = agent(["a"], {});
      change(doc);
      expect(wiringProblems(doc, CTX_PKG)).toContain(problem);
      expect(hasContextResolution(doc, CTX_PKG)).toBe(false);
    }
    const nullEdges = agent(["a"], {});
    nullEdges.data_flow_connections = null;
    expect(wiringProblems(nullEdges, CTX_PKG)).toContain("data_flow_connections is not an array");
  });

  it("refuses a slot count it cannot read exactly", () => {
    const unsafe = agent(["a"], {});
    Object.assign(slot(unsafe)[0], JSON.parse('{"minItems": 9007199254740993, "maxItems": 9007199254740992}'));
    expect(wiringProblems(unsafe, CTX_PKG)).toContain(
      "contextSlots[0]: minItems is outside the safe integer range, which this gate cannot read exactly",
    );
    expect(hasContextResolution(unsafe, CTX_PKG)).toBe(false);
    const big = agent(["a"], {});
    slot(big)[0].maxItems = Number.MAX_SAFE_INTEGER + 1;
    expect(wiringProblems(big, CTX_PKG)).toContain(
      "contextSlots[0]: maxItems is outside the safe integer range, which this gate cannot read exactly",
    );
    const edge = agent(["a"], {});
    slot(edge)[0].minItems = 0;
    slot(edge)[0].maxItems = Number.MAX_SAFE_INTEGER;
    expect(wiringProblems(edge, CTX_PKG)).toEqual([]);
  });

  it("refuses a hidden input the loader cannot add", () => {
    const cases: Array<[(doc: Ref) => void, string]> = [
      [(d) => { d.inputs = {}; }, "the definition: inputs is not an array; the loader refuses the injection"],
      [(d) => { components(d).start.inputs = null; }, "start node start: inputs is not an array; the loader refuses the injection"],
      [(d) => { d.inputs = [{ title: "cinatra_run_id", type: "integer" }]; }, 'the definition: input cinatra_run_id has type "integer"; the loader needs a string'],
      [(d) => { components(d).start.inputs = [{ title: "projectId" }]; }, "start node start: input projectId has type none; the loader needs a string"],
      [(d) => { d.inputs = [{ title: "aParentPackageName", type: "string", default: "@cinatra-ai/other-agent" }]; }, 'the definition: input aParentPackageName has default "@cinatra-ai/other-agent"; the loader needs "@cinatra-ai/synthetic-agent"'],
      [(d) => { components(d).start.inputs = [{ title: "aSlotId", type: "string" }]; }, 'start node start: input aSlotId has default none; the loader needs "a"'],
    ];
    for (const [change, problem] of cases) {
      const doc = agent(["a"], {});
      change(doc);
      expect(wiringProblems(doc, CTX_PKG)).toContain(problem);
      expect(hasContextResolution(doc, CTX_PKG)).toBe(false);
    }
    // Compatible inputs are reused as they are.
    const fits = agent(["a"], {});
    const compatible = [
      { title: "cinatra_run_id", type: "string", default: "run" },
      { title: "projectId", type: "string" },
      { title: "aParentPackageName", type: "string", default: "@cinatra-ai/synthetic-agent" },
      { title: "aSlotId", type: "string", default: "a" },
    ];
    fits.inputs = structuredClone(compatible);
    components(fits).start.inputs = structuredClone(compatible);
    expect(wiringProblems(fits, CTX_PKG)).toEqual([]);
    // The loader adds no input for an author-placed slot, so it reads none.
    const placed = agent(["a"], { a: "contextSlotBindings" });
    placed.inputs = {};
    expect(wiringProblems(placed, CTX_PKG)).toEqual([]);
  });

  it("reads a component reference given as a plain string", () => {
    const fedByString = agent(["a"], {});
    (fedByString.data_flow_connections as Ref[]).push({ ...dfe("start", "x", "work", "aContextSlotBindings"), destination_node: "work" });
    expect(wiringProblems(fedByString, CTX_PKG)).toEqual([
      "work.aContextSlotBindings is already fed by a DataFlowEdge; the loader refuses to double-wire it",
    ]);

    const sideByString = agent(["a", "b"], {});
    components(sideByString).side = {
      component_type: "ApiNode",
      id: "side",
      url: "{{CINATRA_BASE_URL}}/api/llm-bridge",
      inputs: [{ title: "contextSlotBindings" }],
    };
    (sideByString.nodes as unknown[]).splice(1, 0, "side");
    expect(wiringProblems(sideByString, CTX_PKG)).toEqual([
      "side declares the bare contextSlotBindings in a multi-slot agent; the loader refuses it",
    ]);

    const startByString = agent(["a"], {});
    const all = components(startByString);
    all.begin = { ...all.start, id: "begin", inputs: [{ title: "aContextSlotBindings" }] };
    delete all.start;
    all.work.inputs = [];
    startByString.start_node = "begin";
    startByString.nodes = ["begin", "work", "end"];
    startByString.control_flow_connections = [
      { component_type: "ControlFlowEdge", name: "begin_to_work", from_node: "begin", to_node: "work" },
    ];
    expect(wiringProblems(startByString, CTX_PKG)).toEqual([
      "declaration-only slot a has no consumer: no work node declares contextSlotBindings or aContextSlotBindings",
    ]);

    const placedByString = agent(["a"], { a: "contextSlotBindings" });
    placedByString.nodes = ["start", "context_a", "work", "end"];
    placedByString.data_flow_connections = [
      { ...dfe("context_a", "contextSlotBindings", "work", "contextSlotBindings"), source_node: "context_a", destination_node: "work" },
    ];
    expect(wiringProblems(placedByString, CTX_PKG)).toEqual([]);
    components(placedByString).context_a.subflow = "context-a-subflow";
    expect(wiringProblems(placedByString, CTX_PKG)).toEqual([]);
    expect(hasContextResolution(placedByString, CTX_PKG)).toBe(true);
  });

  it("maps an author-placed node to its slot by its marker, not by its id", () => {
    const renamed = agent(["a", "b"], { a: "aContextSlotBindings" });
    const all = components(renamed);
    all.resolve_a = all.context_a;
    delete all.context_a;
    renamed.nodes = ["start", "resolve_a", "work", "end"].map(ref);
    renamed.control_flow_connections = [
      { component_type: "ControlFlowEdge", name: "start_to_resolve_a", from_node: ref("start"), to_node: ref("resolve_a") },
      { component_type: "ControlFlowEdge", name: "resolve_a_to_work", from_node: ref("resolve_a"), to_node: ref("work") },
      { component_type: "ControlFlowEdge", name: "work_to_end", from_node: ref("work"), to_node: ref("end") },
    ];
    renamed.data_flow_connections = [dfe("resolve_a", "contextSlotBindings", "work", "aContextSlotBindings")];
    expect(wiringProblems(renamed, CTX_PKG)).toEqual([]);

    const unmarked = agent(["a", "b"], { a: "aContextSlotBindings" });
    delete components(unmarked).context_a.metadata;
    expect(wiringProblems(unmarked, CTX_PKG)).toContain(
      "context_a resolves no declared slot: its metadata.cinatra.purpose marks no declared slot",
    );

    const otherSlot = agent(["a", "b"], { a: "aContextSlotBindings" });
    components(otherSlot).context_a.metadata = { cinatra: { purpose: "author-placed-context-resolution-for-z" } };
    expect(wiringProblems(otherSlot, CTX_PKG)).toContain(
      "context_a resolves no declared slot: its metadata.cinatra.purpose marks no declared slot",
    );

    // A marker inside a nested definition is that definition's own: the slot
    // stays declaration-only here, so it still needs the edge.
    const nested = agent(["a"], {});
    components(nested).child = {
      component_type: "Flow",
      id: "child-flow",
      $referenced_components: {
        resolve: { component_type: "FlowNode", metadata: { cinatra: { purpose: "author-placed-context-resolution-for-a" } } },
      },
    };
    expect(wiringProblems(nested, NO_CTX_PKG)).toEqual([
      `must declare a ${CONTEXT_SELECTION_AGENT} dependency edge`,
      `declaration-only slot a counts as covered by the injected node only with a required runtime ${CONTEXT_SELECTION_AGENT} edge`,
    ]);
  });

  it("leaves an unmarked author-placed node's slot to the injection, which collides with it", () => {
    const doc = agent(["a"], { a: "contextSlotBindings" });
    delete components(doc).context_a.metadata;
    expect(wiringProblems(doc, CTX_PKG)).toEqual([
      "injected component id context-a-subflow collides with an existing id in the document",
      "injected component id context_a collides with an existing id in the document",
      "injected component id ctx-a-resolve_context collides with an existing id in the document",
      "work.contextSlotBindings is already fed by a DataFlowEdge; the loader refuses to double-wire it",
    ]);
  });
});

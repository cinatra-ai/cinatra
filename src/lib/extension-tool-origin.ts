import "server-only";

// WHICH PACKAGE'S CODE AN `extension_tool` CALL RUNS (cinatra#4154).
//
// A step of the run's own flow reaches the run package's own declared tools,
// as before. A step of an EMBEDDED child flow reaches a tool of the child's own
// package, but only when all of this holds, each read fail-closed:
//
//   - the run executes as one exact parent installation, and the flow document
//     is read from the root that installation's own anchor names;
//   - the verified step sits directly in a definition referenced by exactly one
//     FlowNode of the root flow, and that FlowNode is labelled with a package
//     the exact parent manifest declares once as an `agent` dependency;
//   - the parent's one edge for that package resolves to a live child install,
//     bound to its own materialized root (extension-tool-install-binding.ts);
//   - the step node is, apart from its id, the verbatim copy of exactly one
//     ApiNode of the child's own installed flow, that node calls this tool road
//     with a fixed name, the request names exactly that tool, and the child's
//     own declaration marks the tool `embeddable: true`.
//
// The step is never read from the request: only `verifiedStepId`, which the
// route verified from the runtime's signed pair. Each refusal is a fixed
// sentence carrying a fixed code, never a path, an install id, a digest or a
// version. Nothing here names a package.

import path from "node:path";
import { readFile } from "node:fs/promises";

import { declaredToolIsEmbeddable, parseDeclaredTools } from "@cinatra-ai/sdk-extensions/manifest";

import {
  bindChildInstall,
  bindParentInstall,
  childEdgeStillResolvesTo,
  type InstallBindingCode,
  type InstallBindingDeps,
} from "@/lib/extension-tool-install-binding";
import type { DerivedDependentInstallId } from "@/lib/extension-edge-bound-serving";
import {
  resolvePinnedPackageRoot,
  type ExactInstallBinding,
  type PinnedPackageRootResolver,
} from "@/lib/extension-tool-module-loader";
import type { RunExtensionContext } from "@/lib/extension-run-package";
import { logFailure } from "@/lib/failure-log";

/** The codes this resolver refuses with besides the install binding's own. */
export const ORIGIN_CODES = [
  "step-unproven", "parent-install-unresolved", "parent-install-ambiguous", "parent-flow-invalid",
  "step-unknown", "step-duplicate", "graph-duplicate-definition", "graph-bad-reference",
  "graph-multiple-referencers", "graph-unreferenced-definition", "graph-cycle", "graph-bad-label",
  "nested-embedding", "not-a-dependency", "dependency-duplicate", "dependency-wrong-kind",
  "child-flow-invalid", "child-graph-duplicate-definition", "child-graph-bad-reference",
  "child-graph-multiple-referencers", "child-graph-unreferenced-definition", "child-graph-cycle",
  "child-graph-bad-label", "provenance-mismatch", "provenance-ambiguous", "provenance-nested",
  "provenance-unnamed", "name-not-bound", "child-declaration-invalid", "child-tool-undeclared",
  "not-embeddable",
] as const;
export type ExtensionToolOriginCode = InstallBindingCode | (typeof ORIGIN_CODES)[number];

/** A 403: the fixed sentence of its code, and nothing read from a store or a request. */
export class ExtensionToolOriginRefusal extends Error {
  readonly code: ExtensionToolOriginCode;
  constructor(code: ExtensionToolOriginCode) {
    super(`extension_tool: the calling step reaches no tool of this origin (${code})`);
    this.name = "ExtensionToolOriginRefusal";
    this.code = code;
  }
}

export type ExtensionToolOrigin =
  /** The run package's own code, on today's road. */
  | { kind: "parent" }
  /** The embedded child's code, from the exact child installation. */
  | { kind: "child"; context: RunExtensionContext; install: ExactInstallBinding; codeInstallId: string };

export type ExtensionToolOriginRun = {
  id: string;
  orgId: string;
  templateId: string;
  packageVersion: string | null;
  versionId?: string | null;
  dependentInstallId?: string | null;
  verifiedStepId?: string | null;
};

export type ExtensionToolOriginDeps = InstallBindingDeps & {
  /** The parsed `cinatra/oas.json` at a root; a throw is `origin-unreadable`. */
  readFlowDocument?: (root: string) => Promise<unknown>;
  deriveDependentInstallId?: (run: ExtensionToolOriginRun) => Promise<DerivedDependentInstallId>;
  isDevelopmentMode?: () => boolean | Promise<boolean>;
  /** The name-and-version root road, used only for a development parent with no store record. */
  resolveDevelopmentRoot?: PinnedPackageRootResolver;
};

const refuse = (code: ExtensionToolOriginCode): never => {
  throw new ExtensionToolOriginRefusal(code);
};
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/** One injected read; a throw is `origin-unreadable`, logged without its text. */
async function guarded<T>(read: string, run: () => Promise<T> | T): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof ExtensionToolOriginRefusal) throw e;
    logFailure("[extension_tool] an origin read failed", { read }, e);
    return refuse("origin-unreadable");
  }
}

/** Whether a manifest block declares any `agent` dependency (no child is reachable otherwise). */
function declaresAgentDependency(cinatra: Record<string, unknown>): boolean {
  const deps: unknown = cinatra.dependencies;
  return Array.isArray(deps) && deps.some((d) => isPlainObject(d) && d.kind === "agent");
}

// ---- the definition and reference graph ----

type Indexed = { obj: Record<string, unknown>; enclosing: Record<string, unknown> | null };
type Graph = {
  root: Record<string, unknown>;
  nodes: Indexed[];
  enclosingOf: Map<Record<string, unknown>, Record<string, unknown> | null>;
  referencerOf: Map<Record<string, unknown>, Record<string, unknown>>;
};

/** A FlowNode's package label: its value when the key is present (checked by the graph), else NO_LABEL. */
const NO_LABEL = Symbol("no-label");
const labelOf = (flowNode: Record<string, unknown>): unknown => {
  const meta = flowNode.metadata;
  if (!isPlainObject(meta) || !isPlainObject(meta.cinatra) || !Object.hasOwn(meta.cinatra, "packageName")) {
    return NO_LABEL;
  }
  return meta.cinatra.packageName;
};

/** Index and check the whole document; codes carry `prefix` on the child side. */
function graphOf(doc: unknown, prefix: "" | "child-"): Graph {
  const code = (c: string) => refuse(`${prefix}${c}` as ExtensionToolOriginCode);
  if (!isPlainObject(doc) || doc.component_type !== "Flow" || typeof doc.id !== "string") {
    return refuse(prefix === "" ? "parent-flow-invalid" : "child-flow-invalid");
  }
  const definitions = new Map<string, Record<string, unknown>>();
  const enclosingOf = new Map<Record<string, unknown>, Record<string, unknown> | null>();
  const nodes: Indexed[] = [];
  const seen = new Set<unknown>();
  const walk = (v: unknown, enclosing: Record<string, unknown> | null) => {
    if (Array.isArray(v)) return v.forEach((x) => walk(x, enclosing));
    if (!isPlainObject(v) || seen.has(v)) return;
    seen.add(v);
    let inner = enclosing;
    if (typeof v.component_type === "string" && typeof v.id === "string") {
      enclosingOf.set(v, enclosing);
      if (v.component_type === "Flow") {
        if (definitions.has(v.id)) code("graph-duplicate-definition");
        definitions.set(v.id, v);
        inner = v;
      } else {
        nodes.push({ obj: v, enclosing });
      }
    }
    for (const child of Object.values(v)) walk(child, inner);
  };
  walk(doc, null);
  const referencerOf = new Map<Record<string, unknown>, Record<string, unknown>>();
  for (const { obj } of nodes) {
    if (definitions.has(obj.id as string)) code("graph-duplicate-definition");
    if (obj.component_type !== "FlowNode") continue;
    const label = labelOf(obj);
    if (label !== NO_LABEL && !nonEmpty(label)) code("graph-bad-label");
    const sub = obj.subflow;
    // An inline Flow is a target only as the definition the walk indexed (a string id), like any other.
    const target = isPlainObject(sub)
      ? sub.component_type === "Flow"
        ? typeof sub.id === "string" && definitions.get(sub.id) === sub
          ? sub
          : undefined
        : nonEmpty(sub.$component_ref)
          ? definitions.get(sub.$component_ref)
          : undefined
      : undefined;
    if (!target) return code("graph-bad-reference");
    if (referencerOf.has(target)) code("graph-multiple-referencers");
    referencerOf.set(target, obj);
  }
  // A definition that reaches itself through FlowNode references.
  const state = new Map<Record<string, unknown>, 1 | 2>();
  const visit = (def: Record<string, unknown>) => {
    if (state.get(def) === 2) return;
    if (state.get(def) === 1) code("graph-cycle");
    state.set(def, 1);
    for (const [target, ref] of referencerOf) if (enclosingOf.get(ref) === def) visit(target);
    state.set(def, 2);
  };
  for (const def of definitions.values()) visit(def);
  return { root: doc, nodes, enclosingOf, referencerOf };
}

/** The FlowNodes from a node's enclosing definition up to the root flow, innermost first. */
function chainOf(g: Graph, node: Record<string, unknown>, prefix: "" | "child-"): Record<string, unknown>[] {
  const chain: Record<string, unknown>[] = [];
  let def = g.enclosingOf.get(node) ?? null;
  const visited = new Set<unknown>();
  while (def !== null && def !== g.root) {
    if (visited.has(def)) refuse(`${prefix}graph-cycle` as ExtensionToolOriginCode);
    visited.add(def);
    const ref = g.referencerOf.get(def);
    if (!ref) return refuse(`${prefix}graph-unreferenced-definition` as ExtensionToolOriginCode);
    chain.push(ref);
    def = g.enclosingOf.get(ref) ?? null;
  }
  if (def === null) refuse(prefix === "" ? "parent-flow-invalid" : "child-flow-invalid");
  return chain;
}

/** Case P, or case C with the child label, for the step of the parent document. */
function classify(g: Graph, stepId: string, parentPackage: string): { step: Record<string, unknown>; label: string | null } {
  const matching = g.nodes.filter((n) => n.obj.id === stepId);
  if (matching.length === 0) refuse("step-unknown");
  if (matching.length > 1) refuse("step-duplicate");
  const step = matching[0].obj;
  const chain = chainOf(g, step, "");
  const labelled = chain.filter((r) => labelOf(r) !== NO_LABEL);
  if (labelled.length === 0) return { step, label: null };
  if (labelled.length > 1 || labelled[0] !== chain[0] || g.enclosingOf.get(chain[0]) !== g.root) {
    return refuse("nested-embedding");
  }
  const label = labelOf(chain[0]) as string; // a present label is a non-empty string (graphOf)
  return { step, label: label === parentPackage ? null : label };
}

/** JSON value equality; key order ignored, nothing else normalised. */
function sameJson(a: unknown, b: unknown): boolean {
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => sameJson(x, b[i]));
  if (isPlainObject(a)) {
    if (!isPlainObject(b)) return false;
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && sameJson(a[k], b[k]));
  }
  return a === b;
}

const withoutId = (o: Record<string, unknown>): Record<string, unknown> => {
  const rest = { ...o };
  delete rest.id;
  return rest;
};

/**
 * The origin of one `extension_tool` call. `context` is the run package's
 * context as today's road resolves it. Throws `ExtensionToolOriginRefusal`.
 */
export async function resolveExtensionToolOrigin(
  input: { run: ExtensionToolOriginRun; context: RunExtensionContext; request: Record<string, unknown> },
  deps: ExtensionToolOriginDeps = {},
): Promise<ExtensionToolOrigin> {
  const { run, context } = input;
  // No agent dependency: no child is reachable, and nothing is read (today's road).
  if (!declaresAgentDependency(context.cinatra)) return { kind: "parent" };
  const proven = run.verifiedStepId;
  if (!nonEmpty(proven)) return refuse("step-unproven");
  const stepId: string = proven;

  const readFlow =
    deps.readFlowDocument ??
    (async (root: string) => JSON.parse(await readFile(path.join(root, "cinatra", "oas.json"), "utf8")));
  const isDevelopment =
    deps.isDevelopmentMode ??
    (async () => (await import("@/lib/runtime-mode")).isAppDevelopmentMode());
  const derive =
    deps.deriveDependentInstallId ??
    (async (r: ExtensionToolOriginRun) =>
      (await import("@/lib/extension-edge-bound-serving")).deriveDependentInstallIdForRun(r));
  const resolveRoot = deps.resolveDevelopmentRoot ?? resolvePinnedPackageRoot;

  // A development parent with no store record: its flow is read by name and version; no child is reachable.
  const developmentRoad = async (otherwise: ExtensionToolOriginCode): Promise<ExtensionToolOrigin> => {
    if ((await guarded("development-mode", isDevelopment)) !== true) return refuse(otherwise);
    const root = await guarded("package-root", () =>
      resolveRoot({ packageName: context.packageName, packageVersion: context.packageVersion, orgId: run.orgId }),
    );
    if (root === null) return refuse("parent-not-materialized");
    const g = graphOf(await guarded("flow-document", () => readFlow(root)), "");
    return classify(g, stepId, context.packageName).label === null
      ? { kind: "parent" }
      : refuse("child-not-materialized");
  };

  let installId = nonEmpty(run.dependentInstallId) ? run.dependentInstallId : null;
  if (installId === null) {
    const derived = await guarded("derive-install", () => derive(run));
    if (derived.kind === "ambiguous") return refuse("parent-install-ambiguous");
    if (derived.kind === "none") return developmentRoad("parent-install-unresolved");
    installId = derived.id;
  }

  const parent = await bindParentInstall(
    { installId, packageName: context.packageName, packageVersion: context.packageVersion, orgId: run.orgId },
    deps,
  );
  if (!parent.ok) {
    return parent.code === "parent-not-materialized" ? developmentRoad(parent.code) : refuse(parent.code);
  }

  const graph = graphOf(await guarded("flow-document", () => readFlow(parent.value.root)), "");
  const { step, label } = classify(graph, stepId, context.packageName);
  if (label === null) return { kind: "parent" };

  // The exact parent manifest declares the child once, as an agent.
  const declared: unknown = parent.value.cinatra.dependencies;
  const forLabel = Array.isArray(declared)
    ? declared.filter((d) => isPlainObject(d) && d.packageName === label)
    : [];
  if (forLabel.length === 0) refuse("not-a-dependency");
  if (forLabel.length > 1) refuse("dependency-duplicate");
  if ((forLabel[0] as Record<string, unknown>).kind !== "agent") refuse("dependency-wrong-kind");

  const child = await bindChildInstall({ parent: parent.value, childPackageName: label, orgId: run.orgId }, deps);
  if (!child.ok) return refuse(child.code);

  // The step replays, apart from its id, exactly one ApiNode of the child's own flow.
  const childGraph = graphOf(await guarded("flow-document", () => readFlow(child.value.root)), "child-");
  const stepBody = withoutId(step);
  const copies = childGraph.nodes.filter(
    ({ obj }) =>
      obj.component_type === "ApiNode" &&
      typeof obj.id === "string" &&
      stepId.length > obj.id.length &&
      stepId.endsWith(obj.id) &&
      sameJson(stepBody, withoutId(obj)),
  );
  if (copies.length === 0) refuse("provenance-mismatch");
  if (copies.length > 1) refuse("provenance-ambiguous");
  const authored = copies[0].obj;
  if (chainOf(childGraph, authored, "child-").some((r) => labelOf(r) !== NO_LABEL)) refuse("provenance-nested");
  const data = authored.data;
  const fixedName = isPlainObject(data) && data.tool === "extension_tool" && isPlainObject(data.input)
    ? data.input.name
    : undefined;
  if (!nonEmpty(fixedName) || fixedName.includes("{{")) return refuse("provenance-unnamed");
  const requested = typeof input.request.name === "string" ? input.request.name.trim() : "";
  if (requested !== fixedName) refuse("name-not-bound");

  // The child consents per tool. A declaration that does not parse, or that does not declare the
  // tool, is refused here with a fixed code: the parser's text (it can carry manifest values) never
  // reaches a response; the dispatch then re-parses the same declaration, which parsed here.
  const tools = ((): ReturnType<typeof parseDeclaredTools> | null => {
    try {
      return parseDeclaredTools(child.value.cinatra.tools, label);
    } catch {
      return null;
    }
  })();
  if (tools === null) return refuse("child-declaration-invalid");
  const tool = tools.find((t) => t.name === requested);
  if (tool === undefined) return refuse("child-tool-undeclared");
  if (!declaredToolIsEmbeddable(tool)) refuse("not-embeddable");

  const parentInstallId = parent.value.row.id;
  const childInstallId = child.value.row.id;
  return {
    kind: "child",
    codeInstallId: childInstallId,
    context: { packageName: label, packageVersion: child.value.version, cinatra: child.value.cinatra },
    install: {
      installId: childInstallId,
      digest: child.value.digest,
      stillBound: () =>
        childEdgeStillResolvesTo({ parentInstallId, childPackageName: label, childInstallId }, deps),
    },
  };
}

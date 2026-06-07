/**
 * Repo-wide invariant for context resolution.
 *
 * Runtime auto-wiring for context selection is intentionally not used.
 * Every agent OAS that declares a non-empty `metadata.cinatra.contextSlots`
 * MUST carry EXPLICIT, author-placed wiring:
 *   (1) package.json `cinatra.agentDependencies` declares
 *       `@cinatra-ai/context-selection-agent`.
 *   (2) The OAS has at least one explicit `context_<slot>` FlowNode whose
 *       inlined subflow is the real context-resolution subflow (an
 *       ApiNode hits `/api/context-resolve`).
 *   (3) The FlowNode's `contextSlotBindings` output is DataFlowEdge-wired
 *       into a downstream node's `contextSlotBindings` input, replacing
 *       the inert `start.contextSlotBindings → consumer` bypass.
 *   (4) Node order: the context FlowNode is BEFORE its consumer.
 *
 * Plus anti-stub assertions:
 *   - NO top-level `start.contextSlotBindings → consumer` bypass on any
 *     contextSlots leaf.
 *   - NO `start.contextRefs → end.contextRefs` pass-through stub on any agent.
 *   - INTERACTIVE selectors that list `context-selector` in `hitlScreens`
 *     must also have a real context FlowNode (renderer is wired, not just
 *     declared).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const EXT = join(__dirname, "..", "..", "..", "..", "extensions");

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
 *  ApiNode whose url hits `/api/context-resolve`. Independent of metadata
 *  tags, so it survives vendoring metadata trimming. */
function isContextFlowNode(oas: Ref, component: Ref): boolean {
  if (component.component_type !== "FlowNode") return false;
  const subRef = (component.subflow as { "$component_ref"?: string } | undefined)?.["$component_ref"];
  if (!subRef) return false;
  const sub = refs(oas)[subRef];
  if (!sub || sub.component_type !== "Flow") return false;
  const subRefs = ((sub["$referenced_components"] as Record<string, Ref>) ?? {});
  for (const c of Object.values(subRefs)) {
    if (c.component_type === "ApiNode" && typeof c.url === "string"
        && (c.url as string).includes("/api/context-resolve")) {
      return true;
    }
  }
  return false;
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
        "blog-image-prompt-agent",
      ]),
    );
  });

  for (const f of slotted) {
    it(`${f.scope}/${f.agent}: declares dep + explicit context FlowNode + contextSlotBindings producer`, () => {
      const oas = JSON.parse(readFileSync(f.oasPath, "utf8")) as Ref;
      const pkg = JSON.parse(readFileSync(f.pkgPath, "utf8")) as Ref;
      const cinatra = (pkg.cinatra as Record<string, unknown> | undefined) ?? {};
      const deps = (cinatra.agentDependencies as Record<string, string> | undefined) ?? {};
      expect(deps["@cinatra-ai/context-selection-agent"]).toBeTruthy();

      const all = refs(oas);
      const ctxFlowNodes = Object.entries(all).filter(([, c]) => isContextFlowNode(oas, c));
      expect(ctxFlowNodes.length, "≥1 context FlowNode required").toBeGreaterThan(0);

      const order = nodeOrder(oas);
      const edges = dfes(oas);

      for (const [fnId, fn] of ctxFlowNodes) {
        const subRef = (fn.subflow as { "$component_ref"?: string } | undefined)?.["$component_ref"];
        expect(subRef).toBeTruthy();
        const sub = all[subRef!];
        const subOut = (sub.outputs as Array<{ title: string }>).map((o) => o.title);
        expect(subOut, `${fnId}.subflow outputs must include contextSlotBindings (not contextRefs)`)
          .toContain("contextSlotBindings");
        expect(subOut, "the contextRefs stub output is forbidden").not.toContain("contextRefs");

        const bindEdge = edges.find(
          (e) =>
            (e.source_node as { "$component_ref"?: string } | undefined)?.["$component_ref"] === fnId
            && e.source_output === "contextSlotBindings"
            && e.destination_input === "contextSlotBindings",
        );
        expect(bindEdge, `${fnId}.contextSlotBindings must feed a consumer's contextSlotBindings`).toBeTruthy();

        const consumer = (bindEdge!.destination_node as { "$component_ref"?: string })["$component_ref"];
        const ci = order.indexOf(fnId);
        const cj = order.indexOf(consumer!);
        expect(ci).toBeGreaterThanOrEqual(0);
        expect(cj).toBeGreaterThan(ci);
      }
    });
  }
});

describe("anti-stub: no inert bypass / no contextRefs stub", () => {
  for (const f of ALL) {
    const oas = JSON.parse(readFileSync(f.oasPath, "utf8")) as Ref;
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
        const all = refs(oas);
        const hasCtxFn = Object.values(all).some((c) => isContextFlowNode(oas, c));
        expect(hasCtxFn).toBe(true);
      });
    }
  }
});

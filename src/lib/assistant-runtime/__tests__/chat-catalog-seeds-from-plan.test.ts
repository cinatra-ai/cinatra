import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// THE CATALOG'S SEEDING SITE (cinatra#2817 slice 1).
//
// WHAT THIS CAN AND CANNOT SEE. The BEHAVIOUR of the seam — that a plan's
// servable subset is exactly what `registerTool` accepted, for the default,
// hot-installed, collision, malformed-schema and version-pinned cases — is
// pinned against the REAL runtime server in
// `packages/mcp-server/src/__tests__/capability-plan-parity.test.ts`. It is
// pinned there because that is where the property lives.
//
// What is left is the one thing a behavioural test on the seam cannot see: that
// the DB-bound call sites still ROUTE through it. `resolveChatMcpCatalogState`
// and `buildDelegatedChatCapabilityPlan` both need the whole connector/module
// graph and a database, so a behavioural test of them is a test of a mock. A
// seeding site that went back to reading a static name list would leave every
// seam test green while shipping a catalog the perimeter never agreed to.
// ---------------------------------------------------------------------------

const runtimeSource = readFileSync(new URL("../runtime.ts", import.meta.url), "utf8");
const mcpServerSource = readFileSync(new URL("../../mcp-server.ts", import.meta.url), "utf8");

describe("the chat catalog seeds from the request-scoped capability plan", () => {
  it("resolveChatMcpCatalogState builds a plan and maps its SERVABLE subset", () => {
    expect(runtimeSource).toContain("buildDelegatedChatCapabilityPlan({");
    expect(runtimeSource).toContain("plan.servable.map((entry)");
  });

  it("the catalog no longer reads the static allowed-name accessor", () => {
    // The accessor is what #2777 had to seed from, and what this slice
    // replaces. Reading it here again would restore the two-answer shape.
    expect(runtimeSource).not.toContain("delegatedChatAllowedToolNames()");
  });

  it("the capability key resolved from the LIVE connector catalog rides the plan", () => {
    // The key must be resolved as part of PLANNING, not bolted on afterwards:
    // slice 3's evaluator reads it off the planned entry, and a key computed on
    // a second walk could disagree with the one the plan carries.
    expect(runtimeSource).toContain("resolveCapabilityKey: capabilityKeyFor");
    expect(runtimeSource).toContain("capabilityKey: entry.capabilityKey");
  });

  it("buildDelegatedChatCapabilityPlan runs ONE delegated-chat registration pass", () => {
    expect(mcpServerSource).toContain('toolPolicyMode: "delegated-chat"');
    expect(mcpServerSource).toContain("registerCapabilities: registerAllCapabilities");
    expect(mcpServerSource).toContain("onCapabilityPlan:");
  });

  it("an unemitted plan reads as EMPTY, never as everything", () => {
    expect(mcpServerSource).toContain("return { entries: [], outcomes: [], servable: [] };");
  });
});


// ---------------------------------------------------------------------------
// THE SAME SEAM, ASSERTED ON THE MODULE GRAPH.
//
// The literal-fragment checks above are brittle in BOTH directions: splitting
// `buildDelegatedChatCapabilityPlan({` across lines turns them red with no
// behaviour change, and a rename that happens to preserve the substring keeps
// them green. They stay, because they pin the CALL SHAPE that a graph check
// cannot see. This block pins the REACHABILITY instead, which survives any
// reformatting: the seeding site can still get to the builder, and the deleted
// static accessor cannot come back through ANY path in that graph, not just
// through this one file's own text.
// ---------------------------------------------------------------------------

const APP_ROOT = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));

/** Resolve one specifier to an app-owned .ts/.tsx file, or null. */
function resolveAppModule(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = resolve(APP_ROOT, "src", spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else return null; // workspace package or node_modules: not the app graph
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (candidate.endsWith(".ts") || candidate.endsWith(".tsx")) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Every app-owned module reachable from `entry`, static and dynamic edges alike. */
function reachableAppModules(entry: string): Set<string> {
  const seen = new Set([entry]);
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    let source: string;
    try {
      source = readFileSync(current, "utf8");
    } catch {
      continue;
    }
    const specs = new Set<string>();
    for (const re of [
      /\b(?:import|export)\s[^'"`;]*?\bfrom\s*["']([^"']+)["']/g,
      /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    ]) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(source)) !== null) specs.add(m[1]);
    }
    for (const spec of specs) {
      const abs = resolveAppModule(spec, current);
      if (abs && !seen.has(abs)) {
        seen.add(abs);
        queue.push(abs);
      }
    }
  }
  return seen;
}

describe("the seeding site's module graph", () => {
  const runtimeModule = resolve(APP_ROOT, "src/lib/assistant-runtime/runtime.ts");
  const builderModule = resolve(APP_ROOT, "src/lib/mcp-server.ts");
  const graph = reachableAppModules(runtimeModule);

  it("resolveChatMcpCatalogState can REACH the plan builder's module", () => {
    expect(graph.has(builderModule)).toBe(true);
  });

  it("that module is the one that EXPORTS the builder", () => {
    expect(readFileSync(builderModule, "utf8")).toMatch(
      /export\s+(?:async\s+)?function\s+buildDelegatedChatCapabilityPlan\b/,
    );
  });

  it("the deleted static accessor is not reachable through ANY path in that graph", () => {
    const offenders = [...graph].filter((file) =>
      /\bdelegatedChatAllowedToolNames\b/.test(readFileSync(file, "utf8")),
    );
    expect(offenders.map((f) => f.slice(APP_ROOT.length + 1))).toEqual([]);
  });
});

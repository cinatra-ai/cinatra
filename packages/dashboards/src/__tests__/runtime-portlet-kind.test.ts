import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __resetPortletRegistryForTests,
  getPortletKind,
  isRuntimePortletKind,
  registerRuntimePortletKind,
  unregisterRuntimePortletKind,
  unregisterRuntimePortletKindsForPackage,
} from "../portlets/registry";
import { registerCorePortletKinds, hostBundledPortletKinds } from "../portlets/kinds";

const V = "1.0.0";
const hasComponentFor = (kind: string) => new Set(hostBundledPortletKinds()).has(kind);

beforeEach(() => {
  __resetPortletRegistryForTests();
  registerCorePortletKinds();
});
afterEach(() => {
  __resetPortletRegistryForTests();
});

describe("registerRuntimePortletKind", () => {
  it("registers a runtime kind that rendersAs an existing bundled-component kind, inheriting its descriptor", () => {
    const r = registerRuntimePortletKind(
      { kind: "ext_task_list", version: V, rendersAs: "object-list", sourcePackageName: "@x/pkg", activationGeneration: 1 },
      { hasComponentFor },
    );
    expect(r.ok).toBe(true);
    const entry = getPortletKind("ext_task_list", V);
    expect(entry?.rendersAs).toBe("object-list");
    expect(entry?.sourcePackageName).toBe("@x/pkg");
    // Inherits object-list's scope op + keys.
    expect(entry?.scopePolicy.op).toBe("object.read");
    expect(entry?.inputKeys).toEqual(["parentId"]);
    expect(isRuntimePortletKind("ext_task_list", V)).toBe(true);
  });

  it("REJECTS rendersAs targeting a kind with no bundled component", () => {
    const r = registerRuntimePortletKind(
      { kind: "ext_x", version: V, rendersAs: "no-such-component-kind", sourcePackageName: "@x/pkg", activationGeneration: 1 },
      { hasComponentFor },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(["portlet_renders_as_unknown", "portlet_renders_as_no_component"]).toContain(r.code);
  });

  it("REJECTS a rendersAs that is a registered kind but has no bundled component", () => {
    // Register a core kind under a name NOT in the component map, then try to alias it.
    const r = registerRuntimePortletKind(
      { kind: "ext_x", version: V, rendersAs: "object-list", sourcePackageName: "@x/pkg", activationGeneration: 1 },
      { hasComponentFor: () => false },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("portlet_renders_as_no_component");
  });

  it("REJECTS a runtime kind colliding with a BUNDLED kind id", () => {
    const r = registerRuntimePortletKind(
      { kind: "object-list", version: V, rendersAs: "object-detail", sourcePackageName: "@x/pkg", activationGeneration: 1 },
      { hasComponentFor },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("portlet_kind_collision");
  });

  it("REJECTS a runtime kind colliding with ANOTHER package's runtime kind", () => {
    registerRuntimePortletKind(
      { kind: "ext_shared", version: V, rendersAs: "object-list", sourcePackageName: "@x/pkg", activationGeneration: 1 },
      { hasComponentFor },
    );
    const r = registerRuntimePortletKind(
      { kind: "ext_shared", version: V, rendersAs: "object-detail", sourcePackageName: "@y/other", activationGeneration: 1 },
      { hasComponentFor },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("portlet_kind_collision");
  });

  it("same-package re-register replaces idempotently", () => {
    registerRuntimePortletKind(
      { kind: "ext_a", version: V, rendersAs: "object-list", sourcePackageName: "@x/pkg", activationGeneration: 1 },
      { hasComponentFor },
    );
    const r = registerRuntimePortletKind(
      { kind: "ext_a", version: V, rendersAs: "object-detail", sourcePackageName: "@x/pkg", activationGeneration: 2 },
      { hasComponentFor },
    );
    expect(r.ok).toBe(true);
    expect(getPortletKind("ext_a", V)?.rendersAs).toBe("object-detail");
  });

  it("unregisters by package (teardown)", () => {
    registerRuntimePortletKind(
      { kind: "ext_a", version: V, rendersAs: "object-list", sourcePackageName: "@x/pkg", activationGeneration: 1 },
      { hasComponentFor },
    );
    registerRuntimePortletKind(
      { kind: "ext_b", version: V, rendersAs: "object-detail", sourcePackageName: "@x/pkg", activationGeneration: 1 },
      { hasComponentFor },
    );
    const removed = unregisterRuntimePortletKindsForPackage("@x/pkg");
    expect(new Set(removed)).toEqual(new Set(["ext_a", "ext_b"]));
    expect(getPortletKind("ext_a", V)).toBeUndefined();
  });

  it("unregisterRuntimePortletKind refuses to remove a kind owned by another package / bundled kind", () => {
    registerRuntimePortletKind(
      { kind: "ext_a", version: V, rendersAs: "object-list", sourcePackageName: "@x/pkg", activationGeneration: 1 },
      { hasComponentFor },
    );
    expect(unregisterRuntimePortletKind("ext_a", V, "@y/other")).toBe(false);
    expect(unregisterRuntimePortletKind("object-list", V, "@x/pkg")).toBe(false); // bundled
    expect(getPortletKind("ext_a", V)).toBeDefined();
  });
});

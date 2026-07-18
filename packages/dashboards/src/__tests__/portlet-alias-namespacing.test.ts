import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __resetPortletRegistryForTests,
  getPortletKind,
  registerRuntimePortletKind,
  unregisterRuntimePortletKindsForPackage,
  portletAliasNamespace,
  isInstallScopedPortletAlias,
} from "../portlets/registry";
import { registerCorePortletKinds, hostBundledPortletKinds } from "../portlets/kinds";

const V = "1.0.0";
const hasComponentFor = (kind: string) => new Set(hostBundledPortletKinds()).has(kind);

beforeEach(() => {
  __resetPortletRegistryForTests();
  registerCorePortletKinds();
});
afterEach(() => __resetPortletRegistryForTests());

describe("portletAliasNamespace (cinatra#1628, S11c / AC4)", () => {
  it("derives a safe token from a scoped package name", () => {
    expect(portletAliasNamespace("@cinatra-ai/blog-agent")).toBe("blog_agent");
    expect(portletAliasNamespace("@acme/Cool.Widgets")).toBe("cool_widgets");
    expect(portletAliasNamespace("plain-pkg")).toBe("plain_pkg");
  });
  it("falls back to `ext` for an unusable name", () => {
    expect(portletAliasNamespace("@scope/")).toBe("ext");
    expect(portletAliasNamespace("")).toBe("ext");
  });
});

describe("isInstallScopedPortletAlias (cinatra#1628, S11c / AC4)", () => {
  const PKG = "@cinatra-ai/blog-agent";
  it("accepts an alias namespaced to the source package", () => {
    expect(isInstallScopedPortletAlias("blog_agent__task_list", PKG)).toBe(true);
  });
  it("REJECTS a bare / global-looking alias (squat attempt)", () => {
    expect(isInstallScopedPortletAlias("task_list", PKG)).toBe(false);
    expect(isInstallScopedPortletAlias("object-list", PKG)).toBe(false);
  });
  it("REJECTS an alias namespaced to a DIFFERENT package (cross-tenant squat)", () => {
    expect(isInstallScopedPortletAlias("other_pkg__task_list", PKG)).toBe(false);
  });
  it("REJECTS the prefix with no local segment", () => {
    expect(isInstallScopedPortletAlias("blog_agent__", PKG)).toBe(false);
  });
});

describe("install-scoped alias: registry collision + teardown", () => {
  it("rejects a namespaced-id collision from a DIFFERENT source package", () => {
    const A = registerRuntimePortletKind(
      { kind: "blog_agent__list", version: V, rendersAs: "object-list", sourcePackageName: "@cinatra-ai/blog-agent", activationGeneration: 1 },
      { hasComponentFor },
    );
    expect(A.ok).toBe(true);
    // Package B trying to register the SAME kind id (even though B should have
    // namespaced its own) is rejected — the registry's cross-source collision.
    const B = registerRuntimePortletKind(
      { kind: "blog_agent__list", version: V, rendersAs: "object-detail", sourcePackageName: "@evil/other", activationGeneration: 1 },
      { hasComponentFor },
    );
    expect(B.ok).toBe(false);
    if (!B.ok) expect(B.code).toBe("portlet_kind_collision");
  });

  it("uninstall teardown removes exactly the package's namespaced aliases", () => {
    registerRuntimePortletKind(
      { kind: "blog_agent__a", version: V, rendersAs: "object-list", sourcePackageName: "@cinatra-ai/blog-agent", activationGeneration: 1 },
      { hasComponentFor },
    );
    registerRuntimePortletKind(
      { kind: "other__b", version: V, rendersAs: "object-detail", sourcePackageName: "@other/pkg", activationGeneration: 1 },
      { hasComponentFor },
    );
    const removed = unregisterRuntimePortletKindsForPackage("@cinatra-ai/blog-agent");
    expect(removed).toEqual(["blog_agent__a"]);
    expect(getPortletKind("blog_agent__a", V)).toBeUndefined();
    // The other package's alias is untouched (no cross-tenant teardown).
    expect(getPortletKind("other__b", V)).toBeDefined();
  });
});

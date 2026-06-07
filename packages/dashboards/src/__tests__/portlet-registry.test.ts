import { describe, it, expect, beforeEach } from "vitest";
import {
  registerPortletKind,
  getPortletKind,
  getPortletKindDescriptor,
  validatePortletConfig,
  __resetPortletRegistryForTests,
  type PortletKindEntry,
} from "../portlets/registry";

const objectList: PortletKindEntry = {
  kind: "object-list",
  version: "1.0.0",
  scopePolicy: { scopeFrom: "session", resource: "object", op: "object.read" },
  inputKeys: ["parentId"],
  outputKeys: ["selectedId"],
};

describe("portlet registry (PORT-01)", () => {
  beforeEach(() => __resetPortletRegistryForTests());

  it("registers + looks up by kind@version", () => {
    registerPortletKind(objectList);
    expect(getPortletKind("object-list", "1.0.0")?.kind).toBe("object-list");
    expect(getPortletKind("object-list", "9.9.9")).toBeUndefined();
    expect(getPortletKind("nope", "1.0.0")).toBeUndefined();
  });

  it("getPortletKindDescriptor returns the DASH-02-compatible shape", () => {
    registerPortletKind(objectList);
    expect(getPortletKindDescriptor("object-list", "1.0.0")).toEqual({
      kind: "object-list",
      version: "1.0.0",
      inputKeys: ["parentId"],
      outputKeys: ["selectedId"],
    });
    expect(getPortletKindDescriptor("object-list", "2.0.0")).toBeUndefined();
  });

  it("throws when a kind registers without a session scopePolicy", () => {
    expect(() =>
      registerPortletKind({ ...objectList, scopePolicy: undefined as never }),
    ).toThrow(/scopePolicy/);
    expect(() =>
      registerPortletKind({ ...objectList, scopePolicy: { scopeFrom: "caller" } as never }),
    ).toThrow(/scopePolicy/);
  });

  it("validatePortletConfig: unknown kind fails closed; per-kind validator runs", () => {
    registerPortletKind({
      ...objectList,
      kind: "artifact-edit-text",
      validateConfig: (portlet) =>
        portlet.config.refSwapPrimitive ? [] : [{ code: "port_edit_text_missing_refswap", message: "refSwapPrimitive required" }],
    });
    expect(validatePortletConfig("ghost", "1.0.0", { config: {} })[0].code).toBe("portlet_kind_unknown");
    expect(validatePortletConfig("artifact-edit-text", "1.0.0", { config: {} })[0].code).toBe("port_edit_text_missing_refswap");
    expect(validatePortletConfig("artifact-edit-text", "1.0.0", { config: { refSwapPrimitive: "blog_post_update" } })).toEqual([]);
  });
});

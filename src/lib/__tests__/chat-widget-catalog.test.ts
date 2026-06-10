import { describe, it, expect } from "vitest";
import {
  pickChatWidgetDefinitions,
  pickChatWidgetManifest,
  assertChatWidgetCatalogInvariants,
} from "@/lib/chat-widget-catalog.server";
import type { WidgetDefinition, WidgetManifest } from "@cinatra-ai/sdk-ui";

// Structural export discovery + catalog invariants (#34). The discovery is
// shape-based (no export names recorded anywhere), exactly-one per module,
// FAIL LOUDLY on zero/ambiguous — owner decision: no benign fallback.

const Component = (() => null) as unknown as WidgetDefinition["component"];

const defs: WidgetDefinition[] = [
  { id: "acme-connector.finder", label: "Find a thing", component: Component },
];

const manifest: WidgetManifest = {
  id: "acme-connector",
  description: "Use when the user wants to find a thing.",
};

describe("pickChatWidgetDefinitions (structural discovery)", () => {
  it("picks the single WidgetDefinition[] export among unrelated exports", () => {
    const ns = {
      acmeWidgets: defs,
      acmeManifest: manifest, // manifest-shaped — not an array, skipped
      AcmeFinderWidget: Component, // bare component export, skipped
      __esModule: true,
    };
    expect(pickChatWidgetDefinitions(ns, "acme widgets")).toBe(defs);
  });

  it("accepts client-reference-shaped components (RSC import yields tagged objects)", () => {
    const clientRef = { $$typeof: Symbol.for("react.client.reference") };
    const refDefs = [{ id: "x.y", label: "X", component: clientRef }];
    const ns = { widgets: refDefs };
    expect(pickChatWidgetDefinitions(ns, "ref widgets")).toBe(refDefs);
  });

  it("throws on zero matching exports", () => {
    expect(() => pickChatWidgetDefinitions({ nothing: 42 }, "empty widgets")).toThrow(
      /expected exactly one WidgetDefinition\[\] export, found 0/,
    );
  });

  it("throws on ambiguous (multiple) matching exports, naming them", () => {
    const ns = { a: defs, b: [{ id: "z", label: "Z", component: Component }] };
    expect(() => pickChatWidgetDefinitions(ns, "ambiguous widgets")).toThrow(
      /found 2 \(a, b\)/,
    );
  });

  it("rejects arrays whose elements lack a renderable component value", () => {
    const ns = { widgets: [{ id: "x", label: "X", component: "not-a-component" }] };
    expect(() => pickChatWidgetDefinitions(ns, "bad widgets")).toThrow(/found 0/);
  });

  it("survives hostile exports that throw on property access", () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("boom");
        },
        ownKeys() {
          throw new Error("boom");
        },
      },
    );
    expect(pickChatWidgetDefinitions({ hostile, widgets: defs }, "hostile widgets")).toBe(defs);
  });
});

describe("pickChatWidgetManifest (structural discovery)", () => {
  it("picks the single WidgetManifest export among unrelated exports", () => {
    const ns = { acmeManifest: manifest, helper: () => null };
    expect(pickChatWidgetManifest(ns, "acme manifest")).toBe(manifest);
  });

  it("does not mistake a WidgetDefinition (has component) for a manifest", () => {
    const ns = {
      manifest,
      single: { id: "x", label: "X", description: "looks close", component: Component },
    };
    expect(pickChatWidgetManifest(ns, "mixed manifest")).toBe(manifest);
  });

  it("throws on zero matches", () => {
    expect(() => pickChatWidgetManifest({ x: 1 }, "no manifest")).toThrow(
      /expected exactly one WidgetManifest export, found 0/,
    );
  });

  it("throws on multiple matches", () => {
    const ns = { a: manifest, b: { id: "other", description: "second manifest" } };
    expect(() => pickChatWidgetManifest(ns, "two manifests")).toThrow(/found 2 \(a, b\)/);
  });
});

describe("assertChatWidgetCatalogInvariants", () => {
  const pkg = (
    packageName: string,
    widgetIds: string[],
    manifestId: string,
    wizardSteps?: string[],
  ) => ({
    packageName,
    widgets: widgetIds.map((id) => ({ id, label: id, component: Component })),
    manifest: {
      id: manifestId,
      description: "d",
      ...(wizardSteps
        ? {
            wizard: {
              steps: wizardSteps.map((widgetId) => ({ widgetId, description: widgetId })),
              stepLabels: {},
              staging: {
                resourceType: "r",
                resourceIdArg: "id",
                createTools: [],
                updateTools: [],
              },
              confirmation: {
                resourceType: "r",
                buttonLabel: "Go",
                activateEndpoint: "/api/r/{resourceId}",
                successMessage: "ok",
              },
            },
          }
        : {}),
    } as WidgetManifest,
  });

  it("accepts a well-formed multi-package catalog", () => {
    expect(() =>
      assertChatWidgetCatalogInvariants([
        pkg("@x/a", ["a.one", "a.two"], "a", ["a.one", "a.two"]),
        pkg("@x/b", ["b.one"], "b"),
      ]),
    ).not.toThrow();
  });

  it("throws on duplicate widget ids across packages", () => {
    expect(() =>
      assertChatWidgetCatalogInvariants([pkg("@x/a", ["dup.id"], "a"), pkg("@x/b", ["dup.id"], "b")]),
    ).toThrow(/duplicate widget id "dup\.id" \(@x\/a and @x\/b\)/);
  });

  it("throws on duplicate manifest ids", () => {
    expect(() =>
      assertChatWidgetCatalogInvariants([pkg("@x/a", ["a.one"], "same"), pkg("@x/b", ["b.one"], "same")]),
    ).toThrow(/duplicate widget-manifest id "same"/);
  });

  it("throws when a wizard step references a widget the package does not define", () => {
    expect(() =>
      assertChatWidgetCatalogInvariants([pkg("@x/a", ["a.one"], "a", ["a.one", "a.missing"])]),
    ).toThrow(/wizard step references unknown widget id "a\.missing"/);
  });
});

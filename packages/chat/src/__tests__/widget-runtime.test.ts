import { describe, it, expect } from "vitest";
import { createChatWidgetRuntime, EMPTY_WIDGETS, EMPTY_WIDGET_MANIFESTS } from "../widget-runtime";
import type { WidgetDefinition, WidgetManifest } from "@cinatra-ai/sdk-ui";

// The manifest-driven widget runtime (#34 / IOC-39): every detection/wizard/refresh
// structure chat-page.tsx used to build at module level from static extension
// imports is now derived from the props-resolved catalog by this pure factory.

const Component = (() => null) as unknown as WidgetDefinition["component"];

const RES_ID = "0f5a3c2e-9d4b-4f6a-8b1c-2d3e4f5a6b7c";

const widgets: WidgetDefinition[] = [
  { id: "acme-connector.finder", label: "Find a thing", component: Component },
  { id: "acme-connector.editor", label: "Edit a thing", component: Component },
];

const wizardManifest: WidgetManifest = {
  id: "acme-connector",
  description: "Acme widgets.",
  refreshToolPatterns: ["acme_update", "acme_create"],
  detectors: [
    {
      pattern: "#?/things/([a-f0-9-]{36})",
      widgetId: "acme-connector.finder",
      resourceIdGroups: 1,
    },
  ],
  wizard: {
    steps: [
      { widgetId: "acme-connector.finder", description: "Find it" },
      { widgetId: "acme-connector.editor", description: "Edit it" },
    ],
    stepLabels: {
      "acme-connector.finder": "Thing found.",
      "acme-connector.editor": "Thing edited.",
    },
    staging: {
      resourceType: "thing",
      resourceIdArg: "thingId",
      createTools: ["acme_create"],
      updateTools: ["acme_update"],
    },
    confirmation: {
      resourceType: "thing",
      buttonLabel: "Create thing",
      activateEndpoint: "/api/things/{resourceId}/activate",
      successMessage: "Thing created.",
    },
  },
} as WidgetManifest;

const runtime = createChatWidgetRuntime(widgets, [wizardManifest]);

describe("detectWidgets", () => {
  it("detects inline [widget:id:resourceId] embeds for registered widgets only", () => {
    const content = `Here you go [widget:acme-connector.finder:${RES_ID}] and an unknown [widget:ghost.widget:${RES_ID}]`;
    expect(runtime.detectWidgets(content)).toEqual([
      {
        widgetId: "acme-connector.finder",
        resourceId: RES_ID,
        label: "Find a thing",
        href: "#",
      },
    ]);
  });

  it("dedupes repeated embeds of the same widget+resource", () => {
    const tag = `[widget:acme-connector.finder:${RES_ID}]`;
    expect(runtime.detectWidgets(`${tag} ${tag}`)).toHaveLength(1);
  });

  it("detects manifest-declared URL detectors and strips the leading #", () => {
    const detected = runtime.detectWidgets(`See #/things/${RES_ID}`);
    expect(detected).toEqual([
      {
        widgetId: "acme-connector.finder",
        resourceId: RES_ID,
        label: "Find a thing",
        href: `/things/${RES_ID}`,
      },
    ]);
  });

  it("returns nothing on an empty runtime (no widget-bearing extensions live)", () => {
    const empty = createChatWidgetRuntime(EMPTY_WIDGETS, EMPTY_WIDGET_MANIFESTS);
    expect(empty.detectWidgets(`[widget:acme-connector.finder:${RES_ID}]`)).toEqual([]);
  });
});

describe("wizard helpers", () => {
  it("getNextWizardStep advances within the manifest sequence and ends with null", () => {
    expect(runtime.getNextWizardStep("acme-connector.finder")).toBe("acme-connector.editor");
    expect(runtime.getNextWizardStep("acme-connector.editor")).toBeNull();
    expect(runtime.getNextWizardStep("ghost.widget")).toBeNull();
  });

  it("isWizardStep / getWizardManifest / wizardStepLabel resolve from the manifest", () => {
    expect(runtime.isWizardStep("acme-connector.editor")).toBe(true);
    expect(runtime.isWizardStep("ghost.widget")).toBe(false);
    expect(runtime.getWizardManifest("acme-connector.finder")).toBe(wizardManifest);
    expect(runtime.wizardStepLabel("acme-connector.finder")).toBe("Thing found.");
    expect(runtime.wizardStepLabel("ghost.widget")).toBeUndefined();
  });

  it("findManifestByConfirmationResourceType matches the wizard confirmation", () => {
    expect(runtime.findManifestByConfirmationResourceType("thing")).toBe(wizardManifest);
    expect(runtime.findManifestByConfirmationResourceType("ghost")).toBeUndefined();
  });
});

describe("isWidgetRefreshTool", () => {
  it("matches manifest refreshToolPatterns case-insensitively by substring", () => {
    expect(runtime.isWidgetRefreshTool("ACME_UPDATE_THING")).toBe(true);
    expect(runtime.isWidgetRefreshTool("other_tool")).toBe(false);
  });

  it("matches nothing on an empty runtime", () => {
    const empty = createChatWidgetRuntime([], []);
    expect(empty.isWidgetRefreshTool("acme_update")).toBe(false);
  });
});

describe("findWidget", () => {
  it("resolves registered widget definitions by id", () => {
    expect(runtime.findWidget("acme-connector.editor")).toBe(widgets[1]);
    expect(runtime.findWidget("ghost.widget")).toBeUndefined();
  });
});

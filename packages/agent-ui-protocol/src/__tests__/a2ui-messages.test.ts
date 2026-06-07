import { describe, expect, it } from "vitest";
import {
  A2UI_MESSAGE_TYPES,
} from "../a2ui-messages";
import type {
  A2UiMessageType,
  A2UiMessage,
  CreateSurfaceMessage,
  UpdateComponentsMessage,
  UpdateDataModelMessage,
  DeleteSurfaceMessage,
  ComponentDefinition,
} from "../a2ui-messages";

describe("a2ui-messages type definitions", () => {
  it("A2UI_MESSAGE_TYPES is a const array with 4 message types", () => {
    expect(Array.isArray(A2UI_MESSAGE_TYPES)).toBe(true);
    expect(A2UI_MESSAGE_TYPES).toContain("createSurface");
    expect(A2UI_MESSAGE_TYPES).toContain("updateComponents");
    expect(A2UI_MESSAGE_TYPES).toContain("updateDataModel");
    expect(A2UI_MESSAGE_TYPES).toContain("deleteSurface");
    expect(A2UI_MESSAGE_TYPES).toHaveLength(4);
  });

  it("CreateSurfaceMessage has correct shape", () => {
    const msg: CreateSurfaceMessage = {
      version: "v0.9",
      createSurface: { surfaceId: "test-surface", catalogId: "cinatra-default" },
    };
    expect(msg.version).toBe("v0.9");
    expect(msg.createSurface.surfaceId).toBe("test-surface");
    expect(msg.createSurface.catalogId).toBe("cinatra-default");
  });

  it("UpdateComponentsMessage has correct shape", () => {
    const comp: ComponentDefinition = {
      id: "root",
      component: "Column",
    };
    const msg: UpdateComponentsMessage = {
      version: "v0.9",
      updateComponents: { surfaceId: "test-surface", components: [comp] },
    };
    expect(msg.updateComponents.components).toHaveLength(1);
  });

  it("UpdateDataModelMessage has correct shape", () => {
    const msg: UpdateDataModelMessage = {
      version: "v0.9",
      updateDataModel: { surfaceId: "test-surface", path: "/", value: { rows: [] } },
    };
    expect(msg.updateDataModel.path).toBe("/");
  });

  it("DeleteSurfaceMessage has correct shape", () => {
    const msg: DeleteSurfaceMessage = {
      version: "v0.9",
      deleteSurface: { surfaceId: "test-surface" },
    };
    expect(msg.deleteSurface.surfaceId).toBe("test-surface");
  });

  it("A2UiMessage union type accepts all variants", () => {
    const msgs: A2UiMessage[] = [
      { version: "v0.9", createSurface: { surfaceId: "s1", catalogId: "cinatra-default" } },
      { version: "v0.9", updateComponents: { surfaceId: "s1", components: [] } },
      { version: "v0.9", updateDataModel: { surfaceId: "s1", path: "/", value: null } },
      { version: "v0.9", deleteSurface: { surfaceId: "s1" } },
    ];
    expect(msgs).toHaveLength(4);
  });

  it("A2UiMessageType is inferred from A2UI_MESSAGE_TYPES", () => {
    const t: A2UiMessageType = "createSurface";
    expect(A2UI_MESSAGE_TYPES).toContain(t);
  });
});

import { describe, expect, it } from "vitest";
import {
  translateHintToA2UiMessages,
  translateSetupGroupToA2UiMessages,
  // Mid-run translators are imported here to verify the public translator exports.
  translateRecipientsOutputToA2Ui,
  translateDraftsOutputToA2Ui,
  translateSendOutputToA2Ui,
  A2UI_DEFAULT_CATALOG_ID,
} from "../a2ui-translator";
import type { UpdateDataModelMessage, UpdateComponentsMessage } from "../a2ui-messages";

describe("translateHintToA2UiMessages", () => {
  // A2UI-07: pure function — no async needed, no external calls
  it("A2UI-07: is a synchronous pure function (no async required)", () => {
    const result = translateHintToA2UiMessages("surf-1", { type: "card_list", items: [] });
    expect(Array.isArray(result)).toBe(true);
  });

  it("A2UI-04: null hint returns empty array", () => {
    expect(translateHintToA2UiMessages("surf-1", null)).toEqual([]);
  });

  it("A2UI-04: undefined hint returns empty array", () => {
    expect(translateHintToA2UiMessages("surf-1", undefined)).toEqual([]);
  });

  it("A2UI-04: tool_call_summary hint returns empty array", () => {
    expect(translateHintToA2UiMessages("surf-1", { type: "tool_call_summary" })).toEqual([]);
  });

  it("unknown hint type returns empty array", () => {
    expect(translateHintToA2UiMessages("surf-1", { type: "unknown_type" })).toEqual([]);
  });

  describe("A2UI-01: contacts_table", () => {
    const hint = {
      type: "contacts_table" as const,
      columns: ["name", "email"],
      rows: [{ name: "Alice", email: "alice@example.com" }],
      title: "Contacts",
    };

    it("returns updateComponents as first message with correct surfaceId", () => {
      const msgs = translateHintToA2UiMessages("run-001", hint);
      const update = msgs[0] as UpdateComponentsMessage;
      expect(update.version).toBe("v0.9");
      expect(update.updateComponents.surfaceId).toBe("run-001");
      expect(update.updateComponents.components.length).toBeGreaterThan(0);
    });

    it("returns updateDataModel with rows", () => {
      const msgs = translateHintToA2UiMessages("run-001", hint);
      const dataMsg = msgs[1] as UpdateDataModelMessage;
      expect(dataMsg.version).toBe("v0.9");
      expect(dataMsg.updateDataModel.surfaceId).toBe("run-001");
      const val = dataMsg.updateDataModel.value as { rows: unknown[] };
      expect(val.rows).toEqual(hint.rows);
    });

    it("produces exactly 2 messages", () => {
      const msgs = translateHintToA2UiMessages("run-001", hint);
      expect(msgs).toHaveLength(2);
    });
  });

  describe("A2UI-02: card_list", () => {
    const hint = {
      type: "card_list" as const,
      items: [{ title: "Card A", description: "Desc A" }],
      title: "My Cards",
    };

    it("returns updateComponents as first message with correct surfaceId", () => {
      const msgs = translateHintToA2UiMessages("run-002", hint);
      const update = msgs[0] as UpdateComponentsMessage;
      expect(update.updateComponents.surfaceId).toBe("run-002");
    });

    it("returns updateDataModel with items", () => {
      const msgs = translateHintToA2UiMessages("run-002", hint);
      const dataMsg = msgs[1] as UpdateDataModelMessage;
      const val = dataMsg.updateDataModel.value as { items: unknown[] };
      expect(val.items).toEqual(hint.items);
    });

    it("produces exactly 2 messages", () => {
      expect(translateHintToA2UiMessages("run-002", hint)).toHaveLength(2);
    });
  });

  describe("A2UI-03: text_sections", () => {
    const hint = {
      type: "text_sections" as const,
      sections: [
        { heading: "Intro", body: "Some text" },
        { heading: "Details", body: "More text" },
      ],
      title: "Report",
    };

    it("returns updateComponents as first and only message (no updateDataModel)", () => {
      const msgs = translateHintToA2UiMessages("run-003", hint);
      expect(msgs).toHaveLength(1);
      const first = msgs[0] as UpdateComponentsMessage;
      expect(first.updateComponents).toBeDefined();
      expect(first.updateComponents.surfaceId).toBe("run-003");
    });

    it("components include section heading texts as literals", () => {
      const msgs = translateHintToA2UiMessages("run-003", hint);
      const update = msgs[0] as UpdateComponentsMessage;
      const componentTexts = update.updateComponents.components
        .map((c) => c["text"])
        .filter(Boolean);
      expect(componentTexts).toContain("Intro");
      expect(componentTexts).toContain("Details");
    });
  });
});

describe("translateSetupGroupToA2UiMessages", () => {
  const baseSchema = {
    type: "object",
    properties: {
      website: { type: "string", title: "Website", format: "uri" },
      senderName: { type: "string", title: "Sender name" }, // optional
      followUp: { type: "array", title: "Follow-up", items: { type: "integer" } },
    },
    required: ["website", "followUp"],
  };

  it("returns exactly 3 messages in order: createSurface, updateComponents, updateDataModel", () => {
    const msgs = translateSetupGroupToA2UiMessages("surf-1", baseSchema, { website: "https://a.com" }, "rt-1");
    expect(msgs).toHaveLength(3);
    expect("createSurface" in msgs[0]).toBe(true);
    expect("updateComponents" in msgs[1]).toBe(true);
    expect("updateDataModel" in msgs[2]).toBe(true);
  });

  it("createSurface includes catalogId === 'cinatra-default' and sendDataModel === true", () => {
    const msgs = translateSetupGroupToA2UiMessages("surf-1", baseSchema, {}, "rt-1");
    const first = msgs[0] as { createSurface: { catalogId: string; sendDataModel: boolean } };
    expect(first.createSurface.catalogId).toBe("cinatra-default");
    expect(first.createSurface.catalogId).toBe(A2UI_DEFAULT_CATALOG_ID);
    expect(first.createSurface.sendDataModel).toBe(true);
  });

  it("updateComponents root Column.children orders required fields first, then optional, ending with submit-btn-label + submit-btn", () => {
    const msgs = translateSetupGroupToA2UiMessages("surf-1", baseSchema, {}, "rt-1");
    const update = msgs[1] as { updateComponents: { components: Array<{ id: string; component: string; children?: string[] }> } };
    const root = update.updateComponents.components.find((c) => c.id === "root");
    expect(root?.children).toEqual(["title", "field-website", "field-followUp", "field-senderName", "submit-btn-label", "submit-btn"]);
  });

  it("submit Button has variant 'primary' and action.event.name === 'approve_review_task' with context.reviewTaskId.literal === passed reviewTaskId", () => {
    const msgs = translateSetupGroupToA2UiMessages("surf-1", baseSchema, {}, "rt-42");
    const update = msgs[1] as { updateComponents: { components: Array<Record<string, unknown>> } };
    const btn = update.updateComponents.components.find((c) => c.id === "submit-btn") as Record<string, unknown>;
    expect(btn.variant).toBe("primary");
    expect(btn.child).toBe("submit-btn-label");
    expect(btn.action).toMatchObject({ event: { name: "approve_review_task", context: { reviewTaskId: { literal: "rt-42" }, values: { path: "/" } } } });
  });

  it("excludes x-hidden fields from components AND from root children", () => {
    const schemaWithHidden = {
      type: "object",
      properties: {
        website: { type: "string", title: "Website" },
        campaignId: { type: "string", title: "Campaign id", "x-hidden": true },
      },
      required: ["website", "campaignId"],
    };
    const msgs = translateSetupGroupToA2UiMessages("surf-1", schemaWithHidden, {}, "rt-1");
    const update = msgs[1] as { updateComponents: { components: Array<{ id: string; children?: string[] }> } };
    const componentIds = update.updateComponents.components.map((c) => c.id);
    expect(componentIds).toContain("field-website");
    expect(componentIds).not.toContain("field-campaignId");
    const root = update.updateComponents.components.find((c) => c.id === "root");
    expect(root?.children).not.toContain("field-campaignId");
  });

  it("updateDataModel.path is '/' and value is the passed currentValues object", () => {
    const current = { website: "https://a.com", senderName: "Alice" };
    const msgs = translateSetupGroupToA2UiMessages("surf-1", baseSchema, current, "rt-1");
    const third = msgs[2] as { updateDataModel: { path: string; value: unknown } };
    expect(third.updateDataModel.path).toBe("/");
    expect(third.updateDataModel.value).toEqual(current);
  });
});

// ---------------------------------------------------------------------------
// Tests for 3 mid-run :output translators.
// ---------------------------------------------------------------------------

type ComponentDef = {
  id: string;
  component: string;
  children?: string[] | { componentId: string; path: string };
  child?: string;
  action?: { event: { name: string; context: Record<string, unknown> } };
  [key: string]: unknown;
};

function findComponent(msgs: unknown[], componentId: string): ComponentDef | undefined {
  const updateMsg = msgs[1] as { updateComponents?: { components?: ComponentDef[] } } | undefined;
  return updateMsg?.updateComponents?.components?.find((c) => c.id === componentId);
}

describe("A2UI recipients translator: translateRecipientsOutputToA2Ui", () => {
  const schema = {
    type: "object",
    properties: { approved: { type: "boolean" } },
    required: ["approved"],
  };
  const values = {
    campaignId: "c1",
    recipients: [{ contactName: "Ada", contactEmail: "ada@acme.com", startupName: "Acme" }],
  };

  it("emits exactly 3 messages: createSurface + updateComponents + updateDataModel", () => {
    const msgs = translateRecipientsOutputToA2Ui("run-1:hitl:rt-1", schema, values, "rt-1");
    expect(msgs).toHaveLength(3);
    expect("createSurface" in msgs[0]).toBe(true);
    const m0 = msgs[0] as { createSurface: { surfaceId: string; catalogId: string } };
    expect(m0.createSurface.surfaceId).toBe("run-1:hitl:rt-1");
    expect(m0.createSurface.catalogId).toBe(A2UI_DEFAULT_CATALOG_ID);
    expect("updateComponents" in msgs[1]).toBe(true);
    const m1 = msgs[1] as { updateComponents: { surfaceId: string } };
    expect(m1.updateComponents.surfaceId).toBe("run-1:hitl:rt-1");
    expect("updateDataModel" in msgs[2]).toBe(true);
    const m2 = msgs[2] as { updateDataModel: { surfaceId: string } };
    expect(m2.updateDataModel.surfaceId).toBe("run-1:hitl:rt-1");
  });

  it("root component is Column with children including title, data-list, actions", () => {
    const msgs = translateRecipientsOutputToA2Ui("run-1:hitl:rt-1", schema, values, "rt-1");
    const root = findComponent(msgs, "root");
    expect(root?.component).toBe("Column");
    expect(Array.isArray(root?.children)).toBe(true);
    const children = root?.children as string[];
    expect(children).toContain("title");
    expect(children).toContain("data-list");
    expect(children).toContain("actions");
  });

  it("Approve Button has action.event.name === 'approve_review_task' with reviewTaskId literal", () => {
    const msgs = translateRecipientsOutputToA2Ui("run-1:hitl:rt-1", schema, values, "rt-1");
    const btn = findComponent(msgs, "btn-approve");
    expect(btn?.action?.event.name).toBe("approve_review_task");
    const ctx = btn?.action?.event.context as Record<string, { literal?: unknown }>;
    expect(ctx?.reviewTaskId?.literal).toBe("rt-1");
  });

  it("Reject Button has action.event.name === 'reject_review_task'", () => {
    const msgs = translateRecipientsOutputToA2Ui("run-1:hitl:rt-1", schema, values, "rt-1");
    const btn = findComponent(msgs, "btn-reject");
    expect(btn?.action?.event.name).toBe("reject_review_task");
  });

  it("List component children uses template form {componentId, path} with path='/recipients'", () => {
    const msgs = translateRecipientsOutputToA2Ui("run-1:hitl:rt-1", schema, values, "rt-1");
    const list = findComponent(msgs, "data-list");
    const children = list?.children as { componentId?: string; path?: string } | undefined;
    expect(typeof children).toBe("object");
    expect(Array.isArray(children)).toBe(false);
    expect(children?.path).toBe("/recipients");
  });
});

describe("A2UI drafts translator: translateDraftsOutputToA2Ui", () => {
  const schema = {
    type: "object",
    properties: { approved: { type: "boolean" } },
    required: ["approved"],
  };
  const values = {
    campaignId: "c1",
    drafts: [{ recipientEmail: "ada@acme.com", subject: "Hi", body: "Hello Ada" }],
  };

  it("emits exactly 3 messages: createSurface + updateComponents + updateDataModel", () => {
    const msgs = translateDraftsOutputToA2Ui("run-1:hitl:rt-1", schema, values, "rt-1");
    expect(msgs).toHaveLength(3);
    expect("createSurface" in msgs[0]).toBe(true);
    const m1 = msgs[1] as { updateComponents: { surfaceId: string } };
    expect(m1.updateComponents.surfaceId).toBe("run-1:hitl:rt-1");
    const m2 = msgs[2] as { updateDataModel: { surfaceId: string } };
    expect(m2.updateDataModel.surfaceId).toBe("run-1:hitl:rt-1");
  });

  it("root component is Column with children including title, data-list, actions", () => {
    const msgs = translateDraftsOutputToA2Ui("run-1:hitl:rt-1", schema, values, "rt-1");
    const root = findComponent(msgs, "root");
    expect(root?.component).toBe("Column");
    const children = root?.children as string[];
    expect(children).toContain("title");
    expect(children).toContain("data-list");
    expect(children).toContain("actions");
  });

  it("Approve Button has action.event.name === 'approve_review_task'", () => {
    const msgs = translateDraftsOutputToA2Ui("run-1:hitl:rt-1", schema, values, "rt-1");
    const btn = findComponent(msgs, "btn-approve");
    expect(btn?.action?.event.name).toBe("approve_review_task");
    const ctx = btn?.action?.event.context as Record<string, { literal?: unknown }>;
    expect(ctx?.reviewTaskId?.literal).toBe("rt-1");
  });

  it("Reject Button has action.event.name === 'reject_review_task'", () => {
    const msgs = translateDraftsOutputToA2Ui("run-1:hitl:rt-1", schema, values, "rt-1");
    const btn = findComponent(msgs, "btn-reject");
    expect(btn?.action?.event.name).toBe("reject_review_task");
  });

  it("List component children uses template form {componentId, path} with path='/drafts'", () => {
    const msgs = translateDraftsOutputToA2Ui("run-1:hitl:rt-1", schema, values, "rt-1");
    const list = findComponent(msgs, "data-list");
    const children = list?.children as { componentId?: string; path?: string } | undefined;
    expect(typeof children).toBe("object");
    expect(Array.isArray(children)).toBe(false);
    expect(children?.path).toBe("/drafts");
  });
});

describe("A2UI send translator: translateSendOutputToA2Ui", () => {
  const schema = {
    type: "object",
    properties: { approved: { type: "boolean" } },
    required: ["approved"],
  };
  const values = {
    campaignId: "c1",
    recipientCount: 12,
    draftCount: 12,
    scheduledAt: "2026-04-18T10:00:00Z",
  };

  it("emits exactly 3 messages: createSurface + updateComponents + updateDataModel", () => {
    const msgs = translateSendOutputToA2Ui("run-1:hitl:rt-1", schema, values, "rt-1");
    expect(msgs).toHaveLength(3);
    expect("createSurface" in msgs[0]).toBe(true);
    const m1 = msgs[1] as { updateComponents: { surfaceId: string } };
    expect(m1.updateComponents.surfaceId).toBe("run-1:hitl:rt-1");
    const m2 = msgs[2] as { updateDataModel: { surfaceId: string } };
    expect(m2.updateDataModel.surfaceId).toBe("run-1:hitl:rt-1");
  });

  it("root component is Column with title, summary-card, and actions children", () => {
    const msgs = translateSendOutputToA2Ui("run-1:hitl:rt-1", schema, values, "rt-1");
    const root = findComponent(msgs, "root");
    expect(root?.component).toBe("Column");
    const children = root?.children as string[];
    expect(children).toContain("title");
    expect(children).toContain("actions");
  });

  it("Approve Button has action.event.name === 'approve_review_task' with reviewTaskId literal", () => {
    const msgs = translateSendOutputToA2Ui("run-1:hitl:rt-1", schema, values, "rt-1");
    const btn = findComponent(msgs, "btn-send");
    expect(btn?.action?.event.name).toBe("approve_review_task");
    const ctx = btn?.action?.event.context as Record<string, { literal?: unknown }>;
    expect(ctx?.reviewTaskId?.literal).toBe("rt-1");
  });

  it("Cancel Button has action.event.name === 'reject_review_task'", () => {
    const msgs = translateSendOutputToA2Ui("run-1:hitl:rt-1", schema, values, "rt-1");
    const btn = findComponent(msgs, "btn-cancel");
    expect(btn?.action?.event.name).toBe("reject_review_task");
  });
});

// ---------------------------------------------------------------------------
// A2UI v0.9 translator — PresentationHint → A2UiMessage[]
//
// Pure function. No side effects. No Redis. No server-only constraint.
// Safe to import in client or server contexts.
//
// DO NOT import PresentationHint from @cinatra/agent-builder — that would
// create a cross-package dependency. Minimal local shapes used instead.
// ---------------------------------------------------------------------------

import type {
  A2UiMessage,
  ComponentDefinition,
  UpdateComponentsMessage,
  UpdateDataModelMessage,
} from "./a2ui-messages";

/**
 * Stable catalog id used across all Cinatra A2UI surface emissions.
 * A2UI v0.9 spec requires catalogId on every createSurface message.
 */
export const A2UI_DEFAULT_CATALOG_ID = "cinatra-default";

// ---------------------------------------------------------------------------
// Minimal local PresentationHint shapes (mirrored from agent-builder).
// Only the fields used in translation are declared.
// ---------------------------------------------------------------------------

type ContactsTableHint = {
  type: "contacts_table";
  columns: string[];
  rows: Record<string, unknown>[];
  title?: string;
};

type CardListHint = {
  type: "card_list";
  items: { title: string; description?: string; viewUrl?: string; fields?: Record<string, string> }[];
  title?: string;
};

type TextSectionsHint = {
  type: "text_sections";
  sections: { heading: string; body: string }[];
  title?: string;
};

type ToolCallSummaryHint = {
  type: "tool_call_summary";
};

type PresentationHint =
  | ContactsTableHint
  | CardListHint
  | TextSectionsHint
  | ToolCallSummaryHint;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function translateContactsTable(
  surfaceId: string,
  hint: ContactsTableHint,
): A2UiMessage[] {
  const colIds = hint.columns.map((col) => `col-${col}`);

  const components: ComponentDefinition[] = [
    { id: "root", component: "Column", children: ["title", "data-list"] },
    { id: "title", component: "Text", text: hint.title ?? "Results", variant: "h2" },
    {
      id: "data-list",
      component: "List",
      children: { componentId: "row-card", path: "/rows" },
      direction: "vertical",
    },
    { id: "row-card", component: "Card", child: "row-content" },
    { id: "row-content", component: "Row", children: colIds },
    ...hint.columns.map((col) => ({
      id: `col-${col}`,
      component: "Text",
      text: { path: `/${col}` },
    })),
  ];

  const updateComponents: UpdateComponentsMessage = {
    version: "v0.9",
    updateComponents: { surfaceId, components },
  };

  const updateData: UpdateDataModelMessage = {
    version: "v0.9",
    updateDataModel: { surfaceId, path: "/", value: { rows: hint.rows } },
  };

  return [updateComponents, updateData];
}

function translateCardList(
  surfaceId: string,
  hint: CardListHint,
): A2UiMessage[] {
  const components: ComponentDefinition[] = [
    { id: "root", component: "Column", children: ["title", "item-list"] },
    { id: "title", component: "Text", text: hint.title ?? "Results", variant: "h2" },
    {
      id: "item-list",
      component: "List",
      children: { componentId: "item-card", path: "/items" },
      direction: "vertical",
    },
    { id: "item-card", component: "Card", child: "card-body" },
    { id: "card-body", component: "Column", children: ["item-title", "item-desc"] },
    { id: "item-title", component: "Text", text: { path: "/title" }, variant: "h3" },
    { id: "item-desc", component: "Text", text: { path: "/description" } },
  ];

  const updateComponents: UpdateComponentsMessage = {
    version: "v0.9",
    updateComponents: { surfaceId, components },
  };

  const updateData: UpdateDataModelMessage = {
    version: "v0.9",
    updateDataModel: { surfaceId, path: "/", value: { items: hint.items } },
  };

  return [updateComponents, updateData];
}

function translateTextSections(
  surfaceId: string,
  hint: TextSectionsHint,
): A2UiMessage[] {
  const sectionIds = hint.sections.map((_, i) => `section-${i}`);
  const headingIds = hint.sections.map((_, i) => `heading-${i}`);
  const bodyIds = hint.sections.map((_, i) => `body-${i}`);

  const rootChildren = hint.title ? ["title", ...sectionIds] : sectionIds;

  const components: ComponentDefinition[] = [
    { id: "root", component: "Column", children: rootChildren },
  ];

  if (hint.title) {
    components.push({ id: "title", component: "Text", text: hint.title, variant: "h2" });
  }

  hint.sections.forEach((sec, i) => {
    components.push({
      id: sectionIds[i] as string,
      component: "Column",
      children: [headingIds[i] as string, bodyIds[i] as string],
    });
    components.push({ id: headingIds[i] as string, component: "Text", text: sec.heading, variant: "h3" });
    components.push({ id: bodyIds[i] as string, component: "Text", text: sec.body });
  });

  const updateComponents: UpdateComponentsMessage = {
    version: "v0.9",
    updateComponents: { surfaceId, components },
  };

  // text_sections: all data is in component literals; no separate data model needed.
  return [updateComponents];
}

/**
 * Translate a grouped-setup-form schema into A2UI v0.9 messages.
 *
 * Emits a 3-message sequence: createSurface (with catalogId), updateComponents
 * (flat adjacency list: Column → title + per-field TextField + submit Button),
 * updateDataModel (current field values bound to path "/").
 *
 * Called from A2UiAdapter.onInterrupt when xRenderer matches the grouped
 * renderer id. No hint-dispatch entry is added — this is called directly
 * from the adapter, not via translateHintToA2UiMessages.
 *
 * Pure function. No side effects. Safe in any context (client or server).
 *
 * ==========================================================================
 * createSurface idempotency contract:
 *
 * This function emits `createSurface` for the passed `surfaceId` on every
 * call. Because `A2UiAdapter.onInterrupt` may be invoked repeatedly for the
 * same grouped interrupt (resume paths, worker retries, state-snapshot
 * re-emission), downstream A2UI consumers WILL see duplicate `createSurface`
 * messages with the same `surfaceId`.
 *
 * Consumers MUST treat a duplicate `createSurface` as a NO-OP (replace-or-
 * ignore), NEVER as a stack/duplicate. Two valid implementations:
 *   (a) no-op: keep the existing surface, drop the duplicate message
 *   (b) replace: tear down the existing surface and create fresh
 * What consumers MUST NOT do: leave two surfaces with the same id active.
 *
 * The translator does NOT dedupe here — adapter-level state would conflict
 * with the fire-and-forget publish model used by A2UiAdapter.
 * ==========================================================================
 */
export function translateSetupGroupToA2UiMessages(
  surfaceId: string,
  groupedSchema: Record<string, unknown>,
  currentValues: Record<string, unknown>,
  reviewTaskId: string,
): A2UiMessage[] {
  const properties = (groupedSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = ((groupedSchema.required ?? []) as string[]);

  // Filter out x-hidden fields entirely (not shown to the user).
  const visibleFieldNames = Object.keys(properties).filter(
    (name) => !(properties[name] as { "x-hidden"?: boolean })["x-hidden"],
  );

  // Ordering rule: required first (in declared order), then optional visible.
  const ordered = [
    ...required.filter((n) => visibleFieldNames.includes(n)),
    ...visibleFieldNames.filter((n) => !required.includes(n)),
  ];

  const fieldComponents: ComponentDefinition[] = ordered.map((fieldName) => {
    const fieldSchema = properties[fieldName] ?? {};
    const title = (fieldSchema as { title?: string }).title ?? fieldName;
    const type = (fieldSchema as { type?: string }).type;
    const xRenderer = (fieldSchema as { "x-renderer"?: string })["x-renderer"] ?? null;
    const textFieldType: "number" | "shortText" =
      type === "integer" || type === "number" ? "number" : "shortText";
    return {
      id: `field-${fieldName}`,
      component: "TextField",
      label: title,
      value: { path: `/${fieldName}` },
      textFieldType,
      "x-renderer": xRenderer,
    };
  });

  const components: ComponentDefinition[] = [
    {
      id: "root",
      component: "Column",
      children: ["title", ...ordered.map((n) => `field-${n}`), "submit-btn-label", "submit-btn"],
    },
    { id: "title", component: "Text", text: "Configure campaign", variant: "h2" },
    ...fieldComponents,
    { id: "submit-btn-label", component: "Text", text: "Save & start run" },
    {
      id: "submit-btn",
      component: "Button",
      child: "submit-btn-label",
      variant: "primary",
      action: {
        event: {
          name: "approve_review_task",
          context: {
            reviewTaskId: { literal: reviewTaskId },
            values: { path: "/" },
          },
        },
      },
    },
  ];

  return [
    {
      version: "v0.9",
      createSurface: {
        surfaceId,
        catalogId: A2UI_DEFAULT_CATALOG_ID,
        sendDataModel: true,
      },
    },
    {
      version: "v0.9",
      updateComponents: { surfaceId, components },
    },
    {
      version: "v0.9",
      updateDataModel: { surfaceId, path: "/", value: currentValues },
    },
  ];
}

// ---------------------------------------------------------------------------
// Mid-run HITL translators
//
// Exported functions for the mid-run approval screens. Each emits
// exactly 3 A2UI v0.9 messages: createSurface + updateComponents + updateDataModel.
// The :output xRenderer IDs in their names match the canonical renderer IDs.
//
// The `schema` parameter is accepted for API consistency but not used in body —
// the component tree is built from the `values` shape, not the schema.
// ---------------------------------------------------------------------------

/** Shared function signature for all mid-run HITL translator functions. */
export type MidRunTranslator = (
  surfaceId: string,
  schema: Record<string, unknown>,
  values: Record<string, unknown>,
  reviewTaskId: string,
) => A2UiMessage[];

/**
 * Translate email-recipients interrupt payload into A2UI v0.9 messages.
 * xRenderer: "@cinatra-ai/email-recipient-selection-agent:output"
 *
 * Component tree:
 *   Column(root) → Text(title) + Text(summary) + List(data-list, /recipients) +
 *                  Row(actions) [Approve, Reject buttons]
 */
export function translateRecipientsOutputToA2Ui(
  surfaceId: string,
  _schema: Record<string, unknown>,
  values: Record<string, unknown>,
  reviewTaskId: string,
): A2UiMessage[] {
  const recipients = Array.isArray((values as { recipients?: unknown[] }).recipients)
    ? (values as { recipients: unknown[] }).recipients
    : [];
  const summaryText = `${recipients.length} recipients selected`;

  const components: ComponentDefinition[] = [
    { id: "root", component: "Column", children: ["title", "summary", "data-list", "actions"] },
    { id: "title", component: "Text", text: "Review recipients", variant: "h2" },
    { id: "summary", component: "Text", text: { path: "/summaryText" } },
    {
      id: "data-list",
      component: "List",
      children: { componentId: "row-template", path: "/recipients" },
      direction: "vertical",
    },
    { id: "row-template", component: "Card", child: "row-content" },
    { id: "row-content", component: "Row", children: ["cell-contact", "cell-email", "cell-startup"] },
    { id: "cell-contact", component: "Text", text: { path: "contactName" } },
    { id: "cell-email", component: "Text", text: { path: "contactEmail" } },
    { id: "cell-startup", component: "Text", text: { path: "startupName" } },
    { id: "actions", component: "Row", children: ["btn-approve-label", "btn-approve", "btn-reject-label", "btn-reject"] },
    { id: "btn-approve-label", component: "Text", text: "Approve" },
    {
      id: "btn-approve",
      component: "Button",
      child: "btn-approve-label",
      variant: "primary",
      action: {
        event: {
          name: "approve_review_task",
          context: {
            reviewTaskId: { literal: reviewTaskId },
            values: { literal: { approved: true } },
          },
        },
      },
    },
    { id: "btn-reject-label", component: "Text", text: "Reject" },
    {
      id: "btn-reject",
      component: "Button",
      child: "btn-reject-label",
      variant: "borderless",
      action: {
        event: {
          name: "reject_review_task",
          context: {
            reviewTaskId: { literal: reviewTaskId },
            values: { literal: { approved: false } },
          },
        },
      },
    },
  ];

  return [
    {
      version: "v0.9",
      createSurface: { surfaceId, catalogId: A2UI_DEFAULT_CATALOG_ID, sendDataModel: true },
    },
    { version: "v0.9", updateComponents: { surfaceId, components } },
    { version: "v0.9", updateDataModel: { surfaceId, path: "/", value: { summaryText, recipients } } },
  ];
}

/**
 * Translate email-drafts interrupt payload into A2UI v0.9 messages.
 * xRenderer: "@cinatra-ai/email-drafting-agent:output"
 *
 * Component tree:
 *   Column(root) → Text(title) + Text(summary) + List(data-list, /drafts) +
 *                  Row(actions) [Approve, Reject buttons]
 */
export function translateDraftsOutputToA2Ui(
  surfaceId: string,
  _schema: Record<string, unknown>,
  values: Record<string, unknown>,
  reviewTaskId: string,
): A2UiMessage[] {
  const drafts = Array.isArray((values as { drafts?: unknown[] }).drafts)
    ? (values as { drafts: unknown[] }).drafts
    : [];
  const summaryText = `${drafts.length} drafts ready`;

  const components: ComponentDefinition[] = [
    { id: "root", component: "Column", children: ["title", "summary", "data-list", "actions"] },
    { id: "title", component: "Text", text: "Review email drafts", variant: "h2" },
    { id: "summary", component: "Text", text: { path: "/summaryText" } },
    {
      id: "data-list",
      component: "List",
      children: { componentId: "draft-card", path: "/drafts" },
      direction: "vertical",
    },
    { id: "draft-card", component: "Card", child: "draft-body" },
    { id: "draft-body", component: "Column", children: ["draft-recipient", "draft-subject", "draft-body-text"] },
    { id: "draft-recipient", component: "Text", text: { path: "recipientEmail" }, variant: "caption" },
    { id: "draft-subject", component: "Text", text: { path: "subject" }, variant: "h3" },
    { id: "draft-body-text", component: "Text", text: { path: "body" } },
    { id: "actions", component: "Row", children: ["btn-approve-label", "btn-approve", "btn-reject-label", "btn-reject"] },
    { id: "btn-approve-label", component: "Text", text: "Approve" },
    {
      id: "btn-approve",
      component: "Button",
      child: "btn-approve-label",
      variant: "primary",
      action: {
        event: {
          name: "approve_review_task",
          context: {
            reviewTaskId: { literal: reviewTaskId },
            values: { literal: { approved: true } },
          },
        },
      },
    },
    { id: "btn-reject-label", component: "Text", text: "Reject" },
    {
      id: "btn-reject",
      component: "Button",
      child: "btn-reject-label",
      variant: "borderless",
      action: {
        event: {
          name: "reject_review_task",
          context: {
            reviewTaskId: { literal: reviewTaskId },
            values: { literal: { approved: false } },
          },
        },
      },
    },
  ];

  return [
    {
      version: "v0.9",
      createSurface: { surfaceId, catalogId: A2UI_DEFAULT_CATALOG_ID, sendDataModel: true },
    },
    { version: "v0.9", updateComponents: { surfaceId, components } },
    { version: "v0.9", updateDataModel: { surfaceId, path: "/", value: { summaryText, drafts } } },
  ];
}

/**
 * Translate email-followups interrupt payload into A2UI v0.9 messages.
 * xRenderer: "@cinatra-ai/email-follow-up-agent:output"
 *
 * Component tree mirrors email-drafts: title + draft list (subject/body/recipient) + Approve/Reject.
 */
export function translateFollowupsOutputToA2Ui(
  surfaceId: string,
  _schema: Record<string, unknown>,
  values: Record<string, unknown>,
  reviewTaskId: string,
): A2UiMessage[] {
  const drafts = Array.isArray((values as { drafts?: unknown[] }).drafts)
    ? (values as { drafts: unknown[] }).drafts
    : [];
  const summaryText = `${drafts.length} follow-up draft${drafts.length === 1 ? "" : "s"} ready`;

  const components: ComponentDefinition[] = [
    { id: "root", component: "Column", children: ["title", "summary", "data-list", "actions"] },
    { id: "title", component: "Text", text: "Review follow-up drafts", variant: "h2" },
    { id: "summary", component: "Text", text: { path: "/summaryText" } },
    {
      id: "data-list",
      component: "List",
      children: { componentId: "draft-card", path: "/drafts" },
      direction: "vertical",
    },
    { id: "draft-card", component: "Card", child: "draft-body" },
    { id: "draft-body", component: "Column", children: ["draft-step", "draft-subject", "draft-body-text"] },
    { id: "draft-step", component: "Text", text: { path: "timingDescription" }, variant: "caption" },
    { id: "draft-subject", component: "Text", text: { path: "subject" }, variant: "h3" },
    { id: "draft-body-text", component: "Text", text: { path: "body" } },
    { id: "actions", component: "Row", children: ["btn-approve-label", "btn-approve", "btn-reject-label", "btn-reject"] },
    { id: "btn-approve-label", component: "Text", text: "Approve" },
    {
      id: "btn-approve",
      component: "Button",
      child: "btn-approve-label",
      variant: "primary",
      action: {
        event: {
          name: "approve_review_task",
          context: {
            reviewTaskId: { literal: reviewTaskId },
            values: { literal: { approved: true } },
          },
        },
      },
    },
    { id: "btn-reject-label", component: "Text", text: "Reject" },
    {
      id: "btn-reject",
      component: "Button",
      child: "btn-reject-label",
      variant: "borderless",
      action: {
        event: {
          name: "reject_review_task",
          context: {
            reviewTaskId: { literal: reviewTaskId },
            values: { literal: { approved: false } },
          },
        },
      },
    },
  ];

  return [
    {
      version: "v0.9",
      createSurface: { surfaceId, catalogId: A2UI_DEFAULT_CATALOG_ID, sendDataModel: true },
    },
    { version: "v0.9", updateComponents: { surfaceId, components } },
    { version: "v0.9", updateDataModel: { surfaceId, path: "/", value: { summaryText, drafts } } },
  ];
}

/**
 * Translate email-sender (send confirmation) interrupt payload into A2UI v0.9 messages.
 * xRenderer: "@cinatra-ai/email-delivery-agent:output"
 *
 * Component tree:
 *   Column(root) → Text(title) + Card(summary-card) + Row(actions) [Send now, Cancel]
 *   No List — send confirmation uses a summary card with counts/time.
 */
export function translateSendOutputToA2Ui(
  surfaceId: string,
  _schema: Record<string, unknown>,
  values: Record<string, unknown>,
  reviewTaskId: string,
): A2UiMessage[] {
  const v = values as { recipientCount?: number; draftCount?: number; scheduledAt?: string };
  const recipientCountLabel = `Recipients: ${v.recipientCount ?? 0}`;
  const draftCountLabel = `Drafts: ${v.draftCount ?? 0}`;
  const scheduledAtLabel = `Send at: ${v.scheduledAt ?? "now"}`;

  const components: ComponentDefinition[] = [
    { id: "root", component: "Column", children: ["title", "summary-card", "actions"] },
    { id: "title", component: "Text", text: "Send confirmation", variant: "h2" },
    { id: "summary-card", component: "Card", child: "summary-body" },
    { id: "summary-body", component: "Column", children: ["row-recipients", "row-drafts", "row-time"] },
    { id: "row-recipients", component: "Text", text: { path: "/recipientCountLabel" } },
    { id: "row-drafts", component: "Text", text: { path: "/draftCountLabel" } },
    { id: "row-time", component: "Text", text: { path: "/scheduledAtLabel" } },
    { id: "actions", component: "Row", children: ["btn-send-label", "btn-send", "btn-cancel-label", "btn-cancel"] },
    { id: "btn-send-label", component: "Text", text: "Send now" },
    {
      id: "btn-send",
      component: "Button",
      child: "btn-send-label",
      variant: "primary",
      action: {
        event: {
          name: "approve_review_task",
          context: {
            reviewTaskId: { literal: reviewTaskId },
            values: { literal: { approved: true } },
          },
        },
      },
    },
    { id: "btn-cancel-label", component: "Text", text: "Cancel" },
    {
      id: "btn-cancel",
      component: "Button",
      child: "btn-cancel-label",
      variant: "borderless",
      action: {
        event: {
          name: "reject_review_task",
          context: {
            reviewTaskId: { literal: reviewTaskId },
            values: { literal: { approved: false } },
          },
        },
      },
    },
  ];

  return [
    {
      version: "v0.9",
      createSurface: { surfaceId, catalogId: A2UI_DEFAULT_CATALOG_ID, sendDataModel: true },
    },
    { version: "v0.9", updateComponents: { surfaceId, components } },
    {
      version: "v0.9",
      updateDataModel: {
        surfaceId,
        path: "/",
        value: { recipientCountLabel, draftCountLabel, scheduledAtLabel },
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Translate a PresentationHint into an ordered sequence of A2UI v0.9 messages.
 * Pure function — no Redis, no side effects. Returns [] for unknown/null hints.
 */
export function translateHintToA2UiMessages(
  surfaceId: string,
  hint: unknown,
): A2UiMessage[] {
  if (!hint || typeof hint !== "object") return [];
  const h = hint as PresentationHint;
  switch (h.type) {
    case "contacts_table":
      return translateContactsTable(surfaceId, h);
    case "card_list":
      return translateCardList(surfaceId, h);
    case "text_sections":
      return translateTextSections(surfaceId, h);
    case "tool_call_summary":
      return [];
    default:
      return [];
  }
}

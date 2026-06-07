"use client";

import type { RendererMode } from "../field-renderer-registry";
import { TableRenderer, type TableRowAction } from "./table-renderer";
import { CardListRenderer } from "./card-list-renderer";
import { TextSectionsRenderer } from "./text-sections-renderer";

// ---------------------------------------------------------------------------
// Public discriminated-union contract for LLM-emitted presentation hints.
// Both the execution wiring and the presentation-parser import this type.
// Adding a new renderer means: (1) add a variant here,
// (2) add a case to the DispatchRenderer switch below,
// (3) add a renderer component file and re-export.
// ---------------------------------------------------------------------------

export type PresentationHint =
  | {
      type: "contacts_table";
      title?: string;
      columns: string[];
      rows: Record<string, unknown>[];
      /**
       * Per-column link mapping: column name → row field holding its URL.
       * All mapped URL fields are hidden from the display columns automatically.
       * Example: { "Contact": "contactUrl", "Company": "companyUrl" }
       */
      columnLinks?: Record<string, string>;
      /** Row-level actions. Requires onAction on DispatchRenderer to activate. */
      actions?: TableRowAction[];
    }
  | {
      type: "card_list";
      title?: string;
      items: {
        title: string;
        description?: string;
        viewUrl?: string;
        fields?: Record<string, unknown>;
      }[];
    }
  | {
      type: "text_sections";
      title?: string;
      sections: { heading: string; body: string }[];
    }
  | { type: "tool_call_summary" };

export { TableRenderer, CardListRenderer, TextSectionsRenderer };
export type { TableRowAction };

/**
 * Dispatch a PresentationHint to the right renderer component. Returns null
 * for `tool_call_summary`, unrecognized types, or a null hint — the caller
 * (ResultsScreen) is responsible for rendering its own fallback (the existing
 * AgenticRunPanel message thread).
 *
 * Pass onAction to enable row-level actions on contacts_table hints.
 */
export function DispatchRenderer({
  hint,
  onAction,
  mode = "view",
}: {
  hint: PresentationHint | null;
  onAction?: (actionId: string, row: Record<string, unknown>) => void;
  mode?: RendererMode;
}) {
  if (!hint) return null;
  switch (hint.type) {
    case "contacts_table":
      return <TableRenderer hint={hint} onAction={onAction} mode={mode} />;
    case "card_list":
      return <CardListRenderer hint={hint} mode={mode} />;
    case "text_sections":
      return <TextSectionsRenderer hint={hint} mode={mode} />;
    case "tool_call_summary":
      return null;
    default:
      return null;
  }
}

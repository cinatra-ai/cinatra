"use client";

// ---------------------------------------------------------------------------
// AG-UI message view (cinatra#1311 — AG-UI interactive layer).
// ---------------------------------------------------------------------------
// Composes the interactive layer over the reducer's view model. Renders the
// ordered `parts` trace (text via the host-supplied `renderText`, tool calls as
// chips), then any inline agent-run cards (host-supplied), citations, the
// RUN_ERROR banner, and — when open — the HITL interrupt form. This is the
// reusable interactive counterpart to the S3 CONTENT renderer:
//
//   - CONTENT (S3, `@cinatra-ai/chat/renderer`): text -> sanitized HTML.
//   - INTERACTIVE (here): the AG-UI event-driven chrome around that content.
//
// Text rendering is delegated (`renderText`) rather than baked in, so this
// module stays decoupled from the heavy markdown/shiki/katex path — the host
// wires `renderMarkdown` from the S3 content barrel. Inline run cards are
// delegated (`renderRunCard`) so the heavy AgenticRunPanel wrapper never rides
// this bundle; use `resolveInlineRunMounts` to enumerate them.

import type { ReactNode } from "react";

import type { AssistantMessagePart } from "../../assistant-parts";
import type { UiMessage } from "../../types";
import type { AgUiInterrupt } from "../ag-ui-reducer";
import { CitationList } from "./citation-list";
import { HitlInterruptForm } from "./hitl-interrupt-form";
import { resolveInlineRunMounts, type InlineRunMount } from "./inline-run-mounts";
import { RunErrorBanner } from "./run-error-banner";
import { ToolCallChip } from "./tool-call-chip";

export type AgUiMessageViewProps = {
  /** The reduced assistant message (AgUiReducerState.message). */
  message: UiMessage;
  /** The open HITL interrupt slice, if any (AgUiReducerState.interrupt). */
  interrupt?: AgUiInterrupt | null;
  /** Render a text part's content (host supplies the S3 content renderer). */
  renderText: (text: string) => ReactNode;
  /** Render an inline agent-run card for a pinned run mount (host supplies). */
  renderRunCard?: (mount: InlineRunMount) => ReactNode;
  /** Submit handler for the HITL form (host wires the RESUME round-trip). */
  onInterruptSubmit?: (values: Record<string, unknown>) => void;
};

function PartView({
  part,
  renderText,
}: {
  part: AssistantMessagePart;
  renderText: (text: string) => ReactNode;
}) {
  if (part.kind === "text") {
    return <div className="ag-ui-text">{renderText(part.content)}</div>;
  }
  return <ToolCallChip toolCall={part} />;
}

export function AgUiMessageView({
  message,
  interrupt,
  renderText,
  renderRunCard,
  onInterruptSubmit,
}: AgUiMessageViewProps) {
  const parts = message.parts ?? [];
  const mounts = resolveInlineRunMounts(message);
  return (
    <div className="ag-ui-message flex flex-col gap-2" data-message-id={message.id}>
      {parts.map((part, i) => (
        <PartView key={i} part={part} renderText={renderText} />
      ))}

      {renderRunCard &&
        mounts.map((mount) => (
          <div key={mount.runId} data-run-mount={mount.runId}>
            {renderRunCard(mount)}
          </div>
        ))}

      <RunErrorBanner error={message.error} />

      <CitationList citations={message.citations ?? []} />

      {interrupt && (
        <HitlInterruptForm
          interrupt={interrupt}
          onSubmit={onInterruptSubmit ?? (() => {})}
        />
      )}
    </div>
  );
}

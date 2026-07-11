"use client";

// ---------------------------------------------------------------------------
// AG-UI interactive layer — the presentational half of the deferred S3 piece
// (cinatra#1311). Draws the reduced view model produced by `./ag-ui-reducer`:
// tool-call chips, thinking groups, citations, inline agent-run-card mount
// points, HITL interrupt forms, streaming/partial text (incl. incomplete-embed
// trimming), the RUN_ERROR banner, and the S4 (#1220) renderable-view cards
// (the reducer's carried-through `dataParts`, dispatched via the registered
// view registry — see `RenderableViewParts`).
//
// DECOUPLING / EMBEDDABILITY. This layer is deliberately framework-light and
// carries NO heavy dependency (no `@cinatra-ai/agents` run panel, no markdown
// engine). The two host-owned pieces are injected as render props:
//   • `renderText`   — turn a text part into rendered nodes (S2/#1218 injects
//     the S3 content renderer `renderMarkdown`; the default is safe plain text).
//   • `renderRunCard`— mount the inline agent-run card for a pinned `runId`
//     (S2 injects `<InlineAgentRunCard/>`; default renders nothing).
//   • `renderInterrupt` — mount the real HITL approval form (S2 injects the
//     AgenticRunPanel-backed form; default renders a read-only field summary).
// This mirrors the S3 content renderer's host-injection philosophy (the host
// supplies its widget detector) and keeps the interactive layer reusable across
// `/chat` and the embedded iframe without either pulling the other's weight.
//
// Token-driven: every class is a `@cinatra-ai/design` utility (`text-foreground`,
// `text-muted-foreground`, `border-line`, `bg-destructive/10`, …) so the layer
// inherits the host palette with no per-surface CSS — mirroring the bespoke
// `chat-messages-view` markup.
//
// UNCONSUMED. `/chat` still renders through `chat-messages-view.tsx` (untouched);
// nothing imports this module. S2 (#1218) cuts `/chat` over.
// ---------------------------------------------------------------------------

import type { ReactNode } from "react";
import Link from "next/link";
import { renderableViewType } from "@cinatra-ai/agent-ui-protocol/renderable-views";
import {
  formatToolCallLabel,
  trimIncompleteEmbeds,
  type AssistantMessagePart,
  type AssistantToolCallPart,
} from "../assistant-parts";
import { RenderableViewCard } from "../renderable-views/index";
import type { UiCitation, UiThoughtGroup, UiToolCall } from "../types";
import type {
  ConversationViewState,
  HitlInterruptSlice,
  ReducedAssistantMessage,
} from "./ag-ui-reducer";

// ---------------------------------------------------------------------------
// Host injection contract
// ---------------------------------------------------------------------------

export type InteractiveRenderers = {
  /** Render a text part's markdown. Default: safe, whitespace-preserving text. */
  renderText?: (text: string) => ReactNode;
  /** Mount the inline agent-run card for a pinned runId. Default: nothing. */
  renderRunCard?: (runId: string) => ReactNode;
  /** Mount the real HITL approval form. Default: a read-only field summary. */
  renderInterrupt?: (interrupt: HitlInterruptSlice) => ReactNode;
};

function defaultRenderText(text: string): ReactNode {
  return <span className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{text}</span>;
}

// ---------------------------------------------------------------------------
// Tool-call chips
// ---------------------------------------------------------------------------

export function ToolCallChip({ toolCall }: { toolCall: UiToolCall }) {
  const label =
    toolCall.resultLabel ||
    formatToolCallLabel({ name: toolCall.name, serverLabel: toolCall.serverLabel });
  const running = toolCall.status === "running";
  const failed = toolCall.status === "failed";
  return (
    <div
      className="flex items-center gap-2 text-xs text-muted-foreground"
      data-tool-call-id={toolCall.id}
      data-status={toolCall.status}
    >
      {running ? (
        <span className="inline-block h-1 w-1 animate-pulse rounded-full bg-muted-foreground" />
      ) : (
        <span
          className={`inline-block h-1 w-1 rounded-full ${failed ? "bg-destructive" : "bg-success"}`}
        />
      )}
      <span>{label}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Thinking group (tool round summary + chips)
// ---------------------------------------------------------------------------

export function ThinkingGroup({ group }: { group: UiThoughtGroup }) {
  if (group.toolCalls.length === 0 && !group.thinkingSeconds) return null;
  const allDone = group.toolCalls.every((tc) => tc.status === "completed");
  const seconds = group.thinkingSeconds ?? 0;
  const summary =
    group.toolCalls.length > 0
      ? `${allDone ? "Used" : "Using"} ${group.toolCalls.length} ${group.toolCalls.length === 1 ? "tool" : "tools"}`
      : seconds > 0
        ? `Thought for ${seconds}s`
        : "Thinking";
  return (
    <div className="mb-2" data-thinking-group={group.id}>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {!allDone && (
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground" />
        )}
        <span className="font-medium">{summary}</span>
      </div>
      {group.toolCalls.length > 0 && (
        <div className="ml-4 mt-1.5 flex flex-col gap-1 border-l border-line pl-3">
          {group.toolCalls.map((tc) => (
            <ToolCallChip key={tc.id} toolCall={tc} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Citations
// ---------------------------------------------------------------------------

export function CitationsList({ citations }: { citations: UiCitation[] }) {
  if (citations.length === 0) return null;
  return (
    <div className="mt-4 border-t border-line pt-3" data-citations>
      <div className="mb-2 text-xs font-semibold text-muted-foreground">Sources</div>
      <ol className="text-xs">
        {citations.map((c, i) => {
          let host = c.url;
          try {
            host = new URL(c.url).hostname.replace(/^www\./, "");
          } catch {
            /* keep raw url */
          }
          return (
            <li key={`cite-${i}-${c.url}`} className="my-1 flex gap-2 first:mt-0">
              <span className="text-muted-foreground">{i + 1}.</span>
              <Link
                href={c.url}
                target="_blank"
                rel="noreferrer"
                className="truncate text-muted-foreground underline underline-offset-4 hover:text-foreground"
              >
                {c.title || host}
                <span className="ml-2 text-muted-foreground/70">({host})</span>
              </Link>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// ---------------------------------------------------------------------------
// RUN_ERROR banner
// ---------------------------------------------------------------------------

export function RunErrorBanner({ error }: { error: string; errorRaw?: string }) {
  return (
    <div
      className="max-w-full overflow-hidden rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3"
      role="alert"
      data-run-error
    >
      <div className="flex items-start gap-2.5">
        <svg viewBox="0 0 20 20" fill="currentColor" className="mt-0.5 h-4 w-4 shrink-0 text-destructive">
          <path
            fillRule="evenodd"
            d="M10 18a8 8 0 100-16 8 8 0 000 16zM9 9a1 1 0 012 0v4a1 1 0 11-2 0V9zm1-5a1 1 0 100 2 1 1 0 000-2z"
            clipRule="evenodd"
          />
        </svg>
        <div className="min-w-0 flex-1 text-sm text-foreground">{error}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live status line
// ---------------------------------------------------------------------------

export function LiveStatusLine({ status }: { status: string }) {
  return (
    <div
      className="flex animate-pulse items-center gap-2.5 text-muted-foreground"
      role="status"
      aria-live="polite"
      data-live-status
    >
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-current opacity-70" />
      </span>
      <span className="text-sm font-medium">{status}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// HITL interrupt — default read-only field summary (host injects the real form)
// ---------------------------------------------------------------------------

export function HitlInterruptFallback({ interrupt }: { interrupt: HitlInterruptSlice }) {
  const props = (interrupt.schema?.properties ?? {}) as Record<string, unknown>;
  const fieldNames = Object.keys(props);
  return (
    <div
      className="mt-3 w-full overflow-hidden rounded-xl border border-line bg-surface-strong p-4"
      data-hitl-interrupt={interrupt.reviewTaskId}
    >
      <div className="mb-2 text-xs font-semibold text-muted-foreground">Approval needed</div>
      <div className="text-sm text-foreground">
        The agent&rsquo;s <code className="text-xs">{interrupt.xRenderer}</code> step is waiting for
        your input.
      </div>
      {fieldNames.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1">
          {fieldNames.map((name) => (
            <li key={name} className="text-xs text-muted-foreground">
              {name}
              {interrupt.values[name] !== undefined ? (
                <span className="ml-2 text-foreground">{String(interrupt.values[name])}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Renderable-view dispatch (S4, #1220) — the reducer's carried-through
// `dataParts` drawn via the registered view registry.
// ---------------------------------------------------------------------------
// The reducer consumes the `DATA_PART` payloads it understands structurally
// (`agent_run` run-card pins, `citations`) and carries every other structured
// payload through in `state.dataParts` FOR THIS DISPATCH. Here each payload
// that IS a renderable view (a non-empty string `viewType`) is drawn through
// `RenderableViewCard` — validate → registered component → safe fallback for
// an unknown/invalid/forward-incompatible view. A plain data part (no
// `viewType`) is NOT a view and renders nothing.
//
// DELIBERATELY NOT host-injectable (unlike `renderText`/`renderRunCard`/
// `renderInterrupt`): the epic's acceptance criterion is that every surface
// draws the registered inventory IDENTICALLY — the dispatch being definitional
// is the point, and the in-package cards carry no heavy dependency.

export function RenderableViewParts({
  dataParts,
}: {
  dataParts: Record<string, unknown>[];
}) {
  const views = dataParts.filter((d) => {
    // Classification must not pierce the never-throw boundary: a hostile
    // `viewType` getter / Proxy trap counts as a view so the GUARDED
    // `RenderableViewCard` path (parseRenderableView never throws) renders the
    // safe fallback instead of the whole turn crashing.
    try {
      return renderableViewType(d) !== undefined;
    } catch {
      return true;
    }
  });
  if (views.length === 0) return null;
  return (
    <div className="flex flex-col gap-2" data-renderable-views>
      {views.map((view, idx) => (
        <RenderableViewCard key={`view-${idx}`} data={view} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ordered parts (chronologically interleaved text + tool chips + run cards)
// ---------------------------------------------------------------------------

function isAgentRunPart(part: AssistantMessagePart): part is AssistantToolCallPart & { runId: string } {
  return part.kind === "tool_call" && part.name === "agent_run" && typeof part.runId === "string";
}

export function InteractiveParts({
  parts,
  streaming = false,
  renderers = {},
}: {
  parts: AssistantMessagePart[];
  /** When true, trim an incomplete trailing embed off the last text part. */
  streaming?: boolean;
  renderers?: InteractiveRenderers;
}) {
  if (parts.length === 0) return null;
  const renderText = renderers.renderText ?? defaultRenderText;
  const renderRunCard = renderers.renderRunCard;
  const lastIdx = parts.length - 1;
  return (
    <div className="flex flex-col gap-2" data-interactive-parts>
      {parts.map((part, idx) => {
        if (part.kind === "text") {
          // Only the last text part of a live stream can hold an incomplete
          // embed; trim it so the renderer never flashes partial JSON.
          const text = streaming && idx === lastIdx ? trimIncompleteEmbeds(part.content) : part.content;
          if (text.trim().length === 0) return null;
          return (
            <div key={`text-${idx}`} className="max-w-none">
              {renderText(text)}
            </div>
          );
        }
        // agent_run tool_call with a pinned runId → mount the inline run card.
        if (isAgentRunPart(part)) {
          return (
            <div key={`agent-run-${part.runId}`} data-run-card={part.runId}>
              {renderRunCard ? renderRunCard(part.runId) : null}
            </div>
          );
        }
        // Other tool parts are surfaced via the thinking-group chips below the
        // parts trace (mirrors the bespoke single-status-line behavior), so the
        // ordered renderer skips them here.
        return null;
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Top-level composition — one reduced assistant turn
// ---------------------------------------------------------------------------

export function ConversationTurn({
  state,
  renderers = {},
}: {
  state: ConversationViewState;
  renderers?: InteractiveRenderers;
}) {
  const message: ReducedAssistantMessage = state.message;
  const streaming = state.status === "running";
  const showLiveStatus = streaming && !!message.liveStatus && !message.error;
  return (
    <div className="flex flex-col gap-3" data-conversation-turn>
      {message.parts.length > 0 ? (
        <InteractiveParts parts={message.parts} streaming={streaming} renderers={renderers} />
      ) : null}

      {message.thoughtGroups.map((g) => (
        <ThinkingGroup key={g.id} group={g} />
      ))}

      <RenderableViewParts dataParts={state.dataParts} />

      {showLiveStatus ? <LiveStatusLine status={message.liveStatus as string} /> : null}

      {message.error ? <RunErrorBanner error={message.error} errorRaw={message.errorRaw} /> : null}

      <CitationsList citations={message.citations} />

      {state.interrupt
        ? renderers.renderInterrupt
          ? renderers.renderInterrupt(state.interrupt)
          : <HitlInterruptFallback interrupt={state.interrupt} />
        : null}
    </div>
  );
}

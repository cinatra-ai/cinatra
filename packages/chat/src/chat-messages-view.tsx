"use client";

// ---------------------------------------------------------------------------
// Conversation message-list view (cinatra#918 — split out of chat-page.tsx).
// ---------------------------------------------------------------------------
// This module is the LAZY BOUNDARY for the chat route's heavy renderers:
// ChatPage mounts it via next/dynamic, so marked + katex (./markdown-render →
// ./math-render), the mermaid wrapper (./mermaid-block) and the shiki wrapper
// (./syntax-highlight) load in their own client chunk only when a conversation
// actually renders — they no longer ride the initial /chat bundle (the empty
// state + composer stay eager). The `chart` renderable-view COMPONENT (formerly
// the in-tree recharts ChartEmbed) is now extension-provided
// (@cinatra-ai/chart-artifact, resolved server-side into the `chatViews` map by
// src/lib/chat-views-catalog.server.ts and dispatched here — cinatra#1626).
// Everything here is moved UNCHANGED from chat-page.tsx: same components,
// same markup, same class names. The only edits are mechanical — closure
// state became props (isStreaming(id) reads the same abort-controller
// registry via a callback; pause/edit handlers are threaded as callbacks) and
// the four identical embed/citation adjunct blocks are factored into local
// components that emit byte-identical DOM.

import { Component, useCallback, useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import Link from "next/link";
import { RotateCcw, PauseCircle, PlayCircle, Copy, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
// Direct per-icon imports — avoid Turbopack processing the full simple-icons barrel (see apis-page.tsx note)
import SiAnthropic from "@icons-pack/react-simple-icons/icons/SiAnthropic.mjs";
import SiGooglegemini from "@icons-pack/react-simple-icons/icons/SiGooglegemini.mjs";
import { cn } from "@/lib/utils";
import { CINATRA_LOGO } from "@/lib/cinatra-brand";
import type { Mentionable, WidgetDefinition, WidgetSubmitHandle } from "@cinatra-ai/sdk-ui";
import type { ChatGateDescriptor } from "@cinatra-ai/agents/client-entry";
import { highlightCodeAsync, type ThemeName } from "./syntax-highlight";
import { renderMarkdown, detectCharts, detectMermaidBlocks } from "./markdown-render";
import { MermaidBlock } from "./mermaid-block";
import { RenderableViewFallback } from "./renderable-views";
import { buildChartView } from "@cinatra-ai/agent-ui-protocol/renderable-views/chart";
import { FriendlyErrorBody } from "./chat-error-display"; // friendly error card (#534)
import { InlineAgentRunCard } from "./inline-agent-run-card";
import { UndoActionChip } from "./chat-undo-action-chip";
import {
  trimIncompleteEmbeds,
  getLiveProgressStatus,
  shouldShowLiveProgressStatus,
  formatToolName,
  type AssistantMessagePart,
} from "./assistant-parts";
import { resolveAssistantDisplayName } from "./assistant-display-name";
import type { ChatWidgetRuntime, DetectedWidget } from "./widget-runtime";
import type { UiMessage, UiThoughtGroup } from "./types";

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function IconCheck() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className="h-3 w-3">
      <path fillRule="evenodd" d="M12.416 3.376a.75.75 0 0 1 .208 1.04l-5 7.5a.75.75 0 0 1-1.154.114l-3-3a.75.75 0 0 1 1.06-1.06l2.353 2.353 4.493-6.74a.75.75 0 0 1 1.04-.207Z" />
    </svg>
  );
}

function IconAgent() {
  return (
    <svg viewBox={CINATRA_LOGO.fullViewBox} fill="none" aria-hidden="true" style={{ height: "0.75rem", width: "auto", flexShrink: 0 }}>
      <path d={CINATRA_LOGO.brim} fill="currentColor" />
      <path d={CINATRA_LOGO.crown} fill="currentColor" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Collapsible thought group (like ChatGPT's "Thought & used N tools")
// ---------------------------------------------------------------------------

function ThoughtGroupSection({ group, isLive }: { group: UiThoughtGroup; isLive: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const toolCount = group.toolCalls.length;
  const allDone = group.toolCalls.every((tc) => tc.status === "completed");
  const seconds = group.thinkingSeconds ?? 0;

  // Build the summary label.
  let summary: string;
  if (isLive && !allDone) {
    summary = toolCount > 0 ? `Thinking & using ${toolCount} tool${toolCount === 1 ? "" : "s"}` : "Thinking...";
  } else if (toolCount > 0 && seconds > 1) {
    summary = `Thought for ${seconds}s & used ${toolCount} tool${toolCount === 1 ? "" : "s"}`;
  } else if (toolCount > 0) {
    summary = `Used ${toolCount} tool${toolCount === 1 ? "" : "s"}`;
  } else if (seconds > 1) {
    summary = `Thought for ${seconds} second${seconds === 1 ? "" : "s"}`;
  } else {
    return null; // Nothing interesting to show.
  }

  return (
    <div className="mb-2">
      <Button
        type="button"
        variant="ghost"
        onClick={() => setExpanded((v) => !v)}
        className="flex h-auto items-center gap-1.5 px-0 py-0 text-xs text-muted-foreground transition hover:bg-transparent hover:text-foreground"
      >
        {isLive && !allDone ? (
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground" />
        ) : (
          <IconAgent />
        )}
        <span className="font-medium">{summary}</span>
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className={`h-3 w-3 transition ${expanded ? "rotate-90" : ""}`}
        >
          <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </Button>
      {expanded && group.toolCalls.length > 0 && (
        <div className="ml-4 mt-1.5 flex flex-col gap-1 border-l border-line pl-3">
          {group.toolCalls.map((tc) => (
            <div key={tc.id} className="flex items-center gap-2 text-xs text-muted-foreground">
              {tc.status === "running" ? (
                <span className="inline-block h-1 w-1 animate-pulse rounded-full bg-muted-foreground" />
              ) : (
                <svg viewBox="0 0 16 16" fill="currentColor" className="h-2.5 w-2.5 text-muted-foreground">
                  <circle cx="8" cy="8" r="3" />
                </svg>
              )}
              <span>{tc.resultLabel || (tc.serverLabel && tc.serverLabel !== "cinatra"
                ? `${tc.serverLabel.replace(/^external-/, "").replace(/-connector$/, "").replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())} · ${tc.name.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}`
                : formatToolName(tc.name))}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ordered parts renderer (chronologically interleaved text + tool badges)
// ---------------------------------------------------------------------------

function OrderedPartsSection({
  parts,
  trimContent,
  theme,
  detectWidgets,
  onMarkdownClick,
  onActiveGateChange,
}: {
  parts: AssistantMessagePart[];
  trimContent?: (content: string) => string;
  theme: ThemeName;
  /** Live widget detector from the chat widget runtime (renderMarkdown needs
   *  it to strip URL lines already rendered as widget embeds). */
  detectWidgets: (content: string) => DetectedWidget[];
  // Delegated click handler so the same code-copy / table-action behaviour
  // that the legacy `message.content` div provides also works for text
  // parts rendered here. Bound at the parent level so the `closest`
  // selectors still match any child element inside any text part.
  onMarkdownClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
  // Threaded down to the inline agent-run card so an open HITL gate can be
  // driven from the chat prompt window.
  onActiveGateChange?: (
    runId: string,
    gate: ChatGateDescriptor | null,
    instanceId: string,
  ) => void;
}) {
  if (parts.length === 0) return null;
  return (
    <div className="flex flex-col gap-2" onClick={onMarkdownClick}>
      {parts.map((part, idx) => {
        if (part.kind === "text") {
          const raw = trimContent ? trimContent(part.content) : part.content;
          // Skip pure-whitespace text parts (they're separator artifacts).
          if (!raw.replace(/\s+/g, "").length) return null;
          return (
            <div
              key={`text-${idx}`}
              className="max-w-none text-[15px] leading-relaxed text-foreground [&_table]:my-0"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(raw, theme, detectWidgets) }}
            />
          );
        }
        // `agent_run` tool_results carry a runId pinned by the tool_result
        // handler. Mount AgenticRunPanel inline so the user can drive HITL
        // gates (URL pickers, list pickers, reviewer approvals) from within
        // the chat thread instead of navigating to /agents/<v>/<s>/<runId>.
        // The card resolves to its own panel chrome — no extra Card wrapper here.
        if (part.kind === "tool_call" && part.name === "agent_run" && part.runId) {
          return (
            <div key={`agent-run-${part.runId}`}>
              <InlineAgentRunCard
                runId={part.runId}
                onActiveGateChange={onActiveGateChange}
              />
              {/* Inline undo for a recent restorable change-set produced by
                  this run. */}
              <UndoActionChip runId={part.runId} />
            </div>
          );
        }
        // Other tool parts feed the single live status line below the
        // message and don't render inline content.
        return null;
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live progress indicator (ChatGPT-style pulsating dot + short status text)
// ---------------------------------------------------------------------------

function ThinkingIndicator({ className, label = "Thinking" }: { className?: string; label?: string } = {}) {
  const showProgressSuffix = label !== "Thinking";

  return (
    <div className={cn("flex animate-pulse items-center gap-2.5 text-muted-foreground", className)} role="status" aria-live="polite">
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-current opacity-70" />
      </span>
      <span className="text-sm font-medium">
        {label}
        {showProgressSuffix ? " >" : null}
      </span>
    </div>
  );
}

// Waiting indicator — shown while an external assistant (@handle) is expected to reply.
function WaitingIndicator({ handle }: { handle: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-muted-foreground opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-muted-foreground opacity-40" />
      </span>
      <span className="text-sm text-muted-foreground">
        Waiting for @{handle}...
      </span>
    </div>
  );
}

// Per-assistant typing indicator shown in Slack mode while a Cinatra stream is buffering.
function SlackTypingIndicator({ handle }: { handle: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-muted-foreground opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-muted-foreground opacity-40" />
      </span>
      <span className="text-sm text-muted-foreground">
        @{handle} is thinking...
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Error card
// ---------------------------------------------------------------------------

function ErrorCard({ error, errorRaw }: { error: string; errorRaw?: string }) {
  const [copied, setCopied] = useState(false);
  const verbatim = errorRaw || error;

  function handleCopy() {
    void navigator.clipboard.writeText(verbatim).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="max-w-full overflow-hidden rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3">
      <div className="flex items-start gap-2.5">
        <svg viewBox="0 0 20 20" fill="currentColor" className="mt-0.5 h-4 w-4 shrink-0 text-destructive">
          <path fillRule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM8.28 7.22a.75.75 0 0 0-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 1 0 1.06 1.06L10 11.06l1.72 1.72a.75.75 0 1 0 1.06-1.06L11.06 10l1.72-1.72a.75.75 0 0 0-1.06-1.06L10 8.94 8.28 7.22Z" clipRule="evenodd" />
        </svg>
        <div className="min-w-0 flex-1">
          <FriendlyErrorBody error={error} />
        </div>
      </div>
      <div className="mt-2 flex items-center justify-end">
        <Button
          type="button"
          variant="ghost"
          onClick={handleCopy}
          className="inline-flex h-auto items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium text-destructive transition hover:bg-destructive/15 hover:text-destructive"
        >
          {copied ? (
            <>
              <IconCheck />
              Copied
            </>
          ) : (
            <>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3 w-3">
                <rect x="5.5" y="5.5" width="7" height="7" rx="1" />
                <path d="M3.5 10.5V4a1 1 0 0 1 1-1h6.5" />
              </svg>
              Copy error details
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Widget system
// ---------------------------------------------------------------------------
// The registries, detector compilation, and wizard/refresh helpers live in
// ./widget-runtime (pure factory). ChatPage builds the runtime from its
// `widgets` / `widgetManifests` props via useMemo and threads it here.

function ChatWidget({
  widget,
  def,
  submitRef,
  isOlderWidget,
  refreshKey,
}: {
  widget: DetectedWidget;
  /** Resolved by the caller from the live widget runtime (findWidget). */
  def: WidgetDefinition | undefined;
  submitRef: React.RefObject<WidgetSubmitHandle | null>;
  isOlderWidget?: boolean;
  refreshKey?: number;
}) {
  const ownRef = useRef<WidgetSubmitHandle | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  if (!def) return null;

  const Component = def.component;
  const effectiveRef = isOlderWidget ? ownRef : submitRef;

  return (
    <div className="mt-3 w-full overflow-hidden rounded-xl border border-line bg-surface-strong shadow-lg">
      <div className="p-2">
        <Component
          key={refreshKey}
          resourceId={widget.resourceId}
          submitRef={effectiveRef}
          onSave={isOlderWidget ? () => setStatus("saved") : undefined}
        />
        {isOlderWidget && (
          <div className="flex justify-end px-2 pb-1">
            {status === "saving" ? (
              <svg className="h-4 w-4 animate-spin text-muted-foreground" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2.5" className="opacity-25" />
                <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
              </svg>
            ) : status === "saved" ? (
              <svg className="h-4 w-4 text-success" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 0 1 0 1.414l-8 8a1 1 0 0 1-1.414 0l-4-4a1 1 0 1 1 1.414-1.414L8 12.586l7.293-7.293a1 1 0 0 1 1.414 0Z" />
              </svg>
            ) : (
              <Button
                type="button"
                variant="ghost"
                onClick={async () => {
                  setStatus("saving");
                  const ok = await ownRef.current?.submit();
                  setStatus(ok ? "saved" : "idle");
                }}
                className="h-auto rounded-lg px-3 py-1 text-xs font-medium text-muted-foreground transition hover:bg-surface-muted hover:text-muted-foreground"
              >
                Save
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mention badge renderer — converts @handle tokens in plain text to inline chips
// ---------------------------------------------------------------------------

function MentionBadge({ m }: { m: Mentionable }) {
  return (
    <span
      className="mention-chip inline-flex items-center gap-1 align-middle bg-surface-muted border border-line rounded-full pl-0.5 pr-1.5 py-0.5 text-xs leading-none select-none mx-1"
    >
      <span className="size-[1.1rem] rounded-full overflow-hidden inline-flex shrink-0 items-center justify-center bg-muted text-muted-foreground text-[8px] font-semibold">
        {m.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={m.image} alt="" className="size-full object-cover" />
        ) : (
          m.displayName.charAt(0).toUpperCase()
        )}
      </span>
      <span>{m.displayName}</span>
    </span>
  );
}

function renderWithMentions(content: string, mentionables: Mentionable[]): React.ReactNode {
  if (!mentionables.length || !content.includes("@")) return content;
  const handleMap = new Map(mentionables.map((m) => [m.handle, m]));
  const parts = content.split(/(@[a-zA-Z0-9_.\-]+)/g);
  return parts.map((part, i) => {
    if (part.startsWith("@")) {
      const m = handleMap.get(part.slice(1));
      if (m) return <MentionBadge key={i} m={m} />;
    }
    return part;
  });
}

// ---------------------------------------------------------------------------
// User message bubble with copy / edit actions
// ---------------------------------------------------------------------------

function UserMessageBubble({
  message,
  onEdit,
  disabled,
  isSlackMode = false,
  editRequested = false,
  onEditStarted,
  mentionables = [],
}: {
  message: UiMessage;
  onEdit: (messageId: string, newContent: string) => void;
  disabled?: boolean;
  isSlackMode?: boolean;
  editRequested?: boolean;
  onEditStarted?: () => void;
  mentionables?: Mentionable[];
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editRequested || editing) {
      return;
    }

    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) {
        return;
      }

      setEditing(true);
      onEditStarted?.();
    });

    return () => {
      cancelled = true;
    };
  }, [editRequested, editing, onEditStarted]);

  useEffect(() => {
    if (editing && textareaRef.current) {
      const el = textareaRef.current;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [editing]);

  if (editing) {
    return (
      <div className="mb-4 w-full rounded-control bg-surface-muted/60 px-4 py-3 shadow-sm">
        <Textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            e.target.style.height = "auto";
            e.target.style.height = `${e.target.scrollHeight}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (draft.trim()) {
                setEditing(false);
                onEdit(message.id, draft);
              }
            }
            if (e.key === "Escape") {
              setEditing(false);
              setDraft(message.content);
            }
          }}
          style={{ boxShadow: "none" }}
          className="min-h-0 w-full resize-none border-0 bg-transparent px-3 py-2 text-sm text-foreground shadow-none outline-none focus-visible:ring-0"
          rows={1}
        />
        <div className="mt-3 flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => { setEditing(false); setDraft(message.content); }}
            className="h-auto rounded-lg px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:bg-surface-muted"
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => {
              if (draft.trim()) {
                setEditing(false);
                onEdit(message.id, draft);
              }
            }}
            className="h-auto rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition hover:bg-primary/80"
          >
            Send
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("group relative min-w-0", isSlackMode ? "max-w-[85%]" : "max-w-[75%]")}>
      <div className="whitespace-pre-wrap break-words rounded-control bg-surface-muted px-4 py-3 text-sm text-foreground">
        {renderWithMentions(message.content, mentionables)}
      </div>
      {!disabled && !isSlackMode && (
        <div className="absolute -bottom-1 right-0 flex translate-y-full gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => void navigator.clipboard.writeText(message.content)}
            className="rounded-lg p-1.5 text-muted-foreground transition hover:bg-surface-muted hover:text-muted-foreground"
            title="Copy"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5">
              <rect x="5.5" y="5.5" width="7" height="7" rx="1" />
              <path d="M3.5 10.5V4a1 1 0 0 1 1-1h6.5" />
            </svg>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => { setDraft(message.content); setEditing(true); }}
            className="rounded-lg p-1.5 text-muted-foreground transition hover:bg-surface-muted hover:text-muted-foreground"
            title="Edit message"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5">
              <path d="M11.5 2.5l2 2L5 13H3v-2l8.5-8.5Z" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Slack-mode helpers
// ---------------------------------------------------------------------------

function getParticipantInitials(handle: string | undefined): string {
  if (!handle || handle.length === 0) return "AS";
  const stripped = handle.startsWith("@") ? handle.slice(1) : handle;
  return stripped.slice(0, 2).toUpperCase();
}

// Inline OpenAI icon (removed from simple-icons)
function OpenAIChatIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v 5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855-5.843-3.368L15.116 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.104v-5.678a.79.79 0 0 0-.407-.666zm2.01-3.023-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08-4.778 2.758a.795.795 0 0 0-.393.681zm1.097-2.365 2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z"/>
    </svg>
  );
}

function CinatraAvatarIcon() {
  // The Cinatra mark is wide (fullViewBox 512×320, ~1.6:1). Forcing it into a
  // square (h-3 w-3) made preserveAspectRatio shrink it to ~7.5px tall, so it
  // looked shrunken next to the square 12px provider glyphs (#502). Keep the
  // 12px height and let width follow the aspect ratio (matching the same logo's
  // other render at the response-header), so it reads at the sibling icons' size.
  return (
    <svg viewBox={CINATRA_LOGO.fullViewBox} xmlns="http://www.w3.org/2000/svg" fill="none" aria-label="Cinatra" className="h-3 w-auto">
      <path d={CINATRA_LOGO.brim} fill="currentColor" />
      <path d={CINATRA_LOGO.crown} fill="currentColor" />
    </svg>
  );
}

function getAssistantProviderIcon(handle: string | undefined): React.ReactNode | null {
  if (!handle) return null;
  const h = handle.toLowerCase();
  if (h.includes("cinatra")) return <CinatraAvatarIcon />;
  if (h.includes("claude") || h.includes("anthropic")) return <SiAnthropic size={12} />;
  if (h.includes("gpt") || h.includes("openai")) return <OpenAIChatIcon size={12} />;
  if (h.includes("gemini") || h.includes("google")) return <SiGooglegemini size={12} />;
  return null;
}

// ---------------------------------------------------------------------------
// In-message table pagination (buttons rendered by markdown-render)
// ---------------------------------------------------------------------------

function updateChatTablePage(frame: Element, requestedPage: number) {
  const pagination = frame.querySelector<HTMLElement>("[data-chat-table-pagination]");
  if (!pagination) return;

  const rows = Array.from(frame.querySelectorAll<HTMLTableRowElement>("[data-chat-table-row]"));
  const pageSize = Number(pagination.dataset.pageSize ?? "25");
  const rowCount = Number(pagination.dataset.rowCount ?? rows.length);
  const safePageSize = Number.isFinite(pageSize) && pageSize > 0 ? pageSize : 25;
  const safeRowCount = Number.isFinite(rowCount) && rowCount > 0 ? rowCount : rows.length;
  const pageCount = Math.max(1, Math.ceil(safeRowCount / safePageSize));
  const page = Math.min(Math.max(requestedPage, 0), pageCount - 1);
  const firstIndex = page * safePageSize;
  const lastIndex = Math.min(safeRowCount, firstIndex + safePageSize);

  pagination.dataset.page = String(page);
  rows.forEach((row, index) => {
    row.classList.toggle("hidden", index < firstIndex || index >= lastIndex);
  });

  const rangeLabel = pagination.querySelector<HTMLElement>("[data-chat-table-range-label]");
  if (rangeLabel) {
    rangeLabel.textContent = `${firstIndex + 1}-${lastIndex} of ${safeRowCount}`;
  }

  const pageLabel = pagination.querySelector<HTMLElement>("[data-chat-table-page-label]");
  if (pageLabel) {
    pageLabel.textContent = `Page ${page + 1} of ${pageCount}`;
  }

  pagination.querySelectorAll<HTMLButtonElement>(".chat-table-pagination-action").forEach((button) => {
    if (button.dataset.action === "previous") {
      button.disabled = page === 0;
    } else if (button.dataset.action === "next") {
      button.disabled = page >= pageCount - 1;
    }
  });
}

// ---------------------------------------------------------------------------
// Shared rich-content adjuncts (widgets / mermaid / charts / citations)
// ---------------------------------------------------------------------------
// The four assistant render sites (Slack/ChatGPT × parts/legacy) repeated
// these blocks verbatim in chat-page.tsx; they are factored here into local
// components that emit byte-identical DOM (same keys, same markup).

function MessageWidgetEmbeds({
  message,
  isLastMessage,
  widgetRuntime,
  widgetSubmitRef,
  widgetRefreshKey,
}: {
  message: UiMessage;
  isLastMessage: boolean;
  widgetRuntime: ChatWidgetRuntime;
  widgetSubmitRef: React.RefObject<WidgetSubmitHandle | null>;
  widgetRefreshKey: number;
}) {
  const widgets = widgetRuntime.detectWidgets(message.content);
  if (widgets.length === 0) return null;
  return widgets.map((widget) => (
    <ChatWidget
      key={widget.widgetId + widget.resourceId}
      widget={widget}
      def={widgetRuntime.findWidget(widget.widgetId)}
      submitRef={isLastMessage ? widgetSubmitRef : { current: null }}
      isOlderWidget={!isLastMessage}
      refreshKey={widgetRefreshKey}
    />
  ));
}

function MessageMermaidEmbeds({ message }: { message: UiMessage }) {
  const mermaidBlocks = detectMermaidBlocks(message.content);
  if (mermaidBlocks.length === 0) return null;
  return mermaidBlocks.map((block, i) => (
    <MermaidBlock
      key={`${message.id}-mermaid-${i}`}
      id={`${message.id}-${i}`}
      source={block.source}
    />
  ));
}

/**
 * viewType → the resolved extension-provided renderable-view component
 * (a React client reference), resolved server-side from the generated
 * `cinatra.views` map by src/lib/chat-views-catalog.server.ts and threaded in
 * as a prop. Empty when no view-bearing extension is live/built.
 */
export type ChatViewComponents = Record<
  string,
  ComponentType<{ view: { viewType: string } }>
>;

/**
 * Error boundary around a mounted EXTENSION renderable-view component: a
 * render/lifecycle throw from the extension degrades to the host's never-blank
 * floor (`fallback`) instead of escaping and crashing the messages subtree /
 * `/chat` (epic #1620 AC1; mirrors the artifact-side DynamicRendererLoader's
 * RendererErrorBoundary). LOGICAL containment only — not a security boundary.
 */
class ChatViewErrorBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { crashed: boolean }
> {
  constructor(props: { fallback: ReactNode; children: ReactNode }) {
    super(props);
    this.state = { crashed: false };
  }
  static getDerivedStateFromError(): { crashed: boolean } {
    return { crashed: true };
  }
  render(): ReactNode {
    return this.state.crashed ? this.props.fallback : this.props.children;
  }
}

function MessageChartEmbeds({
  message,
  chatViews,
}: {
  message: UiMessage;
  chatViews: ChatViewComponents;
}) {
  // Host-side detection stays here permanently (epic #1620 AC2): the detector
  // emits the stable `chart` viewType payload; the COMPONENT that renders it is
  // extension-provided, dispatched through the generated `cinatra.views` map.
  const charts = detectCharts(message.content);
  if (charts.length === 0) return null;
  const ChartView = chatViews.chart;
  return charts.map((c, i) => {
    const key = `chart-${message.id}-${i}`;
    // Unclaimed / not built into this bundle → the never-blank floor (AC1),
    // never a dead arm. The floor covers the whole `chart` viewType at once.
    if (!ChartView) return <RenderableViewFallback key={key} rawViewType="chart" />;
    // The stable payload the extension receives. A malformed embed (`spec ===
    // null`) still dispatches the bare `{ viewType: "chart" }` payload — the
    // extension re-validates and renders its own non-crashing error floor, so
    // an invalid chart is never blank either. A render THROW from the extension
    // is contained by the boundary → the same never-blank floor.
    const view = c.spec ? buildChartView(c.spec) : { viewType: "chart" as const };
    return (
      <ChatViewErrorBoundary key={key} fallback={<RenderableViewFallback rawViewType="chart" />}>
        <ChartView view={view} />
      </ChatViewErrorBoundary>
    );
  });
}

function MessageCitations({ message }: { message: UiMessage }) {
  if (!message.citations || message.citations.length === 0) return null;
  return (
    <div className="mt-4 border-t border-line pt-3">
      <div className="mb-2 text-xs font-semibold text-muted-foreground">Sources</div>
      <ol className="text-xs">
        {message.citations.map((c, i) => {
          const host = (() => {
            try { return new URL(c.url).hostname.replace(/^www\./, ""); } catch { return c.url; }
          })();
          return (
            <li key={`${message.id}-cite-${i}`} className="my-1 flex gap-2 first:mt-0">
              <span className="text-muted-foreground">{i + 1}.</span>
              <Link href={c.url} target="_blank" rel="noreferrer" className="truncate text-muted-foreground underline underline-offset-4 hover:text-foreground">
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
// Conversation view
// ---------------------------------------------------------------------------

export type ChatMessagesViewProps = {
  messages: UiMessage[];
  isSlackMode: boolean;
  animating: boolean;
  theme: ThemeName;
  /** Signed-in user's id + display fields (from authClient.useSession()). */
  userId?: string;
  sessionUser?: { name?: string | null; image?: string | null } | null;
  activeThreadId: string | null;
  activeAssistantHandle?: string;
  /** assistantUserId → @handle map scanned from user-message mentions. */
  assistantHandleMap: Map<string, string>;
  taggedAssistantUserIds: string[];
  mentionables: Mentionable[];
  pausedParticipants: string[];
  onTogglePause: (participantId: string, next: boolean) => void;
  requestEditMessageId: string | null;
  onRequestEditMessage: (messageId: string) => void;
  onEditStarted: () => void;
  hasActiveStream: boolean;
  /** True while `messageId` has an in-flight stream (abort-controller registry). */
  isStreaming: (messageId: string) => boolean;
  onEditAndResend: (messageId: string, newContent: string) => void;
  onActivateResource: (resourceType: string, resourceId: string) => void;
  widgetRuntime: ChatWidgetRuntime;
  widgetSubmitRef: React.RefObject<WidgetSubmitHandle | null>;
  widgetRefreshKey: number;
  onActiveGateChange: (
    runId: string,
    gate: ChatGateDescriptor | null,
    instanceId: string,
  ) => void;
  pendingExternalHandle: string | null;
  /** assistantId → display handle for per-assistant typing bubbles (Slack mode). */
  typingIndicators: Map<string, string>;
  /** Extension-provided chat renderable-view components (viewType → component),
   *  resolved server-side from the generated `cinatra.views` map. Defaults to
   *  empty — the `chart` viewType then renders the never-blank fallback. */
  chatViews: ChatViewComponents;
};

export function ChatMessagesView({
  messages,
  isSlackMode,
  animating,
  theme,
  userId,
  sessionUser,
  activeThreadId,
  activeAssistantHandle,
  assistantHandleMap,
  taggedAssistantUserIds,
  mentionables,
  pausedParticipants,
  onTogglePause,
  requestEditMessageId,
  onRequestEditMessage,
  onEditStarted,
  hasActiveStream,
  isStreaming,
  onEditAndResend,
  onActivateResource,
  widgetRuntime,
  widgetSubmitRef,
  widgetRefreshKey,
  onActiveGateChange,
  pendingExternalHandle,
  typingIndicators,
  chatViews,
}: ChatMessagesViewProps) {
  // Hydrate shiki placeholders after render — replace fallback <pre> blocks with
  // syntax-highlighted HTML loaded lazily from shiki. (Moved with the view: the
  // placeholders it queries exist only in this component's DOM.)
  useEffect(() => {
    const placeholders = document.querySelectorAll<HTMLElement>("[data-shiki-code]");
    if (placeholders.length === 0) return;
    placeholders.forEach((el) => {
      // URL-encoded raw source (UTF-safe, set in the code() renderer).
      const code = decodeURIComponent(el.dataset.shikiCode ?? "");
      const lang = el.dataset.shikiLang ?? "text";
      const elTheme = (el.dataset.shikiTheme ?? "github-light") as ThemeName;
      void highlightCodeAsync(code, lang, elTheme).then((html) => {
        if (!html) return;
        const pre = el.querySelector("pre");
        if (!pre) return;
        const temp = document.createElement("div");
        temp.innerHTML = html;
        const shikiPre = temp.querySelector("pre");
        if (shikiPre) {
          // Preserve our layout classes on the <pre> element.
          shikiPre.classList.add("overflow-x-auto", "whitespace-pre", "p-4", "text-[0.8rem]", "leading-relaxed", "font-mono");
          pre.replaceWith(shikiPre);
        }
        el.removeAttribute("data-shiki-code");
      });
    });
  }, [messages, hasActiveStream, theme]);

  // Shared click handler for assistant markdown content: handles
  // copy-code buttons (inside fenced code blocks) and table copy/CSV
  // download actions. Both the legacy `message.content` div and the new
  // `OrderedPartsSection` text parts wear this handler so the buttons
  // work the same way regardless of which render path is active.
  const handleAssistantMarkdownClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const codeBtn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-action='copy-code']");
    if (codeBtn) {
      const block = codeBtn.closest(".chat-code-block");
      if (block) {
        const codeEl = block.querySelector("code");
        const rawText = codeEl?.textContent ?? "";
        void navigator.clipboard.writeText(rawText);
      }
      return;
    }
    const tablePageBtn = (e.target as HTMLElement).closest<HTMLButtonElement>(".chat-table-pagination-action");
    if (tablePageBtn) {
      const frame = tablePageBtn.closest("[data-chat-table-frame]");
      const pagination = frame?.querySelector<HTMLElement>("[data-chat-table-pagination]");
      if (frame && pagination) {
        const currentPage = Number(pagination.dataset.page ?? "0");
        updateChatTablePage(
          frame,
          tablePageBtn.dataset.action === "previous" ? currentPage - 1 : currentPage + 1,
        );
      }
      return;
    }
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".chat-table-action");
    if (!btn) return;
    const tableId = btn.dataset.tableId;
    const action = btn.dataset.action;
    if (action === "copy" && tableId) {
      const table = document.getElementById(tableId);
      if (table) {
        const rows = Array.from(table.querySelectorAll("tr"));
        const text = rows.map((row) =>
          Array.from(row.querySelectorAll("th, td")).map((cell) => cell.textContent?.trim() ?? "").join("\t"),
        ).join("\n");
        void navigator.clipboard.writeText(text);
      }
    } else if (action === "download" && btn.dataset.csv) {
      const csv = btn.dataset.csv.replace(/\\n/g, "\n");
      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "table.csv";
      a.click();
      URL.revokeObjectURL(url);
    }
  }, []);

  return (
    /* gap-8 (was gap-5): action row clears next turn's header on same-side turns (#504) */
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4">
      {messages.map((message) => {
        const isUser = message.role === "user";
        if (isSlackMode) {
          const userInitials = sessionUser?.name
            ? sessionUser.name.split(" ").map((n: string) => n[0]).filter(Boolean).join("").toUpperCase().slice(0, 2)
            : "Me";
          // Resolve per-message handle: authorUserId → handle map, fallback to "cinatra"
          const messageHandle = !isUser
            ? (message.authorUserId
                ? (assistantHandleMap.get(message.authorUserId) ?? activeAssistantHandle ?? "cinatra")
                : "cinatra")
            : null;
          const initials = isUser ? userInitials : getParticipantInitials(messageHandle ?? undefined);
          const displayName = isUser
            ? (sessionUser?.name ?? "You")
            : resolveAssistantDisplayName(messageHandle);
          const assistantIcon = !isUser ? getAssistantProviderIcon(messageHandle ?? undefined) : null;
          return (
            <div
              key={message.id}
              className={cn(
                "group flex flex-col gap-1",
                animating && "animate-slack-slide-left",
              )}
            >
              {/* Header row: Avatar + name aligned in the middle */}
              <div className="flex items-center gap-2">
                {/* Resolve sender user ID — covers human, external assistant, and built-in cinatra */}
                {(() => {
                  const senderUserId = isUser
                    ? userId
                    : (message.authorUserId ?? mentionables.find((m) => m.handle === (messageHandle ?? "cinatra"))?.id);
                  const profileHref = senderUserId ? `/users/${senderUserId}` : null;
                  const avatarEl = (
                    <Avatar size="sm">
                      {isUser && sessionUser?.image && <AvatarImage src={sessionUser.image} />}
                      <AvatarFallback>{assistantIcon ?? initials}</AvatarFallback>
                    </Avatar>
                  );
                  return (
                    <>
                      {profileHref ? (
                        <Link href={profileHref} className={cn("shrink-0", animating && "animate-slack-avatar-fade-in")}>{avatarEl}</Link>
                      ) : (
                        <span className={cn("shrink-0", animating && "animate-slack-avatar-fade-in")}>{avatarEl}</span>
                      )}
                      <div className={cn("group/name flex items-center gap-1", animating && "animate-slack-name-fade-in")}>
                        {profileHref ? (
                          <Link href={profileHref} className="text-xs font-medium text-muted-foreground hover:text-foreground hover:underline">{displayName}</Link>
                        ) : (
                          <span className="text-xs font-medium text-muted-foreground">{displayName}</span>
                        )}
                  {!isUser && activeThreadId && (() => {
                    // Resolve participant ID: authorUserId for external, "cinatra" for built-in
                    const participantId = message.authorUserId ?? "cinatra";
                    const isPaused = pausedParticipants.includes(participantId);
                    return (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        title={isPaused ? `Resume ${displayName}` : `Pause ${displayName}`}
                        onClick={() => {
                          onTogglePause(participantId, !isPaused);
                        }}
                        className="h-auto w-auto transition-opacity text-muted-foreground hover:text-foreground hover:bg-transparent"
                      >
                        {isPaused
                          ? <PlayCircle className="h-3.5 w-3.5" />
                          : <PauseCircle className="h-3.5 w-3.5" />}
                      </Button>
                    );
                  })()}
                      </div>
                    </>
                  );
                })()}
                <div className="flex-1" />
                <div className="flex items-center gap-0.5">
                  {isUser && !hasActiveStream && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      title="Edit message"
                      onClick={() => onRequestEditMessage(message.id)}
                      className="h-auto w-auto rounded p-1 text-muted-foreground hover:text-foreground hover:bg-surface-muted transition-colors"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    title="Copy message"
                    onClick={() => void navigator.clipboard.writeText(message.content)}
                    className="h-auto w-auto rounded p-1 text-muted-foreground hover:text-foreground hover:bg-surface-muted transition-colors"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              {/* Bubble indented to align with name (past avatar + gap) */}
              <div className="relative ml-8 max-w-[85%]">
                {isUser ? (
                  <UserMessageBubble
                    message={message}
                    onEdit={(id, content) => onEditAndResend(id, content)}
                    disabled={hasActiveStream}
                    isSlackMode
                    editRequested={requestEditMessageId === message.id}
                    onEditStarted={onEditStarted}
                    mentionables={mentionables}
                  />
                ) : (
                  <div className="group min-w-0 max-w-full flex-1">
                    {/* Ordered parts: when an assistant message
                        has a `parts` trace, render text + tool badges
                        chronologically interleaved. Replaces the
                        flat thoughtGroups-above-content layout. Old
                        messages without parts fall through to the
                        legacy path below. */}
                    {message.parts && message.parts.length > 0 && !message.error ? (
                      <OrderedPartsSection
                        parts={message.parts}
                        trimContent={isStreaming(message.id) ? trimIncompleteEmbeds : undefined}
                        theme={theme}
                        detectWidgets={widgetRuntime.detectWidgets}
                        onMarkdownClick={handleAssistantMarkdownClick}
                        onActiveGateChange={onActiveGateChange}
                      />
                    ) : (
                      <>
                        {message.thoughtGroups && message.thoughtGroups.length > 0 && !isStreaming(message.id) && (
                          <div>
                            {message.thoughtGroups.map((group) => (
                              <ThoughtGroupSection
                                key={group.id}
                                group={group}
                                isLive={isStreaming(message.id)}
                              />
                            ))}
                          </div>
                        )}
                      </>
                    )}
                    {message.error ? (
                      <ErrorCard error={message.error} errorRaw={message.errorRaw} />
                    ) : (message.parts && message.parts.length > 0) ? (
                      // Rich-content adjuncts (mermaid, charts, citations,
                      // widgets) are computed from `message.content` which
                      // is populated alongside `parts`. Render them BELOW
                      // the interleaved parts so the feature set matches
                      // the legacy path.
                      <>
                        <MessageWidgetEmbeds
                          message={message}
                          isLastMessage={message === messages[messages.length - 1]}
                          widgetRuntime={widgetRuntime}
                          widgetSubmitRef={widgetSubmitRef}
                          widgetRefreshKey={widgetRefreshKey}
                        />
                        <MessageMermaidEmbeds message={message} />
                        <MessageChartEmbeds message={message} chatViews={chatViews} />
                        <MessageCitations message={message} />
                        {isStreaming(message.id) && shouldShowLiveProgressStatus(message) && (
                          <ThinkingIndicator className="mt-2" label={getLiveProgressStatus(message)} />
                        )}
                      </>
                    ) : message.content ? (
                      <>
                        <div
                          className="max-w-none text-[15px] leading-relaxed text-foreground [&_table]:my-0"
                          dangerouslySetInnerHTML={{ __html: renderMarkdown(
                            isStreaming(message.id)
                              ? trimIncompleteEmbeds(message.content)
                              : message.content,
                            theme,
                            widgetRuntime.detectWidgets,
                          ) }}
                          onClick={handleAssistantMarkdownClick}
                        />
                        <MessageWidgetEmbeds
                          message={message}
                          isLastMessage={message === messages[messages.length - 1]}
                          widgetRuntime={widgetRuntime}
                          widgetSubmitRef={widgetSubmitRef}
                          widgetRefreshKey={widgetRefreshKey}
                        />
                        <MessageMermaidEmbeds message={message} />
                        <MessageChartEmbeds message={message} chatViews={chatViews} />
                        <MessageCitations message={message} />
                        {isStreaming(message.id) && shouldShowLiveProgressStatus(message) && (
                          <ThinkingIndicator className="mt-2" label={getLiveProgressStatus(message)} />
                        )}
                      </>
                    ) : isStreaming(message.id) && shouldShowLiveProgressStatus(message) ? (
                      <ThinkingIndicator label={getLiveProgressStatus(message)} />
                    ) : null}
                  </div>
                )}
              </div>
            </div>
          );
        }
        // ChatGPT branch — preserve byte-identical render behavior.
        const showParticipantHeaders = true;
        const nmUserInitials = sessionUser?.name
          ? sessionUser.name.split(" ").map((n: string) => n[0]).filter(Boolean).join("").toUpperCase().slice(0, 2)
          : "Me";
        const nmUserName = sessionUser?.name ?? "You";
        const nmThreadHasMention = taggedAssistantUserIds.length >= 1
          || messages.some((m) => m.role === "user" && /@[a-z0-9_-]+/i.test(m.content));
        const nmResolvedHandle = nmThreadHasMention ? activeAssistantHandle : undefined;
        const nmHandle = !isUser
          ? (message.authorUserId
              ? (assistantHandleMap.get(message.authorUserId) ?? nmResolvedHandle ?? "cinatra")
              : (nmResolvedHandle ?? "cinatra"))
          : null;
        const nmDisplayName = isUser ? nmUserName : resolveAssistantDisplayName(nmHandle);
        const nmAssistantIcon = !isUser ? getAssistantProviderIcon(nmHandle ?? undefined) : null;
        const nmInitials = !isUser ? getParticipantInitials(nmHandle ?? undefined) : nmUserInitials;
        return (
          <div key={message.id} className={cn("flex flex-col gap-1", isUser && "items-end")}>
            {showParticipantHeaders && (
              isUser ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-muted-foreground">{nmUserName}</span>
                  <Avatar size="sm">
                    {sessionUser?.image && <AvatarImage src={sessionUser.image} />}
                    <AvatarFallback>{nmUserInitials}</AvatarFallback>
                  </Avatar>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <Avatar size="sm">
                    <AvatarFallback>{nmAssistantIcon ?? nmInitials}</AvatarFallback>
                  </Avatar>
                  <span className="text-xs font-medium text-muted-foreground">{nmDisplayName}</span>
                </div>
              )
            )}
            {isUser ? (
              <UserMessageBubble
                message={message}
                onEdit={(id, content) => onEditAndResend(id, content)}
                disabled={hasActiveStream}
                mentionables={mentionables}
              />
            ) : (
              <div className="group min-w-0 max-w-full flex-1">
                {/* Ordered parts — see comment at the first render site
                    above. Same conditional applies here in slack-mode
                    view. */}
                {message.parts && message.parts.length > 0 && !message.error ? (
                  <OrderedPartsSection
                    parts={message.parts}
                    trimContent={isStreaming(message.id) ? trimIncompleteEmbeds : undefined}
                    theme={theme}
                    detectWidgets={widgetRuntime.detectWidgets}
                    onMarkdownClick={handleAssistantMarkdownClick}
                    onActiveGateChange={onActiveGateChange}
                  />
                ) : (
                  <>
                    {message.thoughtGroups && message.thoughtGroups.length > 0 && !isStreaming(message.id) && (
                      <div>
                        {message.thoughtGroups.map((group) => (
                          <ThoughtGroupSection
                            key={group.id}
                            group={group}
                            isLive={isStreaming(message.id)}
                          />
                        ))}
                      </div>
                    )}
                  </>
                )}
                {message.error ? (
                  <ErrorCard error={message.error} errorRaw={message.errorRaw} />
                ) : (message.parts && message.parts.length > 0) ? (
                  // Same rich-content adjuncts treatment as the
                  // ChatGPT-mode render site above.
                  <>
                    <MessageWidgetEmbeds
                      message={message}
                      isLastMessage={message === messages[messages.length - 1]}
                      widgetRuntime={widgetRuntime}
                      widgetSubmitRef={widgetSubmitRef}
                      widgetRefreshKey={widgetRefreshKey}
                    />
                    <MessageMermaidEmbeds message={message} />
                    <MessageChartEmbeds message={message} chatViews={chatViews} />
                    <MessageCitations message={message} />
                    {isStreaming(message.id) && shouldShowLiveProgressStatus(message) && (
                      <ThinkingIndicator className="mt-2" label={getLiveProgressStatus(message)} />
                    )}
                  </>
                ) : message.content ? (
                  <>
                    <div
                      className="max-w-none text-[15px] leading-relaxed text-foreground [&_table]:my-0"
                      dangerouslySetInnerHTML={{ __html: renderMarkdown(
                        // While streaming, trim incomplete embed prefixes so partial
                        // JSON/mermaid never flashes as raw text in the markdown output.
                        isStreaming(message.id)
                          ? trimIncompleteEmbeds(message.content)
                          : message.content,
                        theme,
                        widgetRuntime.detectWidgets,
                      ) }}
                      /* renderMarkdown strips mermaid blocks; they are rendered separately below */
                      onClick={handleAssistantMarkdownClick}
                    />
                    <MessageWidgetEmbeds
                      message={message}
                      isLastMessage={message === messages[messages.length - 1]}
                      widgetRuntime={widgetRuntime}
                      widgetSubmitRef={widgetSubmitRef}
                      widgetRefreshKey={widgetRefreshKey}
                    />
                    <MessageMermaidEmbeds message={message} />
                    <MessageChartEmbeds message={message} chatViews={chatViews} />
                    {message.role === "assistant" && <MessageCitations message={message} />}
                    {isStreaming(message.id) && shouldShowLiveProgressStatus(message) && (
                      <ThinkingIndicator className="mt-2" label={getLiveProgressStatus(message)} />
                    )}
                    {(() => {
                      const confirmMatch = message.content.match(/\[confirm-([a-z_-]+):([a-f0-9-]{36})\]/i);
                      if (!confirmMatch) return null;
                      const [, resourceType, resourceId] = confirmMatch;
                      const manifest = widgetRuntime.findManifestByConfirmationResourceType(resourceType);
                      if (!manifest?.wizard) return null;
                      const isLastMessage = message === messages[messages.length - 1];
                      if (!isLastMessage) return null;
                      return (
                        <div className="mt-3 flex gap-2">
                          <Button
                            type="button"
                            onClick={() => onActivateResource(resourceType, resourceId)}
                            disabled={hasActiveStream}
                            className="h-auto rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/80 disabled:opacity-50"
                          >
                            {manifest.wizard.confirmation.buttonLabel}
                          </Button>
                        </div>
                      );
                    })()}
                    {!isStreaming(message.id) && (
                      <div className="mt-1 flex gap-0.5">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => void navigator.clipboard.writeText(message.content)}
                          className="rounded-lg p-1.5 text-muted-foreground transition hover:bg-surface-muted hover:text-muted-foreground"
                          title="Copy response"
                        >
                          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5">
                            <rect x="5.5" y="5.5" width="7" height="7" rx="1" />
                            <path d="M3.5 10.5V4a1 1 0 0 1 1-1h6.5" />
                          </svg>
                        </Button>
                        {(() => {
                          const idx = messages.findIndex((m) => m.id === message.id);
                          const prevUser = idx > 0 ? messages.slice(0, idx).findLast((m) => m.role === "user") : undefined;
                          if (!prevUser || isSlackMode) return null;
                          return (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() => onEditAndResend(prevUser.id, prevUser.content)}
                              disabled={hasActiveStream}
                              className="rounded-lg p-1.5 text-muted-foreground transition hover:bg-surface-muted hover:text-muted-foreground disabled:opacity-50"
                              title="Try again"
                            >
                              <RotateCcw className="h-3.5 w-3.5" />
                            </Button>
                          );
                        })()}
                      </div>
                    )}
                  </>
                ) : isStreaming(message.id) && shouldShowLiveProgressStatus(message) ? (
                  <ThinkingIndicator label={getLiveProgressStatus(message)} />
                ) : null}
              </div>
            )}
          </div>
        );
      })}
      {/* Waiting indicator — shown while an external assistant is expected to reply */}
      {pendingExternalHandle && (
        <div className="flex justify-start">
          <div className="min-w-0 max-w-full flex-1">
            <WaitingIndicator handle={pendingExternalHandle} />
          </div>
        </div>
      )}
      {/* Slack mode: per-assistant typing indicator while stream is buffering */}
      {isSlackMode && typingIndicators.size > 0 && Array.from(typingIndicators.entries()).map(([id, indicatorHandle]) => (
        <div key={id} className="flex justify-start">
          <div className="min-w-0 max-w-full flex-1">
            <SlackTypingIndicator handle={indicatorHandle} />
          </div>
        </div>
      ))}
    </div>
  );
}

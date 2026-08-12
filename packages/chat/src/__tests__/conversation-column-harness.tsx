// ---------------------------------------------------------------------------
// The TWO-SURFACE harness for the ONE conversation column (cinatra#2683, S8f).
// ---------------------------------------------------------------------------
// The 2026-08-12 inventory measured the widget's conversation column against
// `/chat` element by element, on a real WordPress site. This harness is that
// measurement made automatic — but note what it can and cannot be after the
// owner's architecture ruling.
//
// BEFORE the ruling, a parity harness compared TWO implementations and asked
// whether they agreed. That test is only ever as good as the day it was written:
// the next affordance added to one side is invisible to it.
//
// AFTER the ruling there is ONE implementation. So the two arms below mount the
// SAME component and differ ONLY in the host adapter — the cookie surface's
// declaration versus the widget's broker declaration. The inventory then passes
// by CONSTRUCTION, and that is the point: these checks are a regression net
// around the construction (a host adapter that silently suppressed an affordance
// would still be caught), not the proof of parity. The proof of parity is
// `one-conversation-column.test.ts`, which fails if a second column ever exists.
// ---------------------------------------------------------------------------

import { fireEvent, render, waitFor, type RenderResult } from "@testing-library/react";
import { expect } from "vitest";
import type { ReactElement } from "react";

import type { ChatViewComponents } from "../chat-messages-view";
import {
  CHAT_THREAD_HOST,
  ConversationColumn,
  useConversationColumnTurns,
  type ConversationTransport,
} from "../conversation-column";
import { createChatWidgetRuntime, EMPTY_WIDGETS, EMPTY_WIDGET_MANIFESTS } from "../widget-runtime";
import type { UiMessage } from "../types";
import type { Mentionable } from "@cinatra-ai/sdk-ui/prompt-field";

export const SURFACES = ["chat", "widget"] as const;
export type SurfaceName = (typeof SURFACES)[number];

/** The broker proof the embed declares. Values are structural, not real. */
export const WIDGET_TRANSPORT: ConversationTransport = {
  authHeaders: () => ({
    Authorization: "Bearer cit_site",
    "X-Cinatra-Widget-User-Token": "cwu_user",
    "X-Cinatra-Widget-Assistant": "wordpress",
    "X-Cinatra-Widget-Origin": "https://blog.example.com",
  }),
  credentialsMode: "omit",
  assistant: "wordpress",
};

/** The embed's lifecycle declaration, in the shape the card runtime reads. */
export const WIDGET_LIFECYCLE_SURFACE = {
  host: "site_widget" as const,
  auth: { headers: WIDGET_TRANSPORT.authHeaders, credentials: "omit" as const },
  frame: { assistant: "wordpress", instanceId: "inst-1" },
};

export const FIXTURE_THREAD_ID = "thread-parity-2683";

/**
 * ONE fixture thread, carrying every element class the inventory measured:
 * multiple prior turns, a user turn, an assistant answer with fenced code, a
 * mermaid block, a chart embed and an extension widget embed, plus citations.
 */
export function parityFixtureMessages(): UiMessage[] {
  return [
    { id: "u1", role: "user", content: "First question about @cinatra" },
    { id: "a1", role: "assistant", content: "First answer." },
    { id: "u2", role: "user", content: "Second question" },
    {
      id: "a2",
      role: "assistant",
      content: [
        "Here is the rich answer.",
        "",
        "```ts",
        "const answer = 42;",
        "```",
        "",
        "```mermaid",
        "graph TD; A-->B;",
        "```",
        "",
        "```chart",
        '{"type":"bar","data":{"labels":["a"],"datasets":[{"label":"x","data":[1]}]}}',
        "```",
        "",
        "[widget:test.widget:11111111-1111-4111-8111-111111111111]",
      ].join("\n"),
      citations: [{ index: 1, title: "Source", url: "https://example.com/doc" }],
    },
  ];
}

/**
 * A thread whose assistant turn ran an AGENT — the mount point for the undo
 * chip (item 12), which renders under an `agent_run` part.
 */
export function parityAgentRunMessages(): UiMessage[] {
  return [
    { id: "u1", role: "user", content: "Run the agent" },
    {
      id: "a1",
      role: "assistant",
      content: "",
      parts: [
        { kind: "tool_call", id: "t1", name: "agent_run", runId: "run-2683", status: "completed" },
      ],
    } as UiMessage,
  ];
}

/** A thread whose last assistant turn FAILED — drives the error-card checks. */
export function parityErrorMessages(): UiMessage[] {
  return [
    { id: "u1", role: "user", content: "Do the thing" },
    {
      id: "a1",
      role: "assistant",
      content: "",
      error: "The default LLM provider is not available.",
      errorRaw: "Error: provider anthropic is not configured\n    at run()",
    },
  ];
}

export const PARITY_MENTIONABLES: Mentionable[] = [
  { id: "assistant-1", handle: "cinatra", displayName: "Cinatra", type: "assistant" },
  { id: "assistant-2", handle: "claude", displayName: "Claude", type: "assistant" },
];

export const PARITY_SESSION_USER = { name: "Ada Lovelace", image: null };

/** A widget definition + manifest pair, so the EXTENSION-widget detector has
 *  something to find on both surfaces (item 14's "extension chat widgets"). */
export function parityWidgetCatalog() {
  return {
    widgets: [
      {
        id: "test.widget",
        component: function TestWidget() {
          return <div data-testid="extension-chat-widget">extension widget</div>;
        },
      },
    ] as never,
    manifests: [] as never,
  };
}

export const PARITY_CHAT_VIEWS: ChatViewComponents = {
  chart: function ChartView() {
    return <div data-testid="chart-view">chart</div>;
  },
};

export type SurfaceMountOptions = {
  messages?: UiMessage[];
  mentionables?: Mentionable[];
  sessionUser?: { name?: string | null; image?: string | null } | null;
  /** Report `hasActiveStream` / `isStreaming` as true for these ids (chat arm). */
  streamingIds?: string[];
  onEditAndResend?: (messageId: string, newContent: string) => void;
  withCatalog?: boolean;
  /** Supply the composer's attachment handler (items 8/9's prop gate). */
  onAttachmentsSelected?: (files: File[]) => void;
};

/**
 * The `/chat` arm — THE column, with the props `chat-page.tsx` passes it: no
 * host adapter at all, so the list declares `chat_thread` and the link policy
 * stays first-party. `chat-page-mounts-the-column.test.ts` pins that this prop
 * set is the one the real page passes, so this arm cannot claim a `/chat` that
 * does not exist.
 */
export function chatSurfaceElement(options: SurfaceMountOptions = {}): ReactElement {
  const messages = options.messages ?? parityFixtureMessages();
  const streaming = new Set(options.streamingIds ?? []);
  const catalog = options.withCatalog ? parityWidgetCatalog() : null;
  const runtime = createChatWidgetRuntime(
    catalog?.widgets ?? EMPTY_WIDGETS,
    catalog?.manifests ?? EMPTY_WIDGET_MANIFESTS,
  );
  return (
    <div data-parity-surface="chat">
      <ConversationColumn
        host={CHAT_THREAD_HOST}
        messages={messages}
        isSlackMode={false}
        animating={false}
        theme="github-light"
        userId="user-1"
        sessionUser={options.sessionUser ?? PARITY_SESSION_USER}
        activeThreadId={FIXTURE_THREAD_ID}
        assistantHandleMap={new Map()}
        taggedAssistantUserIds={[]}
        mentionables={options.mentionables ?? PARITY_MENTIONABLES}
        pausedParticipants={[]}
        onTogglePause={() => {}}
        requestEditMessageId={null}
        onRequestEditMessage={() => {}}
        onEditStarted={() => {}}
        streamingCount={streaming.size}
        isStreaming={(id) => streaming.has(id)}
        onEditAndResend={options.onEditAndResend ?? (() => {})}
        onActivateResource={() => {}}
        widgetRuntime={runtime}
        widgetSubmitRef={{ current: null }}
        widgetRefreshKey={0}
        onActiveGateChange={() => {}}
        pendingExternalHandle={null}
        typingIndicators={new Map()}
        chatViews={options.withCatalog ? PARITY_CHAT_VIEWS : {}}
        promptRef={{ current: null }}
        placeholder="Type a message..."
        promptStorageKey={`cinatra_thread_prompt_${FIXTURE_THREAD_ID}`}
        onSubmit={() => {}}
        submitAriaLabel="Send message"
        onStop={() => {}}
        {...(options.onAttachmentsSelected
          ? { onAttachmentsSelected: options.onAttachmentsSelected }
          : {})}
      />
    </div>
  );
}

/**
 * The WIDGET arm — THE SAME column, with the embed's host adapters and the
 * shared turn engine, exactly as `embed-assistant-client.tsx` mounts it.
 */
/**
 * The widget's PRODUCTION composer inputs. The embed supplies no participant
 * list (it has one bound assistant, and no broker-aware source for a list) and
 * no attachment handler (the upload route is cookie-bound) — see the open
 * questions in `conversation-column-inventory.test.tsx`. The arm therefore
 * defaults to what production passes, so a check cannot pass here by being
 * handed something the real widget never gets (codex round 2, finding 1). A test
 * that wants to measure the COLUMN's seam rather than the widget's wiring passes
 * the input explicitly, to BOTH arms.
 */
const WIDGET_PRODUCTION_MENTIONABLES: Mentionable[] = [];

function WidgetSurface(options: SurfaceMountOptions) {
  const catalog = options.withCatalog ? parityWidgetCatalog() : null;
  const turns = useConversationColumnTurns({
    threadId: FIXTURE_THREAD_ID,
    transport: WIDGET_TRANSPORT,
    ...(catalog ? { widgets: catalog.widgets, widgetManifests: catalog.manifests } : {}),
    initialMessages: options.messages ?? parityFixtureMessages(),
  });
  return (
    <div data-parity-surface="widget">
      <ConversationColumn
        {...turns}
        host={{ lifecycleSurface: WIDGET_LIFECYCLE_SURFACE }}
        theme="github-light"
        sessionUser={options.sessionUser ?? PARITY_SESSION_USER}
        mentionables={options.mentionables ?? WIDGET_PRODUCTION_MENTIONABLES}
        chatViews={options.withCatalog ? PARITY_CHAT_VIEWS : {}}
        onActivateResource={() => {}}
        onActiveGateChange={() => {}}
        placeholder="Type a message..."
        promptStorageKey={`cinatra_embed_prompt_${FIXTURE_THREAD_ID}`}
        submitAriaLabel="Send message"
        {...(options.onAttachmentsSelected
          ? { onAttachmentsSelected: options.onAttachmentsSelected }
          : {})}
      />
    </div>
  );
}

export function surfaceElement(
  surface: SurfaceName,
  options: SurfaceMountOptions = {},
): ReactElement {
  return surface === "chat" ? chatSurfaceElement(options) : <WidgetSurface {...options} />;
}

/**
 * Render a surface and wait for its message list.
 *
 * The column loads the list behind its OWN `next/dynamic` boundary (that is what
 * keeps the heavy renderers off both routes' initial bundles), so the list
 * arrives a tick after mount on every host — which is exactly what happens in a
 * browser too. Waiting on the list's own presence hook keeps every check below
 * measuring a mounted column rather than a loading one.
 */
export async function mountSurface(
  surface: SurfaceName,
  options: SurfaceMountOptions = {},
): Promise<RenderResult> {
  const result = render(surfaceElement(surface, options));
  await waitFor(() =>
    expect(result.container.querySelector("[data-conversation-list]")).not.toBeNull(),
  );
  return result;
}

// ---------------------------------------------------------------------------
// The INVENTORY probes — the 2026-08-12 measurement, as code.
// ---------------------------------------------------------------------------
// Each probe is the count/predicate the inventory table reported, read off a
// mounted surface. `measureConversationColumn` returns the whole row, so a test
// can assert the two surfaces produce the SAME row rather than re-deriving
// per-item expectations twice.

export type ConversationInventory = {
  /** 1 — every prior message of the thread renders. */
  messageBlocks: number;
  /** 2 — the user's own message, echoed as a bubble. */
  userBubbles: number;
  /** 3 — sender identity rows (avatar + display name). */
  avatars: number;
  /** 4 — per-message Copy / Edit on a user message. */
  userCopyButtons: number;
  userEditButtons: number;
  /** 5 — the whole-response action row under an answer. */
  responseCopyButtons: number;
  responseRetryButtons: number;
  /** 6 — the composer's stop control (present only while a turn runs). */
  hasStopControl: boolean;
  /** 7 — the composer's shape. */
  composerIsMultiline: boolean;
  legacySingleLineInputs: number;
  /** 8/9 — the attachment picker and the prompt-options flyout trigger. */
  hasAttachmentInput: boolean;
  hasPromptOptionsTrigger: boolean;
  /** 10 — the composer's @-mention flyout anchor. */
  mentionFlyoutAnchors: number;
  /** 11/12 — mount points for the pending-confirmation cards and undo chip. */
  pendingConfirmationCards: number;
  undoChips: number;
  /** 13 — the friendly error card + "Copy error details". */
  errorCards: number;
  hasCopyErrorDetails: boolean;
  /** 14 — the rich-rendering stack's own output. */
  codeBlocks: number;
  codeCopyButtons: number;
  mermaidBlocks: number;
  chartViews: number;
  extensionWidgets: number;
  contentBlocks: number;
  /** The circular send control (the cosmetic item folded in with the above). */
  sendControlIsIconButton: boolean;
  /** Frame-specific elements that must NEVER leak into the column. */
  frameLeaks: number;
};

const FRAME_SELECTORS = [
  "nav",
  "header",
  "[data-chat-thread-header]",
  "[data-chat-sidebar]",
  "[data-chat-history-drawer]",
  "[data-app-top-bar]",
];

export function measureConversationColumn(root: HTMLElement): ConversationInventory {
  const q = (sel: string) => root.querySelectorAll(sel);
  const editor = root.querySelector<HTMLElement>('[data-testid="chat-prompt-input"]');
  const sendControl = root.querySelector<HTMLButtonElement>(
    'button[aria-label="Send message"], button[aria-label="Stop generating"]',
  );
  return {
    messageBlocks: q("[data-embed-content]").length + q("[data-chat-error-card]").length,
    userBubbles: q("div.whitespace-pre-wrap.break-words.rounded-control").length,
    avatars: q('[data-slot="avatar"]').length,
    userCopyButtons: q('button[title="Copy"]').length,
    userEditButtons: q('button[title="Edit message"]').length,
    responseCopyButtons: q('button[title="Copy response"]').length,
    responseRetryButtons: q('button[title="Try again"]').length,
    hasStopControl: !!root.querySelector('button[aria-label="Stop generating"]'),
    composerIsMultiline: !!editor && editor.getAttribute("contenteditable") === "true",
    legacySingleLineInputs: Array.from(q("input")).filter(
      (el) => (el as HTMLInputElement).type !== "file",
    ).length,
    hasAttachmentInput: !!root.querySelector('input[type="file"]'),
    hasPromptOptionsTrigger: !!root.querySelector('button[aria-label="Prompt options"]'),
    mentionFlyoutAnchors: q('span[aria-hidden="true"][aria-haspopup="dialog"]').length,
    pendingConfirmationCards: q('[data-testid="pending-tool-confirmations"]').length,
    undoChips: q('[data-conformance-id="artifacts-undo-entry"]').length,
    errorCards: q("[data-chat-error-card]").length,
    hasCopyErrorDetails: Array.from(q("button")).some((el) =>
      (el.textContent ?? "").includes("Copy error details"),
    ),
    // The code block, counted by its STABLE wrapper rather than by the shiki
    // placeholder attribute: the hydration effect removes that attribute
    // asynchronously (and queries the whole document), so counting it would make
    // the measurement depend on timing rather than on what the surface rendered.
    codeBlocks: q("div.chat-code-block").length,
    codeCopyButtons: q("[data-action='copy-code']").length,
    mermaidBlocks: q("[data-mermaid-block]").length,
    chartViews: q('[data-testid="chart-view"]').length,
    extensionWidgets: q('[data-testid="extension-chat-widget"]').length,
    contentBlocks: q("[data-embed-content]").length,
    sendControlIsIconButton:
      !!sendControl &&
      sendControl.className.includes("rounded-full") &&
      !(sendControl.textContent ?? "").trim(),
    frameLeaks: FRAME_SELECTORS.reduce((n, sel) => n + q(sel).length, 0),
  };
}

// ---------------------------------------------------------------------------
// Driving a RUNNING turn — per host, so the assertion can be shared.
// ---------------------------------------------------------------------------
// `/chat` owns its abort-controller registry in the page orchestrator and hands
// the column `streamingCount` / `isStreaming`; the widget arm owns its own
// through the shared turn engine. That difference is genuinely host-specific
// (it is the "who holds the turn" question, not a conversation affordance), so
// the harness absorbs it and the tests assert the SAME thing about the DOM.

/** A fetch stub whose AG-UI response body stays open until `close()` is called. */
export function openStreamFetchStub() {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const encoder = new TextEncoder();
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchMock = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
        // Honour the caller's AbortSignal exactly as a real fetch body does: a
        // stub that ignored it would leave the driver's promise pending forever
        // and make "stop" look broken when it is not.
        const signal = init?.signal;
        if (signal) {
          const onAbort = () => {
            try {
              c.error(new DOMException("The operation was aborted.", "AbortError"));
            } catch {
              /* already closed */
            }
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }
      },
    });
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  };
  return {
    fetchMock,
    calls,
    emit(event: Record<string, unknown>) {
      controller?.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    },
    close() {
      controller?.close();
    },
  };
}

/** Type `text` into the shared composer and press its send control. */
export function sendThroughComposer(root: HTMLElement, text: string): void {
  const editor = root.querySelector<HTMLElement>('[data-testid="chat-prompt-input"]');
  if (!editor) throw new Error("composer editor not found");
  editor.textContent = text;
  fireEvent.input(editor);
  const send = root.querySelector<HTMLButtonElement>('button[aria-label="Send message"]');
  if (!send) throw new Error("send control not found");
  fireEvent.click(send);
}

/**
 * Mount a surface with a turn IN FLIGHT.
 *
 * The returned `stream` is non-null only for the driven (widget) surface; close
 * it to let the turn finish.
 */
export async function mountRunningSurface(
  surface: SurfaceName,
  options: SurfaceMountOptions = {},
): Promise<RenderResult & { stream: ReturnType<typeof openStreamFetchStub> | null }> {
  if (surface === "chat") {
    const result = await mountSurface("chat", { ...options, streamingIds: ["a2"] });
    return Object.assign(result, { stream: null });
  }
  const stream = openStreamFetchStub();
  const original = globalThis.fetch;
  globalThis.fetch = stream.fetchMock as unknown as typeof fetch;
  const result = await mountSurface("widget", options);
  sendThroughComposer(result.container, "Third question");
  await waitFor(() =>
    expect(
      result.container.querySelector('button[aria-label="Stop generating"]'),
    ).not.toBeNull(),
  );
  globalThis.fetch = original;
  return Object.assign(result, { stream });
}

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
import { useMemo, type ReactElement } from "react";

import type { ChatViewComponents } from "../chat-messages-view";
import {
  CHAT_THREAD_HOST,
  ConversationColumn,
  useConversationColumnTurns,
  type ConversationTransport,
} from "../conversation-column";
import { createChatWidgetRuntime, EMPTY_WIDGETS, EMPTY_WIDGET_MANIFESTS } from "../widget-runtime";
import { LIFECYCLE_VIEW_RESOLVE_PATH } from "../renderable-views/lifecycle-card";
import {
  LIFECYCLE_VIEW_SCHEMA_VERSION,
  TRIGGER_SCHEDULE_PROPOSAL_VIEW_VERSION,
  VERIFICATION_SUMMARY_VIEW_VERSION,
  type LifecycleCardState,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";
import { useBrokeredComposerInputs } from "../brokered-composer-inputs";
import type { ConversationServiceTransport } from "../conversation-services";
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

/**
 * `/chat`'s Skill-autosave prop, in the state its own read produces for a reader
 * allowed to see and change it. The widget arm resolves the SAME answer from the
 * SAME route through its broker branch, so the flyout compares like for like.
 */
export const CHAT_AUTOSAVE_PROP = {
  enabled: false,
  canToggle: true,
  onToggle: () => {},
};

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
  /** The remote-chat jump-out row, server-resolved on BOTH surfaces. */
  remoteChat?: { label: string; href: string };
  /**
   * Mount with NO composer inputs at all — the negative control for the
   * prop-gated rows. Both arms honour it, so a check that the gate still CLOSES
   * measures the column's own gate rather than one surface's wiring.
   */
  withoutComposerInputs?: boolean;
  /**
   * Mount the CHAT arm on a named thread instead of the fixture thread
   * (cinatra#2740). A re-render with a different id is a thread switch, which is
   * what the cold-load settle pass re-arms on. The widget arm resolves its own
   * thread through the shared turn engine and ignores this.
   */
  threadId?: string;
  /**
   * Mount the CHAT arm in the SLACK layout (cinatra#2825, S9l) — the two-mention
   * turn shape, whose pinned layout omits the ordered `parts` trace. `/chat`
   * chooses this per thread, so a survival check has to be able to mount BOTH
   * layouts on the same transcript. Default `false` keeps every existing arm
   * mounting exactly what it mounted before. The widget arm resolves its own
   * layout through the shared turn engine and ignores this.
   */
  slackMode?: boolean;
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
  const threadId = options.threadId ?? FIXTURE_THREAD_ID;
  return (
    <div data-parity-surface="chat">
      <ConversationColumn
        host={CHAT_THREAD_HOST}
        messages={messages}
        isSlackMode={options.slackMode ?? false}
        animating={false}
        theme="github-light"
        userId="user-1"
        sessionUser={options.sessionUser ?? PARITY_SESSION_USER}
        activeThreadId={threadId}
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
        promptStorageKey={`cinatra_thread_prompt_${threadId}`}
        onSubmit={() => {}}
        submitAriaLabel="Send message"
        onStop={() => {}}
        {...(options.withoutComposerInputs
          ? {}
          : {
              // `/chat`'s PRODUCTION composer inputs: it wires an upload handler
              // and a Skill-autosave row from its own reads. The widget arm
              // resolves the same two through its broker branch, so the rows
              // compare like for like rather than one arm being handed
              // something the real page never passes.
              onAttachmentsSelected: options.onAttachmentsSelected ?? NOOP_ATTACHMENTS,
              autosave: CHAT_AUTOSAVE_PROP,
            })}
        {...(options.remoteChat ? { remoteChat: options.remoteChat } : {})}
      />
    </div>
  );
}

/** A handler reduced to its identity: the composer's gate reads that one EXISTS,
 *  and what it does with the files is `useChatAttachments`' own suite. */
const NOOP_ATTACHMENTS = () => {};

/**
 * The WIDGET arm — THE SAME column, with the embed's host adapters, the shared
 * turn engine and the SHARED BROKERED-INPUTS hook, exactly as
 * `embed-assistant-client.tsx` mounts them.
 *
 * IT RESOLVES ITS COMPOSER INPUTS THE WAY PRODUCTION DOES (cinatra#2683,
 * second half). Before the broker-aware data paths existed, this arm hardcoded
 * what the widget could pass — an empty participant list, no attachment handler
 * — because those were the honest production values. They are no longer: the
 * widget resolves each one through the shared services with its broker
 * transport, so the arm calls the SAME hook and the checks measure what a reader
 * really gets. `widgetServiceFetchStub` answers those calls the way the widget
 * routes do; an arm that answered them itself would be measuring the fixture.
 *
 * A test that wants to measure the COLUMN's own seam rather than the widget's
 * wiring still passes an input explicitly, to BOTH arms.
 */
const WIDGET_SERVICE_TRANSPORT: ConversationServiceTransport = {
  authHeaders: WIDGET_TRANSPORT.authHeaders,
  credentialsMode: "omit",
};

function WidgetSurface(options: SurfaceMountOptions) {
  const catalog = options.withCatalog ? parityWidgetCatalog() : null;
  const brokered = useBrokeredComposerInputs({
    threadId: FIXTURE_THREAD_ID,
    transport: WIDGET_SERVICE_TRANSPORT,
  });
  const turns = useConversationColumnTurns({
    threadId: FIXTURE_THREAD_ID,
    transport: WIDGET_TRANSPORT,
    ...(catalog ? { widgets: catalog.widgets, widgetManifests: catalog.manifests } : {}),
    initialMessages: options.messages ?? parityFixtureMessages(),
    takePendingAttachments: brokered.takePendingAttachments,
  });
  const host = useMemo(() => ({ lifecycleSurface: WIDGET_LIFECYCLE_SURFACE }), []);
  return (
    <div data-parity-surface="widget">
      <ConversationColumn
        {...turns}
        host={host}
        theme="github-light"
        sessionUser={options.sessionUser ?? PARITY_SESSION_USER}
        mentionables={options.mentionables ?? brokered.mentionables}
        chatViews={options.withCatalog ? PARITY_CHAT_VIEWS : {}}
        onActivateResource={() => {}}
        onActiveGateChange={() => {}}
        placeholder="Type a message..."
        promptStorageKey={`cinatra_embed_prompt_${FIXTURE_THREAD_ID}`}
        submitAriaLabel="Send message"
        composerNotice={brokered.composerNotice}
        {...(options.withoutComposerInputs
          ? {}
          : {
              onAttachmentsSelected:
                options.onAttachmentsSelected ?? brokered.onAttachmentsSelected,
              ...(brokered.autosave ? { autosave: brokered.autosave } : {}),
            })}
        {...(options.remoteChat ? { remoteChat: options.remoteChat } : {})}
      />
    </div>
  );
}


// ---------------------------------------------------------------------------
// The WIDGET's server, as a fetch stub (cinatra#2683, second half).
// ---------------------------------------------------------------------------
// The widget arm resolves its composer inputs through the SHARED services, so
// the harness has to answer them — and it answers them the way the widget
// branches of those routes do, with the widget principal's own data. Anything
// this stub gets wrong is a thing a reader would notice; anything it gets
// generous is a check that would pass for the wrong reason, so it also RECORDS
// every call and every credential, which the credential-rail check reads back.

export type WidgetServiceCall = { url: string; init: RequestInit };

export type WidgetServiceStubOptions = {
  /** The reader's directory (item 4). Empty ⇒ no @-mention flyout. */
  mentionables?: Array<{ id: string; handle: string }>;
  /** The Skill-autosave answer (item 3). Null ⇒ the row is not drawn. */
  autosave?: { enabled: boolean; userCanConfigure: boolean; userCanSeeIndicator: boolean } | null;
  /** The restored transcript (item 1). Null ⇒ nothing to restore. */
  threadMessages?: UiMessage[] | null;
  /** The parked destructive calls (item 5). */
  pendingRows?: unknown[];
  /** The undo candidate (item 6). Null ⇒ no chip. */
  undoChangeSetId?: string | null;
  /** Make one route refuse, so a check can prove the refusal is honoured. */
  unauthorized?: string[];
  /**
   * The LIFECYCLE resolve answer, per requested kind (cinatra#2826, S9m).
   *
   * The transcript's cards resolve their authority through the same fetch the
   * rest of the surface uses, so the widget's server has to answer that route
   * too — otherwise a card would draw nothing for want of a stub and a suite
   * could read that silence as a surface that carries no cards. Returning
   * `null` means "this reader gets nothing", which is a 200 `absent` envelope,
   * not a transport failure.
   */
  lifecycle?: (viewType: string) => unknown | null;
};

/**
 * Install a fetch that answers the widget's conversation routes. Returns the
 * recorded calls and a restore function; the caller restores in a cleanup.
 */
export function installWidgetServiceStub(options: WidgetServiceStubOptions = {}) {
  const calls: WidgetServiceCall[] = [];
  const original = globalThis.fetch;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    if ((options.unauthorized ?? []).some((p) => url.startsWith(p))) {
      return json({ error: "Unauthorized" }, 401);
    }
    if (url === LIFECYCLE_VIEW_RESOLVE_PATH) {
      if (!options.lifecycle) return json({ error: "no lifecycle stub" }, 404);
      const requested = (() => {
        try {
          return String(JSON.parse(String(init?.body ?? "{}")).viewType ?? "");
        } catch {
          return "";
        }
      })();
      const answer = options.lifecycle(requested);
      return answer === null ? json({ error: "Not available to you." }, 404) : json(answer);
    }
    if (url.startsWith("/api/assistants/list")) {
      return json({ assistants: options.mentionables ?? [] });
    }
    if (url.startsWith("/api/assistants/autosave")) {
      return options.autosave ? json(options.autosave) : json({ error: "no" }, 403);
    }
    // The COLLECTION (the write), before the by-id prefix below.
    if (url === "/api/assistants/threads") {
      return json({ ok: true });
    }
    if (url.startsWith("/api/assistants/threads/")) {
      return options.threadMessages
        ? json({ messages: options.threadMessages })
        : json({ error: "Not found" }, 404);
    }
    if (url.startsWith("/api/chat/pending-tool-calls")) {
      return json({ rows: options.pendingRows ?? [] });
    }
    if (url.startsWith("/api/chat/undo-candidate")) {
      return json({ changeSetId: options.undoChangeSetId ?? null });
    }
    if (url.startsWith("/api/artifacts/upload")) {
      return json({ ok: true, ref: { artifactId: "art-1", mime: "text/plain" } }, 201);
    }
    return json({}, 404);
  }) as unknown as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

/** The directory the widget arm resolves when the stub is asked for one. */
export const WIDGET_DIRECTORY = [
  { id: "assistant-1", handle: "cinatra" },
  { id: "assistant-2", handle: "claude" },
];

/** A Skill-autosave answer that makes the row visible and toggleable. */
export const WIDGET_AUTOSAVE_VISIBLE = {
  enabled: false,
  userCanConfigure: true,
  userCanSeeIndicator: true,
};

/** The remote-chat row both surfaces receive server-resolved. */
export const PARITY_REMOTE_CHAT = {
  label: "Remote chat",
  href: "https://blog.example.com/wp-admin/",
};

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
/**
 * A mount whose host declaration the runtime REFUSES — `site_widget` with no
 * credential. It is neither surface: it is the mis-wired case, and the column's
 * asking affordances must issue no request at all under it.
 */
export function refusedSurfaceElement(options: SurfaceMountOptions = {}): ReactElement {
  return (
    <div data-parity-surface="undeclared">
      <RefusedSurface {...options} />
    </div>
  );
}

function RefusedSurface(options: SurfaceMountOptions) {
  const turns = useConversationColumnTurns({
    threadId: FIXTURE_THREAD_ID,
    transport: WIDGET_TRANSPORT,
    initialMessages: options.messages ?? parityFixtureMessages(),
  });
  const host = useMemo(
    () => ({ lifecycleSurface: { host: "site_widget" as const } }),
    [],
  );
  return (
    <ConversationColumn
      {...turns}
      host={host}
      theme="github-light"
      sessionUser={PARITY_SESSION_USER}
      mentionables={[]}
      chatViews={{}}
      onActivateResource={() => {}}
      onActiveGateChange={() => {}}
      placeholder="Type a message..."
      promptStorageKey={`cinatra_refused_prompt_${FIXTURE_THREAD_ID}`}
      submitAriaLabel="Send message"
    />
  );
}

export async function mountRefusedSurface(
  options: SurfaceMountOptions = {},
): Promise<RenderResult> {
  const result = render(refusedSurfaceElement(options));
  await waitFor(() =>
    expect(result.container.querySelector("[data-conversation-list]")).not.toBeNull(),
  );
  return result;
}

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

// ---------------------------------------------------------------------------
// LIFECYCLE carriage on the shared column (cinatra#2826, epic #2784 S9m)
// ---------------------------------------------------------------------------
// The transcripts a lifecycle kind really arrives in, and the resolve answers a
// server really returns for it. Both live here because BOTH arms use them: a
// parity claim measured from two different fixtures measures the fixtures.

/**
 * A persisted turn carrying one lifecycle DATA_PART — the shape the whole-message
 * save replays after a reload. The payload is the reserved envelope and nothing
 * else: a ref, never content.
 */
export function lifecycleDataPartTranscript(viewType: string, ref: string): UiMessage[] {
  return [
    { id: "u1", role: "user", content: "What is waiting on me?" },
    {
      id: "a1",
      role: "assistant",
      content: "Here is what is waiting on you.",
      dataParts: [{ viewType, schemaVersion: LIFECYCLE_VIEW_SCHEMA_VERSION, ref }],
    } as UiMessage,
  ];
}

/** The run id the held transcript below parks on. */
export const HELD_RUN_ID = "run-held-2826";

/**
 * A persisted HELD dispatch turn — the carriage of the one INTERRUPT kind. The
 * durable `agent_run` part is what the server pinned, so this is what a reload
 * replays.
 */
export function lifecycleHeldTranscript(): UiMessage[] {
  return [
    { id: "u1", role: "user", content: "Run the proof agent" },
    {
      id: "a1",
      role: "assistant",
      content: "",
      parts: [
        {
          kind: "text",
          content:
            "Dispatched `@cinatra-ai/proof-agent` (runId: `" + HELD_RUN_ID + "`, status: `pending_input`).",
        },
        {
          kind: "tool_call",
          id: "t1",
          name: "agent_run",
          runId: HELD_RUN_ID,
          status: "completed",
          resultLabel: `runId: ${HELD_RUN_ID}, status: pending_input`,
        },
      ],
    } as UiMessage,
  ];
}

/** A §VII reading — the verification kind fails closed without one. */
const VERIFICATION_BODY = {
  version: VERIFICATION_SUMMARY_VIEW_VERSION,
  outcome: "verified",
  reviewedRevisionId: "rev-base",
  repairedRevisionId: "rev-fixed",
  // The authorization travels as each ROW's own mark, decided server-side
  // against the whole manifest (cinatra#2861) — never as a `scopePaths` list.
  // The body schema is `.strict()`, so a stub still sending the retired list,
  // or omitting `inScope`, is rejected and the card fails closed.
  fieldDiff: [{ field: "content.title", before: "old", after: "new", inScope: true }],
  advisoryComments: [],
};

/** A live proposal — the schedule kind's own body. */
const SCHEDULE_BODY = {
  phase: "proposal",
  version: TRIGGER_SCHEDULE_PROPOSAL_VIEW_VERSION,
  agentName: "Weekly digest",
  schedule: { kind: "scheduled", runAt: "2026-09-01T09:00", timezone: "Europe/Berlin" },
  durationCopy: "About 45s – 3.4 hr.",
  canConfirm: true,
  restrictedReason: null,
};

/** The per-kind body a drawn state must carry. `null` for the review kind — its
 *  target arrives through its own island, never through the envelope. */
function lifecycleBodyFor(viewType: string): unknown {
  if (viewType === "verification_summary") return VERIFICATION_BODY;
  if (viewType === "trigger_schedule_proposal") return SCHEDULE_BODY;
  return null;
}

/**
 * The resolve envelopes a stub returns, in the per-kind shape the card parses.
 * The kind is ECHOED from the request, so a mount that asked about one kind can
 * never be answered about another.
 */
export const LIFECYCLE_RESOLVE_ANSWERS = {
  pending(viewType: string): unknown {
    const state: LifecycleCardState =
      viewType === "verification_summary"
        ? { state: "advisory" }
        : { state: "pending", canDecide: true, canComment: true };
    return { kind: viewType, state, body: lifecycleBodyFor(viewType) };
  },
  absent(viewType: string): unknown {
    return { kind: viewType, state: { state: "absent" }, body: null };
  },
};

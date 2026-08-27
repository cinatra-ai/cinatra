// @vitest-environment jsdom
//
// ---------------------------------------------------------------------------
// `/chat` IS UNCHANGED BY THE EXTRACTION (cinatra#2683, epic #2564 S8f).
// ---------------------------------------------------------------------------
// S8f moves `/chat`'s conversation column into a component the widget also
// mounts. The whole slice rests on that move being a MOVE: if `/chat` shifts by
// a pixel, the extraction bought parity with a regression, which is not a trade
// anybody agreed to.
//
// So this file pins the column's DOM SKELETON — the elements between the frame
// and the message content, with the exact class strings that position and size
// them. Those class strings are the layout: `min-h-0 flex-1 overflow-y-auto` is
// the scroll container, `absolute bottom-0 left-4 right-4` is the docked
// composer, `mx-auto w-full max-w-3xl px-4` is the width the composer shares
// with the message content. A refactor that "tidied" any of them would move the
// page, and this goes red.
//
// The golden was taken from `chat-page.tsx` at the commit BEFORE the extraction
// and is reproduced verbatim below, so the comparison is against what `/chat`
// rendered, not against what the extraction happens to render now.
//
// It also pins that `/chat` still passes the column the same values it used to
// pass the inline JSX — a source check, because the values come from page state
// this test does not run.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// The mounted list reaches two cookie-bound server actions and the AG-UI run
// panel. Replaced here for the same reasons set out in
// `conversation-column-inventory.test.tsx`; none of them is part of the SHAPE
// this file measures.
// The recommendation card's own graph. The shared column now mounts that card
// at the `agent_run` slot on BOTH of its arms — the cookie `/chat` transcript
// (cinatra#2794, S9b) and the site widget (cinatra#2790, S9f) — and the card
// statically imports its cookie-bound server actions, which reach a database.
// Replaced here for the same reason the pending-call and undo actions above
// are: none of them is part of what this file measures, and without these the
// column does not mount at all — an empty column would look like a passing
// negative arm. Any test that mounts the conversation column needs both.
vi.mock("../../../agents/src/run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: async () => ({ state: "none" }),
  confirmRunRecommendationAction: async () => ({ ok: true, dispatched: true }),
  skipRunRecommendationAction: async () => ({ ok: true, dispatched: true }),
}));
const hitlScreenStateMock = vi.fn(async () => ({ state: "none" }) as Record<string, unknown>);
// The HITL screen card's own server-only entry, stubbed for the same reason
// (cinatra#2930, lifecycle-b W3): the column mounts that card beside the §V one
// now, and an unstubbed `"use server"` module fails the whole lazy chat chunk.
// The default answer is "no screen", so a suite that is not about this kind sees
// exactly what it saw before the card existed.
vi.mock("../../../agents/src/agent-hitl-screen-actions", () => ({
  getAgentHitlScreenStateAction: () => hitlScreenStateMock(),
}));
vi.mock("../../../agents/src/hitl-actions", () => ({
  approveReviewTask: vi.fn(async () => undefined),
  rejectReviewTask: vi.fn(async () => undefined),
}));
vi.mock("../../../agents/src/server-actions", () => ({
  getRunRecommendedSkillsAction: async () => [],
  getSkillsForAgentAction: async () => [],
  getFieldRendererContextForAgentBuilderAction: async () => ({}),
  confirmRunSkillSelectionAction: async () => ({ ok: true }),
}));
vi.mock("../pending-call-actions", () => ({
  listPendingToolConfirmations: async () => ({ rows: [] }),
  decidePendingToolCall: async () => ({ ok: true }),
}));
vi.mock("../undo-actions", () => ({
  recentUndoableChangeSetForRunAction: async () => null,
}));
vi.mock("@/components/data-safety/undo-toast", () => ({
  undoDeepLink: (id: string) => `/objects?undo=${id}`,
}));
vi.mock("../inline-agent-run-card", () => ({ InlineAgentRunCard: () => null }));

import { mountSurface } from "./conversation-column-harness";

afterEach(cleanup);

const PKG_ROOT = path.resolve(__dirname, "..", "..");
const CHAT_PAGE = readFileSync(path.join(PKG_ROOT, "src", "chat-page.tsx"), "utf8");

/**
 * The column's skeleton as `chat-page.tsx` rendered it before S8f — copied out
 * of that file's pre-extraction conversation return, outermost first.
 */
const CHAT_COLUMN_SKELETON = [
  { depth: 0, className: "relative flex min-h-0 flex-1 flex-col" },
  {
    depth: 1,
    className:
      "min-h-0 flex-1 overflow-y-auto pb-24 pt-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
  },
  { depth: 1, className: "relative mx-auto w-full max-w-3xl px-4" },
  { depth: 2, className: "absolute bottom-0 left-4 right-4 bg-background pb-3 pt-0" },
];

describe("/chat's conversation column is byte-identical after the extraction (#2683)", () => {
  it("renders the pre-extraction skeleton, class string for class string", async () => {
    const { container } = await mountSurface("chat");
    const column = container.querySelector<HTMLElement>("[data-parity-surface='chat'] > div");
    expect(column, "the column's outermost element").not.toBeNull();

    const at = (depth: number, index: number): HTMLElement | null => {
      if (depth === 0) return column;
      // Walk `index` children down from the column, one level per depth step.
      let node: HTMLElement | null = column;
      for (let d = 0; d < depth && node; d += 1) {
        node = (node.children[index] as HTMLElement | undefined) ?? null;
      }
      return node;
    };

    expect(at(0, 0)?.className).toBe(CHAT_COLUMN_SKELETON[0].className);
    // The scroll container and the composer anchor are the column's two children.
    expect((column!.children[0] as HTMLElement).className).toBe(
      CHAT_COLUMN_SKELETON[1].className,
    );
    expect((column!.children[1] as HTMLElement).className).toBe(
      CHAT_COLUMN_SKELETON[2].className,
    );
    // The docked composer sits inside the zero-height anchor.
    expect(
      (column!.children[1].children[0] as HTMLElement).className,
    ).toBe(CHAT_COLUMN_SKELETON[3].className);
  });

  it("keeps the message list inside the scroll container and the composer outside it", async () => {
    const { container } = await mountSurface("chat");
    const column = container.querySelector<HTMLElement>("[data-parity-surface='chat'] > div")!;
    const scroller = column.children[0] as HTMLElement;
    const composerAnchor = column.children[1] as HTMLElement;

    // Message content scrolls...
    expect(scroller.querySelector("[data-embed-content]")).not.toBeNull();
    // ...and the composer does not.
    expect(scroller.querySelector('[data-testid="chat-prompt-input"]')).toBeNull();
    expect(composerAnchor.querySelector('[data-testid="chat-prompt-input"]')).not.toBeNull();
  });

  it("mounts exactly one composer — the extraction did not leave a second one behind", async () => {
    const { container } = await mountSurface("chat");
    expect(container.querySelectorAll('[data-testid="chat-prompt-input"]')).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // The values `/chat` hands the column are the values it used to hand the JSX.
  // -------------------------------------------------------------------------
  it("passes the same composer values the inline JSX passed", async () => {
    const mount = CHAT_PAGE.slice(CHAT_PAGE.indexOf("<ConversationColumn"));
    // The placeholder, aria-label and canSubmitEmpty all key off hasActiveEmbed
    // exactly as before (an active widget turns the composer into a form save).
    expect(mount).toContain(
      'placeholder={hasActiveEmbed ? "Press Enter to save, or type a message..." : "Type a message..."}',
    );
    expect(mount).toContain('submitAriaLabel={hasActiveEmbed ? "Save form" : "Send message"}');
    expect(mount).toContain("canSubmitEmpty={hasActiveEmbed}");
    // The per-thread draft key, the attachment picker, the autosave row and the
    // remote-chat jump-out all still reach the composer.
    expect(mount).toContain("promptStorageKey={`cinatra_thread_prompt_${activeThreadId}`}");
    expect(mount).toContain("onAttachmentsSelected={handleAttachmentsSelected}");
    expect(mount).toContain("autosave={autosaveProp}");
    expect(mount).toContain("remoteChat={remoteChat}");
    // The attachment-refusal notice still renders directly above the composer.
    expect(mount).toContain("composerNotice={refusalNotice}");
    // Slack mode, the external-assistant wait and the typing bubbles still reach
    // the list — the props whose loss would be invisible until a second
    // participant joined a thread.
    expect(mount).toContain("isSlackMode={isSlackMode}");
    expect(mount).toContain("pendingExternalHandle={pendingExternalHandle}");
    expect(mount).toContain("typingIndicators={typingIndicators}");
    expect(mount).toContain("assistantHandleMap={assistantHandleMap}");
    // `/chat` states its host EXPLICITLY (there is no default to inherit — a
    // default would hand `chat_thread`, a COOKIE host, to any mount that forgot
    // its adapter). It is the first-party cookie surface, so the list keeps
    // `chat_thread` and the link policy stays same-tab.
    //
    // Since cinatra#2566 the adapter is COMPOSED — the exported constant plus
    // this page's per-mount composer-focus store, which cannot live in a module
    // constant. The invariant is unchanged and asserted in two halves: the mount
    // names the composed adapter, and the adapter is built by SPREADING the
    // exported constant rather than by writing a host literal a second time.
    expect(mount).toContain("host={chatHostAdapter}");
    expect(CHAT_PAGE).toContain("...CHAT_THREAD_HOST");
    expect(CHAT_PAGE).not.toMatch(/lifecycleSurface:\s*\{\s*host:/);
  });

  it("keeps the lazy boundary — now inside the column, so BOTH hosts get it", () => {
    const column = readFileSync(
      path.join(PKG_ROOT, "src", "conversation-column.tsx"),
      "utf8",
    );
    // The bundle boundary for marked/katex, mermaid, shiki and the extension
    // view dispatch. It moved out of `/chat` into the column, which is what lets
    // the widget have the same split — and, more importantly, removes the
    // component prop a host could have used to hand in a DIFFERENT list.
    expect(column).toMatch(
      /const ChatMessagesView = dynamic\(\s*\(\) => import\("\.\/chat-messages-view"\)/,
    );
    expect(column).toContain('{ ssr: false, loading: () => null }');
    expect(CHAT_PAGE).not.toContain("messagesView=");
    expect(CHAT_PAGE).not.toContain('import("./chat-messages-view")');
  });

  it("keeps the auto-scroll lock's two releases, now inside the column", async () => {
    const column = readFileSync(
      path.join(PKG_ROOT, "src", "conversation-column.tsx"),
      "utf8",
    );
    // (#1702) released on thread switch...
    expect(column).toMatch(
      /useEffect\(\(\) => \{\s*userScrolledUpRef\.current = false;\s*\}, \[activeThreadId\]\);/,
    );
    // ...and on stream completion.
    expect(column).toMatch(
      /if \(prevHasActiveStreamRef\.current && !hasActiveStream\) userScrolledUpRef\.current = false;/,
    );
    // React runs effects in definition order: the lock must already be clear
    // when scrollToBottom fires for the new thread's messages.
    const resetIdx = column.search(/userScrolledUpRef\.current = false;\s*\}, \[activeThreadId\]\);/);
    const scrollIdx = column.search(
      /scrollToBottom\(\);\s*\}, \[messages, streamingCount, pendingExternalHandle, typingIndicators, scrollToBottom\]\);/,
    );
    expect(resetIdx).toBeGreaterThan(-1);
    expect(scrollIdx).toBeGreaterThan(-1);
    expect(resetIdx).toBeLessThan(scrollIdx);
  });
});

// ---------------------------------------------------------------------------
// §I INPUT HIERARCHY — the composer is the ONE primary input (#2865).
// ---------------------------------------------------------------------------
// Design: `specs/app-lifecycle-cards.html` §I at
// 60b27dfbb8a2a1594e6e88333cc5c048c244e640 — `.composer.primary { border-color:
// var(--line-strong); }`, and the rule beneath it: exactly one primary input is
// drawn per conversation, and it is the chat box.
//
// The widget arm is not a second wiring to keep in step — it is the SAME column
// mounted under the broker host adapter, so the promotion reaches the embedded
// conversation by construction. That is exactly what makes it worth asserting:
// this case is what would go red if a later change moved the opt-in somewhere
// only `/chat` passes through.
// ---------------------------------------------------------------------------

const COMPOSER = '[data-conformance-id="chat-composer-primary"]';

describe("§I — the chat box is the one primary input, on every host (#2865)", () => {
  it.each(["chat", "widget"] as const)(
    "%s: the composer takes the line-strong edge and names itself",
    async (surface) => {
      const { container } = await mountSurface(surface);
      const composer = container.querySelector<HTMLElement>(COMPOSER);
      expect(composer, `the ${surface} composer's §I field container`).not.toBeNull();

      const classes = composer!.className.split(/\s+/).filter(Boolean);
      expect(classes, "the primary edge").toContain("border-line-strong");
      expect(classes, "the ordinary edge must be gone").not.toContain("border-line");

      // §I: the primary input KEEPS the three things a subordinate field gives
      // up — its own box, the raised ground and the send affordance.
      expect(classes).toContain("rounded-control");
      expect(classes).toContain("border");
      expect(classes).toContain("bg-surface-strong");
      expect(
        composer!.querySelector('[data-testid="chat-prompt-input"]'),
        "the editor",
      ).not.toBeNull();
      expect(composer!.querySelector("button[aria-label]"), "the send control").not.toBeNull();
    },
  );

  it("mounts exactly one primary input per conversation", async () => {
    for (const surface of ["chat", "widget"] as const) {
      const { container } = await mountSurface(surface);
      expect(container.querySelectorAll(COMPOSER)).toHaveLength(1);
    }
  });
});

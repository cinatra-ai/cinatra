// @vitest-environment jsdom
//
// ---------------------------------------------------------------------------
// The 2026-08-12 INVENTORY, run against both surfaces (cinatra#2683, S8f).
// ---------------------------------------------------------------------------
// The owner measured the widget's conversation area against `/chat` element by
// element on a real WordPress site and found fourteen things missing. This file
// is that table, as a test, executed against BOTH host configurations of the one
// column from the SAME thread fixture.
//
// Every check should now pass BY CONSTRUCTION — one component, two host
// adapters. That is not a reason to skip them: the host adapter is exactly the
// place where a surface could still lose an affordance quietly (a suppressed
// prop, a fail-closed guard widened by accident), and each numbered check names
// the thing a reader would notice going missing.
//
// TWO ITEMS DO NOT PASS ON THE WIDGET, AND ARE NOT PRETENDED TO. The pending
// tool-confirmation cards (11) and the undo chip (12) read and decide through
// COOKIE-BOUND server actions. The embed frame is same-origin to the Cinatra
// app, so firing them from the widget would answer — and record a decision — as
// whoever else is signed in on that browser. They are fail-closed on a broker
// credential and asserted ABSENT here, with the reason, and carried as open
// questions on the PR. A silent reduction would have been the alternative, and
// the issue forbids it.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";

// ---------------------------------------------------------------------------
// The mounted list reaches four modules that belong to the SERVER or to the
// agent-run substrate. Each is replaced here, and each replacement is chosen so
// the check it enables is stronger, not weaker:
//
//   · the two COOKIE-BOUND server actions answer with real-shaped data, so the
//     cookie surface genuinely draws its confirmation card and undo chip — and
//     the broker surface's silence is a demonstrated fail-closed, not an empty
//     fixture that would look identical either way;
//   · `undoDeepLink` is the app-route builder the chip renders into;
//   · the inline agent-run card is the AG-UI run panel, whose graph reaches the
//     server runtime. It is the substrate the issue calls already-shared and
//     out of scope here; the undo chip beside it still renders, which is the
//     part this file measures.
// ---------------------------------------------------------------------------
vi.mock("../pending-call-actions", () => ({
  listPendingToolConfirmations: async () => ({
    rows: [
      {
        id: "pending-1",
        connectorKey: "files",
        toolName: "delete_everything",
        serverId: "files-mcp",
        instanceId: "inst-1",
        instanceLabel: "Files",
        argsPreview: '{"path":"/"}',
        status: "pending",
        failureCode: null,
        resultSummary: null,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        confirmToken: "confirm-tok",
        rejectToken: "reject-tok",
      },
    ],
  }),
  decidePendingToolCall: async () => ({ ok: true }),
}));
vi.mock("../undo-actions", () => ({
  recentUndoableChangeSetForRunAction: async () => ({ changeSetId: "cs-2683" }),
}));
vi.mock("@/components/data-safety/undo-toast", () => ({
  undoDeepLink: (id: string) => `/objects?undo=${id}`,
}));
vi.mock("../inline-agent-run-card", () => ({
  InlineAgentRunCard: () => null,
}));

import {
  SURFACES,
  measureConversationColumn,
  mountRunningSurface,
  mountSurface,
  PARITY_MENTIONABLES,
  parityAgentRunMessages,
  parityErrorMessages,
  parityFixtureMessages,
  type SurfaceName,
} from "./conversation-column-harness";

afterEach(cleanup);

const root = (surface: SurfaceName, container: HTMLElement): HTMLElement =>
  container.querySelector<HTMLElement>(`[data-parity-surface="${surface}"]`)!;

/**
 * Type into the contenteditable composer WITH a caret.
 *
 * The composer decides whether to open the @-mention flyout by reading the text
 * BEFORE the caret, so a test that only assigns `textContent` types into a field
 * whose caret is nowhere — and the flyout correctly stays shut. Placing a
 * collapsed range at the end is what a real keystroke leaves behind.
 */
function typeIntoEditor(editor: HTMLElement, text: string): void {
  editor.textContent = text;
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  fireEvent.input(editor);
}

describe.each(SURFACES)("conversation column on %s (#2683)", (surface) => {
  it("1 — renders the whole thread, not just the latest answer", async () => {
    const { container } = await mountSurface(surface, { messages: parityFixtureMessages() });
    const m = measureConversationColumn(root(surface, container));
    // Two assistant answers in the fixture, each with its own content block.
    expect(m.contentBlocks).toBeGreaterThanOrEqual(2);
    expect(root(surface, container).textContent).toContain("First answer.");
    expect(root(surface, container).textContent).toContain("Here is the rich answer.");
  });

  it("2 — echoes the user's own messages as bubbles", async () => {
    const { container } = await mountSurface(surface);
    const m = measureConversationColumn(root(surface, container));
    expect(m.userBubbles).toBe(2);
    const text = root(surface, container).textContent ?? "";
    // The user's own words come back. (`@cinatra` renders as a mention CHIP —
    // itself a parity affordance — so the raw handle is not in the text node.)
    expect(text).toContain("First question about");
    expect(text).toContain("Second question");
  });

  it("3 — draws a sender identity row", async () => {
    const { container } = await mountSurface(surface);
    expect(measureConversationColumn(root(surface, container)).avatars).toBeGreaterThan(0);
  });

  it("4 — offers Copy and Edit on a user message", async () => {
    const { container } = await mountSurface(surface);
    const m = measureConversationColumn(root(surface, container));
    expect(m.userCopyButtons).toBeGreaterThan(0);
    expect(m.userEditButtons).toBeGreaterThan(0);
  });

  it("5 — offers the response action row under an answer", async () => {
    const { container } = await mountSurface(surface);
    const m = measureConversationColumn(root(surface, container));
    expect(m.responseCopyButtons).toBeGreaterThan(0);
    expect(m.responseRetryButtons).toBeGreaterThan(0);
  });

  it("6 — the composer's send control becomes Stop while a turn runs", async () => {
    const running = await mountRunningSurface(surface);
    const m = measureConversationColumn(root(surface, running.container));
    expect(m.hasStopControl).toBe(true);
    running.stream?.close();
  });

  it("7 — the composer is the multi-line editor, not a single-line input", async () => {
    const { container } = await mountSurface(surface);
    const m = measureConversationColumn(root(surface, container));
    expect(m.composerIsMultiline).toBe(true);
    // The widget's bespoke `<input aria-label="Message">` is gone; the only
    // `input` the column may contain is the attachment picker (type=file).
    expect(m.legacySingleLineInputs).toBe(0);
  });

  it("8 — the composer takes attachments when the host supplies a handler", async () => {
    const withHandler = await mountSurface(surface, { onAttachmentsSelected: () => {} });
    expect(
      measureConversationColumn(root(surface, withHandler.container)).hasAttachmentInput,
    ).toBe(true);
    cleanup();
    // Prop-gated on BOTH surfaces in the same way: no handler, no upload row.
    const without = await mountSurface(surface);
    expect(measureConversationColumn(root(surface, without.container)).hasAttachmentInput).toBe(
      false,
    );
  });

  it("9 — the prompt-options flyout appears when the host supplies something to put in it", async () => {
    // Measures the COLUMN's seam, not the widget's wiring: the flyout is the
    // container for the attachment row, so both arms are handed a handler here.
    // What the REAL embed passes — and why it passes nothing yet — is asserted
    // in the open-questions block at the bottom of this file.
    const { container } = await mountSurface(surface, { onAttachmentsSelected: () => {} });
    expect(
      measureConversationColumn(root(surface, container)).hasPromptOptionsTrigger,
    ).toBe(true);
  });

  it("10 — @-mentions open the composer's flyout when the host supplies participants", async () => {
    // Same reading as item 9: the participant list is a host input, handed to
    // BOTH arms here so the check measures the shared composer. The widget's own
    // (empty) list is asserted in the open-questions block.
    const { container } = await mountSurface(surface, { mentionables: PARITY_MENTIONABLES });
    const editor = root(surface, container).querySelector<HTMLElement>(
      '[data-testid="chat-prompt-input"]',
    )!;
    typeIntoEditor(editor, "@");
    // The flyout is a Radix popover, so it PORTALS out of the column — query the
    // document, not the container. (That it leaves the column is the popover's
    // business; what this checks is that typing `@` opens it on this surface.)
    await waitFor(() => {
      expect(document.body.querySelector('[role="listbox"]')).not.toBeNull();
    });
  });

  it("13 — a failed turn shows the friendly error body with Copy error details", async () => {
    const { container } = await mountSurface(surface, { messages: parityErrorMessages() });
    const m = measureConversationColumn(root(surface, container));
    expect(m.errorCards).toBe(1);
    expect(m.hasCopyErrorDetails).toBe(true);
    expect(root(surface, container).textContent).toContain("Something went wrong");
  });

  it("14 — the rich-rendering stack renders code, mermaid, charts and extension widgets", async () => {
    const { container } = await mountSurface(surface, { withCatalog: true });
    await waitFor(() => {
      const m = measureConversationColumn(root(surface, container));
      expect(m.codeBlocks).toBeGreaterThan(0);
      expect(m.codeCopyButtons).toBeGreaterThan(0);
      expect(m.mermaidBlocks).toBeGreaterThan(0);
      expect(m.chartViews).toBeGreaterThan(0);
      expect(m.extensionWidgets).toBeGreaterThan(0);
    });
  });

  it("cosmetic — the send control is the circular icon button, not a text button", async () => {
    const { container } = await mountSurface(surface);
    expect(
      measureConversationColumn(root(surface, container)).sendControlIsIconButton,
    ).toBe(true);
  });

  it("no frame element leaks into the column", async () => {
    const { container } = await mountSurface(surface, { withCatalog: true });
    expect(measureConversationColumn(root(surface, container)).frameLeaks).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The rows the two surfaces must agree on, compared directly.
// ---------------------------------------------------------------------------

describe("the inventory row is the SAME on both surfaces (#2683)", () => {
  /**
   * The two fields the surfaces are KNOWN to differ on, excluded from the
   * whole-row compare and asserted separately below with their reason. Naming
   * them here — rather than loosening the compare — is what keeps a third
   * difference from slipping in unnoticed.
   */
  const KNOWN_DIFFERENCES = ["pendingConfirmationCards", "undoChips"] as const;
  const comparable = (row: Record<string, unknown>) => {
    const copy = { ...row };
    for (const k of KNOWN_DIFFERENCES) delete copy[k];
    return copy;
  };

  it("agrees element for element on a populated thread", async () => {
    const hostInputs = {
      withCatalog: true,
      onAttachmentsSelected: () => {},
      mentionables: PARITY_MENTIONABLES,
    };
    const chat = await mountSurface("chat", hostInputs);
    await waitFor(() =>
      expect(root("chat", chat.container).querySelector("[data-mermaid-block]")).not.toBeNull(),
    );
    const chatRow = measureConversationColumn(root("chat", chat.container));
    cleanup();
    const widget = await mountSurface("widget", hostInputs);
    await waitFor(() =>
      expect(root("widget", widget.container).querySelector("[data-mermaid-block]")).not.toBeNull(),
    );
    const widgetRow = measureConversationColumn(root("widget", widget.container));
    expect(comparable(widgetRow)).toEqual(comparable(chatRow));
  });

  it("agrees on a failed turn", async () => {
    const chat = await mountSurface("chat", { messages: parityErrorMessages() });
    const chatRow = measureConversationColumn(root("chat", chat.container));
    cleanup();
    const widget = await mountSurface("widget", { messages: parityErrorMessages() });
    const widgetRow = measureConversationColumn(root("widget", widget.container));
    expect(comparable(widgetRow)).toEqual(comparable(chatRow));
  });
});

// ---------------------------------------------------------------------------
// Items 11 and 12 — the cookie-bound affordances, stated honestly.
// ---------------------------------------------------------------------------

describe("cookie-bound affordances fail CLOSED on the broker surface (#2683)", () => {
  it("11 — /chat draws the pending tool-confirmation card; the widget draws none", async () => {
    const chat = await mountSurface("chat");
    await waitFor(() =>
      expect(
        measureConversationColumn(root("chat", chat.container)).pendingConfirmationCards,
      ).toBe(1),
    );
    cleanup();
    const widget = await mountSurface("widget");
    // Not "renders empty": the component returns null and issues NO request,
    // because the request would be answered from an ambient Cinatra cookie that
    // belongs to whoever else uses this browser.
    await new Promise((r) => setTimeout(r, 20));
    expect(
      measureConversationColumn(root("widget", widget.container)).pendingConfirmationCards,
    ).toBe(0);
  });

  it("12 — /chat draws the undo chip under a run; the widget draws none", async () => {
    const messages = parityAgentRunMessages();
    const chat = await mountSurface("chat", { messages });
    await waitFor(() =>
      expect(measureConversationColumn(root("chat", chat.container)).undoChips).toBe(1),
    );
    cleanup();
    const widget = await mountSurface("widget", { messages });
    await new Promise((r) => setTimeout(r, 20));
    expect(measureConversationColumn(root("widget", widget.container)).undoChips).toBe(0);
  });

  it("the guard is keyed on the CREDENTIAL, so every cookie host keeps them", async () => {
    // `/chat` mounts the same components from the same list and is untouched:
    // the guard reads the declared broker credential, not a surface name, so a
    // future cookie-session host needs no edit and cannot be caught by it.
    const guarded = [
      "pending-tool-confirmation-card.tsx",
      "chat-undo-action-chip.tsx",
    ];
    for (const file of guarded) {
      const src = require("node:fs").readFileSync(
        require("node:path").join(__dirname, "..", file),
        "utf8",
      ) as string;
      expect(src).toContain("useBrokeredSurface()");
      expect(src).not.toMatch(/host === "site_widget"/);
    }
  });
});

// ---------------------------------------------------------------------------
// THE RECORDED OPEN QUESTIONS — what the widget still cannot do, and why.
// ---------------------------------------------------------------------------
// Four inventory items depend on a request the BROKER transport cannot make
// today. Each one is recorded here, with the reason, and carried on the S8f PR.
// They are pinned as tests for one reason: an open question that lives only in a
// PR body is forgotten, and the next reader cannot tell a known gap from a bug.
// When the missing broker-aware path lands, these checks go red and say so.

import { readFileSync } from "node:fs";
import path from "node:path";

const PKG_ROOT = path.resolve(__dirname, "..", "..");
const REPO_ROOT = path.resolve(PKG_ROOT, "..", "..");
const EMBED_SRC = readFileSync(
  path.join(REPO_ROOT, "src", "app", "embed", "assistant", "embed-assistant-client.tsx"),
  "utf8",
);
const TURN_CLIENT = readFileSync(path.join(PKG_ROOT, "src", "ag-ui-chat-client.ts"), "utf8");

describe("open questions carried on the S8f PR (#2683)", () => {
  it("1 (partial) — the widget's transcript is per session: a reload starts empty", () => {
    // WHAT WORKS: within a session the widget renders the WHOLE thread — the
    // user's echo and every prior turn — because it renders the shared list over
    // a real message array. That is the gap the inventory measured.
    // WHAT DOES NOT: restoring a thread across a frame reload needs a read of
    // `/api/assistants/threads/:id`, which is COOKIE-bound. The embed must not
    // send a cookie (same-origin frame, somebody else's session), so it has no
    // way to ask. The seam is ready — the shared engine seeds from
    // `initialMessages` — and only the broker-aware read is missing.
    expect(readFileSync(path.join(PKG_ROOT, "src", "conversation-column.tsx"), "utf8")).toContain(
      "initialMessages",
    );
    // The embed restores nothing today, and does NOT reach for the cookie route
    // to do it. (The one `credentials: "include"` fetch it still has is the
    // TEST-ONLY parity seed, inert in production behind a server env gate.)
    const liveRestores = EMBED_SRC.split("loadParitySeed")[0];
    expect(liveRestores).not.toContain("/api/assistants/threads/");
  });

  it("8 — the widget composer offers no attachments: the upload route is cookie-bound", () => {
    // The COLUMN's attachment seam works on either host — the checks above mount
    // both surfaces with a handler and both draw the picker. What is missing is
    // a handler the widget could honour: `uploadChatAttachments` posts to
    // `/api/artifacts/upload` with `credentials: "include"`, which on this
    // surface would upload as whoever else is signed in on that browser.
    expect(TURN_CLIENT).toMatch(/\/api\/artifacts\/upload[\s\S]{0,200}credentials: "include"/);
    // So the embed passes no handler, and the shared composer correctly draws no
    // upload row — a prop gate, not a per-surface reduction inside the composer.
    expect(EMBED_SRC).not.toContain("onAttachmentsSelected");
  });

  it("10 — the widget composer has no @-mention list, so it draws no flyout", () => {
    // Two reasons, and only the second is a gap: the widget conversation has ONE
    // bound assistant, so there is no second participant to address; and the
    // list `/chat` shows is resolved through a first-party, cookie-bound reader
    // the embed cannot call. The COMPOSER is unchanged — hand it a list and it
    // draws the same flyout on this surface, which the item-10 check above
    // demonstrates. What is missing is a broker-aware source for the list.
    expect(EMBED_SRC).toContain("NO_MENTIONABLES");
    expect(EMBED_SRC).toMatch(/const NO_MENTIONABLES: never\[\] = \[\];/);
  });

  it("9 — the widget composer draws no prompt-options flyout, because it has nothing to put in it", () => {
    // The flyout is prop-gated on its CONTENTS: the attachment row (blocked by
    // item 8), the Skill-autosave row (a `/chat` account setting written through
    // a cookie-bound PATCH) and the remote-chat jump-out (a `/chat`
    // server-resolved prop). With none supplied the shared composer correctly
    // renders no trigger. Item 9 returns with item 8.
    expect(EMBED_SRC).not.toContain("autosave=");
    expect(EMBED_SRC).not.toContain("remoteChat=");
  });

  it("11/12 — the two cookie-bound affordances are guarded in ONE place each", () => {
    for (const file of ["pending-tool-confirmation-card.tsx", "chat-undo-action-chip.tsx"]) {
      const src = readFileSync(path.join(PKG_ROOT, "src", file), "utf8");
      // One guard, keyed on the credential, deleted in one edit when the actions
      // become broker-aware.
      expect(src.match(/useBrokeredSurface\(\)/g) ?? []).toHaveLength(1);
    }
  });
});

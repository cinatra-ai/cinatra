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
// EVERY ITEM NOW PASSES ON BOTH SURFACES, AND SIX OF THEM ARE NEW HERE. The
// first half of S8f left six items open, each for the same reason: the data path
// behind the affordance resolved its identity from an ambient cookie, and the
// embed frame is same-origin to the Cinatra app, so a cookie request from it
// answers as whoever else is signed in on that browser. The column was never the
// problem.
//
// The second half gave each of them a broker-aware path — a widget auth BRANCH
// on the route that already existed, the S8a full actor, the same per-row check
// — so the six pinned open questions below became assertions. They are asserted
// the same way as every other row: on BOTH host configurations, from the same
// fixture, with the widget arm resolving its inputs the way production resolves
// them (`installWidgetServiceStub`), and with a NEGATIVE CONTROL beside each one
// so a green run is evidence the check can go red.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
/**
 * ONE server answer, presented at BOTH doors (cinatra#2683, second half).
 *
 * The cookie arm reaches these rows through the server action and the widget arm
 * through the route, so the fixture is HOISTED and used by both — a check that
 * the two surfaces agree is only meaningful when they were told the same thing.
 */
const SERVER = vi.hoisted(() => ({
  pendingRows: [
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
  undoChangeSetId: "cs-2683",
}));

vi.mock("../pending-call-actions", () => ({
  listPendingToolConfirmations: async () => ({ rows: SERVER.pendingRows }),
  decidePendingToolCall: async () => ({ ok: true }),
}));
vi.mock("../undo-actions", () => ({
  recentUndoableChangeSetForRunAction: async () => ({
    changeSetId: SERVER.undoChangeSetId,
  }),
}));
vi.mock("@/components/data-safety/undo-toast", () => ({
  undoDeepLink: (id: string) => `/objects?undo=${id}`,
}));
vi.mock("../inline-agent-run-card", () => ({
  InlineAgentRunCard: () => null,
}));

import {
  SURFACES,
  installWidgetServiceStub,
  mountRefusedSurface,
  measureConversationColumn,
  mountRunningSurface,
  mountSurface,
  PARITY_MENTIONABLES,
  PARITY_REMOTE_CHAT,
  parityAgentRunMessages,
  parityErrorMessages,
  parityFixtureMessages,
  WIDGET_AUTOSAVE_VISIBLE,
  WIDGET_DIRECTORY,
  type SurfaceName,
} from "./conversation-column-harness";
import { fetchThreadMessages } from "../conversation-services";

/**
 * The widget's server, installed for every mount in this file.
 *
 * The widget arm resolves its composer inputs through the shared services, so
 * without this the arm would measure a surface whose reads all failed — which is
 * the state the FIRST half of S8f left, not the state under test. Each numbered
 * check that depends on one of the six says which answer it depends on.
 */
let widgetServer: ReturnType<typeof installWidgetServiceStub>;
beforeEach(() => {
  widgetServer = installWidgetServiceStub({
    mentionables: WIDGET_DIRECTORY,
    autosave: WIDGET_AUTOSAVE_VISIBLE,
    pendingRows: SERVER.pendingRows,
    undoChangeSetId: SERVER.undoChangeSetId,
  });
});
afterEach(() => widgetServer.restore());

afterEach(cleanup);

const root = (
  surface: SurfaceName | "undeclared",
  container: HTMLElement,
): HTMLElement =>
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

  it("8 — the composer takes attachments", async () => {
    // PRODUCTION inputs on both arms: `/chat` wires its upload handler and the
    // widget wires the SAME one with its broker transport, so the shared
    // composer draws its upload row on both. (The gate itself is still a prop
    // gate, and the negative control below proves it still closes.)
    const { container } = await mountSurface(surface);
    expect(measureConversationColumn(root(surface, container)).hasAttachmentInput).toBe(true);
  });

  it("8 (negative control) — no handler, no upload row", async () => {
    // The gate is the COLUMN's, identical on both surfaces: a host that supplies
    // nothing draws nothing. This is what makes the check above meaningful.
    const { container } = await mountSurface(surface, { withoutComposerInputs: true });
    expect(measureConversationColumn(root(surface, container)).hasAttachmentInput).toBe(false);
  });

  it("9 — the prompt-options flyout appears, with all three of its rows", async () => {
    // The flyout is gated on its CONTENTS, so this is really three checks: the
    // attachment row (item 8), the Skill-autosave row (the same account setting,
    // read through the same handler) and the remote-chat jump-out (a
    // server-resolved prop on both surfaces).
    const { container } = await mountSurface(surface, { remoteChat: PARITY_REMOTE_CHAT });
    const scope = root(surface, container);
    const trigger = scope.querySelector<HTMLButtonElement>(
      'button[aria-label="Prompt options"]',
    );
    expect(trigger).not.toBeNull();
    // Radix opens a dropdown on POINTERDOWN, not on click — a click-only test
    // would report "no flyout" for a flyout that works.
    fireEvent.pointerDown(trigger!, { button: 0, ctrlKey: false });
    fireEvent.click(trigger!);
    // The flyout is a Radix dropdown, so it PORTALS out of the column.
    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Upload files");
      expect(text).toContain("Skills autosave");
      expect(text).toContain(PARITY_REMOTE_CHAT.label);
    });
    // The jump-out is an EXTERNAL destination on both surfaces and already opened
    // out of the page on both — so the widget carries the identical row with the
    // identical target. No reduction, and none invented.
    const remote = Array.from(document.body.querySelectorAll("a")).find(
      (a) => a.getAttribute("href") === PARITY_REMOTE_CHAT.href,
    );
    expect(remote?.getAttribute("target")).toBe("_blank");
  });

  it("9 (negative control) — nothing to put in it, no flyout", async () => {
    const { container } = await mountSurface(surface, { withoutComposerInputs: true });
    expect(
      measureConversationColumn(root(surface, container)).hasPromptOptionsTrigger,
    ).toBe(false);
  });

  it("10 — @-mentions open the composer's flyout", async () => {
    // PRODUCTION inputs on both arms: `/chat` resolves its participant list from
    // the directory reader and the widget resolves the SAME list, from the same
    // reader, through its broker branch — tenant-scoped by the reader's own
    // proven membership on both.
    const { container } = await mountSurface(surface);
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

  it("10 (negative control) — an empty participant list draws no flyout", async () => {
    const { container } = await mountSurface(surface, { mentionables: [] });
    const editor = root(surface, container).querySelector<HTMLElement>(
      '[data-testid="chat-prompt-input"]',
    )!;
    typeIntoEditor(editor, "@");
    await new Promise((r) => setTimeout(r, 30));
    expect(document.body.querySelector('[role="listbox"]')).toBeNull();
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
   * THE WHOLE ROW, WITH NOTHING EXCLUDED (cinatra#2683, second half).
   *
   * This compare used to carry a KNOWN_DIFFERENCES list holding
   * `pendingConfirmationCards` and `undoChips` — the two affordances that could
   * only ask with a cookie, and so could not answer on the widget. Both now ask
   * with the host's own credential through the same server module, so the list
   * is EMPTY and the compare is total: a single field that differs fails here,
   * which is the property the list was weakening.
   */
  const comparable = (row: Record<string, unknown>) => ({ ...row });

  it("agrees element for element on a populated thread", async () => {
    const hostInputs = {
      withCatalog: true,
      mentionables: PARITY_MENTIONABLES,
      remoteChat: PARITY_REMOTE_CHAT,
    };
    const chat = await mountSurface("chat", hostInputs);
    await waitFor(() =>
      expect(root("chat", chat.container).querySelector("[data-mermaid-block]")).not.toBeNull(),
    );
    await waitFor(() =>
      expect(
        measureConversationColumn(root("chat", chat.container)).pendingConfirmationCards,
      ).toBe(1),
    );
    const chatRow = measureConversationColumn(root("chat", chat.container));
    cleanup();
    const widget = await mountSurface("widget", hostInputs);
    await waitFor(() =>
      expect(root("widget", widget.container).querySelector("[data-mermaid-block]")).not.toBeNull(),
    );
    await waitFor(() =>
      expect(
        measureConversationColumn(root("widget", widget.container)).pendingConfirmationCards,
      ).toBe(1),
    );
    const widgetRow = measureConversationColumn(root("widget", widget.container));
    expect(comparable(widgetRow)).toEqual(comparable(chatRow));
  });

  it("agrees on a failed turn", async () => {
    const chat = await mountSurface("chat", { messages: parityErrorMessages() });
    await waitFor(() =>
      expect(
        measureConversationColumn(root("chat", chat.container)).pendingConfirmationCards,
      ).toBe(1),
    );
    const chatRow = measureConversationColumn(root("chat", chat.container));
    cleanup();
    const widget = await mountSurface("widget", { messages: parityErrorMessages() });
    await waitFor(() =>
      expect(
        measureConversationColumn(root("widget", widget.container)).pendingConfirmationCards,
      ).toBe(1),
    );
    const widgetRow = measureConversationColumn(root("widget", widget.container));
    expect(comparable(widgetRow)).toEqual(comparable(chatRow));
  });
});

// ---------------------------------------------------------------------------
// Items 11 and 12 — the two affordances that ASK the server, on both surfaces.
// ---------------------------------------------------------------------------
// These were the two the first half of S8f could not ship: both read (and one
// decides) through a path that resolved its identity from an ambient cookie, so
// on the widget they were fail-closed and asserted ABSENT here.
//
// They now ask with the credential the HOST declared, through a route whose
// widget branch builds the S8a full actor and runs the same per-row check. So
// the row they produce is the same on both surfaces — which is why they leave
// the known-differences list below and join the whole-row compare.

describe("the asking affordances answer on BOTH surfaces (#2683)", () => {
  it("11 — both surfaces draw the pending tool-confirmation card", async () => {
    for (const surface of SURFACES) {
      const mounted = await mountSurface(surface);
      await waitFor(() =>
        expect(
          measureConversationColumn(root(surface, mounted.container)).pendingConfirmationCards,
        ).toBe(1),
      );
      cleanup();
    }
  });

  it("12 — both surfaces draw the undo chip under a run", async () => {
    const messages = parityAgentRunMessages();
    for (const surface of SURFACES) {
      const mounted = await mountSurface(surface, { messages });
      await waitFor(() =>
        expect(measureConversationColumn(root(surface, mounted.container)).undoChips).toBe(1),
      );
      cleanup();
    }
  });

  it("11/12 (negative control) — a surface that declares nothing asks nothing", async () => {
    // The fail-closed default did not move: an undeclared or refused host issues
    // NO request and draws no card. The full four-shape matrix — including the
    // REFUSED broker declaration that a credential-based read got backwards —
    // lives in `cookie-bound-affordances-fail-closed.test.tsx`; this is the
    // in-column restatement, so the inventory itself cannot go green on a column
    // that answers for anybody who mounts it.
    const { container } = await mountRefusedSurface({
      messages: parityAgentRunMessages(),
    });
    await new Promise((r) => setTimeout(r, 30));
    const row = measureConversationColumn(root("undeclared", container));
    expect(row.pendingConfirmationCards).toBe(0);
    expect(row.undoChips).toBe(0);
  });

  it("the guard is keyed on the CREDENTIAL, never on a surface name", async () => {
    // One seam, read in one place per component, so a future host declares
    // itself ONCE and neither component needs a surface list to be updated.
    const guarded = ["pending-tool-confirmation-card.tsx", "chat-undo-action-chip.tsx"];
    for (const file of guarded) {
      const src = readFileSync(path.join(PKG_ROOT, "src", file), "utf8");
      expect(src.match(/useConversationCredential\(\)/g) ?? []).toHaveLength(1);
      expect(src).not.toMatch(/host === "site_widget"/);
      expect(src).not.toMatch(/surface === "widget"/);
    }
  });
});

// ---------------------------------------------------------------------------
// THE SIX ITEMS THAT WERE OPEN — closed, and asserted closed.
// ---------------------------------------------------------------------------
// The first half of S8f carried six open questions here, each pinned as a test
// so a known gap could not be mistaken for a bug. Every one of them said the
// same thing in a different place: the affordance's data path was cookie-bound,
// and this surface must never send a cookie.
//
// Each is now a broker-aware path — a widget auth BRANCH on the route that
// already existed, the S8a full actor, the same per-row check, no ambient-session
// fallback — so the pins are assertions of the closure. They check the two things
// the DOM checks above cannot: that the WIDGET really wires each path (a source
// pin, so the two-surface arm cannot claim a widget that does not exist), and
// that every one of its requests carries the credential rails.

import { readFileSync } from "node:fs";
import path from "node:path";

const PKG_ROOT = path.resolve(__dirname, "..", "..");
const REPO_ROOT = path.resolve(PKG_ROOT, "..", "..");
const EMBED_SRC = readFileSync(
  path.join(REPO_ROOT, "src", "app", "embed", "assistant", "embed-assistant-client.tsx"),
  "utf8",
);
const EMBED_SHELL_SRC = readFileSync(
  path.join(REPO_ROOT, "src", "app", "embed", "assistant", "page.tsx"),
  "utf8",
);
const BROKERED_INPUTS = readFileSync(
  path.join(PKG_ROOT, "src", "brokered-composer-inputs.tsx"),
  "utf8",
);
const TURN_CLIENT = readFileSync(path.join(PKG_ROOT, "src", "ag-ui-chat-client.ts"), "utf8");

describe("the six items S8f carried open are CLOSED (#2683)", () => {
  it("1 — a reload restores the thread, through a broker-authenticated read", async () => {
    // The seam was always ready (the shared engine seeds from `initialMessages`);
    // what was missing was a read this surface could make. It is the SAME route
    // `/chat` reads, through the SAME shared function, with the transport.
    const server = installWidgetServiceStub({
      threadMessages: [{ id: "restored-1", role: "assistant", content: "From before." }],
    });
    try {
      const restored = await fetchThreadMessages("thread-parity-2683", {
        authHeaders: () => ({ "X-Cinatra-Widget-User-Token": "cwu_user" }),
        credentialsMode: "omit",
      });
      expect(restored?.[0]?.content).toBe("From before.");
      const call = server.calls.find((c) => c.url.includes("/api/assistants/threads/"));
      expect(call).toBeDefined();
      expect(call!.init.credentials).toBe("omit");
      expect(
        (call!.init.headers as Record<string, string>)["X-Cinatra-Widget-User-Token"],
      ).toBe("cwu_user");
    } finally {
      server.restore();
    }
    // A restored transcript renders as the whole thread — the shared list over a
    // real message array, which is what every check above already measures.
    const { container } = await mountSurface("widget", {
      messages: [{ id: "restored-1", role: "assistant", content: "From before." }],
    });
    expect(root("widget", container).textContent).toContain("From before.");
    // And the EMBED really does this: it seeds the mount from the shared read,
    // and it MOUNTS ONCE — the column opens only after the restore settles, so a
    // late transcript can never remount over a turn the reader already started.
    expect(EMBED_SRC).toContain("fetchThreadMessages");
    expect(EMBED_SRC).toContain("restoredMessages");
    expect(EMBED_SRC).toContain("historySettled");
    // EVERY request this surface makes omits credentials — including the
    // test-only parity seam, which was the file's last cookie-bearing fetch.
    // Matched as a REQUEST OPTION, so the file may still explain in prose what
    // it used to send.
    expect(EMBED_SRC).not.toMatch(/^\s*credentials: "include",/m);
    expect((EMBED_SRC.match(/credentialsMode: "omit"/g) ?? []).length).toBeGreaterThan(0);
  });

  it("1 (negative control) — a refused read restores nothing, silently", async () => {
    const server = installWidgetServiceStub({ threadMessages: null });
    try {
      // A denied read is a 404 — the route refuses to disclose a thread's
      // existence across tenants — and so is an absent one. Both restore
      // nothing, and neither is reported to the host page.
      expect(
        await fetchThreadMessages("someone-elses-thread", {
          authHeaders: () => ({}),
          credentialsMode: "omit",
        }),
      ).toBeNull();
    } finally {
      server.restore();
    }
  });

  it("2 — the upload carries the broker credential, never a cookie", () => {
    // The upload used to be `credentials: "include"` with no seam, which on this
    // same-origin frame would have filed the reader's file into whoever else's
    // account. The one upload path now takes the transport, and the widget's
    // composer draws its row because a handler exists (item 8 above).
    expect(TURN_CLIENT).toMatch(/credentials: options\.credentialsMode \?\? "include"/);
    expect(TURN_CLIENT).toContain("...(options.authHeaders?.() ?? {})");
    expect(BROKERED_INPUTS).toContain("useChatAttachments(threadIdBox, transport)");
    expect(EMBED_SRC).toContain("useBrokeredComposerInputs");
  });

  it("3 — the flyout's three rows are wired, and the jump-out needs no reduction", () => {
    // Attachments and the Skill-autosave row come from the shared brokered-inputs
    // hook; the remote-chat row is SERVER-RESOLVED by the embed shell from the
    // same first-party builder `/chat` uses.
    expect(BROKERED_INPUTS).toContain("fetchChatCaptureConfig");
    expect(BROKERED_INPUTS).toContain("patchChatCaptureConfig");
    expect(EMBED_SHELL_SRC).toContain("buildRemoteChatHref");
    expect(EMBED_SHELL_SRC).toContain("remoteConnectorKindForProvider");
    // NOT a first-party app link, and never was: the destination is the connected
    // CMS site and the shared composer already opened it out of the page on both
    // surfaces. So the host link policy has nothing to decide here and no
    // reduction was invented — which the DOM check for item 9 also asserts.
    expect(EMBED_SHELL_SRC).not.toContain("remoteChat: undefined");
  });

  it("4 — the participant list is the same reader, broker-authorized", () => {
    expect(BROKERED_INPUTS).toContain("fetchMentionables");
    // The widget passes NO hardcoded list any more — it resolves the reader's own.
    expect(EMBED_SRC).not.toMatch(/const NO_MENTIONABLES/);
    expect(EMBED_SRC).toContain("mentionables={mentionables}");
  });

  it("5/6 — both asking affordances reach the SAME server module, per credential", () => {
    // ONE seam per component, and the route is the widget's door onto the module
    // the cookie action already reached. The four-shape credential matrix (and
    // the still-fail-closed refused case) is
    // `cookie-bound-affordances-fail-closed.test.tsx`.
    const card = readFileSync(
      path.join(PKG_ROOT, "src", "pending-tool-confirmation-card.tsx"),
      "utf8",
    );
    const chip = readFileSync(path.join(PKG_ROOT, "src", "chat-undo-action-chip.tsx"), "utf8");
    expect(card).toContain("/api/chat/pending-tool-calls");
    expect(card).toContain("listPendingToolConfirmations");
    expect(chip).toContain("/api/chat/undo-candidate");
    expect(chip).toContain("recentUndoableChangeSetForRunAction");
    // The undo DEEP LINK follows the column's shared link policy rather than a
    // second undo path: restoring still happens on the first-party surface,
    // under the reader's own session.
    expect(chip).toContain("<AppRouteLink");
    expect(chip).not.toMatch(/<Link\b/);
  });

  it("every widget request omits credentials and carries the broker header", async () => {
    // The credential rail, measured over EVERY call a mounted widget surface
    // makes rather than asserted one call at a time — so a new data path cannot
    // be added without it.
    const server = installWidgetServiceStub({
      mentionables: WIDGET_DIRECTORY,
      autosave: WIDGET_AUTOSAVE_VISIBLE,
    });
    try {
      await mountSurface("widget");
      await waitFor(() => expect(server.calls.length).toBeGreaterThan(1));
      for (const call of server.calls) {
        expect(call.init.credentials).toBe("omit");
        expect(
          (call.init.headers as Record<string, string>)["X-Cinatra-Widget-User-Token"],
        ).toBe("cwu_user");
      }
    } finally {
      server.restore();
    }
  });
});

// @vitest-environment jsdom
//
// The chat's user messages draw the signed-in person's initials on a
// categorical accent (cinatra#4292), in both message layouts. The assistant
// avatars are a separate matter and stay as they were.
//
// The drawing (specs/app-components.html, Avatar): "User avatars carry the
// user's initials in Archivo italic 800 on a random categorical accent (never
// indigo or navy)". Before this change the user branches drew their initials
// on the grey ground. This test renders the real message list with a named
// and a nameless person and reads the drawn fallback.
//
//   pnpm --filter @cinatra-ai/chat exec vitest run \
//     src/__tests__/chat-user-avatar-accent-4292.test.tsx

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("../../../agents/src/run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: async () => ({ state: "none" }),
  confirmRunRecommendationAction: async () => ({ ok: true, dispatched: true }),
  skipRunRecommendationAction: async () => ({ ok: true, dispatched: true }),
}));
vi.mock("../../../agents/src/agent-hitl-screen-actions", () => ({
  getAgentHitlScreenStateAction: async () => ({ state: "none" }),
}));
vi.mock("../../../agents/src/hitl-actions", () => ({
  approveReviewTask: vi.fn(async () => undefined),
  rejectReviewTask: vi.fn(async () => undefined),
}));
vi.mock("../../../agents/src/server-actions", () => ({
  getRunRecommendedSkillsAction: async () => [],
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({})),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/chat",
  useSearchParams: () => new URLSearchParams(),
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
// The run card reaches the host's server modules; no turn here runs an agent.
vi.mock("../inline-agent-run-card", () => ({
  InlineAgentRunCard: () => null,
}));

import { ChatMessagesView, type ChatMessagesViewProps } from "../chat-messages-view";
import { createChatWidgetRuntime } from "../widget-runtime";
import type { UiMessage } from "../types";
import { ACCENT_PALETTE, EXTENSION_ACCENTS, type ExtensionAccent } from "@/lib/extension-accent";

afterEach(() => cleanup());

const MESSAGES: UiMessage[] = [
  { id: "u1", role: "user", content: "Hello there" },
  { id: "a1", role: "assistant", content: "Hello back." },
];

function props(
  isSlackMode: boolean,
  sessionUser: ChatMessagesViewProps["sessionUser"],
): ChatMessagesViewProps {
  return {
    messages: MESSAGES,
    isSlackMode,
    animating: false,
    theme: "light" as ChatMessagesViewProps["theme"],
    userId: "user-ada",
    sessionUser,
    activeThreadId: "thread-4292",
    assistantHandleMap: new Map(),
    taggedAssistantUserIds: [],
    mentionables: [],
    pausedParticipants: [],
    onTogglePause: () => {},
    requestEditMessageId: null,
    onRequestEditMessage: () => {},
    onEditStarted: () => {},
    hasActiveStream: false,
    isStreaming: () => false,
    onEditAndResend: () => {},
    onActivateResource: () => {},
    widgetRuntime: createChatWidgetRuntime([], []),
    widgetSubmitRef: { current: null },
    widgetRefreshKey: 0,
    onActiveGateChange: () => {},
    pendingExternalHandle: null,
    typingIndicators: new Map(),
    chatViews: {},
  };
}

/** Hex "#a6384f" as the rgb() text jsdom reports for an inline background. */
function rgbOf(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

/** Every avatar fallback the list drew, in document order. */
function fallbacks(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-slot="avatar-fallback"]')];
}

/** The user message's fallback: the one whose text is the given initials. */
function userFallback(container: HTMLElement, initials: string): HTMLElement {
  const found = fallbacks(container).filter((el) => el.textContent === initials);
  expect(found.length).toBe(1);
  return found[0];
}

function expectInitialsOnAccent(el: HTMLElement) {
  const accent = el.getAttribute("data-accent");
  expect(EXTENSION_ACCENTS as readonly (string | null)[]).toContain(accent);
  expect(el.style.background).toBe(rgbOf(ACCENT_PALETTE[accent as ExtensionAccent].bg));
  expect(el.className).not.toMatch(/\bbg-muted\b/);
  expect(el.querySelector("svg")).toBeNull();
}

for (const isSlackMode of [false, true]) {
  const layout = isSlackMode ? "the side-by-side (Slack) layout" : "the default layout";
  describe(`chat user avatar in ${layout} (cinatra#4292)`, () => {
    it("draws a named person's initials on an accent", () => {
      const { container } = render(
        <ChatMessagesView {...props(isSlackMode, { name: "Grace Hopper", image: null })} />,
      );
      expectInitialsOnAccent(userFallback(container, "GH"));
    });

    it("draws a nameless person's initials from the e-mail on an accent", () => {
      const { container } = render(
        <ChatMessagesView
          {...props(isSlackMode, { name: null, email: "ada.lovelace@example.com", image: null })}
        />,
      );
      expectInitialsOnAccent(userFallback(container, "AL"));
    });

    it("keeps a valid persisted accent", () => {
      const { container } = render(
        <ChatMessagesView
          {...props(isSlackMode, { name: "Grace Hopper", image: null, accentColor: "olive" })}
        />,
      );
      const el = userFallback(container, "GH");
      expectInitialsOnAccent(el);
      expect(el.getAttribute("data-accent")).toBe("olive");
    });

    it("leaves the assistant's avatar without a person's accent", () => {
      const { container } = render(
        <ChatMessagesView {...props(isSlackMode, { name: "Grace Hopper", image: null })} />,
      );
      const others = fallbacks(container).filter((el) => el.textContent !== "GH");
      expect(others.length).toBeGreaterThan(0);
      for (const el of others) expect(el.getAttribute("data-accent")).toBeNull();
    });
  });
}

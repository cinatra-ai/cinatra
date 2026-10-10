// @vitest-environment jsdom

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Button } from "@/components/ui/button";
import type { ConversationColumnProps } from "../conversation-column";
import { CHAT_THREAD_HOST, ConversationColumn } from "../conversation-column";
import { COMPOSER_RESERVED_SPACE_FLOOR_PX } from "../composer-reserved-space";

// The column owns scrolling; the card owns an asynchronous expansion without
// replacing the transcript or starting a stream. Server and composer behavior
// are outside this test's boundary.
function IdleRunCard() {
  const [expanded, setExpanded] = useState(false);
  return (
    <div data-conversation-list data-content-height={expanded ? "1000" : "600"}>
      <Button onClick={() => { void Promise.resolve().then(() => setExpanded(true)); }}>
        Load run details
      </Button>
      {expanded && <p>{"The idle run's details arrived."}</p>}
    </div>
  );
}

vi.mock("next/dynamic", () => ({ default: () => IdleRunCard }));
vi.mock("@cinatra-ai/sdk-ui/prompt-field", () => ({ PromptField: () => <div data-composer-input /> }));
vi.mock("../widget-runtime", () => ({
  createChatWidgetRuntime: vi.fn(), EMPTY_WIDGETS: [], EMPTY_WIDGET_MANIFESTS: [],
}));
vi.mock("../ag-ui-chat-client", () => ({ driveAssistantChatTurn: vi.fn(), generateId: vi.fn() }));
vi.mock("@cinatra-ai/agents/lifecycle-card-runtime", () => ({
  LifecycleCardSettleProvider: vi.fn(), LifecycleComposerFocusProvider: vi.fn(),
}));

class ObservedResize {
  static instances: ObservedResize[] = [];
  readonly targets = new Set<Element>();
  readonly callback: ResizeObserverCallback;
  active = true;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ObservedResize.instances.push(this);
  }
  observe(target: Element) { this.targets.add(target); }
  unobserve(target: Element) { this.targets.delete(target); }
  disconnect() { this.active = false; this.targets.clear(); }
  notify() { if (this.active) this.callback([], this as unknown as ResizeObserver); }
}

const messages = [{ id: "idle-run", role: "assistant" as const, content: "" }];
const props: ConversationColumnProps = {
  host: CHAT_THREAD_HOST, messages, isSlackMode: false, animating: false, theme: "light",
  activeThreadId: "thread-4011", assistantHandleMap: new Map(), taggedAssistantUserIds: [],
  mentionables: [], pausedParticipants: [], onTogglePause: vi.fn(), requestEditMessageId: null,
  onRequestEditMessage: vi.fn(), onEditStarted: vi.fn(), streamingCount: 0,
  isStreaming: () => false, onEditAndResend: vi.fn(), onActivateResource: vi.fn(),
  widgetRuntime: {} as ConversationColumnProps["widgetRuntime"], widgetSubmitRef: { current: null },
  widgetRefreshKey: 0, onActiveGateChange: vi.fn(), pendingExternalHandle: null,
  typingIndicators: new Map(), chatViews: {}, promptRef: { current: null }, placeholder: "Message",
  promptStorageKey: "4011", onSubmit: vi.fn(), submitAriaLabel: "Send", onStop: vi.fn(),
};

beforeEach(() => {
  vi.useFakeTimers();
  ObservedResize.instances = [];
  vi.stubGlobal("ResizeObserver", ObservedResize);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 16));
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => clearTimeout(handle));
});
afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function mount() {
  const mounted = render(<ConversationColumn {...props} />);
  const stream = mounted.container.querySelector<HTMLElement>("[data-conversation-stream]")!;
  const card = mounted.container.querySelector<HTMLElement>("[data-conversation-list]")!;
  let top = 0;
  // Model the scroll box, including the real column's composer reservation.
  // The viewport stays fixed while the descendant card's height changes.
  Object.defineProperties(stream, {
    clientHeight: { get: () => 300 },
    scrollHeight: { get: () => Number(card.dataset.contentHeight) + parseFloat(stream.style.paddingBottom) },
    scrollTop: { get: () => top, set: (value: number) => {
      top = Math.max(0, Math.min(value, stream.scrollHeight - stream.clientHeight));
    } },
  });
  return { ...mounted, stream, card };
}

async function settleColdLoad() {
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
}
async function growCard(card: Element) {
  await act(async () => { fireEvent.click(card.querySelector("button")!); });
  await act(async () => {
    for (const observer of ObservedResize.instances) {
      if ([...observer.targets].some((target) => target !== card.closest("[data-conversation-stream]") && target.contains(card))) {
        observer.notify();
      }
    }
  });
}

describe("idle-turn content growth (#4011)", () => {
  it("re-pins after asynchronous card growth after cold-load settling, with the same messages", async () => {
    const { stream, card } = mount();
    await settleColdLoad();
    expect(stream.style.paddingBottom).toBe(`${COMPOSER_RESERVED_SPACE_FLOOR_PX}px`);
    expect(stream.scrollTop).toBe(stream.scrollHeight - stream.clientHeight);
    await growCard(card);
    expect(card.dataset.contentHeight).toBe("1000");
    expect(stream.scrollTop).toBe(stream.scrollHeight - stream.clientHeight);
  });

  it("keeps a reader's scroll-up lock when the idle card grows", async () => {
    const { stream, card } = mount();
    await settleColdLoad();
    stream.scrollTop = 100;
    fireEvent.scroll(stream);
    await growCard(card);
    expect(card.dataset.contentHeight).toBe("1000");
    expect(stream.scrollTop).toBe(100);
  });

  it("resumes pinning when the reader returns to the foot", async () => {
    const { stream, card } = mount();
    await settleColdLoad();
    stream.scrollTop = 100;
    fireEvent.scroll(stream);
    stream.scrollTop = stream.scrollHeight;
    fireEvent.scroll(stream);
    await growCard(card);
    expect(stream.scrollTop).toBe(stream.scrollHeight - stream.clientHeight);
  });

  it("disconnects content and composer observers on unmount", async () => {
    const { unmount } = mount();
    await settleColdLoad();
    expect(ObservedResize.instances.some((observer) => observer.active)).toBe(true);
    unmount();
    expect(ObservedResize.instances.every((observer) => !observer.active)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

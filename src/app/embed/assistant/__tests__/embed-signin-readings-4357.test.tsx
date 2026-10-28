// @vitest-environment jsdom
/**
 * THE FRAME'S SIGN-IN CARD, IN ITS TWO DRAWN READINGS (cinatra#4357).
 *
 * The approved drawing (lifecycle cards, section XIV) draws the widget frame's
 * sign-in card twice, with one sentence each:
 *
 *   embed-signin-first  "Sign in to Cinatra to use the assistant here."
 *   embed-signin-again  "Your sign-in has ended. Sign in again to use the assistant here."
 *
 * The first card is the card before any sign-in; a sign-in that fails or is
 * cancelled shows it again. The sign-in-again card is the card after a sign-in
 * ENDED, drawn once for every cause, naming none, and showing no token, no limit
 * and no code. Both share the frame, the button and its action.
 *
 * This suite renders the real `EmbedAssistantClient` and drives it the way a site
 * visitor does: the page's context arrives, the person signs in, the frame
 * negotiates and mounts, and then the pair's life runs out. Only the edges are
 * doubled: the bridge (the parent page), the sign-in popup (the network), the
 * capability negotiation, the transcript read, the shared conversation column and
 * the button primitive. The frame's phases, refs, timer and request headers are
 * the shipped code.
 */
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Pair = {
  userToken: string;
  transportToken: string;
  expiresIn: number;
  userExpiresIn?: number;
  sessionExpiresIn?: number;
};
type BridgeOptions = { onContext: (context: unknown) => void };

const bridges: BridgeOptions[] = [];
vi.mock("@/lib/embed/embed-bridge.client", () => ({
  installEmbedBridge: (options: BridgeOptions) => {
    bridges.push(options);
    return {
      nonce: "nonce",
      contextReceived: false,
      postReady: () => undefined,
      sendResize: () => true,
      sendFocus: () => true,
      sendA11y: () => true,
      sendApplyIntent: () => true,
      dispose: () => undefined,
    };
  },
}));

type SignInAnswer = { ok: true; credential: Pair } | { ok: false; reason: string };
const runFrameSignIn = vi.fn<(selectors: unknown) => Promise<SignInAnswer>>();
// The real sign-in reads this document's clock just before the request that
// mints the pair and once its answer is read, and hands both readings to the
// frame with the pair (cinatra#4217). The double does the same, so the frame's
// renewal chain is armed exactly as it is after a real sign-in.
vi.mock("@/lib/embed/frame-widget-session.client", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runFrameSignIn: async (selectors: unknown) => {
    const mintedAt = Date.now();
    const answer = await runFrameSignIn(selectors);
    return answer.ok ? { ...answer, mintedAt, receivedAt: Date.now() } : answer;
  },
}));

let frameHeaders: (() => Record<string, string>) | null = null;
const negotiate = vi.fn<() => Promise<{ ok: boolean; reason?: string }>>();
vi.mock("../embed-chat-negotiate", () => ({
  negotiateEmbedChatContract: (authHeaders: () => Record<string, string>) => {
    frameHeaders = authHeaders;
    return negotiate();
  },
}));

const fetchThreadMessages = vi.fn<(threadId: string, transport: unknown) => Promise<unknown[] | null>>();
vi.mock("@cinatra-ai/chat/conversation-services", () => ({
  fetchThreadMessages: (threadId: string, transport: unknown) => fetchThreadMessages(threadId, transport),
  buildThreadWrite: () => ({}),
  saveThreadTranscript: async () => true,
}));

const columnSeeds: unknown[] = [];
// The turn-status callback each render of a mounted column handed the turn
// engine. A real turn keeps the one it was given until it settles, so a test
// can call an OLD column's callback after that column has unmounted.
type TurnReporter = (status: "idle" | "running" | "finished" | "error") => void;
const columnReporters: TurnReporter[] = [];
vi.mock("@cinatra-ai/chat/conversation-column", () => ({
  ConversationColumn: () => React.createElement("div", { "data-test-column": "" }),
  useConversationColumnTurns: (input: { initialMessages?: unknown; onTurnStatusChange?: TurnReporter }) => {
    columnSeeds.push(input.initialMessages);
    if (input.onTurnStatusChange) columnReporters.push(input.onTurnStatusChange);
    return {
      messages: [],
      peekRemovedMessageIds: () => ({ ids: [], runIds: [], saveToken: 0 }),
      confirmRemovedMessageIds: () => undefined,
    };
  },
}));

vi.mock("@cinatra-ai/chat/brokered-composer-inputs", () => ({
  useBrokeredComposerInputs: () => ({
    mentionables: [],
    onAttachmentsSelected: undefined,
    composerNotice: null,
    takePendingAttachments: () => [],
    autosave: undefined,
  }),
}));

// The button primitive, doubled to a plain <button> that keeps every data-*
// attribute the frame sets on it (the drawn action among them).
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, ...rest }: { children?: React.ReactNode; onClick?: () => void } & Record<string, unknown>) => {
    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (key.startsWith("data-")) data[key] = value === true ? "" : value;
    }
    return React.createElement("button", { type: "button", onClick, ...data }, children);
  },
}));

import {
  EmbedAssistantClient,
  armSignInEnd,
  clearSignInEnd,
  signInLifeMs,
  type SignInEndRefs,
} from "../embed-assistant-client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
  observe() {}
  disconnect() {}
};

// The drawn sentences, copied from the drawing, NOT from the component: the
// test fails if the component's words drift from the drawing's.
const FIRST = "Sign in to Cinatra to use the assistant here.";
const AGAIN = "Your sign-in has ended. Sign in again to use the assistant here.";
const DRAWN_ACTION = "start-sign-in -> sign-in-window-opened";

const PARENT = "https://wp.signin.test";
const LIFE_S = 600;
const LIFE_MS = LIFE_S * 1000;
/** The longest delay a browser timer holds (2^31 - 1 ms). */
const MAX_DELAY = 2_147_483_647;
/**
 * A pair that has reached its session cap: the user token and the session end
 * with the pair (cinatra#4217). Nothing renews it, so the sign-in ends when the
 * pair's own life runs out, which is the end these readings draw. The renewal
 * itself, and the end that follows a renewed pair, are proven in
 * embed-assistant-renewal.test.tsx.
 */
const pair = (n: number, expiresIn = LIFE_S): Pair => ({
  userToken: `cwu_secret_${n}`,
  transportToken: `cit_secret_${n}`,
  expiresIn,
  userExpiresIn: expiresIn,
  sessionExpiresIn: expiresIn,
});
const context = (threadId: string) => ({
  session: { assistant: "wordpress", threadId },
  site: { siteId: "site-1" },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A negotiation answer the test settles by hand, either way. */
function deferredNegotiation() {
  let resolve!: (value: { ok: boolean; reason?: string }) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<{ ok: boolean; reason?: string }>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every promise the frame chained finish: the sign-in, the negotiation and
 *  the restore are several awaits deep, and none of them waits on a timer. */
async function drain() {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

let container: HTMLDivElement;
let root: Root;

function frame(): HTMLElement {
  const el = container.querySelector<HTMLElement>("[data-embed-assistant]");
  if (!el) throw new Error("the frame did not render");
  return el;
}
const phase = () => frame().getAttribute("data-phase");
const shown = () => frame().querySelector("[data-embed-state]")?.getAttribute("data-embed-state");
const turnStatus = () => frame().getAttribute("data-turn-status");

/** The sign-in card as a reader sees it: its drawn id, sentence, button and action. */
function signInCard() {
  const card = frame().querySelector<HTMLElement>('[data-embed-state="signin"]');
  if (!card) throw new Error(`no sign-in card (phase ${phase()})`);
  const button = card.querySelector<HTMLButtonElement>("button");
  return {
    id: card.getAttribute("data-conformance-id"),
    sentence: card.querySelector("p")?.textContent ?? null,
    button: button?.textContent ?? null,
    action: button?.getAttribute("data-action") ?? null,
    text: frame().textContent ?? "",
  };
}

/** The headers the frame would put on a request built NOW. */
function requestHeaders(): Record<string, string> {
  if (!frameHeaders) throw new Error("the frame never negotiated");
  const h = frameHeaders();
  const out: Record<string, string> = {};
  if (h.Authorization) out.Authorization = h.Authorization;
  if (h["X-Cinatra-Widget-User-Token"]) out["X-Cinatra-Widget-User-Token"] = h["X-Cinatra-Widget-User-Token"];
  return out;
}

/**
 * The backend detail the drawing keeps off both cards: no token, no jti, no
 * limit number and no error or failure code. Returns what leaked, or [].
 */
function backendDetailIn(text: string): string[] {
  const leaks: string[] = [];
  if (/\d/.test(text)) leaks.push("a number");
  for (const word of [
    "cwu_",
    "cit_",
    "secret",
    "jti",
    "token",
    "expire",
    "renew",
    "revoke",
    "rotate",
    "refused",
    "_failed",
    "failed",
    "cancelled",
    "popup_blocked",
    "unauthorized",
    "error",
    "code",
    "hour",
    "minute",
    "second",
  ]) {
    if (text.toLowerCase().includes(word)) leaks.push(word);
  }
  return leaks;
}

async function render(paritySeam: { threadId: string } | null = null) {
  await act(async () => {
    root.render(
      React.createElement(EmbedAssistantClient, {
        expectedParentOrigin: PARENT,
        assistant: "wordpress",
        instanceId: "inst-1",
        paritySeam,
      }),
    );
    await drain();
  });
}
async function deliverContext(threadId = "t-1") {
  const bridge = bridges[bridges.length - 1];
  await act(async () => {
    bridge.onContext(context(threadId));
    await drain();
  });
}
async function clickSignIn() {
  const button = container.querySelector<HTMLButtonElement>("[data-embed-signin]");
  if (!button) throw new Error(`no sign-in button (phase ${phase()})`);
  await act(async () => {
    button.click();
    await drain();
  });
}
async function wait(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    await drain();
  });
}
/** Context, sign-in with `p`, an `ok` negotiation and a restore of `history`. */
async function signedIn(p: Pair, history: unknown[] = []) {
  await deliverContext();
  runFrameSignIn.mockResolvedValueOnce({ ok: true, credential: p });
  negotiate.mockResolvedValueOnce({ ok: true });
  fetchThreadMessages.mockResolvedValueOnce(history);
  await clickSignIn();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  bridges.length = 0;
  columnSeeds.length = 0;
  columnReporters.length = 0;
  frameHeaders = null;
  runFrameSignIn.mockReset();
  negotiate.mockReset();
  fetchThreadMessages.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("signInLifeMs: the pair's life the frame ends the sign-in at (cinatra#4357)", () => {
  it.each([
    ["zero", 0],
    ["negative zero", -0],
    ["a negative life", -1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["a numeric string", "600"],
    ["undefined", undefined],
    ["null", null],
    ["an object", { seconds: 600 }],
  ])("%s names no usable life: nothing is armed", (_label, value) => {
    expect(signInLifeMs(value)).toBeNull();
  });

  it("a finite positive life is counted in milliseconds", () => {
    expect(signInLifeMs(600)).toBe(600_000);
    expect(signInLifeMs(0.5)).toBe(500);
  });

  it("a life longer than a browser timer holds is held at the longest delay, never fired at once", () => {
    expect(signInLifeMs(1e12)).toBe(2_147_483_647);
    expect(signInLifeMs(2_147_483.647)).toBe(2_147_483_647);
  });
});

describe("reading 1: the first sign-in card (embed-signin-first)", () => {
  it("the frame shows the drawn first card once the page's context arrives", async () => {
    await render();
    await deliverContext();
    expect(phase()).toBe("signin");
    const card = signInCard();
    expect(card.id).toBe("embed-signin-first");
    expect(card.sentence).toBe(FIRST);
    expect(card.button).toBe("Sign in");
    expect(card.action).toBe(DRAWN_ACTION);
  });

  it("the first card shows no backend detail", async () => {
    await render();
    await deliverContext();
    const card = signInCard();
    expect(card.text).toBe(`${FIRST}Sign in`);
    expect(backendDetailIn(card.text)).toEqual([]);
  });

  it.each(["init_failed", "popup_blocked", "cancelled", "redeem_failed"])(
    "a sign-in that ends in '%s' shows the first card again, naming no reason",
    async (reason) => {
      await render();
      await deliverContext();
      runFrameSignIn.mockResolvedValueOnce({ ok: false, reason });
      await clickSignIn();
      const card = signInCard();
      expect(card.id).toBe("embed-signin-first");
      expect(card.sentence).toBe(FIRST);
      expect(card.text).not.toContain(reason);
      expect(backendDetailIn(card.text)).toEqual([]);
      expect(negotiate, "a failed sign-in negotiates nothing").not.toHaveBeenCalled();
    },
  );

  it("a new context while signed in drops the sign-in and shows the first card; the old life never turns it into the again card", async () => {
    await render();
    await signedIn(pair(1));
    expect(shown()).toBe("active");
    await deliverContext("t-2");
    expect(signInCard().id).toBe("embed-signin-first");
    expect(requestHeaders(), "the old pair is dropped").toEqual({});
    await wait(LIFE_MS * 2);
    expect(signInCard().id, "the old pair's end changes nothing").toBe("embed-signin-first");
    expect(signInCard().sentence).toBe(FIRST);
  });

  it("a sign-in that answers after a new context arrived lands nothing", async () => {
    await render();
    await deliverContext("t-1");
    const late = deferred<SignInAnswer>();
    runFrameSignIn.mockReturnValueOnce(late.promise);
    await clickSignIn();
    expect(phase()).toBe("authorizing");
    await deliverContext("t-2");
    await act(async () => {
      late.resolve({ ok: true, credential: pair(1) });
      await drain();
    });
    expect(negotiate, "the late pair negotiates nothing").not.toHaveBeenCalled();
    expect(signInCard().id).toBe("embed-signin-first");
  });

  it.each([
    ["answers ok", (d: ReturnType<typeof deferredNegotiation>) => d.resolve({ ok: true })],
    ["answers gated", (d: ReturnType<typeof deferredNegotiation>) => d.resolve({ ok: false, reason: "auth_mode_unsupported" })],
    ["throws", (d: ReturnType<typeof deferredNegotiation>) => d.reject(new Error("network"))],
  ])("a negotiation that %s after a new context arrived changes nothing", async (_label, settle) => {
    await render();
    await deliverContext("t-1");
    runFrameSignIn.mockResolvedValueOnce({ ok: true, credential: pair(1) });
    const late = deferredNegotiation();
    negotiate.mockReturnValueOnce(late.promise);
    await clickSignIn();
    expect(phase()).toBe("authorizing");
    await deliverContext("t-2");
    await act(async () => {
      settle(late);
      await drain();
    });
    expect(signInCard().id).toBe("embed-signin-first");
    expect(fetchThreadMessages, "no restore for the late negotiation").not.toHaveBeenCalled();
    expect(vi.getTimerCount(), "no end armed for the late negotiation").toBe(0);
  });
});

describe("reading 2: the sign-in-again card (embed-signin-again)", () => {
  it("when the pair's life runs out, the conversation closes and the frame shows the drawn again card", async () => {
    await render();
    await signedIn(pair(1));
    expect(shown()).toBe("active");
    expect(requestHeaders()).toEqual({
      Authorization: "Bearer cit_secret_1",
      "X-Cinatra-Widget-User-Token": "cwu_secret_1",
    });

    await wait(LIFE_MS - 1);
    expect(shown(), "not before the pair's life runs out").toBe("active");

    await wait(1);
    expect(phase()).toBe("signin");
    expect(container.querySelector("[data-test-column]"), "the conversation is closed").toBeNull();
    const card = signInCard();
    expect(card.id).toBe("embed-signin-again");
    expect(card.sentence).toBe(AGAIN);
    expect(card.button).toBe("Sign in");
    expect(card.action).toBe(DRAWN_ACTION);
  });

  it("the again card shows no backend detail, and the frame holds no pair behind it", async () => {
    await render();
    await signedIn(pair(7));
    await wait(LIFE_MS);
    const card = signInCard();
    expect(card.id).toBe("embed-signin-again");
    expect(card.text).toBe(`${AGAIN}Sign in`);
    expect(backendDetailIn(card.text)).toEqual([]);
    expect(frame().outerHTML, "no token value anywhere in the frame's DOM").not.toMatch(/cwu_|cit_|secret/);
    expect(requestHeaders(), "the ended pair is dropped").toEqual({});
  });

  it("its button starts a new sign-in, and the new conversation waits for its own restore", async () => {
    await render();
    await signedIn(pair(1), [{ id: "m-old", role: "assistant", content: "old" }]);
    expect(columnSeeds[columnSeeds.length - 1]).toEqual([{ id: "m-old", role: "assistant", content: "old" }]);
    await wait(LIFE_MS);
    expect(signInCard().id).toBe("embed-signin-again");

    runFrameSignIn.mockResolvedValueOnce({ ok: true, credential: pair(2) });
    negotiate.mockResolvedValueOnce({ ok: true });
    const restore = deferred<unknown[] | null>();
    fetchThreadMessages.mockReturnValueOnce(restore.promise);
    const seedsBefore = columnSeeds.length;
    await clickSignIn();
    expect(runFrameSignIn).toHaveBeenCalledTimes(2);
    expect(phase()).toBe("active");
    expect(shown(), "the column waits for the new sign-in's restore").toBe("waiting");
    expect(columnSeeds.length, "no column mounted with the old transcript").toBe(seedsBefore);

    await act(async () => {
      restore.resolve([{ id: "m-new", role: "assistant", content: "new" }]);
      await drain();
    });
    expect(shown()).toBe("active");
    expect(columnSeeds[columnSeeds.length - 1]).toEqual([{ id: "m-new", role: "assistant", content: "new" }]);
    expect(requestHeaders()).toEqual({
      Authorization: "Bearer cit_secret_2",
      "X-Cinatra-Widget-User-Token": "cwu_secret_2",
    });
  });

  it("a sign-in again that is cancelled shows the first card, as drawn", async () => {
    await render();
    await signedIn(pair(1));
    await wait(LIFE_MS);
    expect(signInCard().id).toBe("embed-signin-again");
    runFrameSignIn.mockResolvedValueOnce({ ok: false, reason: "cancelled" });
    await clickSignIn();
    expect(signInCard().id).toBe("embed-signin-first");
    expect(signInCard().sentence).toBe(FIRST);
  });

  it("the life runs from the mint: a negotiation slower than the life ends the sign-in at once", async () => {
    await render();
    await deliverContext();
    runFrameSignIn.mockResolvedValueOnce({ ok: true, credential: pair(1) });
    const slow = deferred<{ ok: boolean }>();
    negotiate.mockReturnValueOnce(slow.promise);
    fetchThreadMessages.mockResolvedValueOnce([]);
    await clickSignIn();
    expect(phase()).toBe("authorizing");
    await wait(LIFE_MS + 5_000);
    await act(async () => {
      slow.resolve({ ok: true });
      await drain();
    });
    await wait(0);
    expect(signInCard().id).toBe("embed-signin-again");
  });

  it.each([
    ["after", 5],
    ["at the moment", 1],
  ])(
    "a pair whose life ran out %s its negotiation answered never mounts the conversation, not even before a timer runs",
    async (_label, negotiationMs) => {
      await render();
      await deliverContext();
      // A life of 1 ms; the negotiation answers ok later (or exactly then), and
      // the transcript read would answer at once.
      runFrameSignIn.mockResolvedValueOnce({ ok: true, credential: pair(1, 0.001) });
      const slow = deferred<{ ok: boolean }>();
      negotiate.mockReturnValueOnce(slow.promise);
      fetchThreadMessages.mockResolvedValueOnce([]);
      await clickSignIn();
      await wait(negotiationMs);
      await act(async () => {
        slow.resolve({ ok: true });
        await drain();
      });
      // No timer step here: every promise has settled, and no timer has run.
      expect(columnSeeds, "no conversation mounted with the dead pair").toEqual([]);
      expect(fetchThreadMessages, "no transcript read with the dead pair").not.toHaveBeenCalled();
      expect(signInCard().id).toBe("embed-signin-again");
      expect(requestHeaders(), "the dead pair is dropped").toEqual({});
    },
  );

  it("the clock moving on right after the spent check arms no zero-delay end: the end comes at the life that one reading left", async () => {
    await render();
    await deliverContext();
    // A life of 1 ms; the negotiation answers ok while the clock still reads
    // the moment of the sign-in answer.
    runFrameSignIn.mockResolvedValueOnce({ ok: true, credential: pair(1, 0.001) });
    const slow = deferred<{ ok: boolean }>();
    negotiate.mockReturnValueOnce(slow.promise);
    fetchThreadMessages.mockResolvedValueOnce([]);
    await clickSignIn();
    // From the first clock reading on, the clock reads 1 ms later: the life is
    // left at the first reading and gone at any later one.
    const t0 = Date.now();
    let reads = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => (reads++ === 0 ? t0 : t0 + 1));
    try {
      await act(async () => {
        slow.resolve({ ok: true });
        await drain();
      });
    } finally {
      clock.mockRestore();
    }
    expect(reads, "the frame read the clock").toBeGreaterThan(0);
    await wait(0);
    expect(shown(), "no end armed with a zero delay").toBe("active");
    await wait(1);
    expect(signInCard().id, "the end comes at the 1 ms the reading left").toBe("embed-signin-again");
  });

  it("the clock set back 1 ms after the sign-in answer, with the longest life, still arms no end at once: the delay is held at the cap", async () => {
    const timers = vi.spyOn(globalThis, "setTimeout");
    try {
      await render();
      await deliverContext();
      // The longest life a timer holds: at the sign-in answer's reading, the
      // life left is exactly the cap.
      runFrameSignIn.mockResolvedValueOnce({ ok: true, credential: pair(1, 2_147_483.647) });
      const slow = deferred<{ ok: boolean }>();
      negotiate.mockReturnValueOnce(slow.promise);
      fetchThreadMessages.mockResolvedValueOnce([]);
      await clickSignIn();
      // The clock is set back 1 ms before the negotiation answers: the life
      // left now reads 1 ms over the cap.
      const t0 = Date.now();
      const clock = vi.spyOn(Date, "now").mockImplementation(() => t0 - 1);
      try {
        await act(async () => {
          slow.resolve({ ok: true });
          await drain();
        });
      } finally {
        clock.mockRestore();
      }
      const delays = (timers.mock.calls as unknown as Array<[() => void, number?]>).map(([, delay]) => delay ?? 0);
      expect(delays, "the end is armed at the cap").toContain(MAX_DELAY);
      expect(Math.max(...delays), "no timer is armed over the cap").toBeLessThanOrEqual(MAX_DELAY);
      await wait(1);
      expect(shown(), "no end at once").toBe("active");
      await wait(MAX_DELAY - 2);
      expect(shown(), "no end before the cap").toBe("active");
      await wait(1);
      expect(signInCard().id, "the end comes at the cap, early and never at once").toBe("embed-signin-again");
    } finally {
      timers.mockRestore();
    }
  });

  it("a restore that answers after the sign-in ended neither settles nor seeds the next sign-in", async () => {
    await render();
    await deliverContext();
    runFrameSignIn.mockResolvedValueOnce({ ok: true, credential: pair(1) });
    negotiate.mockResolvedValueOnce({ ok: true });
    const oldRestore = deferred<unknown[] | null>();
    fetchThreadMessages.mockReturnValueOnce(oldRestore.promise);
    await clickSignIn();
    expect(shown()).toBe("waiting");
    await wait(LIFE_MS);
    expect(signInCard().id).toBe("embed-signin-again");

    runFrameSignIn.mockResolvedValueOnce({ ok: true, credential: pair(2) });
    negotiate.mockResolvedValueOnce({ ok: true });
    const newRestore = deferred<unknown[] | null>();
    fetchThreadMessages.mockReturnValueOnce(newRestore.promise);
    await clickSignIn();
    await act(async () => {
      oldRestore.resolve([{ id: "m-old", role: "assistant", content: "old" }]);
      await drain();
    });
    expect(shown(), "the old restore settles nothing").toBe("waiting");
    await act(async () => {
      newRestore.resolve([]);
      await drain();
    });
    expect(shown()).toBe("active");
    expect(columnSeeds.every((seed) => seed === undefined), "the old transcript seeds nothing").toBe(true);
  });

  it("a parity seed that answers after the sign-in ended neither settles, seeds nor finishes the next sign-in", async () => {
    await render({ threadId: "seed-1" });
    await deliverContext();
    runFrameSignIn.mockResolvedValueOnce({ ok: true, credential: pair(1) });
    negotiate.mockResolvedValueOnce({ ok: true });
    const oldSeed = deferred<unknown[] | null>();
    fetchThreadMessages.mockReturnValueOnce(oldSeed.promise);
    await clickSignIn();
    expect(shown()).toBe("waiting");
    await wait(LIFE_MS);
    expect(signInCard().id).toBe("embed-signin-again");

    runFrameSignIn.mockResolvedValueOnce({ ok: true, credential: pair(2) });
    negotiate.mockResolvedValueOnce({ ok: true });
    const newSeed = deferred<unknown[] | null>();
    fetchThreadMessages.mockReturnValueOnce(newSeed.promise);
    await clickSignIn();
    expect(shown()).toBe("waiting");
    await act(async () => {
      oldSeed.resolve([{ id: "m-old", role: "assistant", content: "old" }]);
      await drain();
    });
    expect(shown(), "the old seed settles nothing").toBe("waiting");
    expect(frame().getAttribute("data-turn-status"), "the old seed finishes no turn").toBe("idle");
    await act(async () => {
      newSeed.resolve([{ id: "m-new", role: "assistant", content: "new" }]);
      await drain();
    });
    expect(shown()).toBe("active");
    expect(columnSeeds[columnSeeds.length - 1]).toEqual([{ id: "parity-seed", role: "assistant", content: "new" }]);
  });

  it.each([
    ["while the again card shows", false],
    ["inside the next sign-in", true],
  ])("a turn of the ended sign-in that settles %s changes no turn status", async (_label, signInAgain) => {
    await render();
    await signedIn(pair(1));
    const oldTurn = columnReporters[columnReporters.length - 1];
    expect(oldTurn, "the first column handed its turn engine a status callback").toBeTypeOf("function");
    await wait(LIFE_MS - 1_000);
    await act(async () => {
      oldTurn("running");
      await drain();
    });
    expect(turnStatus()).toBe("running");
    // The turn's first attempt fails before any stream arrives. The chat client
    // waits three seconds before its one retry; the retry fails, and the turn
    // settles to `error` through the callback its column gave it.
    setTimeout(() => oldTurn("error"), 3_000);
    await wait(1_000);
    expect(signInCard().id).toBe("embed-signin-again");
    expect(turnStatus()).toBe("idle");
    if (signInAgain) {
      runFrameSignIn.mockResolvedValueOnce({ ok: true, credential: pair(2) });
      negotiate.mockResolvedValueOnce({ ok: true });
      fetchThreadMessages.mockResolvedValueOnce([]);
      await clickSignIn();
      expect(shown()).toBe("active");
    }
    await wait(2_000);
    expect(turnStatus(), "the old turn's settle changes nothing").toBe("idle");
    if (signInAgain) {
      const newTurn = columnReporters[columnReporters.length - 1];
      expect(newTurn, "the new sign-in mounted its own column").not.toBe(oldTurn);
      await act(async () => {
        newTurn("running");
        await drain();
      });
      expect(turnStatus(), "the new sign-in's own turn still reports").toBe("running");
    } else {
      expect(signInCard().id).toBe("embed-signin-again");
    }
  });

  it("a gated frame arms nothing: its card stays the gated card", async () => {
    await render();
    await deliverContext();
    runFrameSignIn.mockResolvedValueOnce({ ok: true, credential: pair(1) });
    negotiate.mockResolvedValueOnce({ ok: false, reason: "auth_mode_unsupported" });
    await clickSignIn();
    expect(shown()).toBe("gated");
    await wait(LIFE_MS * 3);
    expect(shown()).toBe("gated");
  });

  it.each([0, -5, Number.POSITIVE_INFINITY])(
    "a pair whose answer named no usable life (%s) is never ended by the frame",
    async (expiresIn) => {
      await render();
      await signedIn(pair(1, expiresIn));
      expect(shown()).toBe("active");
      await wait(8 * 60 * 60_000);
      expect(shown()).toBe("active");
    },
  );

  it("an unmount leaves no timer behind", async () => {
    await render();
    await signedIn(pair(1));
    expect(shown()).toBe("active");
    act(() => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    // afterEach unmounts again; a fresh root keeps that harmless.
    root = createRoot(container);
  });
});

describe("the sign-in ticket: each check and each move, tried on its own (cinatra#4357)", () => {
  it("an end timer of an earlier pair that still runs leaves the current sign-in alone", async () => {
    const timers = vi.spyOn(globalThis, "setTimeout");
    try {
      await render();
      await signedIn(pair(1));
      const calls = timers.mock.calls as unknown as Array<[() => void, number?]>;
      const firstEnd = calls.find(([, delay]) => delay === LIFE_MS)?.[0];
      expect(firstEnd, "the first pair's end timer was armed").toBeTypeOf("function");
      await deliverContext("t-2");
      runFrameSignIn.mockResolvedValueOnce({ ok: true, credential: pair(2) });
      negotiate.mockResolvedValueOnce({ ok: true });
      fetchThreadMessages.mockResolvedValueOnce([]);
      await clickSignIn();
      expect(shown()).toBe("active");
      // The first pair's timer was cleared; its callback runs anyway.
      await act(async () => {
        firstEnd?.();
        await drain();
      });
      expect(shown(), "the stale end drops nothing").toBe("active");
      expect(requestHeaders()).toEqual({
        Authorization: "Bearer cit_secret_2",
        "X-Cinatra-Widget-User-Token": "cwu_secret_2",
      });
      await wait(LIFE_MS);
      expect(signInCard().id, "the current pair still ends at its own end").toBe("embed-signin-again");
    } finally {
      timers.mockRestore();
    }
  });

  it.each([["an unmount"], ["a new context"]])(
    "after an end timer of an earlier pair ran, %s still cancels the current pair's end timer",
    async (then) => {
      const timers = vi.spyOn(globalThis, "setTimeout");
      try {
        await render();
        await signedIn(pair(1));
        const calls = timers.mock.calls as unknown as Array<[() => void, number?]>;
        const firstEnd = calls.find(([, delay]) => delay === LIFE_MS)?.[0];
        expect(firstEnd, "the first pair's end timer was armed").toBeTypeOf("function");
        await deliverContext("t-2");
        runFrameSignIn.mockResolvedValueOnce({ ok: true, credential: pair(2) });
        negotiate.mockResolvedValueOnce({ ok: true });
        fetchThreadMessages.mockResolvedValueOnce([]);
        await clickSignIn();
        expect(shown()).toBe("active");
        // Two timers: the second pair's end timer, and the hold timer of its
        // renewal chain (cinatra#4217), which holds the capped pair to its
        // upper bound and renews nothing.
        expect(vi.getTimerCount(), "the second pair's end timer and its chain's hold are armed").toBe(2);
        await act(async () => {
          firstEnd?.();
          await drain();
        });
        expect(shown(), "the stale end drops nothing").toBe("active");
        if (then === "an unmount") {
          act(() => root.unmount());
          // afterEach unmounts again; a fresh root keeps that harmless.
          root = createRoot(container);
        } else {
          await deliverContext("t-3");
          expect(signInCard().id).toBe("embed-signin-first");
        }
        expect(vi.getTimerCount(), "the second pair's end timer was cancelled").toBe(0);
      } finally {
        timers.mockRestore();
      }
    },
  );

  it("a sign-in that answers after the frame unmounted lands nothing", async () => {
    await render();
    await deliverContext();
    const late = deferred<SignInAnswer>();
    runFrameSignIn.mockReturnValueOnce(late.promise);
    await clickSignIn();
    expect(phase()).toBe("authorizing");
    act(() => root.unmount());
    await act(async () => {
      late.resolve({ ok: true, credential: pair(1) });
      await drain();
    });
    expect(negotiate, "the late pair negotiates nothing").not.toHaveBeenCalled();
    expect(vi.getTimerCount(), "no end armed for the late pair").toBe(0);
    // afterEach unmounts again; a fresh root keeps that harmless.
    root = createRoot(container);
  });

  it("a negotiation that throws for the current sign-in shows the gated card and arms nothing", async () => {
    await render();
    await deliverContext();
    runFrameSignIn.mockResolvedValueOnce({ ok: true, credential: pair(1) });
    negotiate.mockRejectedValueOnce(new Error("network"));
    await clickSignIn();
    expect(shown()).toBe("gated");
    expect(fetchThreadMessages, "no restore for a failed negotiation").not.toHaveBeenCalled();
    expect(vi.getTimerCount(), "no end armed for a failed negotiation").toBe(0);
  });
});

describe("the end timer: each arm is its own, under the same sign-in ticket too (cinatra#4357)", () => {
  // A renewal keeps the sign-in's ticket and arms the end again for the renewed
  // pair. The frame on this branch never arms twice under one ticket, so these
  // tests drive the arm itself, with the refs the frame passes it. The ticket
  // move without a clear is not a road of the frame (each of its ticket moves
  // clears the timer first); it tries the arm's ticket check on its own.
  it.each([["a re-arm under the same ticket"], ["a clear under the same ticket"], ["a ticket move without a clear"]])(
    "after %s, an earlier arm's callback that still runs ends nothing and leaves the timer ref alone",
    (then) => {
      const timers = vi.spyOn(globalThis, "setTimeout");
      try {
        const refs: SignInEndRefs = { ticket: { current: 7 }, timer: { current: null }, arm: { current: 0 } };
        const end = vi.fn();
        armSignInEnd(refs, 7, LIFE_MS, end);
        const calls = timers.mock.calls as unknown as Array<[() => void, number?]>;
        const firstEnd = calls.find(([, delay]) => delay === LIFE_MS)?.[0];
        expect(firstEnd, "the first arm's timer was armed").toBeTypeOf("function");
        if (then === "a re-arm under the same ticket") {
          armSignInEnd(refs, 7, 2 * LIFE_MS, end);
        } else if (then === "a clear under the same ticket") {
          clearSignInEnd(refs);
        } else {
          refs.ticket.current = 8;
        }
        const current = refs.timer.current;
        expect(vi.getTimerCount(), "the timers still armed").toBe(then === "a clear under the same ticket" ? 0 : 1);
        // The callback of the first arm runs now: cleared but already queued,
        // or (after a ticket move alone) still armed.
        firstEnd?.();
        expect(end, "the earlier arm ends nothing").not.toHaveBeenCalled();
        expect(refs.timer.current, "the earlier arm leaves the timer ref alone").toBe(current);
        if (then === "a re-arm under the same ticket") {
          expect(refs.ticket.current, "the ticket did not move").toBe(7);
          expect(current, "the timer ref holds the current arm's timer").not.toBeNull();
          vi.advanceTimersByTime(2 * LIFE_MS);
          expect(end, "the current arm still ends the sign-in at its own end").toHaveBeenCalledTimes(1);
          expect(refs.timer.current).toBeNull();
        }
      } finally {
        timers.mockRestore();
      }
    },
  );
});

// @vitest-environment jsdom
/**
 * THE FRAME'S RENEWAL, WIRED INTO THE FRAME (cinatra#4217).
 *
 * frame-credential-renewal.client.test.ts proves the scheduler on its own. This
 * suite renders the real `EmbedAssistantClient` and drives it the way a site
 * visitor does: the parent's context arrives, the person signs in, the frame
 * negotiates and mounts, and then time passes. It proves the WIRING the
 * scheduler suite cannot see:
 *
 *   (i)   the chain is armed once the frame is active, renews on schedule with
 *         the pair the frame holds, and every request built afterwards carries
 *         the renewed pair; the frame stays signed in for 20 minutes;
 *   (ii)  a negotiation that ends gated arms nothing and drops the pair;
 *   (iii) a negotiation that answers after the frame moved on (a new context on
 *         a re-installed bridge) changes nothing: no phase, no restore, no chain;
 *   (iv)  a refused renewal returns the frame to its sign-in card with no pair;
 *   (v)   an unmount stops the chain;
 *   (vi)  a renewal still in flight when the frame moved on and signed in again
 *         cannot replace the newer pair;
 *   (vii) a restore that answers after the frame moved on neither settles the
 *         history nor seeds the next conversation;
 *   (viii) a new context on a bridge re-installed for the SAME instance (only
 *         the assistant changed, so the chain's own effect does not re-run)
 *         drops the pair and stops the chain: onContext's own dispose;
 *   (ix)  a restore that answers AFTER the chain was armed still settles the
 *         history and seeds the column: arming the chain does not make the
 *         sign-in's own restore stale;
 *   (x)   the same for the parity seed: a seed that answers after the chain
 *         was armed still seeds the column and settles the history;
 *   (xi)  a sign-in that answers after a newer sign-in took over cannot
 *         replace the newer pair;
 *   (xii) a sign-in again after a refused renewal waits for its own restore:
 *         the column never mounts with the previous sign-in's transcript;
 *   (xiii) a negotiation that takes 100 s and renewal answers that take 60 s
 *         never push a renewal past the end of the pair the frame holds: the
 *         pair's life runs from its mint (cinatra#4217 fold 3).
 *
 * Only the edges are doubled: the bridge (the parent page), the sign-in popup
 * and the renew call (the network), the capability negotiation, the transcript
 * read, and the shared conversation column. The scheduler, the frame's phases,
 * its refs and its request headers are the shipped code.
 */
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Pair = { userToken: string; transportToken: string; expiresIn: number };
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

type SignedIn = { ok: true; credential: Pair; mintedAt: number };
const runFrameSignIn = vi.fn<(selectors: unknown) => Promise<SignedIn | { ok: false; reason: string }>>();
const renewFrameCredential = vi.fn<
  (selectors: unknown, current: Pair) => Promise<{ ok: true; credential: Pair } | { ok: false; reason: string }>
>();
vi.mock("@/lib/embed/frame-widget-session.client", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runFrameSignIn: (selectors: unknown) => runFrameSignIn(selectors),
  renewFrameCredential: (selectors: unknown, current: Pair) => renewFrameCredential(selectors, current),
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
vi.mock("@cinatra-ai/chat/conversation-column", () => ({
  ConversationColumn: () => React.createElement("div", { "data-test-column": "" }),
  useConversationColumnTurns: (input: { initialMessages?: unknown }) => {
    columnSeeds.push(input.initialMessages);
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

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, ...rest }: { children?: React.ReactNode; onClick?: () => void } & Record<string, unknown>) =>
    React.createElement(
      "button",
      { type: "button", onClick, "data-embed-signin": rest["data-embed-signin"] ? "" : undefined },
      children,
    ),
}));

import { EmbedAssistantClient } from "../embed-assistant-client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
  observe() {}
  disconnect() {}
};

const PARENT = "https://wp.renewal.test";
const pair = (n: number): Pair => ({ userToken: `cwu_${n}`, transportToken: `cit_${n}`, expiresIn: 300 });
const headersOf = (p: Pair) => ({
  Authorization: `Bearer ${p.transportToken}`,
  "X-Cinatra-Widget-User-Token": p.userToken,
});
const context = (threadId: string) => ({
  session: { assistant: "wordpress", threadId },
  site: { siteId: "site-1" },
});
const RENEW_AT_MS = 210_000; // max(300 - 90, 30) s: the frame's own schedule

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
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
/** The headers the frame would put on a request built NOW. */
function requestHeaders(): Record<string, string> {
  if (!frameHeaders) throw new Error("the frame never negotiated");
  const h = frameHeaders();
  const out: Record<string, string> = {};
  if (h.Authorization) out.Authorization = h.Authorization;
  if (h["X-Cinatra-Widget-User-Token"]) out["X-Cinatra-Widget-User-Token"] = h["X-Cinatra-Widget-User-Token"];
  return out;
}

async function render(
  instanceId = "inst-1",
  assistant: "wordpress" | "drupal" = "wordpress",
  paritySeam: { threadId: string } | null = null,
) {
  await act(async () => {
    root.render(
      React.createElement(EmbedAssistantClient, {
        expectedParentOrigin: PARENT,
        assistant,
        instanceId,
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
  if (!button) throw new Error(`no sign-in card (phase ${phase()})`);
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
/** Context, sign-in with `p`, an `ok` negotiation and an empty restore. */
async function signedIn(p: Pair, threadId = "t-1") {
  await deliverContext(threadId);
  runFrameSignIn.mockResolvedValueOnce({ ok: true, credential: p, mintedAt: Date.now() });
  negotiate.mockResolvedValueOnce({ ok: true });
  fetchThreadMessages.mockResolvedValueOnce([]);
  await clickSignIn();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  bridges.length = 0;
  columnSeeds.length = 0;
  frameHeaders = null;
  runFrameSignIn.mockReset();
  renewFrameCredential.mockReset();
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

describe("EmbedAssistantClient — the renewal chain, wired (cinatra#4217)", () => {
  it("(i) an active frame renews on schedule with the pair it holds and stays signed in for 20 minutes", async () => {
    await render();
    let n = 1;
    await signedIn(pair(n));
    expect(phase()).toBe("active");
    expect(shown(), "the restore settled and the column mounted").toBe("active");
    expect(requestHeaders()).toEqual(headersOf(pair(1)));

    renewFrameCredential.mockImplementation(async (_s, current) => {
      expect(current, "the chain presents the pair the frame holds").toEqual(pair(n));
      n += 1;
      return { ok: true, credential: pair(n) };
    });
    await wait(RENEW_AT_MS - 1_000);
    expect(renewFrameCredential, "not before the schedule").not.toHaveBeenCalled();
    await wait(1_000);
    expect(renewFrameCredential).toHaveBeenCalledTimes(1);
    expect(requestHeaders(), "a request built now carries the renewed pair").toEqual(headersOf(pair(2)));

    await wait(20 * 60_000 - RENEW_AT_MS);
    expect(renewFrameCredential, "renewed at 210, 420, 630, 840 and 1050 s").toHaveBeenCalledTimes(5);
    expect(phase(), "still signed in after 20 minutes").toBe("active");
    expect(requestHeaders()).toEqual(headersOf(pair(6)));
  });

  it("(ii) a negotiation that ends gated arms nothing and drops the pair", async () => {
    await render();
    await deliverContext();
    runFrameSignIn.mockResolvedValueOnce({ ok: true, credential: pair(1), mintedAt: Date.now() });
    negotiate.mockResolvedValueOnce({ ok: false, reason: "auth_mode_unsupported" });
    await clickSignIn();
    expect(phase()).toBe("gated");
    expect(requestHeaders(), "no pair is held behind a gated card").toEqual({});
    await wait(10 * 60_000);
    expect(renewFrameCredential, "no chain renews behind a gated card").not.toHaveBeenCalled();
  });

  it("(iii) a negotiation that answers after the frame moved on changes nothing", async () => {
    await render("inst-1");
    await deliverContext("t-1");
    runFrameSignIn.mockResolvedValueOnce({ ok: true, credential: pair(1), mintedAt: Date.now() });
    const slow = deferred<{ ok: boolean }>();
    negotiate.mockReturnValueOnce(slow.promise);
    await clickSignIn();
    expect(phase()).toBe("authorizing");

    // The frame moves on: a new instance re-installs the bridge, whose context arrives.
    await render("inst-2");
    await deliverContext("t-2");
    expect(phase()).toBe("signin");

    await act(async () => {
      slow.resolve({ ok: true });
      await drain();
    });
    expect(phase(), "the stale answer does not bring the frame to active").toBe("signin");
    expect(fetchThreadMessages, "nor start a restore").not.toHaveBeenCalled();
    expect(requestHeaders(), "nor hold a pair").toEqual({});
    await wait(10 * 60_000);
    expect(renewFrameCredential, "nor arm a chain").not.toHaveBeenCalled();
  });

  it("(iv) a refused renewal returns the frame to its sign-in card with no pair", async () => {
    await render();
    await signedIn(pair(1));
    renewFrameCredential.mockResolvedValueOnce({ ok: false, reason: "renew_failed" });
    await wait(RENEW_AT_MS);
    expect(renewFrameCredential).toHaveBeenCalledTimes(1);
    expect(phase()).toBe("signin");
    expect(container.querySelector("[data-embed-signin]"), "the sign-in card").not.toBeNull();
    expect(requestHeaders()).toEqual({});
    await wait(10 * 60_000);
    expect(renewFrameCredential, "the chain ended").toHaveBeenCalledTimes(1);
  });

  it("(v) an unmount stops the chain", async () => {
    await render();
    await signedIn(pair(1));
    renewFrameCredential.mockResolvedValue({ ok: true, credential: pair(2) });
    await wait(RENEW_AT_MS);
    expect(renewFrameCredential, "control: the chain runs").toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    root = createRoot(container);
    await wait(30 * 60_000);
    expect(renewFrameCredential, "nothing renews after the unmount").toHaveBeenCalledTimes(1);
  });

  it("(vi) a renewal in flight when the frame moved on and signed in again cannot replace the newer pair", async () => {
    await render("inst-1");
    await signedIn(pair(1), "t-1");
    const inFlight = deferred<{ ok: true; credential: Pair }>();
    renewFrameCredential.mockReturnValueOnce(inFlight.promise);
    await wait(RENEW_AT_MS);
    expect(renewFrameCredential).toHaveBeenCalledTimes(1);

    await render("inst-2");
    await signedIn(pair(3), "t-2");
    expect(phase()).toBe("active");
    expect(requestHeaders()).toEqual(headersOf(pair(3)));

    await act(async () => {
      inFlight.resolve({ ok: true, credential: pair(2) });
      await drain();
    });
    expect(requestHeaders(), "the old chain's answer is dropped").toEqual(headersOf(pair(3)));
    expect(phase()).toBe("active");
  });

  it("(vii) a restore that answers after the frame moved on neither settles the history nor seeds the next conversation", async () => {
    await render("inst-1");
    await deliverContext("t-1");
    runFrameSignIn.mockResolvedValueOnce({ ok: true, credential: pair(1), mintedAt: Date.now() });
    negotiate.mockResolvedValueOnce({ ok: true });
    const staleRestore = deferred<unknown[] | null>();
    fetchThreadMessages.mockReturnValueOnce(staleRestore.promise);
    await clickSignIn();
    expect(phase()).toBe("active");
    expect(shown(), "waiting for its restore").toBe("waiting");

    await render("inst-2");
    await deliverContext("t-2");
    await act(async () => {
      staleRestore.resolve([{ id: "old", role: "user", content: "from the old thread" }]);
      await drain();
    });

    runFrameSignIn.mockResolvedValueOnce({ ok: true, credential: pair(2), mintedAt: Date.now() });
    negotiate.mockResolvedValueOnce({ ok: true });
    const freshRestore = deferred<unknown[] | null>();
    fetchThreadMessages.mockReturnValueOnce(freshRestore.promise);
    await clickSignIn();
    expect(phase()).toBe("active");
    expect(shown(), "the stale restore did not settle the new frame's history").toBe("waiting");
    expect(columnSeeds, "no column mounted yet").toEqual([]);

    await act(async () => {
      freshRestore.resolve([]);
      await drain();
    });
    expect(shown()).toBe("active");
    expect(columnSeeds[0], "the old thread's transcript does not seed the new conversation").toBeUndefined();
    expect(fetchThreadMessages.mock.calls.map((c) => c[0])).toEqual(["t-1", "t-2"]);
  });

  it("(viii) a new context for the same instance drops the pair and stops the chain", async () => {
    await render("inst-1", "wordpress");
    await signedIn(pair(1));
    renewFrameCredential.mockResolvedValue({ ok: true, credential: pair(2) });
    await wait(RENEW_AT_MS - 10_000);
    expect(renewFrameCredential, "not yet due").not.toHaveBeenCalled();

    // Same instance, another assistant: the bridge re-installs and its context
    // arrives, but the chain's own effect (keyed on the instance) does not re-run.
    await render("inst-1", "drupal");
    await deliverContext("t-2");
    expect(phase()).toBe("signin");
    expect(requestHeaders(), "the old pair is dropped").toEqual({});
    await wait(10 * 60_000);
    expect(renewFrameCredential, "the old chain never fires").not.toHaveBeenCalled();
  });

  // The sequence of a first sign-in on a real network: the transcript read is
  // still on its way when the negotiation has answered and the chain is armed.
  it("(ix) a restore that answers after the chain was armed still settles the history", async () => {
    await render();
    await deliverContext("t-1");
    runFrameSignIn.mockResolvedValueOnce({ ok: true, credential: pair(1), mintedAt: Date.now() });
    negotiate.mockResolvedValueOnce({ ok: true });
    const restore = deferred<unknown[] | null>();
    fetchThreadMessages.mockReturnValueOnce(restore.promise);
    await clickSignIn();
    expect(phase()).toBe("active");
    expect(shown(), "waiting for its restore, with the chain already armed").toBe("waiting");

    const transcript = [{ id: "m-1", role: "user", content: "the pending review" }];
    await act(async () => {
      restore.resolve(transcript);
      await drain();
    });
    expect(shown(), "the restore settled the history: the column mounts").toBe("active");
    expect(columnSeeds[0], "seeded with the restored transcript").toEqual(transcript);

    renewFrameCredential.mockResolvedValueOnce({ ok: true, credential: pair(2) });
    await wait(RENEW_AT_MS);
    expect(renewFrameCredential, "and the chain armed at sign-in renews on schedule").toHaveBeenCalledTimes(1);
    expect(requestHeaders()).toEqual(headersOf(pair(2)));
  });

  it("(x) a parity seed that answers after the chain was armed still seeds the column", async () => {
    await render("inst-1", "wordpress", { threadId: "seed-1" });
    await deliverContext("t-1");
    runFrameSignIn.mockResolvedValueOnce({ ok: true, credential: pair(1), mintedAt: Date.now() });
    negotiate.mockResolvedValueOnce({ ok: true });
    const seed = deferred<unknown[] | null>();
    fetchThreadMessages.mockReturnValueOnce(seed.promise);
    await clickSignIn();
    expect(phase()).toBe("active");
    expect(shown(), "waiting for the seed, with the chain already armed").toBe("waiting");

    await act(async () => {
      seed.resolve([{ id: "a-1", role: "assistant", content: "the seeded answer" }]);
      await drain();
    });
    expect(shown(), "the seed settled the history").toBe("active");
    expect(columnSeeds[0]).toEqual([{ id: "parity-seed", role: "assistant", content: "the seeded answer" }]);
    expect(fetchThreadMessages.mock.calls.map((c) => c[0])).toEqual(["seed-1"]);

    renewFrameCredential.mockResolvedValueOnce({ ok: true, credential: pair(2) });
    await wait(RENEW_AT_MS);
    expect(renewFrameCredential, "and the chain armed at sign-in renews on schedule").toHaveBeenCalledTimes(1);
  });

  it("(xi) a sign-in that answers after a newer sign-in took over cannot replace the newer pair", async () => {
    await render("inst-1", "wordpress");
    await deliverContext("t-1");
    const slowSignIn = deferred<SignedIn>();
    runFrameSignIn.mockReturnValueOnce(slowSignIn.promise);
    negotiate.mockResolvedValue({ ok: true });
    fetchThreadMessages.mockResolvedValue([]);
    await clickSignIn();
    expect(phase(), "sign-in A's window is still open").toBe("authorizing");

    // A new context arrives (the bridge re-installs for the same instance), and
    // sign-in B completes while A's window is still open.
    await render("inst-1", "drupal");
    await deliverContext("t-2");
    expect(phase()).toBe("signin");
    runFrameSignIn.mockResolvedValueOnce({ ok: true, credential: pair(3), mintedAt: Date.now() });
    await clickSignIn();
    expect(phase()).toBe("active");
    expect(requestHeaders()).toEqual(headersOf(pair(3)));

    // Now A's window answers.
    await act(async () => {
      slowSignIn.resolve({ ok: true, credential: pair(1), mintedAt: Date.now() });
      await drain();
    });
    expect(requestHeaders(), "the stale sign-in's pair never replaces B's").toEqual(headersOf(pair(3)));
    expect(phase()).toBe("active");

    renewFrameCredential.mockResolvedValueOnce({ ok: true, credential: pair(4) });
    await wait(RENEW_AT_MS);
    expect(renewFrameCredential).toHaveBeenCalledTimes(1);
    expect(renewFrameCredential.mock.calls[0][1], "the chain renews B's pair").toEqual(pair(3));
  });

  it("(xii) sign-in again after a refused renewal waits for its own restore", async () => {
    await render();
    await deliverContext("t-1");
    const oldTranscript = [{ id: "old", role: "user", content: "the old transcript" }];
    runFrameSignIn.mockResolvedValueOnce({ ok: true, credential: pair(1), mintedAt: Date.now() });
    negotiate.mockResolvedValueOnce({ ok: true });
    fetchThreadMessages.mockResolvedValueOnce(oldTranscript);
    await clickSignIn();
    expect(shown()).toBe("active");
    expect(columnSeeds[0], "control: the first sign-in seeds its own transcript").toEqual(oldTranscript);

    renewFrameCredential.mockResolvedValueOnce({ ok: false, reason: "renew_failed" });
    await wait(RENEW_AT_MS);
    expect(phase(), "the refused renewal returns to the sign-in card").toBe("signin");
    const seedsBefore = columnSeeds.length;

    runFrameSignIn.mockResolvedValueOnce({ ok: true, credential: pair(2), mintedAt: Date.now() });
    negotiate.mockResolvedValueOnce({ ok: true });
    const freshRestore = deferred<unknown[] | null>();
    fetchThreadMessages.mockReturnValueOnce(freshRestore.promise);
    await clickSignIn();
    expect(phase()).toBe("active");
    expect(shown(), "the second sign-in waits for its own restore").toBe("waiting");
    expect(columnSeeds.length, "no column mounts with the old transcript").toBe(seedsBefore);

    const newTranscript = [{ id: "new", role: "user", content: "the new transcript" }];
    await act(async () => {
      freshRestore.resolve(newTranscript);
      await drain();
    });
    expect(shown(), "the new restore settled the history: the column mounts").toBe("active");
    const secondMount = columnSeeds.slice(seedsBefore);
    expect(secondMount[0], "seeded with the new transcript").toEqual(newTranscript);
    expect(secondMount, "the old transcript never seeds it").not.toContainEqual(oldTranscript);
    expect(fetchThreadMessages.mock.calls.map((c) => c[0])).toEqual(["t-1", "t-1"]);
  });
  // cinatra#4217 fold 3. RED BEFORE fold 3 (head e804438a): the frame armed the
  // chain after its negotiation with the pair's FULL advertised life, so a 100 s
  // negotiation put the first renewal at mint + 310 s, ten seconds after the
  // 300 s transport token had run out; a slow renewal answer moved every later
  // renewal by its own delay too.
  it("(xiii) a slow negotiation and slow renewal answers never push a renewal past the pair's end", async () => {
    await render();
    await deliverContext("t-1");
    const t0 = Date.now();
    runFrameSignIn.mockResolvedValueOnce({ ok: true, credential: pair(1), mintedAt: t0 });
    const slowNegotiation = deferred<{ ok: boolean }>();
    negotiate.mockReturnValueOnce(slowNegotiation.promise);
    fetchThreadMessages.mockResolvedValueOnce([]);
    await clickSignIn();
    expect(phase()).toBe("authorizing");

    // The negotiation takes 100 s of the pair's 300 s.
    await wait(100_000);
    await act(async () => {
      slowNegotiation.resolve({ ok: true });
      await drain();
    });
    expect(phase()).toBe("active");

    // Each renewal answer reaches the frame 60 s after the request; the pair in
    // it was minted when the request arrived.
    const startedAt: number[] = [];
    let n = 1;
    renewFrameCredential.mockImplementation((_s, current) => {
      expect(current, "the chain presents the pair the frame holds").toEqual(pair(n));
      startedAt.push((Date.now() - t0) / 1_000);
      n += 1;
      const next = pair(n);
      return new Promise<{ ok: true; credential: Pair }>((resolve) => {
        setTimeout(() => resolve({ ok: true, credential: next }), 60_000);
      });
    });

    await wait(110_000 - 1_000);
    expect(renewFrameCredential, "not before mint + 210 s").not.toHaveBeenCalled();
    await wait(1_000);
    expect(startedAt, "the first renewal at mint + 210 s, before the pair's 300 s end").toEqual([210]);

    // At 299 s the frame already holds the renewed pair (answered at 270 s).
    await wait(89_000);
    expect(requestHeaders(), "the first pair is not held to its end").toEqual(headersOf(pair(2)));

    await wait(20 * 60_000 - 299_000);
    expect(startedAt, "every renewal 210 s after the previous one started").toEqual([210, 420, 630, 840, 1050]);
    expect(phase(), "still signed in after 20 minutes").toBe("active");
  });
});

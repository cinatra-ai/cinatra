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

type Pair = { userToken: string; transportToken: string; expiresIn: number; userExpiresIn?: number; sessionExpiresIn?: number };
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

type SignedIn = { ok: true; credential: Pair; mintedAt: number; receivedAt: number };
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
type ColumnProps = { host?: { lifecycleSurface?: { auth?: { headers?: () => Record<string, string> } } } };
const columnProps: ColumnProps[] = [];
vi.mock("@cinatra-ai/chat/conversation-column", () => ({
  ConversationColumn: (props: ColumnProps) => {
    columnProps.push(props);
    return React.createElement("div", { "data-test-column": "" });
  },
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
const RENEW_AT_MS = 210_000; // E_lo - 90 s for a 300 s pair minted at the sign-in

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

/** The review card's decision headers, as the column's host builds them (C35). */
function decisionHeaders(): Record<string, string> | null {
  const h = columnProps[columnProps.length - 1]?.host?.lifecycleSurface?.auth?.headers?.();
  if (!h) return null;
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
  runFrameSignIn.mockResolvedValueOnce({ ok: true, credential: p, mintedAt: Date.now(), receivedAt: Date.now() });
  negotiate.mockResolvedValueOnce({ ok: true });
  fetchThreadMessages.mockResolvedValueOnce([]);
  await clickSignIn();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  bridges.length = 0;
  columnSeeds.length = 0;
  columnProps.length = 0;
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

  it("(ii) C30: a negotiation that ends gated disposes the chain armed at the mint and drops the pair", async () => {
    await render();
    await deliverContext();
    runFrameSignIn.mockResolvedValueOnce({ ok: true, credential: pair(1), mintedAt: Date.now(), receivedAt: Date.now() });
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
    runFrameSignIn.mockResolvedValueOnce({ ok: true, credential: pair(1), mintedAt: Date.now(), receivedAt: Date.now() });
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
    runFrameSignIn.mockResolvedValueOnce({ ok: true, credential: pair(1), mintedAt: Date.now(), receivedAt: Date.now() });
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

    runFrameSignIn.mockResolvedValueOnce({ ok: true, credential: pair(2), mintedAt: Date.now(), receivedAt: Date.now() });
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
    runFrameSignIn.mockResolvedValueOnce({ ok: true, credential: pair(1), mintedAt: Date.now(), receivedAt: Date.now() });
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
    runFrameSignIn.mockResolvedValueOnce({ ok: true, credential: pair(1), mintedAt: Date.now(), receivedAt: Date.now() });
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
    runFrameSignIn.mockResolvedValueOnce({ ok: true, credential: pair(3), mintedAt: Date.now(), receivedAt: Date.now() });
    await clickSignIn();
    expect(phase()).toBe("active");
    expect(requestHeaders()).toEqual(headersOf(pair(3)));

    // Now A's window answers.
    await act(async () => {
      slowSignIn.resolve({ ok: true, credential: pair(1), mintedAt: Date.now(), receivedAt: Date.now() });
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
    runFrameSignIn.mockResolvedValueOnce({ ok: true, credential: pair(1), mintedAt: Date.now(), receivedAt: Date.now() });
    negotiate.mockResolvedValueOnce({ ok: true });
    fetchThreadMessages.mockResolvedValueOnce(oldTranscript);
    await clickSignIn();
    expect(shown()).toBe("active");
    expect(columnSeeds[0], "control: the first sign-in seeds its own transcript").toEqual(oldTranscript);

    renewFrameCredential.mockResolvedValueOnce({ ok: false, reason: "renew_failed" });
    await wait(RENEW_AT_MS);
    expect(phase(), "the refused renewal returns to the sign-in card").toBe("signin");
    const seedsBefore = columnSeeds.length;

    runFrameSignIn.mockResolvedValueOnce({ ok: true, credential: pair(2), mintedAt: Date.now(), receivedAt: Date.now() });
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
    runFrameSignIn.mockResolvedValueOnce({ ok: true, credential: pair(1), mintedAt: t0, receivedAt: t0 });
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

  // -------------------------------------------------------------------------
  // cinatra#4217 rebuild — the chain is armed AT THE MINT and the negotiation
  // runs under a renewal LEASE. Each title names its census row.
  // RED AT a246d839: the chain was armed only after the negotiation (from the
  // mint time, with a 30 s floor), with no lease and no 409 hold.
  // -------------------------------------------------------------------------

  /** A token server double for the frame's bearers: a renewal spends the
   *  presented user token to a grace row of at most 30 s; a request is accepted
   *  only while both tokens of the pair it carries are live. */
  function tokenServer() {
    const users = new Map<string, number>();
    const transports = new Map<string, number>();
    let n = 100;
    const issue = (userLife: number, extra: Partial<Pair> = {}): Pair => {
      n += 1;
      const p: Pair = { userToken: `cwu_${n}`, transportToken: `cit_${n}`, expiresIn: Math.min(userLife, 300), ...extra };
      users.set(p.userToken, Date.now() + userLife * 1000);
      transports.set(p.transportToken, Date.now() + 300_000);
      return p;
    };
    const accepts = (h: Record<string, string>) => {
      const u = users.get(h["X-Cinatra-Widget-User-Token"] ?? "") ?? -Infinity;
      const t = transports.get((h.Authorization ?? "").replace(/^Bearer /, "")) ?? -Infinity;
      return u > Date.now() && t > Date.now();
    };
    const spend = (p: Pair) => {
      const u = users.get(p.userToken);
      if (u !== undefined) users.set(p.userToken, Math.min(u, Date.now() + 30_000));
    };
    return { issue, accepts, spend, users };
  }

  it("(xiv) R2: a 280 s negotiation is never shortened by a renewal and is renewed at its end", async () => {
    await render();
    await deliverContext("t-1");
    const server = tokenServer();
    const first = server.issue(900, { userExpiresIn: 900, sessionExpiresIn: 28_800 });
    first.expiresIn = 300;
    const a = Date.now();
    // The sign-in answers at A + 1 s.
    runFrameSignIn.mockResolvedValueOnce({ ok: true, credential: first, mintedAt: a - 1_000, receivedAt: a });
    const slow = deferred<{ ok: boolean }>();
    let carried: Record<string, string> = {};
    negotiate.mockImplementationOnce(() => {
      carried = requestHeaders();
      return slow.promise;
    });
    fetchThreadMessages.mockResolvedValue([]);
    renewFrameCredential.mockImplementation(async (_s, current) => {
      server.spend(current);
      return { ok: true, credential: server.issue(900, { userExpiresIn: 900 }) };
    });
    await clickSignIn();
    expect(carried).toEqual(headersOf(first));
    await wait(210_000 - 1_000);
    expect(renewFrameCredential, "the D3 timer at A + 210 s fires under the lease: deferred").not.toHaveBeenCalled();
    await wait(279_000 - 209_000);
    expect(server.accepts(carried), "the negotiation's bearer was never spent").toBe(true);
    await act(async () => {
      slow.resolve({ ok: true });
      await drain();
    });
    expect(renewFrameCredential, "renewed at the release (ul 620)").toHaveBeenCalledTimes(1);
    expect(renewFrameCredential.mock.calls[0]![1]).toEqual(first);
    expect(phase(), "active on the same ticket").toBe("active");
    expect(requestHeaders(), "the renewed pair replaces the held one").not.toEqual(headersOf(first));
    expect(server.accepts(requestHeaders())).toBe(true);
  });

  it("(xv) R1: a not_renewable refusal keeps the frame signed in until min(E_hi, R409 + 31 s); a review decision sent at R409 + 20 s is accepted", async () => {
    await render();
    const server = tokenServer();
    await deliverContext("t-1");
    const first = server.issue(300);
    runFrameSignIn.mockResolvedValueOnce({ ok: true, credential: first, mintedAt: Date.now(), receivedAt: Date.now() });
    negotiate.mockResolvedValueOnce({ ok: true });
    fetchThreadMessages.mockResolvedValueOnce([]);
    await clickSignIn();
    expect(phase()).toBe("active");
    // The server already renewed this bearer elsewhere (or it has no more than
    // G left at its claim): it answers 409, and the token is a grace row.
    renewFrameCredential.mockImplementationOnce(async (_s, current) => {
      server.spend(current);
      return { ok: false, reason: "renew_not_renewable" };
    });
    await wait(RENEW_AT_MS);
    expect(renewFrameCredential).toHaveBeenCalledTimes(1);
    const r409 = Date.now();
    expect(phase(), "no sign-in card at the refusal").toBe("active");
    await wait(20_000);
    const decision = decisionHeaders();
    expect(decision, "the review card builds its decision with the held pair").toEqual(headersOf(first));
    expect(server.accepts(decision!), "and the server accepts it").toBe(true);
    await wait(r409 + 31_000 - Date.now() - 1);
    expect(phase(), "still signed in before R409 + 31 s").toBe("active");
    await wait(1);
    expect(phase(), "the sign-in card at R409 + 31 s").toBe("signin");
    expect(container.querySelector("[data-embed-signin]")).not.toBeNull();
    expect(requestHeaders()).toEqual({});
    expect(renewFrameCredential, "no retry inside the grace").toHaveBeenCalledTimes(1);
  });

  it("C30: gated inside the lease: release, then dispose; no request after advancing 900 s", async () => {
    await render();
    await deliverContext("t-1");
    runFrameSignIn.mockResolvedValueOnce({ ok: true, credential: pair(1), mintedAt: Date.now(), receivedAt: Date.now() });
    const slow = deferred<{ ok: boolean; reason?: string }>();
    negotiate.mockReturnValueOnce(slow.promise);
    renewFrameCredential.mockResolvedValue({ ok: true, credential: pair(2) });
    await clickSignIn();
    await wait(100_000); // armed at the mint for 210 s; nothing is due yet
    await act(async () => {
      slow.resolve({ ok: false, reason: "auth_mode_unsupported" });
      await drain();
    });
    expect(phase()).toBe("gated");
    expect(requestHeaders(), "the pair is dropped").toEqual({});
    await wait(900_000);
    expect(renewFrameCredential, "the chain armed at the mint was disposed").not.toHaveBeenCalled();
  });

  it("C30: gated after a deferred renewal: the release decides at once (spec 4), the dispose fences its answer; nothing after", async () => {
    await render();
    await deliverContext("t-1");
    runFrameSignIn.mockResolvedValueOnce({ ok: true, credential: pair(1), mintedAt: Date.now(), receivedAt: Date.now() });
    const slow = deferred<{ ok: boolean; reason?: string }>();
    negotiate.mockReturnValueOnce(slow.promise);
    const answer = deferred<{ ok: true; credential: Pair }>();
    renewFrameCredential.mockReturnValueOnce(answer.promise);
    renewFrameCredential.mockResolvedValue({ ok: true, credential: pair(3) });
    await clickSignIn();
    await wait(250_000); // the renewal fell due at 210 s and waits for the release
    expect(renewFrameCredential).not.toHaveBeenCalled();
    await act(async () => {
      slow.resolve({ ok: false, reason: "auth_mode_unsupported" });
      await drain();
    });
    expect(phase()).toBe("gated");
    const atRelease = renewFrameCredential.mock.calls.length;
    expect(atRelease, "at most the one request the release decided").toBeLessThanOrEqual(1);
    await act(async () => {
      answer.resolve({ ok: true, credential: pair(2) });
      await drain();
    });
    expect(requestHeaders(), "the fenced answer is not taken up").toEqual({});
    await wait(900_000);
    expect(renewFrameCredential.mock.calls.length, "no request after the dispose").toBe(atRelease);
    expect(phase()).toBe("gated");
  });

  it("C31: an END during the lease moves the ticket; the negotiation's answer changes nothing", async () => {
    await render();
    await deliverContext("t-1");
    // U = E = 300: renewability ends at 265 s; the pair is held to E_hi = 301 s.
    runFrameSignIn.mockResolvedValueOnce({ ok: true, credential: pair(1), mintedAt: Date.now(), receivedAt: Date.now() });
    const slow = deferred<{ ok: boolean }>();
    negotiate.mockReturnValueOnce(slow.promise);
    fetchThreadMessages.mockResolvedValue([]);
    await clickSignIn();
    expect(phase()).toBe("authorizing");
    await wait(300_000);
    expect(phase(), "held to E_hi").toBe("authorizing");
    await wait(1_000);
    expect(phase(), "END at E_hi under the lease").toBe("signin");
    await act(async () => {
      slow.resolve({ ok: true });
      await drain();
    });
    expect(phase(), "the stale negotiation does not bring the frame to active").toBe("signin");
    expect(fetchThreadMessages, "nor start a restore").not.toHaveBeenCalled();
    expect(renewFrameCredential).not.toHaveBeenCalled();
  });

  it("C32: a negotiation that settles ok after a deferred renewal: one request at the release; the next request carries the renewed pair", async () => {
    await render();
    await deliverContext("t-1");
    const signIn = { ...pair(1), userExpiresIn: 900 };
    runFrameSignIn.mockResolvedValueOnce({ ok: true, credential: signIn, mintedAt: Date.now(), receivedAt: Date.now() });
    const slow = deferred<{ ok: boolean }>();
    negotiate.mockReturnValueOnce(slow.promise);
    fetchThreadMessages.mockResolvedValue([]);
    renewFrameCredential.mockResolvedValueOnce({ ok: true, credential: pair(2) });
    renewFrameCredential.mockImplementation(() => new Promise(() => undefined));
    await clickSignIn();
    await wait(240_000);
    expect(renewFrameCredential).not.toHaveBeenCalled();
    await act(async () => {
      slow.resolve({ ok: true });
      await drain();
    });
    expect(renewFrameCredential).toHaveBeenCalledTimes(1);
    expect(requestHeaders()).toEqual(headersOf(pair(2)));
  });

  it("C44: a slow negotiation is never refused because of a renewal", async () => {
    await render();
    await deliverContext("t-1");
    const server = tokenServer();
    const first = server.issue(900, { userExpiresIn: 900 });
    first.expiresIn = 300;
    runFrameSignIn.mockResolvedValueOnce({ ok: true, credential: first, mintedAt: Date.now(), receivedAt: Date.now() });
    renewFrameCredential.mockImplementation(async (_s, current) => {
      server.spend(current);
      return { ok: true, credential: server.issue(900, { userExpiresIn: 900 }) };
    });
    // The negotiation is sent at +1 s with the original bearer, and the server
    // authenticates it at +245 s.
    await wait(1_000);
    let carried: Record<string, string> = {};
    negotiate.mockImplementationOnce(() => {
      carried = requestHeaders();
      return new Promise((resolve) => {
        setTimeout(() => resolve({ ok: server.accepts(carried) }), 244_000);
      });
    });
    fetchThreadMessages.mockResolvedValue([]);
    await clickSignIn();
    await wait(244_000);
    expect(phase(), "the negotiation is accepted").toBe("active");
    expect(renewFrameCredential, "the renewal follows at the release").toHaveBeenCalledTimes(1);
  });

  it("C33: a new context while a renewal is deferred under the lease drops it; nothing renews later", async () => {
    await render("inst-1", "wordpress");
    await deliverContext("t-1");
    runFrameSignIn.mockResolvedValueOnce({ ok: true, credential: pair(1), mintedAt: Date.now(), receivedAt: Date.now() });
    const slow = deferred<{ ok: boolean }>();
    negotiate.mockReturnValueOnce(slow.promise);
    renewFrameCredential.mockResolvedValue({ ok: true, credential: pair(2) });
    await clickSignIn();
    await wait(220_000);
    await render("inst-1", "drupal");
    await deliverContext("t-2");
    expect(phase()).toBe("signin");
    await act(async () => {
      slow.resolve({ ok: true });
      await drain();
    });
    await wait(900_000);
    expect(renewFrameCredential).not.toHaveBeenCalled();
    expect(phase()).toBe("signin");
  });

  it("(xvi) C35: a review decision sent after three pair lifetimes, with a 60 s answer and a 429 on the way, is accepted with the renewed pair", async () => {
    await render();
    await deliverContext("t-1");
    const server = tokenServer();
    const first = server.issue(900, { userExpiresIn: 900 });
    first.expiresIn = 300;
    runFrameSignIn.mockResolvedValueOnce({ ok: true, credential: first, mintedAt: Date.now(), receivedAt: Date.now() });
    negotiate.mockResolvedValueOnce({ ok: true });
    fetchThreadMessages.mockResolvedValueOnce([]);
    let call = 0;
    renewFrameCredential.mockImplementation(async (_s, current) => {
      call += 1;
      if (call === 2) return { ok: false, reason: "renew_rate_limited" };
      const slow = call === 1;
      if (slow) await new Promise((r) => setTimeout(r, 60_000));
      server.spend(current);
      return { ok: true, credential: server.issue(900, { userExpiresIn: 900 }) };
    });
    await clickSignIn();
    expect(phase()).toBe("active");
    await wait(3 * 300_000 + 1_000);
    expect(call, "renewals, one slow and one rate-limited, happened").toBeGreaterThanOrEqual(4);
    expect(phase()).toBe("active");
    const decision = decisionHeaders();
    expect(decision).toEqual(requestHeaders());
    expect(decision).not.toEqual(headersOf(first));
    expect(server.accepts(decision!), "the decision is accepted with the current pair").toBe(true);
  });
});

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
type BridgeOptions = { onContext: (context: unknown) => void; onReject?: (reason: string) => void };

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
type RenewEnv = { signal?: AbortSignal };
const renewFrameCredential = vi.fn<
  (
    selectors: unknown,
    current: Pair,
    env?: RenewEnv,
  ) => Promise<{ ok: true; credential: Pair } | { ok: false; reason: string }>
>();
vi.mock("@/lib/embed/frame-widget-session.client", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runFrameSignIn: (selectors: unknown) => runFrameSignIn(selectors),
  renewFrameCredential: (selectors: unknown, current: Pair, env?: RenewEnv) =>
    renewFrameCredential(selectors, current, env),
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
type ColumnProps = {
  host?: {
    lifecycleSurface?: {
      auth?: {
        headers?: () => Record<string, string>;
        renewal?: { pending: () => boolean; settled: () => Promise<void> };
      };
    };
  };
};
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
/** The drawn reading of the sign-in card shown now (cinatra#4357), or null. */
const signInReading = () =>
  frame().querySelector('[data-embed-state="signin"]')?.getAttribute("data-conformance-id") ?? null;
/** The sentence of the sign-in card shown now, or null. */
const signInSentence = () => frame().querySelector('[data-embed-state="signin"] p')?.textContent ?? null;
// The drawn sentence of the sign-in-again card, copied from the drawing
// (lifecycle cards, section XIV), not from the component.
const AGAIN = "Your sign-in has ended. Sign in again to use the assistant here.";
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
/** The env the frame passed to renewal call `i` (module scope). */
const renewEnvOf = (i: number): RenewEnv | undefined => renewFrameCredential.mock.calls[i]?.[2];
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

  // -------------------------------------------------------------------------
  // cinatra#4217 fold 1 (pre-1 review). RED AT a895dbef: a renewal that never
  // answered kept the frame active for ever; an obsolete renewal held the
  // next same-instance sign-in back; a restore that a renewal overtook
  // settled as an empty history; a rejected context left the chain running.
  // -------------------------------------------------------------------------

  /** The env the frame passed to renewal call `i`. */
  const renewEnv = (i: number): RenewEnv | undefined => renewFrameCredential.mock.calls[i]?.[2];

  // cinatra#4217 with cinatra#4357: the frame's end timer follows the pair the
  // frame holds, so a renewal that never answers ends the sign-in at that
  // pair's end (300 s), 1 s before the chain's own deadline for the request
  // (E_hi = 301 s, which frame-credential-renewal.client.test.ts proves on the
  // scheduler alone). The end drops the chain, so the request is given up there.
  it("(xvii) MF1: a renewal that never answers returns the frame to its sign-in-again card at the pair's end", async () => {
    await render();
    await signedIn(pair(1));
    renewFrameCredential.mockReturnValueOnce(new Promise(() => undefined));
    await wait(RENEW_AT_MS);
    expect(renewFrameCredential).toHaveBeenCalledTimes(1);
    await wait(300_000 - RENEW_AT_MS - 1);
    expect(phase(), "the held pair lives to its end at 300 s").toBe("active");
    await wait(1);
    expect(phase(), "the pair's end ends the sign-in").toBe("signin");
    expect(container.querySelector("[data-embed-signin]")).not.toBeNull();
    expect(signInReading(), "the sign-in-again card (cinatra#4357)").toBe("embed-signin-again");
    expect(requestHeaders(), "no pair is held").toEqual({});
    expect(renewEnv(0)?.signal?.aborted, "the request given up is aborted").toBe(true);
    await wait(30 * 60_000);
    expect(renewFrameCredential).toHaveBeenCalledTimes(1);
  });

  it("(xviii) MF3: a renewal in flight when a new context arrives for the same instance never holds the next sign-in back", async () => {
    await render("inst-1", "wordpress");
    await signedIn(pair(1), "t-1");
    renewFrameCredential.mockReturnValueOnce(new Promise(() => undefined)); // never answers
    await wait(RENEW_AT_MS);
    expect(renewFrameCredential).toHaveBeenCalledTimes(1);

    // Same instance, another assistant: onContext disposes the chain while its
    // renewal is still in flight; then the person signs in again.
    await render("inst-1", "drupal");
    await deliverContext("t-2");
    expect(phase()).toBe("signin");
    runFrameSignIn.mockResolvedValueOnce({ ok: true, credential: pair(3), mintedAt: Date.now(), receivedAt: Date.now() });
    negotiate.mockResolvedValueOnce({ ok: true });
    fetchThreadMessages.mockResolvedValueOnce([]);
    await clickSignIn();
    expect(negotiate, "the new sign-in negotiates at once").toHaveBeenCalledTimes(2);
    expect(phase()).toBe("active");
    expect(requestHeaders()).toEqual(headersOf(pair(3)));
    expect(renewEnv(0)?.signal?.aborted, "the obsolete request was aborted").toBe(true);
  });

  /** Sign in with a 300 s pair whose user token lives 900 s, under a
   *  negotiation that answers at +280 s; every transcript read records the
   *  pair it carries, and the first one answers through `firstRead`. Read n
   *  (1-based, n > 1) answers `later(n)` when given, else `transcript`. With a
   *  parity seam the reads are the seed's, not the restore's. */
  async function restoreAcrossRenewal(
    firstRead: Promise<unknown[] | null>,
    transcript: unknown[],
    options: { later?: (n: number) => Promise<unknown[] | null>; paritySeam?: { threadId: string } } = {},
  ) {
    await render("inst-1", "wordpress", options.paritySeam ?? null);
    await deliverContext("t-1");
    const signIn = { ...pair(1), userExpiresIn: 900 };
    runFrameSignIn.mockResolvedValueOnce({ ok: true, credential: signIn, mintedAt: Date.now(), receivedAt: Date.now() });
    const slow = deferred<{ ok: boolean }>();
    negotiate.mockReturnValueOnce(slow.promise);
    const reads: Array<Record<string, string>> = [];
    fetchThreadMessages.mockImplementation(() => {
      reads.push(requestHeaders());
      if (reads.length === 1) return firstRead;
      return options.later ? options.later(reads.length) : Promise.resolve(transcript);
    });
    await clickSignIn();
    await wait(280_000); // the renewal fell due at 210 s and waits for the lease
    expect(renewFrameCredential).not.toHaveBeenCalled();
    await act(async () => {
      slow.resolve({ ok: true });
      await drain();
    });
    expect(renewFrameCredential, "the renewal goes out at the release").toHaveBeenCalledTimes(1);
    expect(reads, "the restore left with the first pair").toEqual([headersOf(signIn)]);
    expect(shown(), "waiting for its restore").toBe("waiting");
    return { signIn, reads };
  }

  it("(xix) MF4: a restore refused after a renewal replaced its pair is read again with the renewed pair", async () => {
    const firstRead = deferred<unknown[] | null>();
    const transcript = [{ id: "m-1", role: "user", content: "the pending review" }];
    renewFrameCredential.mockResolvedValueOnce({ ok: true, credential: pair(2) });
    const { signIn, reads } = await restoreAcrossRenewal(firstRead.promise, transcript);
    // The first read reaches the server at 301 s, after the first pair's
    // transport token ran out: refused, which the reader answers as null.
    await wait(21_000);
    await act(async () => {
      firstRead.resolve(null);
      await drain();
    });
    expect(reads, "read again with the renewed pair").toEqual([headersOf(signIn), headersOf(pair(2))]);
    expect(shown(), "the restore settled the history").toBe("active");
    expect(columnSeeds[0], "seeded with the restored transcript").toEqual(transcript);
  });

  it("(xix) MF4: a refusal that answers while the renewal is still in flight waits for it, then reads with the renewed pair", async () => {
    const firstRead = deferred<unknown[] | null>();
    const transcript = [{ id: "m-2", role: "user", content: "the earlier turn" }];
    const renewing = deferred<{ ok: true; credential: Pair }>();
    renewFrameCredential.mockReturnValueOnce(renewing.promise);
    const { signIn, reads } = await restoreAcrossRenewal(firstRead.promise, transcript);
    await act(async () => {
      firstRead.resolve(null);
      await drain();
    });
    expect(reads, "no second read before the renewal answered").toEqual([headersOf(signIn)]);
    expect(shown(), "and no settle").toBe("waiting");
    await act(async () => {
      renewing.resolve({ ok: true, credential: pair(2) });
      await drain();
    });
    expect(reads).toEqual([headersOf(signIn), headersOf(pair(2))]);
    expect(shown()).toBe("active");
    expect(columnSeeds[0]).toEqual(transcript);
  });

  it("(xix) MF4: a new context while the restore waits for a renewal ends that restore: no second read, no settle", async () => {
    const firstRead = deferred<unknown[] | null>();
    const renewing = deferred<{ ok: true; credential: Pair }>();
    renewFrameCredential.mockReturnValueOnce(renewing.promise);
    const { reads } = await restoreAcrossRenewal(firstRead.promise, [{ id: "m-3", role: "user", content: "x" }]);
    await act(async () => {
      firstRead.resolve(null);
      await drain();
    });
    // The page sends a new context: the chain is disposed (its request
    // aborted), the ticket moves on, and the waiting restore lets go.
    await deliverContext("t-2");
    expect(phase()).toBe("signin");
    await act(async () => {
      renewing.resolve({ ok: true, credential: pair(2) });
      await drain();
    });
    expect(reads, "no second read for the old sign-in").toHaveLength(1);
    expect(columnSeeds, "no column mounts").toEqual([]);
    expect(requestHeaders(), "and no pair is held").toEqual({});
  });

  it("(xix) MF4 cap: a restore that two renewals overtake is read at most three times, then settles empty", async () => {
    const firstRead = deferred<unknown[] | null>();
    const secondRead = deferred<unknown[] | null>();
    // Each successor's user token lives 900 s, as the server's do. A successor
    // whose user token ends no later than the one it replaced (pair(n) alone:
    // 300 s, so 280 + 300 < 900) would count as the cap with no
    // sessionExpiresIn (spec v3, C26), and the chain would renew no more.
    const renewed = (n: number) => ({ ...pair(n), userExpiresIn: 900 });
    renewFrameCredential
      .mockResolvedValueOnce({ ok: true, credential: renewed(2) }) // at the release, 280 s
      .mockResolvedValueOnce({ ok: true, credential: renewed(3) }) // A' 280 + 210 = 490 s
      .mockResolvedValueOnce({ ok: true, credential: renewed(4) }); // 490 + 210 = 700 s
    const { signIn, reads } = await restoreAcrossRenewal(firstRead.promise, [], {
      later: (n) => (n === 2 ? secondRead.promise : Promise.resolve(null)),
    });
    await act(async () => {
      firstRead.resolve(null);
      await drain();
    });
    expect(reads, "read 2 leaves with the renewed pair").toEqual([headersOf(signIn), headersOf(pair(2))]);
    await wait(210_000); // 490 s: the next renewal replaces pair 2 while read 2 is on its way
    expect(renewFrameCredential).toHaveBeenCalledTimes(2);
    await act(async () => {
      secondRead.resolve(null);
      await drain();
    });
    expect(reads, "read 3, the last, with pair 3").toEqual([
      headersOf(signIn),
      headersOf(pair(2)),
      headersOf(pair(3)),
    ]);
    expect(shown(), "after the third null the restore settles empty").toBe("active");
    expect(columnSeeds[0]).toBeUndefined();
    await wait(220_000); // 710 s: a third renewal (pair 4) starts no fourth read
    expect(renewFrameCredential).toHaveBeenCalledTimes(3);
    expect(requestHeaders()).toEqual(headersOf(pair(4)));
    expect(reads, "THREAD_READ_ATTEMPTS = 3").toHaveLength(3);
  });

  it("(xix) MF4 parity seed: a seed read refused after a renewal replaced its pair is read again and seeds the column", async () => {
    const firstRead = deferred<unknown[] | null>();
    renewFrameCredential.mockResolvedValueOnce({ ok: true, credential: pair(2) });
    const { signIn, reads } = await restoreAcrossRenewal(
      firstRead.promise,
      [{ id: "a-1", role: "assistant", content: "the seeded answer" }],
      { paritySeam: { threadId: "seed-1" } },
    );
    await act(async () => {
      firstRead.resolve(null);
      await drain();
    });
    expect(reads, "the seed is read again with the renewed pair").toEqual([headersOf(signIn), headersOf(pair(2))]);
    expect(fetchThreadMessages.mock.calls.map((c) => c[0]), "both reads are the seed's").toEqual(["seed-1", "seed-1"]);
    expect(shown(), "the seed settled the history").toBe("active");
    expect(columnSeeds[0]).toEqual([{ id: "parity-seed", role: "assistant", content: "the seeded answer" }]);
  });

  it("(xix) MF4 control: a restore answered null with no renewal in between settles empty after one read", async () => {
    await render();
    await deliverContext("t-1");
    runFrameSignIn.mockResolvedValueOnce({ ok: true, credential: pair(1), mintedAt: Date.now(), receivedAt: Date.now() });
    negotiate.mockResolvedValueOnce({ ok: true });
    fetchThreadMessages.mockResolvedValueOnce(null);
    await clickSignIn();
    expect(shown()).toBe("active");
    expect(columnSeeds[0]).toBeUndefined();
    expect(fetchThreadMessages).toHaveBeenCalledTimes(1);
  });

  // cinatra#4217 fold 2 (pre-2 MUST-FIX 1 and 2): the conversation's readers
  // learn from the declaration they ask with whether a renewal is on its way,
  // and can wait until its answer is installed. RED AT 2c98c0e4: the column's
  // declaration carried no renewal seam, so a refusal that came back before
  // the renewed pair was installed looked final to every reader.
  it("(xxi) fold 2: the column's declaration says a renewal is on its way and settles only after the renewed pair is installed", async () => {
    await render();
    await signedIn(pair(1));
    const seam = () => columnProps[columnProps.length - 1]?.host?.lifecycleSurface?.auth?.renewal;
    expect(seam(), "the column's declaration carries the renewal seam").toBeDefined();
    expect(seam()!.pending(), "nothing on its way before the schedule").toBe(false);
    const renewing = deferred<{ ok: true; credential: Pair }>();
    renewFrameCredential.mockReturnValueOnce(renewing.promise);
    await wait(RENEW_AT_MS);
    expect(renewFrameCredential).toHaveBeenCalledTimes(1);
    expect(seam()!.pending(), "pending while the renewal answer is on its way").toBe(true);
    let settled = false;
    void seam()!.settled().then(() => {
      settled = true;
    });
    await act(async () => {
      await drain();
    });
    expect(settled, "not settled before the answer").toBe(false);
    expect(decisionHeaders(), "the first pair is still the one held").toEqual(headersOf(pair(1)));
    await act(async () => {
      renewing.resolve({ ok: true, credential: pair(2) });
      await drain();
    });
    expect(settled).toBe(true);
    expect(seam()!.pending()).toBe(false);
    expect(decisionHeaders(), "the renewed pair was installed when it settled").toEqual(headersOf(pair(2)));
  });

  it("(xx) NOTE 8: a rejected replacement context drops the pair and stops the chain behind the error card", async () => {
    await render("inst-1", "wordpress");
    await signedIn(pair(1));
    renewFrameCredential.mockResolvedValue({ ok: true, credential: pair(2) });
    // Same instance, another assistant: the bridge re-installs, and the
    // replacement context it receives is malformed.
    await render("inst-1", "drupal");
    await act(async () => {
      bridges[bridges.length - 1]!.onReject?.("schema");
      await drain();
    });
    expect(phase()).toBe("error");
    expect(requestHeaders(), "no pair behind the error card").toEqual({});
    await wait(10 * 60_000);
    expect(renewFrameCredential, "no chain renews behind the error card").not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// cinatra#4217 with cinatra#4357 — THE RENEWAL AND THE SIGN-IN-AGAIN CARD
// TOGETHER. #4357 ends a sign-in with an end timer at its pair's end and shows
// the drawn sign-in-again card; this change keeps the pair alive by renewing
// it. Together: a renewal keeps the sign-in's ticket and arms the end timer
// again for the renewed pair, and every end of the chain shows the
// sign-in-again card. RED AT a merge of the two that does not re-arm the end
// (the first pair's end shows the card on a renewed session), that ends the
// chain on the first card's reading, or that leaves the end timer armed behind
// the error card.
// ---------------------------------------------------------------------------
describe("EmbedAssistantClient — the renewal and the sign-in-again card together (cinatra#4217, cinatra#4357)", () => {
  it("a renewed session is not ended at the first pair's end; its end follows the renewed pair", async () => {
    await render();
    await signedIn(pair(1));
    // The first renewal (210 s) answers at once with pair 2, whose life is
    // counted from that answer; the next one (420 s) never answers.
    renewFrameCredential.mockResolvedValueOnce({ ok: true, credential: pair(2) });
    renewFrameCredential.mockReturnValueOnce(new Promise(() => undefined));
    await wait(RENEW_AT_MS);
    expect(renewFrameCredential).toHaveBeenCalledTimes(1);
    expect(requestHeaders()).toEqual(headersOf(pair(2)));
    await wait(300_000 - RENEW_AT_MS + 1_000);
    expect(phase(), "past the first pair's end (300 s) the renewed session is still signed in").toBe("active");
    expect(signInReading(), "no sign-in card at the first pair's end").toBeNull();
    // Pair 2 ends at 210 + 300 = 510 s.
    await wait(510_000 - 301_000 - 1);
    expect(renewFrameCredential, "the second renewal is on its way").toHaveBeenCalledTimes(2);
    expect(phase(), "not before the renewed pair's end").toBe("active");
    await wait(1);
    expect(phase(), "the renewed pair's end ends the sign-in").toBe("signin");
    expect(signInReading()).toBe("embed-signin-again");
    expect(signInSentence()).toBe(AGAIN);
    expect(requestHeaders(), "no pair is held").toEqual({});
    expect(renewEnvOf(1)?.signal?.aborted, "the renewal on its way is given up").toBe(true);
    await wait(30 * 60_000);
    expect(renewFrameCredential, "nothing renews behind the card").toHaveBeenCalledTimes(2);
    expect(signInReading()).toBe("embed-signin-again");
  });

  const refusals: Array<[string, { ok: false; reason: string } | null]> = [
    ["renew_failed", { ok: false, reason: "renew_failed" }],
    ["a renewal that throws", null],
  ];
  it.each(refusals)("a renewal refused (%s) ends the sign-in on the drawn sign-in-again card", async (_label, answer) => {
    await render();
    await signedIn(pair(1));
    if (answer) renewFrameCredential.mockResolvedValueOnce(answer);
    else renewFrameCredential.mockRejectedValueOnce(new Error("network"));
    await wait(RENEW_AT_MS);
    expect(renewFrameCredential).toHaveBeenCalledTimes(1);
    expect(phase()).toBe("signin");
    expect(signInReading()).toBe("embed-signin-again");
    expect(signInSentence()).toBe(AGAIN);
    expect(requestHeaders()).toEqual({});
    expect(vi.getTimerCount(), "no end timer and no chain timer left behind the card").toBe(0);
  });

  it("the chain's end under the negotiation's lease shows the sign-in-again card", async () => {
    await render();
    await deliverContext("t-1");
    // U = E = 300: the pair is held to E_hi = 301 s while the negotiation is
    // on its way, and the chain ends there (C31).
    runFrameSignIn.mockResolvedValueOnce({ ok: true, credential: pair(1), mintedAt: Date.now(), receivedAt: Date.now() });
    negotiate.mockReturnValueOnce(new Promise(() => undefined));
    await clickSignIn();
    await wait(301_000);
    expect(phase()).toBe("signin");
    expect(signInReading()).toBe("embed-signin-again");
    expect(signInSentence()).toBe(AGAIN);
  });

  it("a renewal before the frame is active moves the end that the negotiation's answer reads", async () => {
    await render();
    await deliverContext("t-1");
    // No finite clock reading from before the sign-in's request: the chain
    // renews once at once (C04), before the negotiation is sent. That renewal
    // answers at 100 s with pair 2, which ends at 100 + 300 = 400 s.
    runFrameSignIn.mockResolvedValueOnce({ ok: true, credential: pair(1), mintedAt: Number.NaN, receivedAt: Date.now() });
    renewFrameCredential.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ ok: true, credential: pair(2) }), 100_000);
        }),
    );
    const slow = deferred<{ ok: boolean }>();
    negotiate.mockReturnValueOnce(slow.promise);
    fetchThreadMessages.mockResolvedValue([]);
    await clickSignIn();
    expect(renewFrameCredential, "the one renewal at once").toHaveBeenCalledTimes(1);
    await wait(100_000);
    expect(negotiate, "the negotiation is sent once the renewal answered").toHaveBeenCalledTimes(1);
    // The negotiation answers at 350 s: past the first pair's end (300 s),
    // before the renewed pair's end (400 s).
    await wait(250_000);
    await act(async () => {
      slow.resolve({ ok: true });
      await drain();
    });
    expect(phase(), "the renewed pair's end is the one read").toBe("active");
    expect(requestHeaders()).toEqual(headersOf(pair(2)));
    await wait(50_000 - 1);
    expect(phase()).toBe("active");
    await wait(1);
    expect(signInReading(), "the end timer ends the sign-in at the renewed pair's end").toBe("embed-signin-again");
  });

  it("a rejected context leaves no end timer behind the error card, and the error card stays past the pair's end", async () => {
    await render("inst-1", "wordpress");
    await signedIn(pair(1));
    renewFrameCredential.mockResolvedValue({ ok: true, credential: pair(2) });
    await render("inst-1", "drupal");
    await act(async () => {
      bridges[bridges.length - 1]!.onReject?.("schema");
      await drain();
    });
    expect(phase()).toBe("error");
    expect(vi.getTimerCount(), "neither the end timer nor a chain timer is armed").toBe(0);
    await wait(10 * 60_000);
    expect(phase(), "the error card is never turned into a sign-in card").toBe("error");
  });
});

// ---------------------------------------------------------------------------
// cinatra#4217: A RENEWAL SENT LATE, AND THE SPENT CHECK.
//
// The end timer ends the sign-in at the end of the pair the frame holds (the
// answer's reading plus its life). A renewal sent on schedule (210 s for a
// 300 s pair) that never answers is given up there, 1 s before the chain's own
// deadline for it (test (xvii)). A renewal sent LATE, here at the release of
// the negotiation's lease, has its own wait of 90 s from its start, which runs
// past the pair's end: the end timer still gives it up at the pair's end.
//
// The spent check: a negotiation that answers after the held pair's end ends
// the sign-in with the sign-in-again card when it answers. Under the lease the
// chain defers the due renewal of a pair whose user token lives longer than
// the pair (900 s here) until that token stops being renewable (865 s), and
// does not end the sign-in at the pair's end: for such a pair the spent check
// is what ends a negotiation that answers between the pair's end (300 s) and
// that moment.
// RED AT a frame that turns active with the dead pair at that answer.
// ---------------------------------------------------------------------------
describe("EmbedAssistantClient — a renewal sent late and the spent check (cinatra#4217)", () => {
  it("a renewal sent late, at the release of the negotiation's lease, is given up at the held pair's end, before its own wait ends", async () => {
    await render();
    await deliverContext("t-1");
    runFrameSignIn.mockResolvedValueOnce({ ok: true, credential: pair(1), mintedAt: Date.now(), receivedAt: Date.now() });
    const slow = deferred<{ ok: boolean }>();
    negotiate.mockReturnValueOnce(slow.promise);
    fetchThreadMessages.mockResolvedValue([]);
    renewFrameCredential.mockReturnValueOnce(new Promise(() => undefined)); // never answers
    await clickSignIn();
    // The renewal is due at 210 s; the negotiation is on its way until 250 s.
    await wait(250_000);
    expect(renewFrameCredential, "the due renewal waits for the negotiation").not.toHaveBeenCalled();
    await act(async () => {
      slow.resolve({ ok: true });
      await drain();
    });
    expect(phase()).toBe("active");
    expect(renewFrameCredential, "the renewal goes at the lease's release, 250 s").toHaveBeenCalledTimes(1);
    expect(renewEnvOf(0)?.signal?.aborted).toBe(false);
    // Its own wait runs to 250 + 90 = 340 s; the held pair ends at 300 s.
    await wait(50_000 - 1);
    expect(phase(), "the held pair lives to its end at 300 s").toBe("active");
    await wait(1);
    expect(phase(), "the pair's end ends the sign-in, 40 s before the renewal's own wait ends").toBe("signin");
    expect(signInReading()).toBe("embed-signin-again");
    expect(requestHeaders(), "no pair is held").toEqual({});
    expect(renewEnvOf(0)?.signal?.aborted, "the late renewal is given up at the pair's end").toBe(true);
    await wait(10 * 60_000);
    expect(renewFrameCredential, "nothing renews behind the card").toHaveBeenCalledTimes(1);
    expect(signInReading()).toBe("embed-signin-again");
  });

  it("a negotiation that answers after the held pair's end ends a sign-in whose user token is still renewable when it answers, and nothing is renewed at the release (the spent check)", async () => {
    await render();
    await deliverContext("t-1");
    runFrameSignIn.mockResolvedValueOnce({ ok: true, credential: { ...pair(1), userExpiresIn: 900 }, mintedAt: Date.now(), receivedAt: Date.now() });
    const slow = deferred<{ ok: boolean }>();
    negotiate.mockReturnValueOnce(slow.promise);
    fetchThreadMessages.mockResolvedValue([]);
    renewFrameCredential.mockResolvedValue({ ok: true, credential: pair(2) });
    await clickSignIn();
    // The held pair ends at 300 s. Under the lease the chain defers the due
    // renewal until the user token stops being renewable (865 s), and ends
    // nothing before then.
    await wait(400_000);
    expect(phase(), "the chain has not ended the sign-in at 400 s").toBe("authorizing");
    expect(renewFrameCredential, "the due renewal waited for the negotiation").not.toHaveBeenCalled();
    await act(async () => {
      slow.resolve({ ok: true });
      await drain();
    });
    // No timer step here: the negotiation's answer itself ends the sign-in.
    expect(phase()).toBe("signin");
    expect(signInReading(), "the sign-in-again card (cinatra#4357)").toBe("embed-signin-again");
    expect(signInSentence()).toBe(AGAIN);
    expect(columnSeeds, "no conversation mounted with the dead pair").toEqual([]);
    expect(fetchThreadMessages, "no transcript read with the dead pair").not.toHaveBeenCalled();
    expect(requestHeaders(), "the dead pair is dropped").toEqual({});
    expect(renewFrameCredential, "the dead pair is not renewed at the lease's release").not.toHaveBeenCalled();
    expect(vi.getTimerCount(), "no end timer and no chain timer left behind the card").toBe(0);
    await wait(10 * 60_000);
    expect(renewFrameCredential, "nothing renews behind the card").not.toHaveBeenCalled();
  });
});

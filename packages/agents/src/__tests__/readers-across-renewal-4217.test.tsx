// @vitest-environment jsdom
/**
 * THE READERS OF THE LIFECYCLE CARD RUNTIME ACROSS THE HOST'S RENEWAL
 * (cinatra#4217 fold 3, pre-3 MUST-FIX 1-4).
 *
 * The site widget's frame renews its credential pair while it stays open. The
 * server commits the renewed pair (and spends the held one after its grace
 * window) BEFORE the renewal's answer reaches the frame, so for that gap every
 * request the frame sends with the pair it still holds is refused. The frame's
 * declaration tells the readers about it: `renewal.pending()` and
 * `renewal.settled()`, bounded by the renewal request's own deadline.
 *
 * What this file pins, under fake timers and with every answer driven by the
 * test (no real sleeps):
 *
 *   · `sendAcrossRenewal`, `lookCaughtInRenewal` and `lifecycleCredentialKey`,
 *     branch by branch; the key reads the credential pair only.
 *   · The card resolve (pre-3 MF2): a resolve refused before the renewed pair
 *     is installed resolves with it, instead of staying unresolved; of two
 *     resolves waiting for one renewal, only the newest sends again.
 *   · The run-moment watch (pre-3 MF1, MF4): a renewal that outlasts 180 s, and
 *     looks that time out while it is on its way, do not end the watch; a host
 *     whose `pending()` stays true while its `settled()` resolves at once still
 *     ends it; a `settled()` that has not resolved holds the next look (no
 *     limit is reached meanwhile); a watch that was never answered reports
 *     `gaveUp` when it stops.
 *   · The review slot (pre-3 MF3): a refusal in the gap does not spend the
 *     completed reader's last look, in either order; schedules rebuilt while
 *     it waits ask the renewal reading once.
 *   · The ticket probe: a refusal in the gap keeps the authorized ticket; a
 *     refusal after the chain ended while the probe was out withdraws it.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/readers-across-renewal-4217.test.tsx
 */
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, renderHook } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

import * as runtime from "../lifecycle-card-runtime";
import {
  LifecycleCardSurfaceProvider,
  lifecycleCredentialKey,
  lookCaughtInRenewal,
  sendAcrossRenewal,
  useLifecycleCardResolve,
  useRunMomentCard,
  useRunReviewSlot,
  type LifecycleCardAuth,
  type RunMomentCard,
  type RunMomentCardReader,
  type RunReviewSlot,
  type RunReviewSlotReader,
} from "../lifecycle-card-runtime";
import { ReviewGateCard } from "../review-gate-card";

// ---------------------------------------------------------------------------
// The frame: a broker declaration whose pair the test renews, and whose
// renewal answer the test holds back.
// ---------------------------------------------------------------------------

type Frame = ReturnType<typeof frame>;

/**
 * `alwaysPending`: `pending()` reads true from the start and never turns false,
 * while `settled()` resolves at once whenever no `begin()` is outstanding. It
 * models a host whose two readings disagree; it is NOT a `settled()` that never
 * resolves (that is `begin()` with no `answer()`).
 */
function frame(options: { alwaysPending?: boolean } = {}) {
  const state = { n: 1, dropped: false, pending: options.alwaysPending === true };
  let gate: { promise: Promise<void>; resolve: () => void } | null = null;
  const settled = vi.fn((): Promise<void> => (gate ? gate.promise : Promise.resolve()));
  const auth: LifecycleCardAuth = {
    headers: (): Record<string, string> => {
      if (state.dropped) return {};
      return {
        Authorization: `Bearer cit_${state.n}`,
        "X-Cinatra-Widget-User-Token": `cwu_${state.n}`,
      };
    },
    credentials: "omit",
    renewal: { pending: () => state.pending, settled },
  };
  return {
    auth,
    settled,
    /** The user token the frame holds now ("" once the chain dropped it). */
    get token(): string {
      return state.dropped ? "" : `cwu_${state.n}`;
    },
    /** A renewal request leaves; its answer is held back. */
    begin() {
      state.pending = true;
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      gate = { promise, resolve };
    },
    /** The answer lands: the renewed pair is installed FIRST, then the request
     *  stops counting as in flight, as the frame's scheduler does. */
    answer(renewed = true) {
      if (renewed) state.n += 1;
      if (!options.alwaysPending) state.pending = false;
      const g = gate;
      gate = null;
      g?.resolve();
    },
    /** A renewal that was answered while a request was out (the other order). */
    renewNow() {
      state.n += 1;
    },
    /** The renewal ended the chain: the frame drops its pair. */
    drop() {
      state.dropped = true;
      if (!options.alwaysPending) state.pending = false;
      const g = gate;
      gate = null;
      g?.resolve();
    },
  };
}

const tokenOf = (headers: Record<string, string> | undefined): string => {
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (name.toLowerCase() === "x-cinatra-widget-user-token") return value;
  }
  return "";
};

function host(auth: LifecycleCardAuth | null) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return auth ? (
      <LifecycleCardSurfaceProvider host="site_widget" auth={auth}>
        {children}
      </LifecycleCardSurfaceProvider>
    ) : (
      <>{children}</>
    );
  };
}

async function pass(ms: number): Promise<void> {
  const SLICE = 500;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  for (let elapsed = 0; elapsed < ms; elapsed += SLICE) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(Math.min(SLICE, ms - elapsed));
    });
  }
}

/** Drain every promise that can move without the clock: each turn yields a
 *  real macrotask (fake-timers' async tick), so a chain of any length settles. */
async function flush(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const refused = () => new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

// ---------------------------------------------------------------------------
// sendAcrossRenewal and lookCaughtInRenewal
// ---------------------------------------------------------------------------

describe("sendAcrossRenewal (cinatra#4217 fold 3)", () => {
  function sender(f: Frame, answers: (token: string, index: number) => Response) {
    const sent: string[] = [];
    const send = () => {
      const token = tokenOf(f.auth.headers());
      sent.push(token);
      return Promise.resolve(answers(token, sent.length - 1));
    };
    return { sent, send };
  }

  it("passes any answer but 401/403 through after one send", async () => {
    const f = frame();
    for (const status of [200, 404, 500, 503]) {
      const { sent, send } = sender(f, () => new Response("", { status }));
      const response = await sendAcrossRenewal(f.auth, send);
      expect(response?.status).toBe(status);
      expect(sent).toEqual(["cwu_1"]);
    }
    expect(f.settled, "nothing waits for an answer that is not a refusal").not.toHaveBeenCalled();
  });

  it("a cookie host (no declaration) keeps its refusal after one send", async () => {
    let sends = 0;
    const response = await sendAcrossRenewal(null, () => {
      sends += 1;
      return Promise.resolve(refused());
    });
    expect(response?.status).toBe(401);
    expect(sends).toBe(1);
  });

  it("a broker host without a renewal keeps a refusal whose credential did not move", async () => {
    const auth: LifecycleCardAuth = {
      headers: () => ({ "X-Cinatra-Widget-User-Token": "cwu_still" }),
      credentials: "omit",
    };
    let sends = 0;
    const response = await sendAcrossRenewal(auth, () => {
      sends += 1;
      return Promise.resolve(new Response("", { status: 403 }));
    });
    expect(response?.status).toBe(403);
    expect(sends).toBe(1);
  });

  it("order 1: a refusal after the renewed pair was installed is sent once more with it", async () => {
    const f = frame();
    const { sent, send } = sender(f, (token, i) => {
      if (i === 0) f.renewNow();
      return token === "cwu_1" ? refused() : ok({});
    });
    const response = await sendAcrossRenewal(f.auth, send);
    expect(response?.status).toBe(200);
    expect(sent).toEqual(["cwu_1", "cwu_2"]);
  });

  it("order 2: a refusal BEFORE the renewed pair is installed waits for the renewal, then sends with it", async () => {
    const f = frame();
    f.begin();
    const { sent, send } = sender(f, (token) => (token === "cwu_1" ? refused() : ok({})));
    let done: Response | null | undefined;
    void sendAcrossRenewal(f.auth, send).then((r) => {
      done = r;
    });
    await flush();
    expect(f.settled).toHaveBeenCalled();
    expect(done, "not answered while the renewal is on its way").toBeUndefined();
    expect(sent, "no second send before the renewal answered").toEqual(["cwu_1"]);
    f.answer();
    await flush();
    expect(done?.status).toBe(200);
    expect(sent).toEqual(["cwu_1", "cwu_2"]);
  });

  it("a renewal that brings no new pair leaves the refusal as it came, after one send", async () => {
    const f = frame();
    f.begin();
    const { sent, send } = sender(f, () => refused());
    const result = sendAcrossRenewal(f.auth, send);
    await flush();
    f.answer(false);
    expect((await result)?.status).toBe(401);
    expect(sent).toEqual(["cwu_1"]);
  });

  it("at most two renewed sends: refusals that each cross a renewal stop after three sends", async () => {
    const f = frame();
    const { sent, send } = sender(f, () => {
      f.renewNow();
      return refused();
    });
    const response = await sendAcrossRenewal(f.auth, send);
    expect(response?.status).toBe(401);
    expect(sent).toEqual(["cwu_1", "cwu_2", "cwu_3"]);
  });

  it("a renewal that ENDS the chain sends nothing without a token", async () => {
    const f = frame();
    f.begin();
    const { sent, send } = sender(f, () => refused());
    const result = sendAcrossRenewal(f.auth, send);
    await flush();
    f.drop();
    expect((await result)?.status).toBe(401);
    expect(sent, "no tokenless request").toEqual(["cwu_1"]);
  });

  it("an abort while it waits returns the refusal at once and sends nothing more", async () => {
    const f = frame();
    f.begin();
    const controller = new AbortController();
    const { sent, send } = sender(f, (token) => (token === "cwu_1" ? refused() : ok({})));
    let done: Response | null | undefined;
    void sendAcrossRenewal(f.auth, send, controller.signal).then((r) => {
      done = r;
    });
    await flush();
    controller.abort();
    await flush();
    expect(done?.status).toBe(401);
    f.answer();
    await flush();
    expect(sent).toEqual(["cwu_1"]);
  });

  it("a send that declines (no token) sends nothing and answers null", async () => {
    const f = frame();
    expect(await sendAcrossRenewal(f.auth, () => null)).toBeNull();
  });

  it("a renewal reading that rejects counts as settled", async () => {
    const f = frame();
    const auth: LifecycleCardAuth = {
      ...f.auth,
      renewal: { pending: () => true, settled: () => Promise.reject(new Error("gone")) },
    };
    const { sent, send } = sender(f, (token, i) => {
      if (i === 0) f.renewNow();
      return token === "cwu_1" ? refused() : ok({});
    });
    const response = await sendAcrossRenewal(auth, send);
    expect(response?.status).toBe(200);
    expect(sent).toEqual(["cwu_1", "cwu_2"]);
  });
});

describe("lookCaughtInRenewal (cinatra#4217 fold 3)", () => {
  it("is true only on a declaring host whose renewal is on its way or whose credential moved", () => {
    const f = frame();
    const sentKey = lifecycleCredentialKey(f.auth);
    expect(lookCaughtInRenewal(null, ""), "a cookie host").toBe(false);
    expect(lookCaughtInRenewal(f.auth, sentKey), "nothing moved").toBe(false);
    f.begin();
    expect(lookCaughtInRenewal(f.auth, sentKey), "a renewal on its way").toBe(true);
    f.answer();
    expect(lookCaughtInRenewal(f.auth, sentKey), "the credential moved").toBe(true);
    expect(lookCaughtInRenewal(f.auth, lifecycleCredentialKey(f.auth)), "settled, unchanged").toBe(false);
  });

  // RED AT af66c965: the key serialized every header, so a selector change or
  // a change of a header name's case read as a moved credential.
  it("the key reads only the credential pair: selectors and header-name case do not move it", () => {
    const h = {
      transport: "cit_1",
      user: "cwu_1",
      assistant: "assistant-a",
      upper: false,
    };
    const auth: LifecycleCardAuth = {
      headers: (): Record<string, string> => ({
        [h.upper ? "AUTHORIZATION" : "Authorization"]: `Bearer ${h.transport}`,
        [h.upper ? "x-cinatra-widget-user-token" : "X-Cinatra-Widget-User-Token"]: h.user,
        "X-Cinatra-Widget-Assistant": h.assistant,
        "X-Cinatra-Widget-Origin": "https://site.example",
      }),
      credentials: "omit",
      renewal: { pending: () => false, settled: () => Promise.resolve() },
    };
    const sentKey = lifecycleCredentialKey(auth);
    h.assistant = "assistant-b";
    expect(lifecycleCredentialKey(auth), "a selector changed").toBe(sentKey);
    expect(lookCaughtInRenewal(auth, sentKey), "a selector change is not a renewal").toBe(false);
    h.upper = true;
    expect(lifecycleCredentialKey(auth), "the header names changed case").toBe(sentKey);
    h.transport = "cit_2";
    expect(lifecycleCredentialKey(auth), "the transport token moved").not.toBe(sentKey);
    h.transport = "cit_1";
    h.user = "cwu_2";
    expect(lifecycleCredentialKey(auth), "the user token moved").not.toBe(sentKey);
    expect(lookCaughtInRenewal(auth, sentKey)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The card resolve (pre-3 MUST-FIX 2)
// ---------------------------------------------------------------------------

const PENDING = { state: "pending", canDecide: true, canComment: true };
const gateEnvelope = () => ok({ kind: "artifact_review_gate", state: PENDING, body: null });

describe("useLifecycleCardResolve across the renewal (pre-3 MUST-FIX 2)", () => {
  function resolveServer(f: Frame, spent: Set<string>) {
    const tokens: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const token = tokenOf(init?.headers as Record<string, string>);
        tokens.push(token);
        return !token || spent.has(token) ? refused() : gateEnvelope();
      }),
    );
    return tokens;
  }
  const mount = (f: Frame) =>
    renderHook(
      () => useLifecycleCardResolve({ viewType: "artifact_review_gate", ref: "lcr-gate-1", enabled: true }),
      { wrapper: host(f.auth) },
    );

  // RED AT 749d92f2: the resolve returned on the refusal, and nothing but a
  // focus or a reload asked again, so the card stayed unresolved.
  it("a resolve refused before the renewed pair is installed resolves with the renewed pair", async () => {
    const f = frame();
    f.begin();
    const tokens = resolveServer(f, new Set(["cwu_1"]));
    const { result } = mount(f);
    await pass(1000);
    expect(result.current, "unresolved while the renewal is on its way").toBeNull();
    expect(tokens).toEqual(["cwu_1"]);
    f.answer();
    await pass(0);
    await flush();
    expect(result.current?.state?.state, "resolved with the renewed pair").toBe("pending");
    expect(tokens).toEqual(["cwu_1", "cwu_2"]);
  });

  it("control: a renewal that brings no new pair leaves the card unresolved after one resolve", async () => {
    const f = frame();
    f.begin();
    const tokens = resolveServer(f, new Set(["cwu_1"]));
    const { result } = mount(f);
    await pass(500);
    f.answer(false);
    await pass(500);
    expect(result.current).toBeNull();
    expect(tokens).toEqual(["cwu_1"]);
  });

  // RED AT af66c965: both resolves sent again after the renewal, and the older
  // one's answer was dropped only after its request had been made.
  it("of two resolves waiting for one renewal, only the newer sends again", async () => {
    const f = frame();
    f.begin();
    const tokens = resolveServer(f, new Set(["cwu_1"]));
    const { result } = mount(f);
    await pass(500);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await flush();
    expect(tokens, "the mount resolve and the focus resolve, both refused").toEqual(["cwu_1", "cwu_1"]);
    f.answer();
    await flush();
    expect(tokens, "one renewed send, by the newer resolve").toEqual(["cwu_1", "cwu_1", "cwu_2"]);
    expect(result.current?.state?.state, "resolved with the renewed pair").toBe("pending");
  });

  it("an unmount while the resolve waits for the renewal sends nothing more", async () => {
    const f = frame();
    f.begin();
    const tokens = resolveServer(f, new Set(["cwu_1"]));
    const { unmount } = mount(f);
    await pass(500);
    unmount();
    f.answer();
    await pass(500);
    expect(tokens).toEqual(["cwu_1"]);
  });
});

// ---------------------------------------------------------------------------
// The run-moment watch (pre-3 MUST-FIX 1 and 4)
// ---------------------------------------------------------------------------

const WORKING: RunMomentCard = { status: "running", moment: null, kind: null, ref: null };
const AT_SCHEDULE: RunMomentCard = {
  status: "pending_trigger",
  moment: "schedule",
  kind: "trigger_schedule_proposal",
  ref: "sched-ref-4217",
};

/**
 * The moment reader, answering as the chat's reader of the head under test
 * does: at 749d92f2 (fold 2) that reader answered the exported
 * RUN_MOMENT_CREDENTIAL_RENEWING for a 401/403 while the renewal was pending;
 * from fold 3 it answers no card and the watch reads the renewal itself. So
 * this file is red at 749d92f2 for the fold-2 window's own reason.
 */
const FOLD2_RENEWING = (runtime as unknown as Record<string, unknown>).RUN_MOMENT_CREDENTIAL_RENEWING;

function momentServer(f: Frame) {
  const server = {
    card: WORKING,
    spent: new Set<string>(),
    /** While set, every look hangs until its deadline aborts it. */
    hang: false,
    looks: [] as string[],
  };
  const read: RunMomentCardReader = async (signal) => {
    const token = f.token;
    server.looks.push(token);
    if (server.hang) {
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
          once: true,
        });
      });
    }
    if (!token || server.spent.has(token)) {
      if (FOLD2_RENEWING !== undefined && f.auth.renewal?.pending() === true) {
        return FOLD2_RENEWING as RunMomentCard;
      }
      return null;
    }
    return server.card;
  };
  return { server, read };
}

describe("useRunMomentCard across the renewal (pre-3 MUST-FIX 1 and 4)", () => {
  const watch = (f: Frame | null, read: RunMomentCardReader) =>
    renderHook(({ r }: { r: RunMomentCardReader }) => useRunMomentCard({ read: r }), {
      initialProps: { r: read },
      wrapper: host(f ? f.auth : null),
    });

  // RED AT 749d92f2 (pre-3 MF1): the fold-2 window forgave refusals for 180 s
  // only; this renewal stays on its way for 300 s, so ten misses ended the
  // watch first and the renewed pair reached a watch that no longer looked.
  it("a renewal on its way for longer than 180 s is waited out; nothing looks meanwhile, not even a focus", async () => {
    const f = frame();
    const { server, read } = momentServer(f);
    const { result } = watch(f, read);
    await pass(0);
    expect(server.looks).toEqual(["cwu_1"]);
    expect(result.current.answered).toBe(true);

    f.begin();
    server.spent.add("cwu_1");
    await pass(2500);
    expect(server.looks, "the look that met the gap").toEqual(["cwu_1", "cwu_1"]);
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
      });
    }
    await pass(300_000);
    expect(server.looks.length, "nothing looked while the renewal was on its way").toBe(2);

    server.card = AT_SCHEDULE;
    f.answer();
    await pass(2500);
    expect(server.looks.slice(2), "the next look carries the renewed pair").toEqual(["cwu_2"]);
    expect(result.current.card.ref, "the moment reached the open page").toBe("sched-ref-4217");
    expect(result.current.gaveUp).toBe(false);
  });

  // RED AT 749d92f2 (pre-3 MF1, its second half): a look aborted at its 8 s
  // deadline never answered RENEWING, so each one was a miss.
  it("looks that time out while a renewal is on its way are not misses", async () => {
    const f = frame();
    const { server, read } = momentServer(f);
    const { result } = watch(f, read);
    await pass(0);
    f.begin();
    server.hang = true;
    await pass(150_000);
    expect(server.looks.length, "one look timed out, then the watch waited").toBe(2);
    server.hang = false;
    server.card = AT_SCHEDULE;
    f.answer();
    await pass(2500);
    expect(server.looks.slice(2)).toEqual(["cwu_2"]);
    expect(result.current.card.ref).toBe("sched-ref-4217");
  });

  it("cadence: the look after a renewal that settles at once keeps the ordinary 2 s cadence", async () => {
    const f = frame();
    const { server, read } = momentServer(f);
    watch(f, read);
    await pass(0);
    f.begin();
    server.spent.add("cwu_1");
    await pass(2000);
    await flush();
    expect(server.looks.length).toBe(2);
    f.answer();
    await pass(1500);
    expect(server.looks.length, "no look before the cadence").toBe(2);
    await pass(1000);
    expect(server.looks.length).toBe(3);
    expect(server.looks[2]).toBe("cwu_2");
  });

  it("cadence: a gap at the very first look keeps the 2 s cadence after the renewal settles", async () => {
    const f = frame();
    f.begin();
    const { server, read } = momentServer(f);
    server.spent.add("cwu_1");
    watch(f, read);
    await pass(0);
    expect(server.looks, "the first look is immediate and meets the gap").toEqual(["cwu_1"]);
    f.answer();
    await pass(1500);
    expect(server.looks.length, "the look after the wait is not immediate").toBe(1);
    await pass(1000);
    expect(server.looks).toEqual(["cwu_1", "cwu_2"]);
  });

  // The belt covers a host whose pending() stays true while its settled()
  // resolves; it does not cover a settled() that never resolves (next test).
  it("belt: a host whose pending() stays true while settled() resolves at once still ends the watch (3 forgiven, then 10 misses)", async () => {
    const f = frame({ alwaysPending: true });
    const { server, read } = momentServer(f);
    const { result } = watch(f, read);
    // `alwaysPending`: pending() is true from the start and settled() resolves
    // at once. The first look lands (the server has not spent the pair yet).
    await pass(0);
    expect(result.current.answered).toBe(true);
    server.spent.add("cwu_1");
    await pass(400_000);
    const stopped = server.looks.length;
    expect(stopped, "the first look, 3 forgiven looks and 10 misses").toBe(14);
    await pass(60_000);
    expect(server.looks.length, "the watch ended").toBe(stopped);
  });

  // What the belt does NOT cover, pinned as it is: a settled() that has not
  // resolved holds the next look, so no limit is reached while it is
  // unresolved (here for one hour). The site widget's frame resolves it at the
  // latest at the renewal request's own deadline (the frame's own tests).
  it("a settled() that has not resolved holds the next look for as long as it is unresolved; no limit is reached", async () => {
    const f = frame();
    const { server, read } = momentServer(f);
    const { result } = watch(f, read);
    await pass(0);
    f.begin();
    server.spent.add("cwu_1");
    await pass(2500);
    expect(server.looks, "the look that met the gap").toEqual(["cwu_1", "cwu_1"]);
    await pass(3_600_000);
    expect(server.looks.length, "no look while settled() is unresolved").toBe(2);
    expect(result.current.gaveUp, "and no limit was reached").toBe(false);
    f.answer();
    await pass(2500);
    expect(server.looks.slice(2), "the look after it carries the renewed pair").toEqual(["cwu_2"]);
  });

  it("a refusal unrelated to the renewal still counts once the renewal settled with no new pair", async () => {
    const f = frame();
    const { server, read } = momentServer(f);
    watch(f, read);
    await pass(0);
    f.begin();
    server.spent.add("cwu_1"); // revoked: no renewal will bring a pair the server takes
    await pass(2500);
    expect(server.looks.length).toBe(2);
    f.answer(false);
    await pass(400_000);
    const stopped = server.looks.length;
    expect(stopped, "the first look, one forgiven look and 10 misses").toBe(12);
    await pass(60_000);
    expect(server.looks.length).toBe(stopped);
  });

  it("a new reader while the watch waits starts afresh; the old wait looks for nobody", async () => {
    const f = frame();
    const first = momentServer(f);
    const second = momentServer(f);
    const { rerender } = watch(f, first.read);
    await pass(0);
    f.begin();
    first.server.spent.add("cwu_1");
    second.server.spent.add("cwu_1");
    await pass(2500);
    expect(first.server.looks.length).toBe(2);
    rerender({ r: second.read });
    await pass(0);
    expect(second.server.looks, "the new reader's first look is immediate").toEqual(["cwu_1"]);
    f.answer();
    await pass(5000);
    expect(first.server.looks.length, "the old reader never looked again").toBe(2);
    expect(second.server.looks[1], "the new reader's next look carries the renewed pair").toBe("cwu_2");
  });

  // RED AT 749d92f2 (pre-3 MF4): the watch stopped at ten misses, but
  // `gaveUp` needed twenty unanswered reads, so a watch that was never
  // answered stopped with gaveUp false and its caller kept waiting for ever.
  it("a watch that was never answered reports gaveUp when its miss belt stops it", async () => {
    let looks = 0;
    const read: RunMomentCardReader = async () => {
      looks += 1;
      return null;
    };
    const { result } = watch(null, read);
    await pass(0);
    expect(result.current.gaveUp).toBe(false);
    await pass(200_000);
    expect(looks, "ten misses").toBe(10);
    expect(result.current.answered).toBe(false);
    expect(result.current.gaveUp, "the watch is over and never got an answer").toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The review slot (pre-3 MUST-FIX 3)
// ---------------------------------------------------------------------------

const AWAITING_NO_GATE: RunReviewSlot = { ref: null, awaiting: true, producedReviewPark: false };
const GATE: RunReviewSlot = { ref: "lcr-gate-4217", awaiting: true, producedReviewPark: false };

describe("useRunReviewSlot across the renewal (pre-3 MUST-FIX 3)", () => {
  /** The completed run's slot: the review question is owed, its gate row does
   *  not exist yet. At look 30 the gap opens (`atThirty`). */
  function slotServer(f: Frame, atThirty: (token: string) => void) {
    const server = { gateOpen: false, spent: new Set<string>(), looks: [] as string[] };
    const read: RunReviewSlotReader = async () => {
      const token = f.token;
      server.looks.push(token);
      if (server.looks.length === 30) atThirty(token);
      if (!token || server.spent.has(token)) return null;
      return server.gateOpen ? GATE : AWAITING_NO_GATE;
    };
    return { server, read };
  }
  const mountSlot = (f: Frame, read: RunReviewSlotReader, status = "completed") =>
    renderHook(() => useRunReviewSlot({ runId: "run-4217", status, read }), {
      wrapper: host(f.auth),
    });
  async function untilLooks(server: { looks: string[] }, n: number) {
    for (let i = 0; i < 120 && server.looks.length < n; i += 1) await pass(5000);
  }

  // RED AT 749d92f2: look 30 carried the spent pair and was refused before
  // the renewed pair was installed; it spent the completed reader's thirtieth
  // and last read, so the gate was never read with the renewed pair.
  it("order 2: a refusal at the last look before the renewed pair is installed spends no read", async () => {
    const f = frame();
    const { server, read } = slotServer(f, (token) => {
      f.begin();
      server.spent.add(token);
      server.gateOpen = true;
    });
    const { result } = mountSlot(f, read);
    await untilLooks(server, 30);
    await pass(60_000);
    expect(server.looks.length, "nothing looks while the renewal is on its way").toBe(30);
    f.answer();
    await pass(15_000);
    expect(server.looks[30], "the next look carries the renewed pair").toBe("cwu_2");
    expect(result.current.slot.ref).toBe("lcr-gate-4217");
  });

  // RED AT 749d92f2: the same, in the other order: the renewed pair was
  // installed while look 30 was out.
  it("order 1: a refusal at the last look after the renewed pair was installed spends no read", async () => {
    const f = frame();
    const { server, read } = slotServer(f, (token) => {
      server.spent.add(token);
      server.gateOpen = true;
      f.renewNow();
    });
    const { result } = mountSlot(f, read);
    await untilLooks(server, 30);
    await pass(15_000);
    expect(server.looks[30]).toBe("cwu_2");
    expect(result.current.slot.ref).toBe("lcr-gate-4217");
  });

  it("cadence: a gap at the very first look keeps the 2 s cadence after the renewal settles", async () => {
    const f = frame();
    f.begin();
    const looks: string[] = [];
    const read: RunReviewSlotReader = async () => {
      looks.push(f.token);
      return f.token === "cwu_1" ? null : AWAITING_NO_GATE;
    };
    mountSlot(f, read);
    await pass(0);
    expect(looks).toEqual(["cwu_1"]);
    f.answer();
    await pass(1500);
    expect(looks.length, "the look after the wait is not immediate").toBe(1);
    await pass(1000);
    expect(looks).toEqual(["cwu_1", "cwu_2"]);
  });

  // As in the moment watch: this covers a pending() that stays true while
  // settled() resolves at once, not a settled() that never resolves.
  it("belt: a host whose pending() stays true while settled() resolves at once still meets the park's failure belt", async () => {
    const f = frame({ alwaysPending: true });
    const looks: string[] = [];
    const read: RunReviewSlotReader = async () => {
      looks.push(f.token);
      return null;
    };
    const { result } = mountSlot(f, read, "pending_approval");
    await pass(0);
    expect(result.current.stillReading).toBe(true);
    await pass(300_000);
    expect(result.current.stillReading, "3 forgiven looks, then 5 failures end the hold").toBe(false);
    expect(looks.length).toBeGreaterThanOrEqual(8);
  });

  // RED AT af66c965: every schedule rebuilt by a liveness bump while the slot
  // waited asked the renewal reading again (one more settled() call each), and
  // each waiter was kept until the renewal answered.
  it("schedules rebuilt by liveness bumps while the slot waits ask the renewal reading once; one look follows; a later renewal is asked for and waited for afresh", async () => {
    const f = frame();
    const looks: string[] = [];
    const spent = new Set<string>();
    const read: RunReviewSlotReader = async () => {
      looks.push(f.token);
      return spent.has(f.token) ? null : AWAITING_NO_GATE;
    };
    const { rerender } = renderHook(
      ({ signal }: { signal: number }) =>
        useRunReviewSlot({ runId: "run-4217", status: "completed", read, liveSignal: signal }),
      { initialProps: { signal: 0 }, wrapper: host(f.auth) },
    );
    await pass(0);
    expect(looks, "the first look lands").toEqual(["cwu_1"]);
    f.begin();
    spent.add("cwu_1");
    for (let i = 0; i < 60 && looks.length < 2; i += 1) await pass(1000);
    expect(looks, "the look that met the gap").toEqual(["cwu_1", "cwu_1"]);
    await pass(30_000);
    expect(f.settled, "the wait asked the renewal reading").toHaveBeenCalledTimes(1);
    for (let signal = 1; signal <= 5; signal += 1) {
      rerender({ signal });
      await pass(30_000);
    }
    expect(looks.length, "nothing looked while the renewal was on its way").toBe(2);
    expect(f.settled, "five rebuilt schedules joined the one wait").toHaveBeenCalledTimes(1);
    f.answer();
    await flush();
    expect(looks.slice(2), "one look follows, with the renewed pair").toEqual(["cwu_2"]);

    // A LATER renewal asks the reading afresh and is waited for too: the
    // shared wait of the first renewal is not reused once it settled.
    f.begin();
    spent.add("cwu_2");
    for (let i = 0; i < 60 && looks.length < 4; i += 1) await pass(1000);
    expect(looks.slice(3), "the look that met the second gap").toEqual(["cwu_2"]);
    await pass(30_000);
    expect(looks.length, "nothing looked while the second renewal was on its way").toBe(4);
    expect(f.settled, "the second renewal was asked for once").toHaveBeenCalledTimes(2);
    f.answer();
    await flush();
    expect(looks.slice(4), "one look follows, with the second renewed pair").toEqual(["cwu_3"]);
  });
});

// ---------------------------------------------------------------------------
// The ticket probe (a sibling of pre-3 MUST-FIX 2 and 3)
// ---------------------------------------------------------------------------

describe("the review ticket probe across the renewal", () => {
  const OLD = {
    ref: "ticket-that-landed",
    awaiting: false,
    producedReviewPark: true,
    reviewTaskId: "review-task-on-file",
  } as RunReviewSlot;
  const NEXT = { ...OLD, ref: "fresh-seal-for-the-same-gate" } as RunReviewSlot;
  const envelope = (state: unknown, status = 200) =>
    new Response(JSON.stringify({ kind: "artifact_review_gate", state, body: null }), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  function SlotCard({ read }: { read: RunReviewSlotReader }) {
    const { slot } = useRunReviewSlot({ status: "pending_approval", initial: OLD, read, runId: "run-on-file" });
    return (
      <>
        {/* The ticket the slot holds now, read by the chain-end test below. */}
        <span data-slot-ref={slot.ref ?? ""} />
        {slot.ref ? (
          <ReviewGateCard view={{ viewType: "artifact_review_gate", schemaVersion: 1, ref: slot.ref }} />
        ) : null}
      </>
    );
  }

  async function landedThenProbed(f: Frame, probe: () => Response, beforeProbe: () => void) {
    let probing = false;
    let next: RunReviewSlot = OLD;
    const replacementResolves = vi.fn();
    const probes = vi.fn(probe);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        if (body.ref === OLD.ref && !probing) return envelope(PENDING);
        if (body.ref === OLD.ref) return probes();
        replacementResolves();
        return new Promise<Response>(() => {});
      }),
    );
    const read = vi.fn(async () => next);
    const rendered = render(
      <LifecycleCardSurfaceProvider host="site_widget" auth={f.auth}>
        <SlotCard read={read} />
      </LifecycleCardSurfaceProvider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const root = rendered.container.querySelector('[data-conformance-id="review-gate-card"]');
    expect(root, "a real review lands first").not.toBeNull();
    probing = true;
    beforeProbe();
    next = NEXT;
    await pass(4000);
    expect(probes).toHaveBeenCalled();
    return { rendered, root, replacementResolves };
  }

  // RED AT 749d92f2: any 401 withdrew the authorized ticket, so a refusal in
  // the renewal gap took the landed review off the thread.
  it("a refusal while the renewal is on its way keeps the landed review", async () => {
    const f = frame();
    const page = await landedThenProbed(f, () => refused(), () => f.begin());
    expect(page.root?.isConnected, "the landed review stays").toBe(true);
    expect(page.rendered.container.querySelector('[data-conformance-id="review-gate-card"]')).toBe(page.root);
    expect(page.replacementResolves).not.toHaveBeenCalled();
  });

  it("control: a refusal of a credential that did not move still withdraws the landed review", async () => {
    const f = frame();
    const page = await landedThenProbed(f, () => refused(), () => undefined);
    expect(page.root?.isConnected).toBe(false);
    expect(page.replacementResolves).toHaveBeenCalled();
  });

  // RED AT af66c965: the probe left with the held pair, the chain ended while
  // it was out (the frame dropped its pair through the SAME declaration object,
  // so no identity reset), and the refusal then read as "caught in the
  // renewal" because the key had moved to the empty one, so the slot kept the
  // old ticket at that look. (Its NEXT look withdrew it there, through the
  // probe's check before sending; so this reads the slot right after the
  // first probe's answer, before any next look.)
  it("a refusal after the chain ended while the probe was out withdraws the ticket at that look", async () => {
    const f = frame();
    let probing = false;
    let next: RunReviewSlot = OLD;
    const replacementResolves = vi.fn();
    const probes = vi.fn(() => {
      f.drop();
      return refused();
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        if (body.ref === OLD.ref && !probing) return envelope(PENDING);
        if (body.ref === OLD.ref) return probes();
        replacementResolves();
        return new Promise<Response>(() => {});
      }),
    );
    const read = vi.fn(async () => next);
    const rendered = render(
      <LifecycleCardSurfaceProvider host="site_widget" auth={f.auth}>
        <SlotCard read={read} />
      </LifecycleCardSurfaceProvider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const ticket = () => rendered.container.querySelector("[data-slot-ref]")?.getAttribute("data-slot-ref");
    expect(rendered.container.querySelector('[data-conformance-id="review-gate-card"]'), "a real review lands first").not.toBeNull();
    expect(ticket()).toBe(OLD.ref);
    probing = true;
    next = NEXT;
    for (let i = 0; i < 80 && probes.mock.calls.length === 0; i += 1) await pass(250);
    expect(probes, "one probe, refused after the chain ended while it was out").toHaveBeenCalledTimes(1);
    const looksAtProbe = read.mock.calls.length;
    await flush();
    expect(read.mock.calls.length, "no next look yet").toBe(looksAtProbe);
    expect(f.token, "the chain ended").toBe("");
    expect(ticket(), "the old ticket is withdrawn at that look").toBe(NEXT.ref);
    expect(replacementResolves, "nothing is sent without a token").not.toHaveBeenCalled();
  });
});

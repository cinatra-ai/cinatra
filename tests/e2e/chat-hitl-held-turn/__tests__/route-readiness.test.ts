// The boot-window route rules the held-turn flow now obeys (cinatra#3056).
//
// Every arm here is the DEFECT, stated: a route that answers 404 while the
// development runtime prepares it, and a stream handshake that fails on the
// console where the card probe cannot see it. The two runs that motivated the
// change cannot be reproduced on demand — they are boot-window races — so the
// proof that this class is handled lives here, in arms that run in milliseconds
// and go red the moment the rules change.
//
// A REAL SOCKET, not only a fake function, for the two arms that matter most: the
// issue asks for "a fake server answering 404 then 400", and a helper that only
// ever meets a hand-written stub cannot show that a real HTTP 404 is read as a
// status rather than thrown as an error.
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import {
  BOOT_WINDOW_BACKOFF_CAP_MS,
  ROUTE_NOT_COMPILED_STATUS,
  ROUTE_READY_BOUND_MS,
  bootWindowBackoffMs,
  bootWindowRemainingMs,
  handlerAnswered404,
  handshakeFailureFrom,
  isRuntimeNotFoundDocument,
  retryWhileRouteMissing,
  routeAnswered,
  routeReadinessFailure,
  waitForRouteReady,
} from "../route-readiness";

// ---------------------------------------------------------------------------
// A fake clock. The bound is two minutes and the back-off climbs to four seconds;
// asserting either against the wall clock would make this file the slowest in the
// tier and the flakiest. `now` and `sleep` are the module's injected seam, so the
// arms below spend the whole bound without spending any time.
// ---------------------------------------------------------------------------
function fakeClock() {
  let t = 1_000;
  const slept: number[] = [];
  return {
    slept,
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

let server: Server | null = null;

/**
 * A server answering the given answers in order; the last one repeats.
 *
 * AN ANSWER CARRIES A MEDIA TYPE, because the media type is the whole subject of
 * the arms below: the two 404s this helper must tell apart are identical as
 * statuses and differ only in what they are made of. A bare number keeps the
 * original meaning — a handler's own JSON refusal.
 */
type Answer = number | { status: number; contentType: string; body?: string };

async function serverAnswering(answers: readonly Answer[]): Promise<string> {
  let i = 0;
  server = createServer((_req, res) => {
    const answer = answers[Math.min(i, answers.length - 1)]!;
    i += 1;
    const { status, contentType, body } =
      typeof answer === "number"
        ? { status: answer, contentType: "application/json", body: "{}" }
        : { status: answer.status, contentType: answer.contentType, body: answer.body ?? "{}" };
    res.writeHead(status, { "Content-Type": contentType });
    res.end(body);
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return `http://127.0.0.1:${address.port}/api/probe`;
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
});

describe("routeAnswered — what counts as ready", () => {
  it("reads a 404 as NOT ready: that is the development runtime's 'not compiled yet'", () => {
    expect(routeAnswered(ROUTE_NOT_COMPILED_STATUS)).toBe(false);
  });

  it("reads every other status as ready — a rejection proves the route ran", () => {
    // 400/405 are the issue's own side-effect-free readiness signals; 401 is what
    // the chat capabilities POST answers an unauthenticated probe, and it is just
    // as good an answer: the route compiled and refused.
    for (const status of [200, 204, 400, 401, 403, 405, 422, 500]) {
      expect(routeAnswered(status), `status ${status}`).toBe(true);
    }
  });

  it("reads NO RESPONSE as not ready — a request that fails instantly is not a fast route", () => {
    expect(routeAnswered(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE MEASURED RUN THIS SECTION EXISTS FOR (run 33244751481, job "Chat-HITL
// held-turn dev-runtime e2e").
//
// The setup probe posted an empty body to /api/assistants/chat/capabilities
// fourteen times over 117 016 ms and read 404 every time, so the bound failed the
// job. Reading the statuses alone, that is "the route never compiled". Reading
// the RESPONSES — the run's own Playwright trace — it is something else: every
// one of the fourteen carried `content-type: text/html; charset=utf-8` and a
// ~205 KB body that is the application's own not-found PAGE (title "Page not
// found", breadcrumb "Api Assistants Chat Capabilities"). The handler never ran;
// the development runtime resolved the path in the PAGE tree and rendered
// not-found, which is also why the first hit spent 3.7 s in application code
// (rendering that page) rather than the 40 ms the handler takes.
//
// The same probe, same shape, on the same branch seventeen minutes earlier (run
// 33244071398) read 401 on its first attempt, and on main (run 33245807460) 200.
// So the compiled handler CANNOT answer 404 to this probe's request — its arms
// are 401 (sessionless), 400 (a body the hello schema rejects) and 200 — and the
// probe's "404 = not ready" contract is right for it.
//
// What the probe could not do is SAY WHICH 404 it saw, and that is the flaw these
// arms close: a 404 the handler itself produced is an ANSWER, and only the media
// type separates it from the runtime's not-found document.
// ---------------------------------------------------------------------------
describe("routeAnswered — a 404 the HANDLER produced is an answer, the runtime's page is not", () => {
  it("keeps the runtime's own not-found DOCUMENT as not ready — the failing run's exact header", () => {
    expect(routeAnswered(ROUTE_NOT_COMPILED_STATUS, "text/html; charset=utf-8")).toBe(false);
    expect(isRuntimeNotFoundDocument("text/html; charset=utf-8")).toBe(true);
  });

  it("reads a 404 carrying the handler's own media type as READY — it ran to answer", () => {
    expect(routeAnswered(ROUTE_NOT_COMPILED_STATUS, "application/json")).toBe(true);
    expect(handlerAnswered404("application/problem+json")).toBe(true);
  });

  it("keeps an UNDECLARED media type not ready — unknown may never widen readiness", () => {
    // The one-argument call is every existing call site, and it must keep meaning
    // what it meant: not ready.
    expect(routeAnswered(ROUTE_NOT_COMPILED_STATUS)).toBe(false);
    expect(routeAnswered(ROUTE_NOT_COMPILED_STATUS, null)).toBe(false);
    expect(routeAnswered(ROUTE_NOT_COMPILED_STATUS, "")).toBe(false);
    expect(handlerAnswered404(undefined)).toBe(false);
  });

  it("leaves every non-404 status alone, media type or not", () => {
    expect(routeAnswered(401, "text/html; charset=utf-8")).toBe(true);
    expect(routeAnswered(400, "application/json")).toBe(true);
    expect(routeAnswered(null, "application/json")).toBe(false);
  });
});

describe("bootWindowBackoffMs — the back-off shape", () => {
  it("doubles from 250 ms and caps at 4 s", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20].map((n) => bootWindowBackoffMs(n))).toEqual([
      250, 500, 1_000, 2_000, 4_000, 4_000, 4_000, BOOT_WINDOW_BACKOFF_CAP_MS,
    ]);
  });

  it("honours a caller's own base and cap", () => {
    expect([0, 1, 2, 3].map((n) => bootWindowBackoffMs(n, { baseMs: 10, capMs: 30 }))).toEqual([
      10, 20, 30, 30,
    ]);
  });
});

describe("retryWhileRouteMissing — a 404 is retried, everything else is returned", () => {
  it("clears a real server that answers 404 and then 400", async () => {
    const url = await serverAnswering([404, 400]);
    const clock = fakeClock();
    const result = await retryWhileRouteMissing(
      async () => ({ status: (await fetch(url, { method: "POST" })).status }),
      { timeoutMs: ROUTE_READY_BOUND_MS, now: clock.now, sleep: clock.sleep },
    );
    expect(result.answered).toBe(true);
    expect(result.status).toBe(400);
    expect(result.attempts).toBe(2);
    expect(clock.slept).toEqual([250]);
  });

  it("does NOT retry a status that is not 404 — the call site keeps its handling", async () => {
    const clock = fakeClock();
    let calls = 0;
    const result = await retryWhileRouteMissing(
      async () => {
        calls += 1;
        return { status: 500 };
      },
      { timeoutMs: ROUTE_READY_BOUND_MS, now: clock.now, sleep: clock.sleep },
    );
    expect(calls).toBe(1);
    expect(result.answered).toBe(true);
    expect(result.status).toBe(500);
    expect(clock.slept).toEqual([]);
  });

  it("carries the answering attempt's own value out", async () => {
    const clock = fakeClock();
    const statuses = [404, 404, 200];
    const result = await retryWhileRouteMissing<string>(
      async (i) => ({ status: statuses[i]!, value: `attempt-${i}` }),
      { timeoutMs: ROUTE_READY_BOUND_MS, now: clock.now, sleep: clock.sleep },
    );
    expect(result.value).toBe("attempt-2");
    expect(clock.slept).toEqual([250, 500]);
  });

  it("does NOT retry a thrown attempt by default — a transport fault keeps its instant failure", async () => {
    const clock = fakeClock();
    let calls = 0;
    await expect(
      retryWhileRouteMissing(
        async () => {
          calls += 1;
          throw new Error("connect ECONNREFUSED");
        },
        { timeoutMs: ROUTE_READY_BOUND_MS, now: clock.now, sleep: clock.sleep },
      ),
    ).rejects.toThrow("connect ECONNREFUSED");
    // ONE attempt, no waiting: the acceptance item's "any other status keeps its
    // current handling" covers a fault that produced no status at all.
    expect(calls).toBe(1);
    expect(clock.slept).toEqual([]);
  });

  it("retries a thrown attempt as a not-yet ONLY when retryOnError is asked for", async () => {
    const clock = fakeClock();
    const seen: Array<string | null> = [];
    let calls = 0;
    const result = await retryWhileRouteMissing(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error("connect ECONNREFUSED");
        return { status: 401 };
      },
      {
        timeoutMs: ROUTE_READY_BOUND_MS,
        retryOnError: true,
        now: clock.now,
        sleep: clock.sleep,
        onRetry: (info) => seen.push(info.lastError),
      },
    );
    expect(seen).toEqual(["connect ECONNREFUSED"]);
    expect(result.answered).toBe(true);
    expect(result.status).toBe(401);
  });

  it("hands each attempt the REST OF THE BOUND, so an in-flight request can cap itself", async () => {
    const clock = fakeClock();
    const handed: number[] = [];
    await retryWhileRouteMissing(
      async (_index, remainingMs) => {
        handed.push(remainingMs);
        return { status: 404 };
      },
      { timeoutMs: 1_000, now: clock.now, sleep: clock.sleep },
    );
    // 1000 at the start, then the bound minus what the back-off has already spent.
    expect(handed).toEqual([1_000, 750, 250]);
    // The promise the bound makes: no attempt is ever handed more time than is
    // left, and never 0 — Playwright reads a 0 timeout as "no timeout at all".
    expect(Math.max(...handed)).toBeLessThanOrEqual(1_000);
    expect(Math.min(...handed)).toBeGreaterThan(0);
  });

  it("hands the readiness probe a shrinking budget even when the ATTEMPTS spend the time", async () => {
    const clock = fakeClock();
    const handed: number[] = [];
    await retryWhileRouteMissing(
      async (_index, remainingMs) => {
        handed.push(remainingMs);
        clock.advance(400); // the request itself took 400 ms
        return { status: 404 };
      },
      { timeoutMs: 1_000, now: clock.now, sleep: clock.sleep },
    );
    expect(handed).toEqual([1_000, 350]);
    expect(handed.every((ms) => ms <= 1_000)).toBe(true);
  });

  it("does not START an attempt once the bound is spent", async () => {
    const clock = fakeClock();
    let calls = 0;
    const result = await retryWhileRouteMissing(
      async () => {
        calls += 1;
        clock.advance(5_000); // the first attempt alone outlives the whole bound
        return { status: 404 };
      },
      { timeoutMs: 1_000, now: clock.now, sleep: clock.sleep },
    );
    // One attempt is always made; a SECOND would have nothing left to spend and
    // could only overrun, so it is never started.
    expect(calls).toBe(1);
    expect(clock.slept).toEqual([]);
    expect(result.answered).toBe(false);
  });

  it("gives up inside the bound rather than one attempt past it", async () => {
    const clock = fakeClock();
    const result = await retryWhileRouteMissing(async () => ({ status: 404 }), {
      timeoutMs: 1_000,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(result.answered).toBe(false);
    // 250 + 500 spent; the next wait (1000) would end past the 1000 ms bound.
    expect(clock.slept).toEqual([250, 500]);
    expect(result.attempts).toBe(3);
    expect(result.elapsedMs).toBe(750);
  });
});

describe("the two 404s, against a real socket", () => {
  // The failing run's shape, replayed: the runtime answers its not-found PAGE
  // first, and once the path is routable the handler answers for itself — 404 for
  // a request shape it does not know, which is still an ANSWER.
  const RUNTIME_THEN_HANDLER: readonly Answer[] = [
    { status: 404, contentType: "text/html; charset=utf-8", body: "<!DOCTYPE html><html></html>" },
    { status: 404, contentType: "application/json" },
  ];

  it("OLD CONTRACT (status alone): the handler's own 404 is misread and the whole bound is spent", async () => {
    const url = await serverAnswering(RUNTIME_THEN_HANDLER);
    const clock = fakeClock();
    // Exactly what the probe did before this change — the status, and nothing
    // else — against a route that IS answering. The bound is spent on a route
    // that was ready at the second attempt.
    await expect(
      waitForRouteReady(
        "POST /api/probe",
        async () => ({ status: (await fetch(url, { method: "POST" })).status }),
        { timeoutMs: ROUTE_READY_BOUND_MS, now: clock.now, sleep: clock.sleep },
      ),
    ).rejects.toThrow(/never answered anything but 404/);
  });

  it("NEW CONTRACT (status + media type): ready on the attempt the handler answers", async () => {
    const url = await serverAnswering(RUNTIME_THEN_HANDLER);
    const clock = fakeClock();
    const result = await waitForRouteReady(
      "POST /api/probe",
      async () => {
        const response = await fetch(url, { method: "POST" });
        return { status: response.status, contentType: response.headers.get("content-type") };
      },
      { timeoutMs: ROUTE_READY_BOUND_MS, now: clock.now, sleep: clock.sleep },
    );
    expect(result.answered).toBe(true);
    expect(result.status).toBe(ROUTE_NOT_COMPILED_STATUS);
    expect(result.contentType).toContain("application/json");
    expect(result.attempts).toBe(2);
    expect(clock.slept).toEqual([250]);
  });

  it("the sign-up route's probe is untouched: a runtime 404 then a handler 400 reads ready either way", async () => {
    const answers: readonly Answer[] = [
      { status: 404, contentType: "text/html; charset=utf-8" },
      { status: 400, contentType: "application/json" },
    ];
    for (const withMediaType of [false, true]) {
      const url = await serverAnswering(answers);
      const clock = fakeClock();
      const result = await waitForRouteReady(
        "POST /api/probe",
        async () => {
          const response = await fetch(url, { method: "POST" });
          return withMediaType
            ? { status: response.status, contentType: response.headers.get("content-type") }
            : { status: response.status };
        },
        { timeoutMs: ROUTE_READY_BOUND_MS, now: clock.now, sleep: clock.sleep },
      );
      expect(result.status, `withMediaType=${withMediaType}`).toBe(400);
      expect(result.attempts).toBe(2);
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = null;
      }
    }
  });

  it("tells the operator WHICH 404 it spent the bound on", () => {
    const runtimePage = routeReadinessFailure("POST /api/probe", 120_000, {
      answered: false,
      status: 404,
      contentType: "text/html; charset=utf-8",
      attempts: 14,
      elapsedMs: 117_016,
      lastError: null,
    });
    expect(runtimePage).toContain("not-found");
    expect(runtimePage).toContain("text/html");
    expect(runtimePage).toContain("14 attempts");

    const undeclared = routeReadinessFailure("POST /api/probe", 120_000, {
      answered: false,
      status: 404,
      attempts: 3,
      elapsedMs: 900,
      lastError: null,
    });
    expect(undeclared).toContain("no media type");
  });
});

describe("bootWindowRemainingMs — the window is the BOOT's, not each request's", () => {
  it("shrinks as the flow runs and is spent once the window has passed", () => {
    expect(bootWindowRemainingMs(1_000, 1_000, 60_000)).toBe(60_000);
    expect(bootWindowRemainingMs(1_000, 31_000, 60_000)).toBe(30_000);
    // The second turn of a fifteen-minute flow: no boot-window patience left, so a
    // 404 there is served straight through and reported as itself.
    expect(bootWindowRemainingMs(1_000, 900_000, 60_000)).toBe(0);
  });

  it("never goes negative, so a caller can treat 0 as 'do not intercept'", () => {
    expect(bootWindowRemainingMs(0, 10_000_000, 60_000)).toBe(0);
  });
});

describe("waitForRouteReady — the bound exceeded fails the run, NAMING the route", () => {
  it("names the route, the bound and the last status when a real server only ever 404s", async () => {
    const url = await serverAnswering([404]);
    const clock = fakeClock();
    await expect(
      waitForRouteReady(
        "POST /api/auth/sign-up/email",
        async () => ({ status: (await fetch(url, { method: "POST" })).status }),
        { timeoutMs: ROUTE_READY_BOUND_MS, now: clock.now, sleep: clock.sleep },
      ),
    ).rejects.toThrow(/POST \/api\/auth\/sign-up\/email never answered anything but 404/);
  });

  it("returns quietly the moment the route answers, without a second attempt", async () => {
    const url = await serverAnswering([405]);
    const clock = fakeClock();
    const result = await waitForRouteReady(
      "POST /api/probe",
      async () => ({ status: (await fetch(url, { method: "POST" })).status }),
      { now: clock.now, sleep: clock.sleep },
    );
    expect(result.attempts).toBe(1);
    expect(result.status).toBe(405);
    expect(clock.slept).toEqual([]);
  });

  it("says 'no response at all' rather than a status when nothing ever answered", () => {
    const message = routeReadinessFailure("POST /api/probe", 120_000, {
      answered: false,
      status: null,
      attempts: 9,
      elapsedMs: 119_000,
      lastError: "connect ECONNREFUSED",
    });
    expect(message).toContain("POST /api/probe");
    expect(message).toContain("no response at all");
    expect(message).toContain("connect ECONNREFUSED");
    expect(message).toContain("120000ms");
  });
});

describe("handshakeFailureFrom — the card probe's fail-fast", () => {
  it("recognises the failing run's own line and quotes it back", () => {
    const line =
      "[chat] AG-UI stream handshake request failed: Error: stream handshake request failed (404)";
    expect(handshakeFailureFrom(["some other log", line, "later noise"])).toBe(line);
  });

  it("recognises the fail-closed negotiation too — equally terminal for the turn", () => {
    expect(
      handshakeFailureFrom(['[chat] AG-UI stream handshake failed (fail-closed): {"ok":false}']),
    ).toContain("fail-closed");
  });

  it("stays silent on ordinary console noise, so a healthy run is never cut short", () => {
    expect(
      handshakeFailureFrom([
        "[Fast Refresh] rebuilding",
        "Download the React DevTools",
        "[chat] stream opened",
      ]),
    ).toBeNull();
  });

  it("is silent on an empty transcript of console lines", () => {
    expect(handshakeFailureFrom([])).toBeNull();
  });
});

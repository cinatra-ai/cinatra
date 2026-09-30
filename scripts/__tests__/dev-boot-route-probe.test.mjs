// The node tier's boot-answer rules, and their AGREEMENT with the Playwright
// tier's (cinatra#3194).
//
// `scripts/lib/dev-boot-route-probe.mjs` deliberately restates the rule
// `tests/e2e/chat-hitl-held-turn/route-readiness.ts` holds, because the two run in
// different tiers (plain node scripts a workflow invokes, versus TypeScript
// Playwright compiles). Restating a rule is only safe while something proves the
// two statements are the same rule, so this file imports BOTH and asserts they
// answer identically — including the bound, which #3194 forbids widening.
import { describe, expect, it, vi } from "vitest";

import {
  BOOT_WINDOW_BACKOFF_BASE_MS,
  BOOT_WINDOW_BACKOFF_CAP_MS,
  ROUTE_READY_BOUND_MS,
  bootProbeFailure,
  bootVerdict,
  bootWindowBackoffMs,
  classifyBootAnswer,
  handlerAnswered404,
  isRuntimeNotFoundDocument,
  parseRouteSpec,
  parseRuntimeCompileAnnouncement,
  probeRouteUntilAnswered,
  routeAnswered,
  shouldRebootAfter,
} from "../lib/dev-boot-route-probe.mjs";
import * as playwrightTier from "../../tests/e2e/chat-hitl-held-turn/route-readiness";

/** Every answer shape either tier has been shown, plus the ones that matter. */
const ANSWERS = [
  { status: 200, contentType: "application/json" },
  { status: 400, contentType: "application/json; charset=utf-8" },
  { status: 401, contentType: "application/json" },
  { status: 404, contentType: "text/html; charset=utf-8" },
  { status: 404, contentType: "TEXT/HTML" },
  { status: 404, contentType: "application/xhtml+xml" },
  { status: 404, contentType: "application/json" },
  { status: 404, contentType: null },
  { status: 404, contentType: undefined },
  { status: 404, contentType: "" },
  { status: 500, contentType: "text/html" },
  { status: null, contentType: null },
];

describe("the node tier states the same rule as the Playwright tier", () => {
  it("spends the same bound, which cinatra#3194 forbids widening", () => {
    expect(ROUTE_READY_BOUND_MS).toBe(playwrightTier.ROUTE_READY_BOUND_MS);
    expect(ROUTE_READY_BOUND_MS).toBe(120_000);
  });

  it("uses the same back-off shape", () => {
    expect(BOOT_WINDOW_BACKOFF_BASE_MS).toBe(playwrightTier.BOOT_WINDOW_BACKOFF_BASE_MS);
    expect(BOOT_WINDOW_BACKOFF_CAP_MS).toBe(playwrightTier.BOOT_WINDOW_BACKOFF_CAP_MS);
    for (const attempt of [0, 1, 2, 3, 4, 5, 10, 40]) {
      expect(bootWindowBackoffMs(attempt)).toBe(playwrightTier.bootWindowBackoffMs(attempt));
    }
  });

  it.each(ANSWERS)("agrees on $status / $contentType", ({ status, contentType }) => {
    expect(routeAnswered(status, contentType)).toBe(
      playwrightTier.routeAnswered(status, contentType),
    );
    expect(isRuntimeNotFoundDocument(contentType)).toBe(
      playwrightTier.isRuntimeNotFoundDocument(contentType),
    );
    expect(handlerAnswered404(contentType)).toBe(playwrightTier.handlerAnswered404(contentType));
  });
});

describe("classifyBootAnswer names which sender produced a 404", () => {
  it("reads the runtime's own not-found DOCUMENT as not routable", () => {
    expect(classifyBootAnswer({ status: 404, contentType: "text/html; charset=utf-8" })).toBe(
      "runtime-not-found",
    );
  });

  it("reads a 404 the handler produced as an answer", () => {
    expect(classifyBootAnswer({ status: 404, contentType: "application/json" })).toBe("answered");
  });

  it("reads an undeclared media type as unreadable rather than as an answer", () => {
    expect(classifyBootAnswer({ status: 404, contentType: null })).toBe("unknown-404");
  });

  it("reads no response at all as no response", () => {
    expect(classifyBootAnswer({ status: null })).toBe("no-response");
    expect(classifyBootAnswer()).toBe("no-response");
  });

  it("reads every other status as an answer", () => {
    expect(classifyBootAnswer({ status: 400, contentType: "application/json" })).toBe("answered");
    expect(classifyBootAnswer({ status: 500, contentType: "text/html" })).toBe("answered");
  });
});

describe("the boot verdict, and which verdict earns a fresh boot", () => {
  it("is ready when the route answered", () => {
    expect(bootVerdict({ answered: true, classifications: ["runtime-not-found", "answered"] })).toBe(
      "ready",
    );
  });

  it("is unrouted when the bound was spent on the runtime's own not-found document", () => {
    expect(
      bootVerdict({
        answered: false,
        classifications: ["runtime-not-found", "runtime-not-found", "runtime-not-found"],
      }),
    ).toBe("unrouted");
  });

  it("is silent when nothing ever answered", () => {
    expect(bootVerdict({ answered: false, classifications: ["no-response", "no-response"] })).toBe(
      "silent",
    );
  });

  it("replaces only an unrouted boot, and only inside the boot budget", () => {
    expect(shouldRebootAfter("unrouted", { bootIndex: 0, maxBoots: 2 })).toBe(true);
    expect(shouldRebootAfter("unrouted", { bootIndex: 1, maxBoots: 2 })).toBe(false);
    expect(shouldRebootAfter("silent", { bootIndex: 0, maxBoots: 2 })).toBe(false);
    expect(shouldRebootAfter("ready", { bootIndex: 0, maxBoots: 5 })).toBe(false);
  });
});

/** A clock the test drives, so a 120 s bound costs no wall-clock time. */
function fakeClock() {
  let nowMs = 0;
  return {
    now: () => nowMs,
    sleep: async (ms) => {
      nowMs += ms;
    },
    advance: (ms) => {
      nowMs += ms;
    },
  };
}

describe("probeRouteUntilAnswered", () => {
  it("reproduces the cinatra#3194 signature: the whole bound spent on the not-found document", async () => {
    const clock = fakeClock();
    // The measured shape from run 33524006346: every answer is the development
    // runtime's own not-found page, each in a couple of hundred milliseconds.
    const request = vi.fn(async () => {
      clock.advance(180);
      return { status: 404, contentType: "text/html; charset=utf-8" };
    });

    const result = await probeRouteUntilAnswered(request, {
      boundMs: ROUTE_READY_BOUND_MS,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result.answered).toBe(false);
    expect(result.verdict).toBe("unrouted");
    expect(result.status).toBe(404);
    expect(result.contentType).toBe("text/html; charset=utf-8");
    // The recorded reds spent 116-117 s over 12-18 attempts; the same bound and
    // back-off must land in that neighbourhood rather than, say, one attempt.
    expect(result.attempts).toBeGreaterThanOrEqual(12);
    expect(result.elapsedMs).toBeGreaterThan(110_000);
    expect(result.elapsedMs).toBeLessThanOrEqual(ROUTE_READY_BOUND_MS);
    expect(new Set(result.classifications)).toEqual(new Set(["runtime-not-found"]));
  });

  it("stops the moment the route answers, and reports what answered", async () => {
    const clock = fakeClock();
    const answers = [
      { status: 404, contentType: "text/html; charset=utf-8" },
      { status: 404, contentType: "text/html; charset=utf-8" },
      { status: 400, contentType: "application/json" },
    ];
    const request = vi.fn(async () => {
      clock.advance(120);
      return answers.shift();
    });

    const result = await probeRouteUntilAnswered(request, {
      boundMs: ROUTE_READY_BOUND_MS,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result.answered).toBe(true);
    expect(result.verdict).toBe("ready");
    expect(result.attempts).toBe(3);
    expect(result.status).toBe(400);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("retries a thrown attempt as a not-yet and reports it as silent when nothing ever answers", async () => {
    const clock = fakeClock();
    const request = vi.fn(async () => {
      clock.advance(50);
      throw new Error("connect ECONNREFUSED");
    });

    const result = await probeRouteUntilAnswered(request, {
      boundMs: 10_000,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result.answered).toBe(false);
    expect(result.verdict).toBe("silent");
    expect(result.lastError).toContain("ECONNREFUSED");
  });

  it("hands each attempt the rest of the bound, so no call can outlive it", async () => {
    const clock = fakeClock();
    const remainders = [];
    const request = vi.fn(async (remainingMs) => {
      remainders.push(remainingMs);
      clock.advance(1_000);
      return { status: 404, contentType: "text/html" };
    });

    await probeRouteUntilAnswered(request, { boundMs: 5_000, now: clock.now, sleep: clock.sleep });

    expect(remainders[0]).toBe(5_000);
    for (const remaining of remainders) {
      expect(remaining).toBeGreaterThan(0);
      expect(remaining).toBeLessThanOrEqual(5_000);
    }
  });
});

describe("bootProbeFailure names the route and what it saw", () => {
  it("says the page tree rendered when the answer was the runtime's own document", () => {
    const message = bootProbeFailure("POST /api/auth/sign-up/email", 120_000, {
      attempts: 18,
      elapsedMs: 117_253,
      status: 404,
      contentType: "text/html; charset=utf-8",
    });
    expect(message).toContain("POST /api/auth/sign-up/email");
    expect(message).toContain("18 attempts over 117253ms");
    expect(message).toContain("not-found DOCUMENT");
  });

  it("says so plainly when there was no response at all", () => {
    const message = bootProbeFailure("POST /api/auth/sign-up/email", 120_000, {
      attempts: 4,
      elapsedMs: 9_000,
      status: null,
      lastError: "connect ECONNREFUSED",
    });
    expect(message).toContain("never answered this route at all");
    expect(message).toContain("connect ECONNREFUSED");
  });
});

describe("parseRouteSpec", () => {
  it("reads a method-qualified spec", () => {
    expect(parseRouteSpec("POST:/api/auth/sign-up/email")).toEqual({
      method: "POST",
      path: "/api/auth/sign-up/email",
    });
  });

  it("defaults a bare path to POST, which is what both probes send", () => {
    expect(parseRouteSpec("/api/health")).toEqual({ method: "POST", path: "/api/health" });
  });

  it("refuses a spec that names no absolute path", () => {
    expect(() => parseRouteSpec("GET:api/health")).toThrow(/absolute path/);
    expect(() => parseRouteSpec("nonsense")).toThrow(/absolute path/);
  });
});

// AN ANNOUNCED, UNFINISHED COMPILE IS NOT AN UNROUTED ROUTE (cinatra#3553).
//
// #3194's member of this class is a boot whose probed route is ABSENT: the
// runtime serves its own not-found DOCUMENT in 110-400 ms for the whole bound
// and NEVER announces a compile of that path (the only announcements in those
// job logs are `instrumentation Node.js` and `/_not-found/page`, the page tree
// rendering because nothing was routable there). That member is untouched here,
// and the first case below is what pins it.
//
// The member #3553 adds is a route that DID enter compilation and did not
// finish inside the bound. The readings that separate the two: on a green boot
// of the same job the capabilities route announced its compile and answered
// `401 in 37.6s` on the FIRST attempt; on the red boot the same route announced
// its compile and its first request was ended at exactly 60.0 s by the gate's
// own transport cap, after which that path served the not-found document for
// the rest of the process. A compile the runtime announced for THIS path is
// therefore evidence the route exists, and it buys a bounded extension —
// nothing else does, and nothing buys a second one.
describe("an announced, unfinished compile versus a genuinely unrouted route (cinatra#3553)", () => {
  const PROBED_PATH = "/api/auth/sign-up/email";

  /** The measured #3194 shape: the runtime's own not-found document, forever. */
  function notFoundForever(clock) {
    return vi.fn(async () => {
      clock.advance(180);
      return { status: 404, contentType: "text/html; charset=utf-8" };
    });
  }

  it("leaves a genuinely unrouted boot exactly where it was, at exactly today's bound", async () => {
    // NOTHING ANNOUNCED A COMPILE OF THIS PATH, so the extension is not drawn and
    // this boot reaches the same verdict at the same moment after this change as
    // before it — asserted as an EQUALITY against the old rule (`extensionMs: 0`
    // is that rule exactly) rather than as a number copied from the code.
    const oldClock = fakeClock();
    const underTheOldRule = await probeRouteUntilAnswered(notFoundForever(oldClock), {
      boundMs: ROUTE_READY_BOUND_MS,
      now: oldClock.now,
      sleep: oldClock.sleep,
      compileAnnounced: () => false,
      extensionMs: 0,
    });

    const newClock = fakeClock();
    const underTheNewRule = await probeRouteUntilAnswered(notFoundForever(newClock), {
      boundMs: ROUTE_READY_BOUND_MS,
      now: newClock.now,
      sleep: newClock.sleep,
      compileAnnounced: () => false,
      extensionMs: 120_000,
    });

    expect(underTheNewRule.answered).toBe(false);
    expect(underTheNewRule.verdict).toBe("unrouted");
    expect(underTheNewRule.verdict).toBe(underTheOldRule.verdict);
    expect(underTheNewRule.elapsedMs).toBe(underTheOldRule.elapsedMs);
    expect(underTheNewRule.attempts).toBe(underTheOldRule.attempts);
    expect(underTheNewRule.elapsedMs).toBeLessThanOrEqual(ROUTE_READY_BOUND_MS);
    // And it is still the verdict that earns a fresh boot, exactly as today.
    expect(shouldRebootAfter(underTheNewRule.verdict, { bootIndex: 0, maxBoots: 2 })).toBe(true);
  });

  it("waits out a compile the runtime announced for this very path, instead of calling it unrouted", async () => {
    // The member-B shape, measured: the compile is announced about three seconds
    // after the first probe request and the handler's own answer arrives after
    // the 120 s bound is already spent.
    const ANNOUNCED_AT_MS = 3_000;
    const ANSWERS_AT_MS = 150_000;
    const run = (extensionMs) => {
      const clock = fakeClock();
      const request = vi.fn(async () => {
        clock.advance(180);
        return clock.now() >= ANSWERS_AT_MS
          ? { status: 401, contentType: "application/json" }
          : { status: 404, contentType: "text/html; charset=utf-8" };
      });
      return probeRouteUntilAnswered(request, {
        boundMs: ROUTE_READY_BOUND_MS,
        now: clock.now,
        sleep: clock.sleep,
        compileAnnounced: () => clock.now() >= ANNOUNCED_AT_MS,
        extensionMs,
      });
    };

    const underTheNewRule = await run(120_000);
    expect(underTheNewRule.answered).toBe(true);
    expect(underTheNewRule.verdict).toBe("ready");
    expect(underTheNewRule.status).toBe(401);
    expect(underTheNewRule.compileExtensionMs).toBe(120_000);
    expect(underTheNewRule.elapsedMs).toBeGreaterThanOrEqual(ANSWERS_AT_MS);

    // THE OLD RULE ON THE SAME SCRIPT, so the change is legible in one case:
    // `extensionMs: 0` is what this loop did before cinatra#3553, and it lost
    // this boot at the bound.
    const underTheOldRule = await run(0);
    expect(underTheOldRule.answered).toBe(false);
    expect(underTheOldRule.verdict).toBe("unrouted");
    expect(underTheOldRule.elapsedMs).toBeLessThanOrEqual(ROUTE_READY_BOUND_MS);
  });

  it("draws the extension once and never again, so a stuck announced compile cannot hang a boot", async () => {
    const clock = fakeClock();

    const result = await probeRouteUntilAnswered(notFoundForever(clock), {
      boundMs: ROUTE_READY_BOUND_MS,
      now: clock.now,
      sleep: clock.sleep,
      compileAnnounced: () => true,
      extensionMs: 120_000,
    });

    expect(result.answered).toBe(false);
    expect(result.verdict).toBe("unrouted");
    expect(result.compileExtensionMs).toBe(120_000);
    expect(result.elapsedMs).toBeGreaterThan(ROUTE_READY_BOUND_MS);
    expect(result.elapsedMs).toBeLessThanOrEqual(ROUTE_READY_BOUND_MS + 120_000);
  });

  it("grants nothing for a compile announced for a different path", async () => {
    const clock = fakeClock();
    // `Compiling /_not-found/page` is the page tree rendering BECAUSE nothing was
    // routable at the probed path — the #3194 signature itself, never evidence
    // that the probed route exists.
    const announced = new Set(["/_not-found/page"]);

    const result = await probeRouteUntilAnswered(notFoundForever(clock), {
      boundMs: ROUTE_READY_BOUND_MS,
      now: clock.now,
      sleep: clock.sleep,
      compileAnnounced: () => announced.has(PROBED_PATH),
      extensionMs: 120_000,
    });

    expect(result.verdict).toBe("unrouted");
    expect(result.compileExtensionMs).toBe(0);
    expect(result.elapsedMs).toBeLessThanOrEqual(ROUTE_READY_BOUND_MS);
  });

  it("hands the request the whole of what is left of the bound, never a narrower one", async () => {
    // THE CALLER'S OWN TRANSPORT CAP IS THE OTHER HALF OF cinatra#3553: the
    // recorded red's first request was ended at exactly 60.0 s while the compile
    // it had announced was still running. This loop hands out what is left of the
    // bound, and this arm is what pins the number the boot gate's
    // `requestTimeoutMs` is then given.
    const clock = fakeClock();
    const handed = [];
    const request = vi.fn(async (remainingMs) => {
      handed.push(remainingMs);
      clock.advance(180);
      return { status: 404, contentType: "text/html; charset=utf-8" };
    });

    await probeRouteUntilAnswered(request, {
      boundMs: ROUTE_READY_BOUND_MS,
      now: clock.now,
      sleep: clock.sleep,
      compileAnnounced: () => false,
      extensionMs: 0,
    });

    expect(handed[0]).toBe(ROUTE_READY_BOUND_MS);
    expect(Math.max(...handed)).toBe(ROUTE_READY_BOUND_MS);
    expect(Math.min(...handed)).toBeGreaterThan(0);
  });

  it("grants nothing once the boot's extension budget is spent, even to an announced path", async () => {
    // THE BUDGET IS PER BOOT, so the SECOND route of a boot whose first route
    // already drew the extension is handed `extensionMs: 0` by the gate — and an
    // announcement must then buy it nothing at all.
    const clock = fakeClock();

    const result = await probeRouteUntilAnswered(notFoundForever(clock), {
      boundMs: ROUTE_READY_BOUND_MS,
      now: clock.now,
      sleep: clock.sleep,
      compileAnnounced: () => true,
      extensionMs: 0,
    });

    expect(result.verdict).toBe("unrouted");
    expect(result.compileExtensionMs).toBe(0);
    expect(result.elapsedMs).toBeLessThanOrEqual(ROUTE_READY_BOUND_MS);
  });

  it("still reports silence as silent, and silence is still never retried", async () => {
    const clock = fakeClock();
    const request = vi.fn(async () => {
      clock.advance(50);
      throw new Error("connect ECONNREFUSED");
    });

    const result = await probeRouteUntilAnswered(request, {
      boundMs: 10_000,
      now: clock.now,
      sleep: clock.sleep,
      compileAnnounced: () => true,
      extensionMs: 120_000,
    });

    expect(result.answered).toBe(false);
    expect(result.verdict).toBe("silent");
    expect(shouldRebootAfter(result.verdict, { bootIndex: 0, maxBoots: 2 })).toBe(false);
  });
});

describe("parseRuntimeCompileAnnouncement reads the runtime's own announcement", () => {
  // THE FOUR LINE SHAPES THE JOB LOGS CARRY, verbatim: the glyph-prefixed one the
  // runtime prints for a route, the same shape for the page tree, the bare one,
  // and the glyph wrapped in the dim/reset escapes a colour-capable log keeps.
  it.each([
    ["○ Compiling /api/assistants/chat/capabilities ...", "/api/assistants/chat/capabilities"],
    [" ○ Compiling /_not-found/page ...", "/_not-found/page"],
    ["Compiling /api/auth/sign-up/email ...", "/api/auth/sign-up/email"],
    [
      "\u001b[2m ○\u001b[22m Compiling /api/auth/sign-up/email ...",
      "/api/auth/sign-up/email",
    ],
  ])("reads the path out of %j", (line, path) => {
    expect(parseRuntimeCompileAnnouncement(line)).toBe(path);
  });

  it("announces nothing for a compile that names no route path", () => {
    // `instrumentation Node.js` is the announcement BOTH recorded reds carried
    // while the probed route was never announced at all — it must buy nothing.
    expect(parseRuntimeCompileAnnouncement("○ Compiling instrumentation Node.js ...")).toBe(
      null,
    );
    expect(parseRuntimeCompileAnnouncement("Compiling instrumentation Node.js")).toBe(null);
  });

  it("announces nothing for a line that merely MENTIONS a compile", () => {
    // THE WHOLE LINE MUST BE THE ANNOUNCEMENT. A quoted message and a sentence
    // that carries on after the path are ordinary output; reading either as an
    // announcement would hand a genuinely unrouted boot (the cinatra#3194
    // member, which must be left exactly where it was) an extension it never
    // earned.
    expect(
      parseRuntimeCompileAnnouncement('"Compiling /api/auth/sign-up/email ..."'),
    ).toBe(null);
    expect(parseRuntimeCompileAnnouncement("Compiling /api/auth/sign-up/email is disabled")).toBe(
      null,
    );
    expect(
      parseRuntimeCompileAnnouncement("[worker] warning: Compiling /api/auth/sign-up/email ..."),
    ).toBe(null);
  });

  it("announces nothing for an ordinary log line", () => {
    expect(
      parseRuntimeCompileAnnouncement(
        "POST /api/auth/sign-up/email 404 in 39.8s (next.js: 33.2s, proxy.ts: 5ms)",
      ),
    ).toBe(null);
    expect(parseRuntimeCompileAnnouncement("")).toBe(null);
    expect(parseRuntimeCompileAnnouncement(null)).toBe(null);
    expect(parseRuntimeCompileAnnouncement(undefined)).toBe(null);
  });
});

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

describe("probeRouteUntilAnswered", () => {
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

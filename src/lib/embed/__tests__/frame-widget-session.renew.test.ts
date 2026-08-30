/**
 * THE RENEWAL, BROWSER SIDE (cinatra#3051).
 *
 * The mint's own suite beside this one proves the ceremony that CREATES a
 * credential. This one proves the much smaller thing that keeps one alive, and
 * the properties worth proving about it are all refusals: what it presents, what
 * it will not present, and what it does when the answer is anything other than a
 * whole fresh pair.
 */
import { describe, expect, it, vi } from "vitest";

import {
  FRAME_RENEW_PATH,
  WIDGET_USER_TOKEN_HEADER,
  FRAME_RENEW_RETRY_LIMIT,
  frameCredentialRenewDelayMs,
  frameCredentialRenewRetryDelayMs,
  renewFrameCredential,
} from "@/lib/embed/frame-widget-session.client";

const SELECTORS = { assistant: "wordpress", instanceId: "inst-1" };
const HELD = { userToken: "cwu_held", transportToken: "cit_held", expiresIn: 900 };

type Call = { url: string; init: RequestInit };

function fetchDouble(response: { status?: number; body?: unknown; throws?: boolean } = {}) {
  const calls: Call[] = [];
  const impl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (response.throws) throw new Error("the network was not there");
    return {
      ok: (response.status ?? 200) < 400,
      status: response.status ?? 200,
      json: async () =>
        response.body ?? {
          userToken: "cwu_successor",
          transportToken: "cit_successor",
          expiresIn: 900,
        },
    } as unknown as Response;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe("renewFrameCredential", () => {
  it("presents the held bearer ON THE HEADER and never in the body", async () => {
    const { impl, calls } = fetchDouble();
    const result = await renewFrameCredential(SELECTORS, HELD, { fetchImpl: impl });
    expect(result.ok).toBe(true);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(FRAME_RENEW_PATH);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers[WIDGET_USER_TOKEN_HEADER]).toBe(HELD.userToken);
    // THE BODY CARRIES NO CREDENTIAL AT ALL. Not the user bearer, not the
    // transport half — a body is the part of a request that ends up in a log by
    // accident.
    const body = String(calls[0].init.body);
    expect(body).not.toContain("cwu_");
    expect(body).not.toContain("cit_");
  });

  it("names only SELECTORS — no agent, no org, no scope, no origin", async () => {
    const { impl, calls } = fetchDouble();
    await renewFrameCredential(SELECTORS, HELD, { fetchImpl: impl });
    const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    expect(body).toEqual({
      grantType: "widget_token_renewal",
      assistant: "wordpress",
      instanceId: "inst-1",
    });
  });

  it("adopts the fresh pair the server returned", async () => {
    const { impl } = fetchDouble();
    const result = await renewFrameCredential(SELECTORS, HELD, { fetchImpl: impl });
    expect(result).toEqual({
      ok: true,
      credential: {
        userToken: "cwu_successor",
        transportToken: "cit_successor",
        expiresIn: 900,
      },
    });
  });

  it("BOTH OR NOTHING: a half pair is refused rather than half-adopted", async () => {
    const { impl } = fetchDouble({ body: { userToken: "cwu_successor", expiresIn: 900 } });
    // Adopting one half would swap a working credential for a broken one — the
    // very failure this leg exists to remove, arrived at from the other side.
    expect(await renewFrameCredential(SELECTORS, HELD, { fetchImpl: impl })).toEqual({
      ok: false,
      reason: "renew_failed",
    });
  });

  it("refuses a non-2xx answer, uninformatively", async () => {
    const { impl } = fetchDouble({ status: 400, body: { error: "invalid_grant" } });
    expect(await renewFrameCredential(SELECTORS, HELD, { fetchImpl: impl })).toEqual({
      ok: false,
      reason: "renew_failed",
    });
  });

  it("refuses a transport failure rather than throwing into the column", async () => {
    const { impl } = fetchDouble({ throws: true });
    expect(await renewFrameCredential(SELECTORS, HELD, { fetchImpl: impl })).toEqual({
      ok: false,
      reason: "renew_failed",
    });
  });

  it("asks nothing at all when there is no bearer to present", async () => {
    const { impl, calls } = fetchDouble();
    const result = await renewFrameCredential(
      SELECTORS,
      { userToken: "", transportToken: "cit_held", expiresIn: 900 },
      { fetchImpl: impl },
    );
    expect(result).toEqual({ ok: false, reason: "renew_failed" });
    expect(calls).toHaveLength(0);
  });
});

describe("frameCredentialRenewDelayMs", () => {
  it("asks comfortably INSIDE the life it is renewing, leaving room for a refusal", () => {
    const delay = frameCredentialRenewDelayMs(900);
    expect(delay).toBe(600_000);
    // A third of the life is still ahead of the ask, so one refused attempt
    // leaves the column working rather than instantly dead.
    expect(delay).toBeLessThan(900 * 1000);
  });

  it("floors an absurdly short stated life so the chain can never spin", () => {
    expect(frameCredentialRenewDelayMs(1)).toBe(5_000);
    expect(frameCredentialRenewDelayMs(6)).toBe(5_000);
  });

  it("schedules nothing when the server stated no life", () => {
    expect(frameCredentialRenewDelayMs(0)).toBeNull();
    expect(frameCredentialRenewDelayMs(Number.NaN)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A REFUSAL IS NOT ALWAYS AN ANSWER (convergence finding 6).
//
// The first shape of this chain gave up for good on the first failure, which
// means ONE dropped request ended a column that would have gone on working for
// hours — and, since the pair's stated life is the SHORTER of its two halves,
// that first ask happens every few minutes, so the odds of meeting one bad
// moment are not small.
// ---------------------------------------------------------------------------
describe("the renewal's retry budget", () => {
  it("asks again on a short fixed delay, a bounded number of times, then stops", () => {
    for (let failures = 1; failures <= FRAME_RENEW_RETRY_LIMIT; failures += 1) {
      const delay = frameCredentialRenewRetryDelayMs(failures);
      expect(delay).not.toBeNull();
      // Short and FLAT: the whole budget has to fit inside the third of the life
      // the schedule leaves ahead of the first ask, and a growing backoff would
      // spend that third waiting rather than asking.
      expect(delay).toBe(15_000);
    }
    // Spent. A person who really did sign out costs three refused asks, not a
    // chain that never ends.
    expect(frameCredentialRenewRetryDelayMs(FRAME_RENEW_RETRY_LIMIT + 1)).toBeNull();
  });

  it("fits its whole budget inside the life it is renewing", () => {
    const scheduled = frameCredentialRenewDelayMs(900) as number;
    const budget = FRAME_RENEW_RETRY_LIMIT * (frameCredentialRenewRetryDelayMs(1) as number);
    // Every retry lands while the pair is still good, which is what makes a
    // refusal invisible to the reader.
    expect(scheduled + budget).toBeLessThan(900 * 1000);
  });

  it("counts nothing as a failure before there has been one", () => {
    expect(frameCredentialRenewRetryDelayMs(0)).toBeNull();
    expect(frameCredentialRenewRetryDelayMs(Number.NaN)).toBeNull();
  });
});

describe("a renewal that never comes back", () => {
  it("carries an abort signal, so a hung ask is a refusal rather than the end of the chain", async () => {
    const { impl, calls } = fetchDouble();
    await renewFrameCredential(SELECTORS, HELD, { fetchImpl: impl });
    const signal = (calls[0].init as { signal?: AbortSignal }).signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
  });

  it("refuses when the ask is aborted, without throwing into the column", async () => {
    const impl = (async (_url: string, init: RequestInit) => {
      // What fetch does on an abort: it rejects. The chain must read that as one
      // failed look, not as an error nobody catches.
      const signal = (init as { signal?: AbortSignal }).signal;
      signal?.dispatchEvent?.(new Event("abort"));
      throw new DOMException("aborted", "AbortError");
    }) as unknown as typeof fetch;
    expect(await renewFrameCredential(SELECTORS, HELD, { fetchImpl: impl })).toEqual({
      ok: false,
      reason: "renew_failed",
    });
  });
});

// `isNangoServerUnreachable` is the pure error-classifier behind cinatra#533:
// it distinguishes an infra/upstream outage (the Nango SERVER is down) from a
// request the connector legitimately rejects, so the route can surface an
// actionable 502 diagnostic instead of an opaque 400.

import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { isNangoServerUnreachable } from "../route";

/** A Node fetch network failure: `TypeError: fetch failed` + `cause.code`. */
function fetchFailed(code?: string): TypeError {
  const err = new TypeError("fetch failed");
  if (code !== undefined) {
    (err as TypeError & { cause?: { code: string } }).cause = { code };
  }
  return err;
}

describe("isNangoServerUnreachable", () => {
  it("classifies connection-refused (server not listening) as unreachable", () => {
    expect(isNangoServerUnreachable(fetchFailed("ECONNREFUSED"))).toBe(true);
  });

  it("classifies DNS failures (ENOTFOUND / EAI_AGAIN) as unreachable", () => {
    expect(isNangoServerUnreachable(fetchFailed("ENOTFOUND"))).toBe(true);
    expect(isNangoServerUnreachable(fetchFailed("EAI_AGAIN"))).toBe(true);
  });

  it("classifies connect timeouts and dropped connections as unreachable", () => {
    expect(isNangoServerUnreachable(fetchFailed("ETIMEDOUT"))).toBe(true);
    expect(isNangoServerUnreachable(fetchFailed("ECONNRESET"))).toBe(true);
    expect(isNangoServerUnreachable(fetchFailed("UND_ERR_CONNECT_TIMEOUT"))).toBe(true);
    expect(isNangoServerUnreachable(fetchFailed("UND_ERR_SOCKET"))).toBe(true);
  });

  it("classifies abort/timeout errors as unreachable", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    expect(isNangoServerUnreachable(abort)).toBe(true);
    expect(isNangoServerUnreachable(timeout)).toBe(true);
  });

  it("treats a bare `fetch failed` TypeError (no classifiable cause) as unreachable", () => {
    expect(isNangoServerUnreachable(fetchFailed())).toBe(true);
  });

  it("does NOT classify a connector-rejected request (bad input) as unreachable", () => {
    // The delegate may throw a domain error for bad input — that is NOT an outage.
    expect(isNangoServerUnreachable(new Error("Unknown connectorKey: bogus"))).toBe(false);
    // A TypeError that is not a fetch transport failure is also not an outage.
    expect(isNangoServerUnreachable(new TypeError("Cannot read properties of undefined"))).toBe(
      false,
    );
    // An unrelated cause code on a non-"fetch failed" error must not be misread
    // as an outage (e.g. a programming TypeError carrying its own cause).
    const typed = new TypeError("Cannot read properties of undefined");
    (typed as TypeError & { cause?: { code: string } }).cause = { code: "ERR_INVALID_ARG_TYPE" };
    expect(isNangoServerUnreachable(typed)).toBe(false);
  });

  it("returns false for non-Error throwables", () => {
    expect(isNangoServerUnreachable("fetch failed")).toBe(false);
    expect(isNangoServerUnreachable(null)).toBe(false);
    expect(isNangoServerUnreachable(undefined)).toBe(false);
    expect(isNangoServerUnreachable({ cause: { code: "ECONNREFUSED" } })).toBe(false);
  });
});

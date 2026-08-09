// cinatra#2539 — the installed-extension catalog renders through an
// UNREACHABLE registry, and only an unreachable one.
//
// Before this rule the catalog took the registry read's rejection with it: an
// operator whose local Verdaccio was not running saw ZERO installed extensions
// (measured on a real instance: 0 rows before, 231 after). Degrading is right
// for that class — every field the registry contributes has a local fallback.
//
// The opposite mistake is just as bad: swallowing a 401/403/404, a malformed
// body, or a plain programming error would hide a revoked token or a broken
// configuration behind a catalog that merely looks a bit sparse. So the rule is
// an ALLOW-LIST — recognised transport/abort/timeout failures and 5xx degrade,
// and EVERYTHING else, including shapes this code has never seen, fails loud.
import { describe, expect, it } from "vitest";
import { isRegistryUnreachable } from "../registry-failure-class";

function withStatus(status: number, key: "status" | "statusCode" = "status"): Error {
  const err = new Error(`registry responded ${status}`) as Error & Record<string, number>;
  err[key] = status;
  return err;
}

function withCode(code: string): Error {
  const err = new Error(code) as Error & { code: string };
  err.code = code;
  return err;
}

describe("isRegistryUnreachable (cinatra#2539)", () => {
  it("degrades on a transport failure", () => {
    expect(isRegistryUnreachable(withCode("ECONNREFUSED"))).toBe(true);
    expect(isRegistryUnreachable(withCode("ENOTFOUND"))).toBe(true);
    expect(isRegistryUnreachable(withCode("ETIMEDOUT"))).toBe(true);
    expect(isRegistryUnreachable(withCode("ERR_SOCKET_TIMEOUT"))).toBe(true);
  });

  it("unwraps the `cause` chain — `fetch` reports a refused connection as a bare TypeError", () => {
    // This is the EXACT shape undici produces, and the shape the live
    // registry-down proof exercised. Classifying only the outer error would
    // have missed it.
    const wrapped = new TypeError("fetch failed");
    (wrapped as TypeError & { cause: unknown }).cause = withCode("ECONNREFUSED");
    expect(isRegistryUnreachable(wrapped)).toBe(true);
  });

  it("degrades on an abort / timeout / budget cut-off", () => {
    const aborted = new Error("The operation was aborted");
    aborted.name = "AbortError";
    expect(isRegistryUnreachable(aborted)).toBe(true);

    const timedOut = new Error("timed out");
    timedOut.name = "TimeoutError";
    expect(isRegistryUnreachable(timedOut)).toBe(true);

    const budget = new Error("registry catalog read exceeded its 12000ms budget");
    budget.name = "RegistryCatalogBudgetExceededError";
    expect(isRegistryUnreachable(budget)).toBe(true);
  });

  it("degrades on a 5xx — the registry is up but broken on its own side", () => {
    expect(isRegistryUnreachable(withStatus(500))).toBe(true);
    expect(isRegistryUnreachable(withStatus(502))).toBe(true);
    expect(isRegistryUnreachable(withStatus(503, "statusCode"))).toBe(true);
  });

  it("does NOT swallow a credential failure — 401/403 must surface", () => {
    expect(isRegistryUnreachable(withStatus(401))).toBe(false);
    expect(isRegistryUnreachable(withStatus(403))).toBe(false);
    expect(isRegistryUnreachable(withStatus(403, "statusCode"))).toBe(false);
  });

  it("does NOT swallow a misconfigured registry URL — 404 on the enumeration must surface", () => {
    expect(isRegistryUnreachable(withStatus(404))).toBe(false);
  });

  it("does NOT swallow a malformed body, a bad URL, or a certificate problem", () => {
    expect(isRegistryUnreachable(new SyntaxError("Unexpected token < in JSON at position 0"))).toBe(false);
    expect(isRegistryUnreachable(new TypeError("Invalid URL"))).toBe(false);
    expect(isRegistryUnreachable(withCode("SELF_SIGNED_CERT_IN_CHAIN"))).toBe(false);
  });

  it("does NOT swallow a programming error or an unrecognised shape", () => {
    expect(isRegistryUnreachable(new TypeError("x is not a function"))).toBe(false);
    expect(isRegistryUnreachable("a bare string")).toBe(false);
    expect(isRegistryUnreachable({ weird: true })).toBe(false);
    const nonNumericStatus = new Error("odd") as Error & { status: string };
    nonNumericStatus.status = "418";
    expect(isRegistryUnreachable(nonNumericStatus)).toBe(false);
  });

  it("terminates on a self-referencing cause chain", () => {
    const looped = new Error("loop") as Error & { cause?: unknown };
    looped.cause = looped;
    expect(isRegistryUnreachable(looped)).toBe(false);
  });
});

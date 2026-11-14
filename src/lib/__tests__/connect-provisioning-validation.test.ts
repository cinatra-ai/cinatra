// Pure-validator coverage for cinatra#221 Connect provisioning (no DB).
//
// Covers the anti-open-redirect redirect_uri / widget_origin allowlisting,
// PKCE S256 verification, consent CSRF, the client enum, and the full
// authorize-param validation table.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

import {
  validateRedirectUri,
  validateWidgetOrigin,
  isValidCodeChallenge,
  isValidCodeVerifier,
  verifyPkceS256,
  sha256Base64Url,
  isConnectClient,
  issueConsentCsrfToken,
  verifyConsentCsrfToken,
  consumeConsentCsrfToken,
  __resetConsentCsrfConsumedForTests,
  deriveConsentRequestId,
  validateAuthorizeParams,
  CONNECT_SCOPE,
} from "@/lib/connect-provisioning";

const WP_CALLBACK =
  "https://shop.example.com/wp-admin/admin-post.php?action=cinatra_connect_callback";
const DRUPAL_CALLBACK =
  "https://news.example.com/admin/config/services/cinatra/connect/callback";

describe("validateRedirectUri (anti open-redirect)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts the exact WordPress callback contract (path + action)", () => {
    vi.stubEnv("NODE_ENV", "production");
    const r = validateRedirectUri("wordpress", WP_CALLBACK);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.callbackOrigin).toBe("https://shop.example.com");
  });

  it("accepts the exact Drupal callback contract path", () => {
    vi.stubEnv("NODE_ENV", "production");
    const r = validateRedirectUri("drupal", DRUPAL_CALLBACK);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.callbackOrigin).toBe("https://news.example.com");
  });

  it("rejects WordPress callback path WITHOUT the connect action (codex: check the action)", () => {
    expect(
      validateRedirectUri(
        "wordpress",
        "https://shop.example.com/wp-admin/admin-post.php?action=something_else",
      ).ok,
    ).toBe(false);
    expect(
      validateRedirectUri(
        "wordpress",
        "https://shop.example.com/wp-admin/admin-post.php",
      ).ok,
    ).toBe(false);
  });

  it("rejects an arbitrary path (open-redirect attempt)", () => {
    expect(
      validateRedirectUri("wordpress", "https://evil.example.com/steal?action=cinatra_connect_callback").ok,
    ).toBe(false);
    expect(validateRedirectUri("drupal", "https://news.example.com/").ok).toBe(false);
  });

  it("rejects DUPLICATE action params (codex: WP last-wins smuggling)", () => {
    expect(
      validateRedirectUri(
        "wordpress",
        "https://shop.example.com/wp-admin/admin-post.php?action=cinatra_connect_callback&action=evil",
      ).ok,
    ).toBe(false);
  });

  it("rejects EXTRA query params on the WP callback (only action allowed)", () => {
    expect(
      validateRedirectUri(
        "wordpress",
        "https://shop.example.com/wp-admin/admin-post.php?action=cinatra_connect_callback&inject=1",
      ).ok,
    ).toBe(false);
  });

  it("rejects ANY query on the Drupal callback (path-only contract)", () => {
    expect(
      validateRedirectUri(
        "drupal",
        "https://news.example.com/admin/config/services/cinatra/connect/callback?x=1",
      ).ok,
    ).toBe(false);
  });

  it("rejects http in production but allows http loopback in dev", () => {
    // Blank runtime-mode keys: the build decides, whatever the shell exports.
    vi.stubEnv("CINATRA_RUNTIME_MODE", "");
    vi.stubEnv("APP_RUNTIME_MODE", "");
    vi.stubEnv("NODE_ENV", "production");
    expect(
      validateRedirectUri(
        "wordpress",
        "http://localhost/wp-admin/admin-post.php?action=cinatra_connect_callback",
      ).ok,
    ).toBe(false);
    vi.stubEnv("NODE_ENV", "development");
    expect(
      validateRedirectUri(
        "wordpress",
        "http://localhost/wp-admin/admin-post.php?action=cinatra_connect_callback",
      ).ok,
    ).toBe(true);
    expect(
      validateRedirectUri(
        "wordpress",
        "http://127.0.0.1/wp-admin/admin-post.php?action=cinatra_connect_callback",
      ).ok,
    ).toBe(true);
    // http on a NON-loopback host stays rejected even in dev.
    expect(
      validateRedirectUri(
        "wordpress",
        "http://shop.example.com/wp-admin/admin-post.php?action=cinatra_connect_callback",
      ).ok,
    ).toBe(false);
  });

  it("rejects userinfo, fragment, CRLF/control chars, and non-http(s) schemes", () => {
    expect(
      validateRedirectUri(
        "wordpress",
        "https://user:pass@shop.example.com/wp-admin/admin-post.php?action=cinatra_connect_callback",
      ).ok,
    ).toBe(false);
    expect(
      validateRedirectUri(
        "wordpress",
        "https://shop.example.com/wp-admin/admin-post.php?action=cinatra_connect_callback#frag",
      ).ok,
    ).toBe(false);
    expect(
      validateRedirectUri(
        "wordpress",
        "https://shop.example.com/wp-admin/admin-post.php?action=cinatra_connect_callback\r\nSet-Cookie: x",
      ).ok,
    ).toBe(false);
    expect(
      validateRedirectUri(
        "wordpress",
        "javascript:alert(1)//wp-admin/admin-post.php?action=cinatra_connect_callback",
      ).ok,
    ).toBe(false);
  });
});

describe("validateWidgetOrigin", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts an https origin and normalizes default port / trailing slash", () => {
    vi.stubEnv("NODE_ENV", "production");
    const r = validateWidgetOrigin("https://shop.example.com/");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.widgetOrigin).toBe("https://shop.example.com");
    const r2 = validateWidgetOrigin("https://shop.example.com:443");
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.widgetOrigin).toBe("https://shop.example.com");
  });

  it("normalizes punycode and preserves non-default port", () => {
    vi.stubEnv("NODE_ENV", "production");
    const r = validateWidgetOrigin("https://xn--mnchen-3ya.example:8443");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.widgetOrigin).toBe("https://xn--mnchen-3ya.example:8443");
  });

  it("rejects the literal null, paths, queries, fragments, userinfo", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(validateWidgetOrigin("null").ok).toBe(false);
    expect(validateWidgetOrigin("https://shop.example.com/path").ok).toBe(false);
    expect(validateWidgetOrigin("https://shop.example.com/?q=1").ok).toBe(false);
    expect(validateWidgetOrigin("https://shop.example.com/#f").ok).toBe(false);
    expect(validateWidgetOrigin("https://u:p@shop.example.com").ok).toBe(false);
  });

  it("rejects a host that is a shape, not a place — with a message to act on", () => {
    vi.stubEnv("NODE_ENV", "production");
    // Every one of these survives `new URL()`; the parser is not a validator.
    // The shared origin resolver is what refuses them at this door.
    for (const candidate of [
      "*",
      "https://*",
      "https://*.example.com",
      "https://%2A.example.com",
      "https://.example.com",
      "https://shop.example..com",
    ]) {
      const verdict = validateWidgetOrigin(candidate);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason.length).toBeGreaterThan(0);
    }
  });

  it("rejects http in prod, allows http loopback in dev", () => {
    // Blank runtime-mode keys: the build decides, whatever the shell exports.
    vi.stubEnv("CINATRA_RUNTIME_MODE", "");
    vi.stubEnv("APP_RUNTIME_MODE", "");
    vi.stubEnv("NODE_ENV", "production");
    expect(validateWidgetOrigin("http://shop.example.com").ok).toBe(false);
    expect(validateWidgetOrigin("http://localhost:3000").ok).toBe(false);
    vi.stubEnv("NODE_ENV", "development");
    expect(validateWidgetOrigin("http://localhost:3000").ok).toBe(true);
    expect(validateWidgetOrigin("http://shop.example.com").ok).toBe(false);
  });
});

describe("PKCE S256", () => {
  it("accepts a 43-char base64url challenge, rejects others", () => {
    const verifier = "a".repeat(43);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    expect(isValidCodeChallenge(challenge)).toBe(true);
    expect(isValidCodeChallenge("short")).toBe(false);
    expect(isValidCodeChallenge("+".repeat(43))).toBe(false); // not base64url
    expect(isValidCodeChallenge("a".repeat(44))).toBe(false);
  });

  it("verifies base64url(sha256(verifier)) === challenge", () => {
    const verifier = "verifier-" + "x".repeat(40);
    const challenge = sha256Base64Url(verifier);
    expect(verifyPkceS256(verifier, challenge)).toBe(true);
    expect(verifyPkceS256(verifier + "tamper", challenge)).toBe(false);
    expect(verifyPkceS256("", challenge)).toBe(false);
    expect(verifyPkceS256(verifier, "")).toBe(false);
  });

  it("rejects a degenerate (too-short) code_verifier even if it hashes to the challenge (codex Low)", () => {
    // A 1-char verifier is brute-forceable; RFC 7636 requires 43–128 chars.
    const tiny = "x";
    const challenge = sha256Base64Url(tiny);
    expect(verifyPkceS256(tiny, challenge)).toBe(false);
    expect(isValidCodeVerifier(tiny)).toBe(false);
    expect(isValidCodeVerifier("a".repeat(43))).toBe(true);
    expect(isValidCodeVerifier("a".repeat(129))).toBe(false);
    expect(isValidCodeVerifier("has space " + "a".repeat(40))).toBe(false);
  });
});

describe("isConnectClient", () => {
  it("accepts wordpress|drupal, rejects others", () => {
    expect(isConnectClient("wordpress")).toBe(true);
    expect(isConnectClient("drupal")).toBe(true);
    expect(isConnectClient("joomla")).toBe(false);
    expect(isConnectClient("")).toBe(false);
    expect(isConnectClient(undefined)).toBe(false);
  });
});

describe("consent CSRF token", () => {
  beforeEach(() => {
    process.env.CINATRA_ENCRYPTION_KEY = "0".repeat(64);
    __resetConsentCsrfConsumedForTests();
  });

  it("round-trips when session+request match and is not expired", () => {
    const token = issueConsentCsrfToken({ sessionId: "s1", requestId: "r1" });
    expect(verifyConsentCsrfToken({ token, sessionId: "s1", requestId: "r1" })).toBe(true);
  });

  it("consumeConsentCsrfToken is SINGLE-USE: second use of the same token is rejected (codex Medium)", () => {
    const token = issueConsentCsrfToken({ sessionId: "s1", requestId: "r1" });
    expect(consumeConsentCsrfToken({ token, sessionId: "s1", requestId: "r1" })).toBe(true);
    // Replay (same session, same token) is rejected.
    expect(consumeConsentCsrfToken({ token, sessionId: "s1", requestId: "r1" })).toBe(false);
    // A fresh token still works.
    const token2 = issueConsentCsrfToken({ sessionId: "s1", requestId: "r1" });
    expect(consumeConsentCsrfToken({ token: token2, sessionId: "s1", requestId: "r1" })).toBe(true);
  });

  it("rejects when sessionId or requestId differ (CSRF binding)", () => {
    const token = issueConsentCsrfToken({ sessionId: "s1", requestId: "r1" });
    expect(verifyConsentCsrfToken({ token, sessionId: "s2", requestId: "r1" })).toBe(false);
    expect(verifyConsentCsrfToken({ token, sessionId: "s1", requestId: "r2" })).toBe(false);
  });

  it("rejects an expired token and garbage", () => {
    const token = issueConsentCsrfToken({ sessionId: "s1", requestId: "r1", ttlMs: -1 });
    expect(verifyConsentCsrfToken({ token, sessionId: "s1", requestId: "r1" })).toBe(false);
    expect(verifyConsentCsrfToken({ token: "garbage", sessionId: "s1", requestId: "r1" })).toBe(false);
    expect(verifyConsentCsrfToken({ token: "", sessionId: "s1", requestId: "r1" })).toBe(false);
  });

  it("requestId changes if any shown param changes (no param smuggling, incl. state)", () => {
    const base = {
      client: "wordpress" as const,
      redirectUri: WP_CALLBACK,
      widgetOrigin: "https://shop.example.com",
      codeChallenge: "c".repeat(43),
      scope: CONNECT_SCOPE,
      state: "state-1",
    };
    const id1 = deriveConsentRequestId(base);
    expect(deriveConsentRequestId({ ...base, widgetOrigin: "https://other.example.com" })).not.toBe(id1);
    // state is bound: changing it changes the requestId (CSRF token won't verify).
    expect(deriveConsentRequestId({ ...base, state: "state-2" })).not.toBe(id1);
  });
});

describe("validateAuthorizeParams", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const good = {
    client: "wordpress",
    redirect_uri: WP_CALLBACK,
    widget_origin: "https://shop.example.com",
    state: "opaque-state",
    scope: CONNECT_SCOPE,
    code_challenge: "c".repeat(43),
    code_challenge_method: "S256",
  };

  it("accepts a fully valid param set and derives canonical origins + requestId", () => {
    const r = validateAuthorizeParams(good);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params.callbackOrigin).toBe("https://shop.example.com");
      expect(r.params.widgetOrigin).toBe("https://shop.example.com");
      expect(r.params.requestId).toHaveLength(43); // base64url sha256
    }
  });

  it("rejects wrong scope, wrong method, bad challenge, oversized/empty state", () => {
    expect(validateAuthorizeParams({ ...good, scope: "openid" }).ok).toBe(false);
    expect(validateAuthorizeParams({ ...good, code_challenge_method: "plain" }).ok).toBe(false);
    expect(validateAuthorizeParams({ ...good, code_challenge: "short" }).ok).toBe(false);
    expect(validateAuthorizeParams({ ...good, state: "" }).ok).toBe(false);
    expect(validateAuthorizeParams({ ...good, state: "x".repeat(257) }).ok).toBe(false);
    expect(validateAuthorizeParams({ ...good, client: "joomla" }).ok).toBe(false);
  });

  it("rejects a redirect_uri that does not match the client callback contract", () => {
    expect(
      validateAuthorizeParams({ ...good, redirect_uri: "https://evil.example.com/x" }).ok,
    ).toBe(false);
  });
});

// The http exception follows the app's RUNTIME MODE, not the build: an
// application built for production that its operator runs in development mode
// (CINATRA_RUNTIME_MODE / APP_RUNTIME_MODE) takes a loopback http callback and
// widget origin; an instance in production mode never does, and a non-loopback
// http address is refused in every mode. Each case sets both mode keys itself so
// the reading never depends on the environment the suite runs in.
describe("loopback http follows the runtime mode, not the build", () => {
  type Mode = { NODE_ENV: string; CINATRA_RUNTIME_MODE?: string; APP_RUNTIME_MODE?: string };
  function runAs(mode: Mode) {
    vi.stubEnv("NODE_ENV", mode.NODE_ENV);
    vi.stubEnv("CINATRA_RUNTIME_MODE", mode.CINATRA_RUNTIME_MODE ?? "");
    vi.stubEnv("APP_RUNTIME_MODE", mode.APP_RUNTIME_MODE ?? "");
  }
  const PRODUCTION_BUILD_DEVELOPMENT_MODE: Mode = {
    NODE_ENV: "production",
    CINATRA_RUNTIME_MODE: "development",
  };
  const EVERY_MODE: Mode[] = [
    { NODE_ENV: "production" },
    { NODE_ENV: "production", CINATRA_RUNTIME_MODE: "production" },
    PRODUCTION_BUILD_DEVELOPMENT_MODE,
    { NODE_ENV: "production", APP_RUNTIME_MODE: "development" },
    { NODE_ENV: "development" },
    { NODE_ENV: "development", CINATRA_RUNTIME_MODE: "production" },
  ];
  const WP_LOOPBACK =
    "http://localhost:8080/wp-admin/admin-post.php?action=cinatra_connect_callback";
  const DRUPAL_LOOPBACK = "http://127.0.0.1:8081/admin/config/services/cinatra/connect/callback";

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("a production build in development mode accepts a loopback http redirect_uri", () => {
    runAs(PRODUCTION_BUILD_DEVELOPMENT_MODE);
    const wp = validateRedirectUri("wordpress", WP_LOOPBACK);
    expect(wp).toEqual({ ok: true, callbackOrigin: "http://localhost:8080" });
    const drupal = validateRedirectUri("drupal", DRUPAL_LOOPBACK);
    expect(drupal).toEqual({ ok: true, callbackOrigin: "http://127.0.0.1:8081" });
  });

  it("a production build in development mode accepts a loopback http widget_origin", () => {
    runAs(PRODUCTION_BUILD_DEVELOPMENT_MODE);
    expect(validateWidgetOrigin("http://localhost:8080")).toEqual({
      ok: true,
      widgetOrigin: "http://localhost:8080",
    });
    expect(validateWidgetOrigin("http://127.0.0.1:8081")).toEqual({
      ok: true,
      widgetOrigin: "http://127.0.0.1:8081",
    });
  });

  it("the second mode key reads the same way when the first is unset", () => {
    runAs({ NODE_ENV: "production", APP_RUNTIME_MODE: "development" });
    expect(validateRedirectUri("wordpress", WP_LOOPBACK).ok).toBe(true);
    expect(validateWidgetOrigin("http://localhost:8080").ok).toBe(true);
  });

  it("a production build in development mode validates a whole loopback authorize request", () => {
    runAs(PRODUCTION_BUILD_DEVELOPMENT_MODE);
    const r = validateAuthorizeParams({
      client: "wordpress",
      redirect_uri: WP_LOOPBACK,
      widget_origin: "http://localhost:8080",
      state: "opaque-state",
      scope: CONNECT_SCOPE,
      code_challenge: "c".repeat(43),
      code_challenge_method: "S256",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params.callbackOrigin).toBe("http://localhost:8080");
      expect(r.params.widgetOrigin).toBe("http://localhost:8080");
    }
  });

  it("a development build declared production refuses loopback http (the mode decides both ways)", () => {
    runAs({ NODE_ENV: "development", CINATRA_RUNTIME_MODE: "production" });
    expect(validateRedirectUri("wordpress", WP_LOOPBACK).ok).toBe(false);
    expect(validateWidgetOrigin("http://localhost:8080")).toEqual({
      ok: false,
      reason: "Use an https:// address.",
    });
  });

  it("a production build in production mode refuses loopback http, with no mode key and with the production key", () => {
    for (const mode of [
      { NODE_ENV: "production" },
      { NODE_ENV: "production", CINATRA_RUNTIME_MODE: "production" },
    ]) {
      runAs(mode);
      expect(validateRedirectUri("wordpress", WP_LOOPBACK).ok).toBe(false);
      expect(validateRedirectUri("drupal", DRUPAL_LOOPBACK).ok).toBe(false);
      expect(validateWidgetOrigin("http://localhost:8080")).toEqual({
        ok: false,
        reason: "Use an https:// address.",
      });
    }
  });

  it("refuses non-loopback http in every mode", () => {
    for (const mode of EVERY_MODE) {
      runAs(mode);
      for (const host of ["shop.example.com", "localhost.example.com", "10.0.0.5"]) {
        expect(
          validateRedirectUri(
            "wordpress",
            `http://${host}/wp-admin/admin-post.php?action=cinatra_connect_callback`,
          ).ok,
        ).toBe(false);
        expect(validateWidgetOrigin(`http://${host}`).ok).toBe(false);
      }
    }
  });

  it("https reads the same in every mode", () => {
    for (const mode of EVERY_MODE) {
      runAs(mode);
      expect(validateRedirectUri("wordpress", WP_CALLBACK)).toEqual({
        ok: true,
        callbackOrigin: "https://shop.example.com",
      });
      expect(validateRedirectUri("drupal", DRUPAL_CALLBACK)).toEqual({
        ok: true,
        callbackOrigin: "https://news.example.com",
      });
      expect(validateRedirectUri("wordpress", "https://shop.example.com/x").ok).toBe(false);
      expect(validateWidgetOrigin("https://localhost:8443")).toEqual({
        ok: true,
        widgetOrigin: "https://localhost:8443",
      });
      expect(validateWidgetOrigin("https://shop.example.com/path").ok).toBe(false);
    }
  });
});

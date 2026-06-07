// Tests for createNpmUser HTTP helper.
//
// Covers the expected createNpmUser response-handling cases:
//   1. 201 + { token: "abc" } -> returns { token: "abc" }
//   2. 201 + body missing token -> throws VerdaccioUnexpectedResponseError
//   3. 201 + { token: 123 } (wrong type) -> throws VerdaccioUnexpectedResponseError
//   4. 409 + "already registered" -> throws VerdaccioUserAlreadyRegisteredError
//   5. 409 + "user registration disabled" -> throws VerdaccioRegistrationDisabledError
//   6. 500 -> throws generic Error (no body reflection)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createNpmUser,
  VerdaccioUserAlreadyRegisteredError,
  VerdaccioRegistrationDisabledError,
} from "../src/verdaccio/user-provisioning";
import { VerdaccioUnexpectedResponseError } from "../src/verdaccio/errors";

const ORIGINAL_FETCH = globalThis.fetch;

function mockFetch(status: number, body: unknown, asText = false): void {
  globalThis.fetch = vi.fn(async () => {
    if (asText) {
      return new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "content-type": "text/plain" },
      });
    }
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

const VALID_OPTS = {
  instanceNamespace: "example-namespace",
  password: "x".repeat(43),
  email: "operator@example.com",
  registryUrl: "https://registry.cinatra.ai",
};

describe("createNpmUser — happy path", () => {
  it("returns token on 201 + valid body", async () => {
    mockFetch(201, { token: "verdaccio-token-abc" });
    const result = await createNpmUser(VALID_OPTS);
    expect(result).toEqual({ token: "verdaccio-token-abc" });
  });

  it("issues PUT to /-/user/org.couchdb.user:<name> with documented body shape", async () => {
    mockFetch(201, { token: "tok" });
    await createNpmUser(VALID_OPTS);
    const fetchMock = vi.mocked(globalThis.fetch);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toMatch(/\/-\/user\/org\.couchdb\.user:example-namespace$/);
    expect((init as RequestInit).method).toBe("PUT");
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get("content-type")?.toLowerCase()).toBe("application/json");
    const parsed = JSON.parse(String((init as RequestInit).body));
    expect(parsed).toEqual(
      expect.objectContaining({
        _id: "org.couchdb.user:example-namespace",
        name: "example-namespace",
        type: "user",
        roles: [],
      }),
    );
    expect(typeof parsed.password).toBe("string");
    expect(typeof parsed.email).toBe("string");
    expect(typeof parsed.date).toBe("string");
  });

  it("does NOT send an authorization header (anonymous adduser)", async () => {
    mockFetch(201, { token: "tok" });
    await createNpmUser(VALID_OPTS);
    const fetchMock = vi.mocked(globalThis.fetch);
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.has("authorization")).toBe(false);
  });
});

describe("createNpmUser — VerdaccioUnexpectedResponseError", () => {
  it("throws when 201 body has no token field", async () => {
    mockFetch(201, { ok: true });
    await expect(createNpmUser(VALID_OPTS)).rejects.toBeInstanceOf(
      VerdaccioUnexpectedResponseError,
    );
  });

  it("throws when 201 body has token of wrong type (number)", async () => {
    mockFetch(201, { token: 123 });
    await expect(createNpmUser(VALID_OPTS)).rejects.toBeInstanceOf(
      VerdaccioUnexpectedResponseError,
    );
  });

  it("error message tells maintainers to update the response parser", async () => {
    mockFetch(201, {});
    await expect(createNpmUser(VALID_OPTS)).rejects.toThrow(
      /Update the createNpmUser response parser/,
    );
  });
});

describe("createNpmUser — 409 typed error mapping", () => {
  it("maps 409 + 'already registered' to VerdaccioUserAlreadyRegisteredError", async () => {
    mockFetch(409, { error: "user oss is already registered" });
    await expect(createNpmUser(VALID_OPTS)).rejects.toBeInstanceOf(
      VerdaccioUserAlreadyRegisteredError,
    );
  });

  it("maps 409 + 'user registration disabled' to VerdaccioRegistrationDisabledError", async () => {
    mockFetch(409, { error: "user registration disabled" });
    await expect(createNpmUser(VALID_OPTS)).rejects.toBeInstanceOf(
      VerdaccioRegistrationDisabledError,
    );
  });
});

describe("createNpmUser — generic non-2xx", () => {
  it("throws generic Error on 500 with status code", async () => {
    mockFetch(500, { error: "internal error" });
    await expect(createNpmUser(VALID_OPTS)).rejects.toThrow(/HTTP 500/);
  });

  it("does NOT include the response body in the error message", async () => {
    const sensitiveBody = "INPUT_REFLECTED_PASSWORD_LEAK";
    mockFetch(500, sensitiveBody, true);
    let caught: Error | null = null;
    try {
      await createNpmUser(VALID_OPTS);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught?.message).toMatch(/HTTP 500/);
    expect(caught?.message ?? "").not.toContain(sensitiveBody);
  });
});

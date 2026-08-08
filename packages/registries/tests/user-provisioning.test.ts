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
  VerdaccioUserCredentialConflictError,
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

describe("createNpmUser — 401 credential-conflict mapping (cinatra#2500)", () => {
  it("maps 401 to VerdaccioUserCredentialConflictError, NOT the generic throw", async () => {
    mockFetch(401, { error: "unauthorized" });
    const caught = await createNpmUser(VALID_OPTS).catch((err: unknown) => err);
    expect(caught).toBeInstanceOf(VerdaccioUserCredentialConflictError);
    // The regression this guards: a 401 used to fall through to the generic
    // "HTTP <status>" throw, which the actions map to the opaque
    // "registry-provision-failed" flash ("see server logs").
    expect((caught as Error).message).not.toMatch(/HTTP 401/);
  });

  it("carries the discriminating code so call sites can branch on it", async () => {
    mockFetch(401, { error: "unauthorized" });
    const caught = (await createNpmUser(VALID_OPTS).catch(
      (err: unknown) => err,
    )) as VerdaccioUserCredentialConflictError;
    expect(caught.code).toBe("USER_CREDENTIAL_CONFLICT");
    expect(caught.name).toBe("VerdaccioUserCredentialConflictError");
  });

  it("never reflects the 401 response body (no password echo)", async () => {
    const sensitiveBody = "INPUT_REFLECTED_PASSWORD_LEAK";
    mockFetch(401, sensitiveBody, true);
    const caught = (await createNpmUser(VALID_OPTS).catch((err: unknown) => err)) as Error;
    expect(caught).toBeInstanceOf(VerdaccioUserCredentialConflictError);
    expect(caught.message).not.toContain(sensitiveBody);
    // The body is not even READ on this path — the status is the whole
    // discriminator, unlike the 409 branch which must read to disambiguate.
    expect(caught.message).not.toContain(VALID_OPTS.password);
  });

  it("leaves the 409 'already registered' class untouched (distinct remedy)", async () => {
    mockFetch(409, { error: "user oss is already registered" });
    await expect(createNpmUser(VALID_OPTS)).rejects.toBeInstanceOf(
      VerdaccioUserAlreadyRegisteredError,
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

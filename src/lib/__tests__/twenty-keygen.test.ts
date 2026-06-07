import { describe, expect, it, vi } from "vitest";

import {
  SEED_APPLE_WORKSPACE_ID,
  buildSeedDevArgs,
  buildGenerateApiKeyArgs,
  parseTwentyApiKey,
  probeTwentyBearer,
} from "../twenty-keygen.mjs";

describe("buildSeedDevArgs", () => {
  it("is the idempotent --light Apple-workspace seed", () => {
    expect(buildSeedDevArgs()).toEqual(["yarn", "command:prod", "workspace:seed:dev", "--light"]);
  });
});

describe("buildGenerateApiKeyArgs", () => {
  it("defaults to the Apple workspace and omits -e when no expiry", () => {
    expect(buildGenerateApiKeyArgs({ keyName: "cinatra-dev-auto" })).toEqual([
      "yarn",
      "command:prod",
      "workspace:generate-api-key",
      "-w",
      SEED_APPLE_WORKSPACE_ID,
      "-n",
      "cinatra-dev-auto",
    ]);
  });

  it("appends -e <days> when expireDays is set", () => {
    expect(buildGenerateApiKeyArgs({ keyName: "k", expireDays: 1 })).toContain("-e");
    expect(buildGenerateApiKeyArgs({ keyName: "k", expireDays: 1 }).at(-1)).toBe("1");
  });

  it("honors a custom workspaceId", () => {
    const args = buildGenerateApiKeyArgs({ workspaceId: "ws-9", keyName: "k" });
    expect(args[args.indexOf("-w") + 1]).toBe("ws-9");
  });

  it("requires a keyName", () => {
    // @ts-expect-error keyName is required
    expect(() => buildGenerateApiKeyArgs({})).toThrow(/keyName/);
  });
});

describe("parseTwentyApiKey", () => {
  it("extracts a JWT from decorated CLI output", () => {
    const out = "info: minted key\n  eyJhbGciOiJI.eyJzdWIiOiIxMjM.SflKxwRJSMeKKF2QT4\n done";
    expect(parseTwentyApiKey(out)).toBe("eyJhbGciOiJI.eyJzdWIiOiIxMjM.SflKxwRJSMeKKF2QT4");
  });

  it("returns null when there is no JWT", () => {
    expect(parseTwentyApiKey("no token here")).toBeNull();
    expect(parseTwentyApiKey(undefined)).toBeNull();
  });
});

// A fetch-typed mock so `mock.calls[0]` is a proper [input, init?] tuple.
const makeFetch = (impl: (url: string | URL | Request, init?: RequestInit) => Promise<Response>) =>
  vi.fn(impl);
const response = (status: number): Response => ({ ok: status >= 200 && status < 300, status }) as Response;

describe("probeTwentyBearer", () => {
  it("is 'unreachable' without an apiKey (never calls fetch)", async () => {
    const fetchImpl = makeFetch(async () => response(200));
    expect(await probeTwentyBearer({ baseUrl: "http://localhost:3300", apiKey: "", fetchImpl })).toBe("unreachable");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does an authenticated REST read and is 'ok' on 2xx", async () => {
    const fetchImpl = makeFetch(async () => response(200));
    expect(await probeTwentyBearer({ baseUrl: "http://localhost:3300/", apiKey: "jwt-abc", fetchImpl })).toBe("ok");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://localhost:3300/rest/companies?limit=1");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer jwt-abc" });
  });

  it("is 'unauthorized' on 401/403 (the key is stale → caller rotates)", async () => {
    const f401 = makeFetch(async () => response(401));
    const f403 = makeFetch(async () => response(403));
    expect(await probeTwentyBearer({ baseUrl: "http://localhost:3300", apiKey: "jwt", fetchImpl: f401 })).toBe("unauthorized");
    expect(await probeTwentyBearer({ baseUrl: "http://localhost:3300", apiKey: "jwt", fetchImpl: f403 })).toBe("unauthorized");
  });

  it("is 'unreachable' on a 5xx (indeterminate → caller keeps the key)", async () => {
    const fetchImpl = makeFetch(async () => response(503));
    expect(await probeTwentyBearer({ baseUrl: "http://localhost:3300", apiKey: "jwt", fetchImpl })).toBe("unreachable");
  });

  it("is 'unreachable' when the request throws (network / aborted)", async () => {
    const fetchImpl = makeFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(await probeTwentyBearer({ baseUrl: "http://localhost:3300", apiKey: "jwt", fetchImpl })).toBe("unreachable");
  });
});

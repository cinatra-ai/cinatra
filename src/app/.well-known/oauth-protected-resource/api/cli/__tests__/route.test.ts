// cinatra#2478 — the `/api/cli` RFC 9728 protected-resource document must
// advertise the PUBLIC origin.
//
// Regression under test, measured live during cinatra-cli#204: on a deployment
// that hands the app its own bind-origin URL, this route served
// `{"resource":"https://0.0.0.0:3102/api/cli",
//   "authorization_servers":["https://0.0.0.0:3102/api/auth"]}` — unusable
// discovery output, which is why that CLI hard-codes the `/api/auth` mount.
//
// These cases drive the REAL route handler against real `Request` objects and
// the REAL `rewriteJsonOriginResponse` (nothing mocked — the route imports the
// app-graph-free `@cinatra-ai/mcp-server/origin-rewrite` leaf precisely so this
// suite exercises the production treatment).

import { afterEach, describe, expect, it } from "vitest";

import { GET, OPTIONS, dynamic, runtime } from "../route";

const INTERNAL = "https://0.0.0.0:3102";
const PUBLIC = "https://cinatra.ossflywheel.com";
const METADATA_PATH = "/.well-known/oauth-protected-resource/api/cli";

const CLI_SCOPES_EXPECTED = [
  "cli:status",
  "cli:agent:read",
  "cli:agent:write",
  "cli:extensions:read",
  "cli:extensions:write",
];

function proxiedRequest(origin = INTERNAL): Request {
  return new Request(`${origin}${METADATA_PATH}`, {
    headers: {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "cinatra.ossflywheel.com",
    },
  });
}

async function metadataOf(request: Request) {
  const response = await GET(request);
  expect(response.status).toBe(200);
  return { response, body: (await response.json()) as Record<string, unknown> };
}

const savedAppUrl = process.env.NEXT_PUBLIC_APP_URL;

afterEach(() => {
  if (savedAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = savedAppUrl;
});

describe("GET /.well-known/oauth-protected-resource/api/cli — behind a proxy", () => {
  it("advertises the public origin in resource AND authorization_servers", async () => {
    const { body } = await metadataOf(proxiedRequest());

    expect(body.resource).toBe(`${PUBLIC}/api/cli`);
    expect(body.authorization_servers).toEqual([`${PUBLIC}/api/auth`]);
  });

  it("leaves NO trace of the internal bind origin anywhere in the document", async () => {
    // Read the raw body: an internal origin that survived in some OTHER field
    // (or a future added field) is a defect of the same class, not a pass.
    const raw = await (await GET(proxiedRequest())).text();

    expect(raw).not.toContain("0.0.0.0");
    expect(raw).toContain(PUBLIC);
  });

  it("rewrites a localhost bind origin too (the dev-behind-a-tunnel shape)", async () => {
    const { body } = await metadataOf(proxiedRequest("http://localhost:3000"));

    expect(body.resource).toBe(`${PUBLIC}/api/cli`);
    expect(body.authorization_servers).toEqual([`${PUBLIC}/api/auth`]);
  });

  it("keeps the non-origin fields intact through the rewrite", async () => {
    const { body } = await metadataOf(proxiedRequest());

    expect(body.scopes_supported).toEqual(CLI_SCOPES_EXPECTED);
    expect(body.bearer_methods_supported).toEqual(["header"]);
    expect(body.resource_name).toBe("Cinatra CLI control plane");
  });

  it("keeps the CORS + no-store headers on the rewritten response", async () => {
    const { response } = await metadataOf(proxiedRequest());

    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toContain("application/json");
    // The rewrite changes the byte length; a stale content-length would
    // truncate the document on the wire.
    expect(response.headers.get("content-length")).toBeNull();
  });

  it("does not itself promote a half-set forwarded pair to the public origin", async () => {
    // Scope of this case, stated precisely: it pins what THIS HANDLER does with
    // the `Request` it is given. It is NOT a claim that a wire request carrying
    // a lone `x-forwarded-host` cannot reach the client's chosen host in the
    // document — measured 2026-08-06 on both `next dev` and `next start`
    // (Next 16.2.10), the server folds `x-forwarded-host` into `request.url`
    // BEFORE the handler runs, so such a request yields that host on this route
    // and equally on the already-shipped `/api/mcp` sibling. Stripping
    // client-supplied forwarded headers is the reverse proxy's job; the handler
    // simply does not add a second, weaker promotion path of its own.
    const { body } = await metadataOf(
      new Request(`${INTERNAL}${METADATA_PATH}`, { headers: { "x-forwarded-host": "attacker.example" } }),
    );

    expect(body.resource).toBe(`${INTERNAL}/api/cli`);
    expect(body.authorization_servers).toEqual([`${INTERNAL}/api/auth`]);
  });
});

describe("GET /.well-known/oauth-protected-resource/api/cli — unproxied (unchanged)", () => {
  it("serves the request origin verbatim when no proxy headers are present", async () => {
    const { body } = await metadataOf(new Request(`http://localhost:3103${METADATA_PATH}`));

    expect(body.resource).toBe("http://localhost:3103/api/cli");
    expect(body.authorization_servers).toEqual(["http://localhost:3103/api/auth"]);
    expect(body.scopes_supported).toEqual(CLI_SCOPES_EXPECTED);
  });

  it("is a no-op when the forwarded pair names the SAME origin the request arrived at", async () => {
    const { body } = await metadataOf(
      new Request(`https://cinatra.ossflywheel.com${METADATA_PATH}`, {
        headers: { "x-forwarded-proto": "https", "x-forwarded-host": "cinatra.ossflywheel.com" },
      }),
    );

    expect(body.resource).toBe(`${PUBLIC}/api/cli`);
    expect(body.authorization_servers).toEqual([`${PUBLIC}/api/auth`]);
  });
});

describe("route contract", () => {
  it("OPTIONS preflights with the CORS headers and no body", async () => {
    const response = OPTIONS();

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("stays dynamic on the node runtime — the document is per-request", async () => {
    // A cached/static render would freeze one requester's origin into every
    // other requester's document.
    expect(runtime).toBe("nodejs");
    expect(dynamic).toBe("force-dynamic");
  });
});

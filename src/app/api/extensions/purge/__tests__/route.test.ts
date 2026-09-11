/**
 * /api/extensions/purge — the irreversible extension purge.
 *
 * This route is EXEMPT from the sign-in middleware by design (its caller is a
 * cookieless local shell), so the handler's own gate is the whole of its
 * authorization. Before this change that gate was a `Host` header plus a digest
 * a caller could compute offline. Here the digest handshake is unchanged and
 * the route is additionally unreachable without a loopback socket and the
 * per-boot credential.
 *
 * The route deliberately gets NO session requirement — it has no session to
 * read — so nothing here asserts one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const { purgeExtensionMock, FakePurgeRefused } = vi.hoisted(() => ({
  purgeExtensionMock: vi.fn(async () => ({ purged: true })),
  // Hoisted with the mock: vi.mock's factory runs before any top-level class
  // declaration in this file would have initialised.
  FakePurgeRefused: class FakePurgeRefused extends Error {},
}));

vi.mock("@cinatra-ai/extensions/purge", () => ({
  purgeExtension: purgeExtensionMock,
  ExtensionPurgeRefused: FakePurgeRefused,
}));
vi.mock("@cinatra-ai/extensions/purge-deps", () => ({
  defaultPurgeDeps: vi.fn(async () => ({})),
}));
// Side-effect-only import in the route; the real module drags the extension
// registry graph in behind a gate that must stay cheap to evaluate.
vi.mock("@/lib/extensions", () => ({}));

import {
  BOOT_CREDENTIAL_HEADER,
  INSTANCE_DATA_DIR_ENV,
  mintBootCredential,
} from "@/lib/boot-credential";
import {
  CLIENT_FORWARDED_HEADER,
  NO_CLIENT_FORWARDED,
  SOCKET_PEER_HEADER,
} from "@/lib/request-peer";
import { POST } from "@/app/api/extensions/purge/route";

let dataDir: string;
let secret: string;

beforeEach(() => {
  vi.clearAllMocks();
  dataDir = mkdtempSync(path.join(tmpdir(), "cinatra-purge-route-"));
  // stubEnv rather than assignment: NODE_ENV is typed read-only, and
  // unstubAllEnvs restores every one of these without replacing process.env.
  vi.stubEnv(INSTANCE_DATA_DIR_ENV, dataDir);
  vi.stubEnv("CINATRA_RUNTIME_MODE", "development");
  vi.stubEnv("NODE_ENV", "development");
  secret = mintBootCredential(process.env);
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function request(
  body: Record<string, unknown> = {
    packageName: "@acme/thing",
    expectedDigest: "sha256-plan",
  },
  extra: Record<string, string> = {},
) {
  return new Request("http://localhost:3000/api/extensions/purge", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [SOCKET_PEER_HEADER]: "127.0.0.1",
      [CLIENT_FORWARDED_HEADER]: NO_CLIENT_FORWARDED,
      [BOOT_CREDENTIAL_HEADER]: secret,
      ...extra,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/extensions/purge — the local-caller gate", () => {
  it("purges for the operator's own loopback call with the credential", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(purgeExtensionMock).toHaveBeenCalledTimes(1);
  });

  it("REFUSES a Host: localhost request with a synthesised forwarded chain", async () => {
    const response = await POST(
      request(undefined, {
        host: "localhost:3000",
        "x-forwarded-for": "127.0.0.1",
        "x-forwarded-proto": "http",
        [SOCKET_PEER_HEADER]: "2001:db8::1",
        [CLIENT_FORWARDED_HEADER]: "x-forwarded-for,x-forwarded-proto",
      }),
    );
    expect(response.status).toBe(403);
    expect(purgeExtensionMock).not.toHaveBeenCalled();
  });

  it("is no longer reachable with a correct digest but NO credential", async () => {
    const noCredential = new Request(
      "http://localhost:3000/api/extensions/purge",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [SOCKET_PEER_HEADER]: "127.0.0.1",
          [CLIENT_FORWARDED_HEADER]: NO_CLIENT_FORWARDED,
        },
        body: JSON.stringify({
          packageName: "@acme/thing",
          expectedDigest: "sha256-plan",
        }),
      },
    );
    const response = await POST(noCredential);
    expect(response.status).toBe(403);
    expect(purgeExtensionMock).not.toHaveBeenCalled();
  });

  it("refuses a remote peer holding the credential", async () => {
    const response = await POST(
      request(undefined, { [SOCKET_PEER_HEADER]: "2001:db8::1" }),
    );
    expect(response.status).toBe(403);
    expect(purgeExtensionMock).not.toHaveBeenCalled();
  });

  it("refuses an unstamped request", async () => {
    const unstamped = new Request("http://localhost:3000/api/extensions/purge", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [BOOT_CREDENTIAL_HEADER]: secret,
      },
      body: JSON.stringify({
        packageName: "@acme/thing",
        expectedDigest: "sha256-plan",
      }),
    });
    const response = await POST(unstamped);
    expect(response.status).toBe(403);
    expect(purgeExtensionMock).not.toHaveBeenCalled();
  });

  it("refuses outside a development runtime", async () => {
    vi.stubEnv("CINATRA_RUNTIME_MODE", "production");
    const response = await POST(request());
    expect(response.status).toBe(403);
    expect(purgeExtensionMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/extensions/purge — the digest handshake is unchanged", () => {
  it("still requires expectedDigest behind the new gate", async () => {
    const response = await POST(request({ packageName: "@acme/thing" }));
    expect(response.status).toBe(400);
    expect(purgeExtensionMock).not.toHaveBeenCalled();
  });

  it("still requires packageName behind the new gate", async () => {
    const response = await POST(request({ expectedDigest: "sha256-plan" }));
    expect(response.status).toBe(400);
    expect(purgeExtensionMock).not.toHaveBeenCalled();
  });

  it("still answers an invalid JSON body with 400", async () => {
    const bad = new Request("http://localhost:3000/api/extensions/purge", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SOCKET_PEER_HEADER]: "127.0.0.1",
        [CLIENT_FORWARDED_HEADER]: NO_CLIENT_FORWARDED,
        [BOOT_CREDENTIAL_HEADER]: secret,
      },
      body: "{not json",
    });
    expect((await POST(bad)).status).toBe(400);
  });

  it("still surfaces a purge refusal as 409", async () => {
    purgeExtensionMock.mockRejectedValueOnce(
      new FakePurgeRefused("digest mismatch"),
    );
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ refused: true });
  });

  it("still passes the digest and reason through to the purge", async () => {
    await POST(
      request({
        packageName: "@acme/thing",
        expectedDigest: "sha256-plan",
        reason: "superseded",
      }),
    );
    expect(purgeExtensionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        packageName: "@acme/thing",
        expectedDigest: "sha256-plan",
        reason: "superseded",
      }),
      expect.anything(),
    );
  });
});

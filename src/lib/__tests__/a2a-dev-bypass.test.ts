/**
 * The A2A development bypass now costs a loopback SOCKET and the per-boot
 * credential — the same single decision the two destructive routes take.
 *
 * Written as its own file so the existing verifyA2AAccessToken suite
 * (src/lib/__tests__/a2a-auth.test.ts) keeps asserting exactly what it did.
 * Nothing here weakens a Bearer-token path: every case below either refuses
 * the bypass and falls through to the ordinary 401, or takes it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const { readServiceAccountByClientIdMock, verifyAccessTokenMock } = vi.hoisted(
  () => ({
    readServiceAccountByClientIdMock: vi.fn(async () => null),
    verifyAccessTokenMock: vi.fn(async () => {
      throw new Error("no token in these tests");
    }),
  }),
);

vi.mock("@/lib/service-accounts", () => ({
  readServiceAccount: vi.fn(async () => null),
  readServiceAccountByClientId: readServiceAccountByClientIdMock,
}));
vi.mock("better-auth/client", () => ({
  createAuthClient: () => ({ verifyAccessToken: verifyAccessTokenMock }),
}));
vi.mock("@better-auth/oauth-provider/resource-client", () => ({
  oauthProviderResourceClient: () => ({}),
}));
vi.mock("@/lib/better-auth-db", () => ({
  betterAuthDb: { execute: vi.fn(async () => ({ rows: [] })) },
}));

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
import { verifyA2AAccessToken, verifyLangGraphBridgeToken } from "@/lib/a2a-auth";

let dataDir: string;
let secret: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "cinatra-a2a-bypass-"));
  // stubEnv rather than assignment: NODE_ENV is typed read-only, and
  // unstubAllEnvs restores every one of these without replacing process.env.
  vi.stubEnv(INSTANCE_DATA_DIR_ENV, dataDir);
  vi.stubEnv("CINATRA_RUNTIME_MODE", "development");
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("A2A_DEV_BYPASS", "true");
  secret = mintBootCredential(process.env);
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function request(extra: Record<string, string> = {}) {
  return new Request("http://localhost:3000/api/a2a", {
    headers: {
      [SOCKET_PEER_HEADER]: "127.0.0.1",
      [CLIENT_FORWARDED_HEADER]: NO_CLIENT_FORWARDED,
      [BOOT_CREDENTIAL_HEADER]: secret,
      ...extra,
    },
  });
}

const verifiers: Array<[string, (req: Request) => Promise<{ ok: boolean }>]> = [
  ["verifyA2AAccessToken", verifyA2AAccessToken],
  ["verifyLangGraphBridgeToken", verifyLangGraphBridgeToken],
];

describe.each(verifiers)("%s dev bypass", (_name, verify) => {
  it("takes the bypass for a loopback socket presenting the credential", async () => {
    const result = await verify(request());
    expect(result.ok).toBe(true);
  });

  it("REFUSES a Host: localhost request with a synthesised forwarded chain", async () => {
    const result = await verify(
      request({
        host: "localhost:3000",
        "x-forwarded-for": "127.0.0.1",
        "x-forwarded-host": "localhost",
        [SOCKET_PEER_HEADER]: "2001:db8::1",
        [CLIENT_FORWARDED_HEADER]: "x-forwarded-for,x-forwarded-host",
      }),
    );
    expect(result.ok).toBe(false);
  });

  it("refuses a remote socket even with the credential", async () => {
    const result = await verify(
      request({ [SOCKET_PEER_HEADER]: "2001:db8::1" }),
    );
    expect(result.ok).toBe(false);
  });

  it("refuses a loopback socket with NO credential", async () => {
    const bare = new Request("http://localhost:3000/api/a2a", {
      headers: {
        [SOCKET_PEER_HEADER]: "127.0.0.1",
        [CLIENT_FORWARDED_HEADER]: NO_CLIENT_FORWARDED,
      },
    });
    expect((await verify(bare)).ok).toBe(false);
  });

  it("refuses an unstamped request", async () => {
    const unstamped = new Request("http://localhost:3000/api/a2a", {
      headers: { [BOOT_CREDENTIAL_HEADER]: secret },
    });
    expect((await verify(unstamped)).ok).toBe(false);
  });

  it("stays off when A2A_DEV_BYPASS is not set, however local the caller is", async () => {
    vi.stubEnv("A2A_DEV_BYPASS", undefined);
    expect((await verify(request())).ok).toBe(false);
  });

  it("stays off under a production build", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect((await verify(request())).ok).toBe(false);
  });

  it("answers a refused bypass with the ordinary 401, not a leak of the reason", async () => {
    const result = (await verify(
      request({ [SOCKET_PEER_HEADER]: "2001:db8::1" }),
    )) as { ok: false; response: Response };
    expect(result.response.status).toBe(401);
    expect(await result.response.json()).toEqual({ error: "unauthorized" });
  });
});

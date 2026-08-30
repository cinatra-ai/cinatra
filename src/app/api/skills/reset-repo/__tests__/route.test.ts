/**
 * /api/skills/reset-repo — the route that FORCE-PUSHES the operator's connected
 * skills repository.
 *
 * Two independent things are proved here, in the order the handler asks them:
 *   1. a platform ADMINISTRATOR, which the route did not ask for at all before
 *      (the cookie-only middleware admitted any authenticated member);
 *   2. the shared local-caller decision — a loopback SOCKET and the per-boot
 *      credential, rather than a `Host` header anyone can write.
 *
 * Every refusal is asserted by "the force-push never ran", not merely by the
 * status code, because the status code is not what is destructive.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const { pushSkillStoreToGitHubMock, getAuthSessionMock } = vi.hoisted(() => ({
  pushSkillStoreToGitHubMock: vi.fn(async () => ({ commitSha: "deadbeef" })),
  getAuthSessionMock: vi.fn(async () => null as unknown),
}));

vi.mock("@cinatra-ai/skills", () => ({
  pushSkillStoreToGitHub: pushSkillStoreToGitHubMock,
}));

vi.mock("@/lib/auth-session", async (importOriginal) => {
  // Keep the REAL isPlatformAdmin — the comma-separated role parsing is part of
  // what the admin gate has to get right, and a stubbed predicate would agree
  // with whatever the route said.
  const actual = await importOriginal<typeof import("@/lib/auth-session")>();
  return { ...actual, getAuthSession: getAuthSessionMock };
});

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
import { POST } from "@/app/api/skills/reset-repo/route";

let dataDir: string;
let secret: string;

beforeEach(() => {
  vi.clearAllMocks();
  dataDir = mkdtempSync(path.join(tmpdir(), "cinatra-reset-repo-"));
  // stubEnv rather than assignment: NODE_ENV is typed read-only, and
  // unstubAllEnvs restores every one of these without replacing process.env
  // itself (which would strand anything else holding a reference to it).
  vi.stubEnv(INSTANCE_DATA_DIR_ENV, dataDir);
  vi.stubEnv("CINATRA_RUNTIME_MODE", "development");
  vi.stubEnv("NODE_ENV", "development");
  secret = mintBootCredential(process.env);
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const ADMIN = { user: { id: "u-admin", role: "user,admin" } };
const MEMBER = { user: { id: "u-member", role: "user" } };

function request(extra: Record<string, string> = {}) {
  return new Request("http://localhost:3000/api/skills/reset-repo", {
    method: "POST",
    headers: {
      [SOCKET_PEER_HEADER]: "127.0.0.1",
      [CLIENT_FORWARDED_HEADER]: NO_CLIENT_FORWARDED,
      [BOOT_CREDENTIAL_HEADER]: secret,
      ...extra,
    },
  });
}

describe("POST /api/skills/reset-repo — the administrator gate", () => {
  it("refuses an authenticated MEMBER even from a perfect local call", async () => {
    getAuthSessionMock.mockResolvedValue(MEMBER);
    const response = await POST(request());
    expect(response.status).toBe(403);
    expect(pushSkillStoreToGitHubMock).not.toHaveBeenCalled();
  });

  it("refuses a caller with no session at all — with JSON, not a sign-in redirect", async () => {
    getAuthSessionMock.mockResolvedValue(null);
    const response = await POST(request());
    expect(response.status).toBe(403);
    // This is the HANDLER's own answer. Over HTTP a cookieless caller does not
    // get this far: the path is not public, so the middleware redirects it to
    // /sign-in first (true before this change too). What is asserted here is
    // that the handler itself never adds a second redirect — a 307 from a POST
    // route would be followed with the body intact and answered with sign-in
    // HTML the CLI then parses as JSON.
    expect(response.headers.get("location")).toBeNull();
    expect(await response.json()).toMatchObject({ error: expect.any(String) });
    expect(pushSkillStoreToGitHubMock).not.toHaveBeenCalled();
  });

  it("asks for the administrator BEFORE it looks at the connection", async () => {
    getAuthSessionMock.mockResolvedValue(MEMBER);
    // A member arriving from off the machine with no credential: the answer must
    // still be the administrator refusal, so the route never tells an
    // unprivileged caller which connection shapes it would have accepted.
    const response = await POST(
      request({
        [SOCKET_PEER_HEADER]: "2001:db8::1",
        [BOOT_CREDENTIAL_HEADER]: "wrong",
      }),
    );
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/administrator/i);
    expect(pushSkillStoreToGitHubMock).not.toHaveBeenCalled();
  });

  it("admits an admin whose role string carries several roles", async () => {
    getAuthSessionMock.mockResolvedValue(ADMIN);
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(pushSkillStoreToGitHubMock).toHaveBeenCalledWith({ force: true });
  });
});

describe("POST /api/skills/reset-repo — the local-caller gate", () => {
  beforeEach(() => {
    getAuthSessionMock.mockResolvedValue(ADMIN);
  });

  it("refuses an admin on a Host: localhost request with a synthesised forwarded chain", async () => {
    const response = await POST(
      request({
        host: "localhost:3000",
        "x-forwarded-for": "127.0.0.1",
        "x-forwarded-host": "localhost",
        [SOCKET_PEER_HEADER]: "2001:db8::1",
        [CLIENT_FORWARDED_HEADER]: "x-forwarded-for,x-forwarded-host",
      }),
    );
    expect(response.status).toBe(403);
    expect(pushSkillStoreToGitHubMock).not.toHaveBeenCalled();
  });

  it("refuses an admin without the boot credential", async () => {
    const bare = new Request("http://localhost:3000/api/skills/reset-repo", {
      method: "POST",
      headers: {
        [SOCKET_PEER_HEADER]: "127.0.0.1",
        [CLIENT_FORWARDED_HEADER]: NO_CLIENT_FORWARDED,
      },
    });
    const response = await POST(bare);
    expect(response.status).toBe(403);
    expect(pushSkillStoreToGitHubMock).not.toHaveBeenCalled();
  });

  it("refuses an admin on an unstamped request", async () => {
    const unstamped = new Request("http://localhost:3000/api/skills/reset-repo", {
      method: "POST",
      headers: { [BOOT_CREDENTIAL_HEADER]: secret },
    });
    const response = await POST(unstamped);
    expect(response.status).toBe(403);
    expect(pushSkillStoreToGitHubMock).not.toHaveBeenCalled();
  });

  it("refuses outside a development runtime, admin and credential notwithstanding", async () => {
    vi.stubEnv("CINATRA_RUNTIME_MODE", "production");
    const response = await POST(request());
    expect(response.status).toBe(403);
    expect(pushSkillStoreToGitHubMock).not.toHaveBeenCalled();
  });

  it("reports the push failure honestly rather than claiming success", async () => {
    pushSkillStoreToGitHubMock.mockRejectedValueOnce(new Error("remote rejected"));
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: "remote rejected" });
  });
});

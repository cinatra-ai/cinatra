// Unit tests for the `cinatra login` token cache + profile + refresh logic.
// The OAuth protocol primitives (browser flow, DCR) are NOT exercised here —
// those are SDK-driven and require a live server. We test the pure store /
// resolution / refresh seams against a temp XDG_CONFIG_HOME dir + injected
// metadata-discovery / refresh functions where applicable.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = resolve(
  fileURLToPath(new URL("../bin/cinatra.mjs", import.meta.url)),
);

/** Run the real CLI bin with an isolated config dir + no DB url. */
function runBin(args, extraEnv = {}) {
  const cfg = mkdtempSync(join(tmpdir(), "cinatra-bin-test-"));
  try {
    const res = spawnSync(process.execPath, [BIN, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        XDG_CONFIG_HOME: cfg,
        SUPABASE_DB_URL: "", // ensure the local fallback would error distinctly
        ...extraEnv,
      },
    });
    return `${res.stdout}\n${res.stderr}`;
  } finally {
    rmSync(cfg, { recursive: true, force: true });
  }
}

import {
  appUrlToProfileKey,
  resolveCredentialsPath,
  readCredentialsStore,
  writeCredentialsStore,
  saveProfile,
  buildProfileRecord,
  resolveAccessToken,
  maskToken,
  redactTokens,
  CLI_OAUTH_SCOPES,
} from "../src/login.mjs";

let configDir;
let env;

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "cinatra-login-test-"));
  env = { XDG_CONFIG_HOME: configDir };
});

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

describe("appUrlToProfileKey", () => {
  it("reduces an app URL to its origin", () => {
    expect(appUrlToProfileKey("https://instance.cinatra.ai/path?x=1")).toBe(
      "https://instance.cinatra.ai",
    );
    expect(appUrlToProfileKey("http://localhost:3000/")).toBe("http://localhost:3000");
  });

  it("rejects an invalid or non-http(s) URL", () => {
    expect(() => appUrlToProfileKey("not a url")).toThrow(/Invalid --app-url/);
    expect(() => appUrlToProfileKey("ftp://x")).toThrow(/must be http/);
  });

  it("rejects plaintext http for a remote (non-loopback) host", () => {
    expect(() => appUrlToProfileKey("http://remote.example.com")).toThrow(
      /must use https for a remote host/,
    );
  });

  it("allows plaintext http only for loopback dev hosts", () => {
    expect(appUrlToProfileKey("http://localhost:3000")).toBe("http://localhost:3000");
    expect(appUrlToProfileKey("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
    expect(appUrlToProfileKey("https://remote.example.com")).toBe(
      "https://remote.example.com",
    );
  });
});

describe("redactTokens", () => {
  it("redacts the exact access token and Bearer patterns", () => {
    const token = "supersecretaccesstoken1234";
    expect(redactTokens(`leaked ${token} here`, token)).toBe("leaked [REDACTED] here");
    expect(redactTokens("Authorization: Bearer abc.def-123/x=", null)).toBe(
      "Authorization: Bearer [REDACTED]",
    );
  });

  it("is a no-op on token-free text", () => {
    expect(redactTokens("plain error message", "tok")).toBe("plain error message");
  });
});

describe("credentials store", () => {
  it("resolves the path under XDG_CONFIG_HOME", () => {
    expect(resolveCredentialsPath(env)).toBe(
      join(configDir, "cinatra", "credentials.json"),
    );
  });

  it("returns an empty store when the file is absent", async () => {
    const store = await readCredentialsStore(env);
    expect(store).toEqual({ version: 1, defaultProfile: null, profiles: {} });
  });

  it("writes the store with 0600 perms", async () => {
    await writeCredentialsStore(
      { version: 1, defaultProfile: null, profiles: {} },
      env,
    );
    const path = resolveCredentialsPath(env);
    const st = await stat(path);
    // Mask off the file-type bits; assert the perm bits are exactly 0600.
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("re-tightens perms to 0600 even when the file pre-existed as 0644", async () => {
    const { mkdir, writeFile, chmod } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    const path = resolveCredentialsPath(env);
    await mkdir(dirname(path), { recursive: true });
    // Plant a world-readable pre-existing file.
    await writeFile(path, "{}", { mode: 0o644 });
    await chmod(path, 0o644);
    // The atomic write must replace it with a 0600 file (never widen exposure).
    await writeCredentialsStore(
      { version: 1, defaultProfile: null, profiles: { p: { accessToken: "AT" } } },
      env,
    );
    const st = await stat(path);
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("never serializes a token in plaintext-unprotected form (perms enforced)", async () => {
    await saveProfile(
      "https://x",
      buildProfileRecord({
        origin: "https://x",
        clientInformation: { client_id: "c1" },
        tokens: { access_token: "AT", refresh_token: "RT", expires_in: 3600 },
      }),
      {},
      env,
    );
    const raw = await readFile(resolveCredentialsPath(env), "utf8");
    // The token IS stored (it must be, to be usable) but the file is 0600.
    expect(raw).toContain("AT");
    const st = await stat(resolveCredentialsPath(env));
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("saveProfile sets the first profile as default", async () => {
    await saveProfile("https://a", { origin: "https://a" }, {}, env);
    const store = await readCredentialsStore(env);
    expect(store.defaultProfile).toBe("https://a");
    // A second profile does not steal default unless makeDefault is set.
    await saveProfile("https://b", { origin: "https://b" }, {}, env);
    expect((await readCredentialsStore(env)).defaultProfile).toBe("https://a");
    await saveProfile("https://b", { origin: "https://b" }, { makeDefault: true }, env);
    expect((await readCredentialsStore(env)).defaultProfile).toBe("https://b");
  });
});

describe("buildProfileRecord", () => {
  it("computes expiresAt from expires_in and never stores a client secret", () => {
    const rec = buildProfileRecord(
      {
        origin: "https://x",
        clientInformation: { client_id: "c1", client_secret: "SHOULD_NOT_APPEAR" },
        tokens: { access_token: "AT", refresh_token: "RT", expires_in: 100 },
      },
      1_000,
    );
    expect(rec.expiresAt).toBe(1_000 + 100_000);
    expect(rec.accessToken).toBe("AT");
    expect(rec.refreshToken).toBe("RT");
    expect(rec.scope).toBe(CLI_OAUTH_SCOPES.join(" "));
    // Public client — no secret is persisted.
    expect(JSON.stringify(rec)).not.toContain("SHOULD_NOT_APPEAR");
    expect(rec).not.toHaveProperty("clientSecret");
  });
});

describe("resolveAccessToken", () => {
  it("throws when no profile exists", async () => {
    await expect(resolveAccessToken({ env })).rejects.toThrow(/No Cinatra login profile/);
  });

  it("returns a fresh token without refreshing", async () => {
    const now = 10_000;
    await saveProfile(
      "https://x",
      buildProfileRecord(
        {
          origin: "https://x",
          clientInformation: { client_id: "c1" },
          tokens: { access_token: "AT", refresh_token: "RT", expires_in: 3600 },
        },
        now,
      ),
      {},
      env,
    );
    const result = await resolveAccessToken({ appUrl: "https://x", env, now: now + 1000 });
    expect(result.accessToken).toBe("AT");
    expect(result.origin).toBe("https://x");
  });

  it("throws when expired with no refresh token", async () => {
    const now = 10_000;
    await saveProfile(
      "https://x",
      {
        origin: "https://x",
        clientId: "c1",
        accessToken: "AT",
        refreshToken: null,
        expiresAt: now, // already expired
      },
      {},
      env,
    );
    await expect(
      resolveAccessToken({ appUrl: "https://x", env, now: now + 1 }),
    ).rejects.toThrow(/expired and has no refresh token/);
  });

  it("selects the default profile when no target is given", async () => {
    const now = 10_000;
    await saveProfile(
      "https://default",
      buildProfileRecord(
        {
          origin: "https://default",
          clientInformation: { client_id: "c1" },
          tokens: { access_token: "DEF", expires_in: 3600 },
        },
        now,
      ),
      { makeDefault: true },
      env,
    );
    const result = await resolveAccessToken({ env, now: now + 1000 });
    expect(result.accessToken).toBe("DEF");
    expect(result.profileKey).toBe("https://default");
  });
});

describe("maskToken", () => {
  it("masks all but a prefix/suffix", () => {
    expect(maskToken("abcdef1234567890")).toBe("abcd…90");
    expect(maskToken("short")).toBe("***");
    expect(maskToken(undefined)).toBe("***");
  });
});

// Regression: `login` / `status` are command-only descriptors, so the
// dispatcher's `mode` slot (argv[1]) holds the FIRST option token. The handlers
// re-prepend `mode` so the flag is visible. Without that fix, `login --app-url`
// printed a usage error and `status --profile` fell through to the local DB.
describe("CLI flag dispatch for command-only descriptors", () => {
  it("`login --app-url <url>` reaches OAuth discovery, not a usage error", () => {
    const out = runBin(["login", "--app-url", "https://nonexistent.invalid"]);
    expect(out).toMatch(/Discovering OAuth configuration/);
    expect(out).not.toMatch(/Usage: cinatra login/);
  });

  it("`status --profile <name>` takes the remote path, not the local DB fallback", () => {
    const out = runBin(["status", "--profile", "prod"]);
    // Remote path: "No login profile" — NOT the local SUPABASE_DB_URL error.
    expect(out).toMatch(/No login profile "prod"/);
    expect(out).not.toMatch(/SUPABASE_DB_URL/);
  });

  it("`status` with no target still uses the local path", () => {
    const out = runBin(["status"]);
    // Local path errors on the missing DB url (proves it did NOT go remote).
    expect(out).toMatch(/SUPABASE_DB_URL/);
  });
});

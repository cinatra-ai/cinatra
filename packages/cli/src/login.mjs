// packages/cli/src/login.mjs
//
// `cinatra login` — interactive browser sign-in to a Cinatra instance, plus
// the token cache + profile model the Class-A control-plane client uses.
//
// cinatra#255 (G2). Builds STRICTLY on the instance's EXISTING OAuth surface —
// it invents no new server auth:
//   * Discovers OAuth metadata via the standard
//     `/.well-known/oauth-authorization-server` document.
//   * Registers a PUBLIC client via Dynamic Client Registration (DCR is on by
//     default on the instance), no secret stored.
//   * Runs the `authorization_code` + PKCE flow with a loopback redirect
//     listener, opening the system browser.
//   * Caches tokens per named PROFILE (keyed by `--app-url`) under
//     `~/.config/cinatra/credentials.json` at mode 0600, and refreshes with the
//     stored `refresh_token` before expiry.
//
// All OAuth mechanics come from `@modelcontextprotocol/sdk/client/auth.js`
// (already a CLI dependency, ships an OAuth client) — we drive its pure
// primitives (`discoverAuthorizationServerMetadata`, `registerClient`,
// `startAuthorization`, `exchangeAuthorization`, `refreshAuthorization`) rather
// than reimplementing the protocol.
//
// SECURITY: tokens are NEVER logged. The cache file is created/chmod'd 0600.
// The loopback listener binds 127.0.0.1 on an ephemeral port, accepts exactly
// ONE redirect, validates `state`, and shuts down immediately.

import { createServer } from "node:http";
import { mkdir, readFile, writeFile, chmod, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import {
  discoverAuthorizationServerMetadata,
  registerClient,
  startAuthorization,
  exchangeAuthorization,
  refreshAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";

// The OAuth scopes the CLI requests. `mcp:connect` is the instance's admission
// scope for the control plane; the rest are standard OIDC scopes for the token
// + refresh. Authorization (role) is enforced SERVER-SIDE per endpoint — the
// scope only admits.
export const CLI_OAUTH_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "mcp:connect",
];

const CLIENT_NAME = "Cinatra CLI";

// ---------------------------------------------------------------------------
// Credentials store
// ---------------------------------------------------------------------------

/**
 * Resolve the credentials file path. Honors `XDG_CONFIG_HOME`, else
 * `~/.config/cinatra/credentials.json`.
 */
export function resolveCredentialsPath(env = process.env) {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const base = xdg ? xdg : join(homedir(), ".config");
  return join(base, "cinatra", "credentials.json");
}

/** Loopback hostnames that may legitimately be served over plain HTTP in dev. */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function isLoopbackHostname(hostname) {
  return LOOPBACK_HOSTNAMES.has(hostname);
}

/**
 * Normalize an app URL into a stable profile key (origin only, no trailing
 * slash). Throws on an invalid URL so a typo can't silently create a junk
 * profile.
 *
 * SECURITY: rejects plaintext `http:` for any NON-loopback host. OAuth tokens
 * (and the later `Authorization: Bearer …` calls) must never cross the network
 * in the clear — only `https:`, or `http:` to a loopback dev host, is allowed.
 */
export function appUrlToProfileKey(appUrl) {
  let u;
  try {
    u = new URL(appUrl);
  } catch {
    throw new Error(`Invalid --app-url: ${appUrl}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`--app-url must be http(s): ${appUrl}`);
  }
  if (u.protocol === "http:" && !isLoopbackHostname(u.hostname)) {
    throw new Error(
      `--app-url must use https for a remote host (plaintext http is allowed only for loopback): ${appUrl}`,
    );
  }
  return u.origin;
}

/** Read the full credentials store ({ version, profiles, defaultProfile }). */
export async function readCredentialsStore(env = process.env) {
  const path = resolveCredentialsPath(env);
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return {
        version: parsed.version ?? 1,
        defaultProfile: parsed.defaultProfile ?? null,
        profiles:
          parsed.profiles && typeof parsed.profiles === "object"
            ? parsed.profiles
            : {},
      };
    }
  } catch {
    // ENOENT / malformed → empty store.
  }
  return { version: 1, defaultProfile: null, profiles: {} };
}

/**
 * Write the credentials store ATOMICALLY with strict 0600 perms.
 *
 * SECURITY: the token body is written to a FRESH 0600 temp file (so it never
 * exists at the final path while world-readable, even if a pre-existing
 * `credentials.json` was 0644), then atomically renamed into place. The
 * `wx` flag ensures the temp file is newly created (never an attacker-planted
 * symlink) and `mode: 0o600` sets its perms at creation. The parent dir is
 * created 0700.
 */
export async function writeCredentialsStore(store, env = process.env) {
  const path = resolveCredentialsPath(env);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const body = JSON.stringify(store, null, 2);
  const tmpPath = `${path}.${randomUUID()}.tmp`;
  try {
    // `wx` = create + exclusive (fail if exists); mode 0o600 at creation time.
    await writeFile(tmpPath, body, { mode: 0o600, flag: "wx" });
    await chmod(tmpPath, 0o600).catch(() => {});
    await rename(tmpPath, path);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}

/** Persist a single profile's record, optionally marking it the default. */
export async function saveProfile(profileKey, record, options = {}, env = process.env) {
  const store = await readCredentialsStore(env);
  store.profiles[profileKey] = record;
  if (options.makeDefault || !store.defaultProfile) {
    store.defaultProfile = profileKey;
  }
  await writeCredentialsStore(store, env);
}

// ---------------------------------------------------------------------------
// Loopback redirect listener
// ---------------------------------------------------------------------------

/**
 * Start a one-shot loopback listener on 127.0.0.1:<ephemeral>. Resolves with
 * `{ redirectUrl, waitForCode() }`. `waitForCode()` resolves with the `code`
 * once the browser is redirected back (validating `state`), or rejects on an
 * OAuth error redirect / state mismatch. The server is always closed.
 */
export async function startLoopbackListener(expectedState) {
  return await new Promise((resolveListener, rejectListener) => {
    let resolveCode;
    let rejectCode;
    const codePromise = new Promise((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });

    const server = createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end("Not found");
        return;
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");

      const finish = (statusText) => {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          `<!doctype html><html><body style="font-family:system-ui;padding:2rem">` +
            `<h2>Cinatra CLI</h2><p>${statusText}</p>` +
            `<p>You can close this tab and return to your terminal.</p></body></html>`,
        );
        server.close();
      };

      if (error) {
        finish("Sign-in failed. See your terminal for details.");
        rejectCode(new Error(`Authorization error: ${error}`));
        return;
      }
      if (!code) {
        finish("Sign-in failed: no authorization code returned.");
        rejectCode(new Error("No authorization code in redirect."));
        return;
      }
      if (state !== expectedState) {
        finish("Sign-in failed: state mismatch.");
        rejectCode(new Error("State mismatch in OAuth redirect (possible CSRF)."));
        return;
      }
      finish("Signed in successfully.");
      resolveCode(code);
    });

    server.on("error", rejectListener);
    // Bind loopback + ephemeral port.
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const redirectUrl = `http://127.0.0.1:${port}/callback`;
      resolveListener({ redirectUrl, waitForCode: () => codePromise, close: () => server.close() });
    });
  });
}

/** Open a URL in the system browser (best-effort; never throws). */
export function openBrowser(url) {
  const platform = process.platform;
  const cmd =
    platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // No browser launcher available — the caller prints the URL as a fallback.
  }
}

// ---------------------------------------------------------------------------
// Login flow
// ---------------------------------------------------------------------------

/**
 * Run the interactive `cinatra login` flow against `appUrl`.
 *
 * @param {object} opts
 * @param {string} opts.appUrl     Target instance origin (required).
 * @param {string} [opts.profile]  Profile name override (defaults to the origin).
 * @param {boolean} [opts.makeDefault] Mark this profile the default target.
 * @param {(url:string)=>void} [opts.open] Browser opener (injectable for tests).
 * @param {(m:string)=>void} [opts.log]    Logger (injectable for tests).
 * @param {object} [opts.env]
 * @returns {Promise<{ profileKey: string }>}
 */
export async function runLogin(opts) {
  const log = opts.log ?? ((m) => console.log(m));
  const open = opts.open ?? openBrowser;
  const env = opts.env ?? process.env;

  if (!opts.appUrl) {
    throw new Error("Usage: cinatra login --app-url <https://instance> [--profile <name>] [--default]");
  }
  const profileKey = opts.profile ?? appUrlToProfileKey(opts.appUrl);
  const origin = appUrlToProfileKey(opts.appUrl);

  // 1. Discover the authorization-server metadata.
  log(`Discovering OAuth configuration at ${origin} …`);
  const metadata = await discoverAuthorizationServerMetadata(origin);
  if (!metadata) {
    throw new Error(
      `Could not discover OAuth metadata at ${origin}/.well-known/oauth-authorization-server.`,
    );
  }

  // 2. Start the loopback listener so we have the concrete redirect URI for DCR.
  const expectedState = randomUUID();
  const listener = await startLoopbackListener(expectedState);

  try {
    // 3. Register a PUBLIC client (DCR). No secret is requested or stored.
    const clientInformation = await registerClient(origin, {
      metadata,
      clientMetadata: {
        client_name: CLIENT_NAME,
        redirect_uris: [listener.redirectUrl],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none", // public client (PKCE)
        scope: CLI_OAUTH_SCOPES.join(" "),
      },
      scope: CLI_OAUTH_SCOPES.join(" "),
    });

    // FAIL CLOSED if the AS handed back a CONFIDENTIAL client. We only persist
    // `client_id` (a public client has no secret), so a confidential client
    // would exchange once but break on refresh — and we must not be tricked
    // into a secret-bearing flow on a CLI. Require a public (`none`) client.
    const issuedAuthMethod =
      clientInformation.token_endpoint_auth_method ?? "none";
    if (clientInformation.client_secret || issuedAuthMethod !== "none") {
      throw new Error(
        "Refusing to continue: the instance issued a confidential OAuth client " +
          `(token_endpoint_auth_method="${issuedAuthMethod}"). The CLI requires a ` +
          "public PKCE client. Check the instance's Dynamic Client Registration policy.",
      );
    }

    // 4. Build the authorization URL (PKCE) and open the browser.
    const { authorizationUrl, codeVerifier } = await startAuthorization(origin, {
      metadata,
      clientInformation,
      redirectUrl: listener.redirectUrl,
      scope: CLI_OAUTH_SCOPES.join(" "),
      state: expectedState,
    });

    log("Opening your browser to sign in …");
    log(`If it doesn't open, visit:\n  ${authorizationUrl.toString()}`);
    open(authorizationUrl.toString());

    // 5. Wait for the redirect + exchange the code for tokens.
    const code = await listener.waitForCode();
    const tokens = await exchangeAuthorization(origin, {
      metadata,
      clientInformation,
      authorizationCode: code,
      codeVerifier,
      redirectUri: listener.redirectUrl,
    });

    // 6. Persist the profile (tokens never logged).
    const record = buildProfileRecord({ origin, clientInformation, tokens });
    await saveProfile(profileKey, record, { makeDefault: opts.makeDefault }, env);

    log(`Signed in. Saved profile "${profileKey}" → ${origin}.`);
    return { profileKey };
  } finally {
    listener.close();
  }
}

/** Shape a stored profile record from an issued token set. */
export function buildProfileRecord({ origin, clientInformation, tokens }, now = Date.now()) {
  const expiresAt =
    typeof tokens.expires_in === "number"
      ? now + tokens.expires_in * 1000
      : null;
  return {
    origin,
    clientId: clientInformation.client_id,
    // Public client (PKCE) — no client secret is stored.
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? null,
    tokenType: tokens.token_type ?? "Bearer",
    scope: tokens.scope ?? CLI_OAUTH_SCOPES.join(" "),
    expiresAt,
    obtainedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Token resolution for Class-A client calls
// ---------------------------------------------------------------------------

// Refresh when the access token is within this window of expiry (or expired).
const REFRESH_SKEW_MS = 60_000;

/**
 * Resolve a usable bearer access token for a target. Selects the profile by
 * `appUrl` (or the store's default), refreshes it if near/over expiry using the
 * stored refresh token, persists the refreshed record, and returns the token.
 *
 * @returns {Promise<{ accessToken: string, origin: string, profileKey: string }>}
 * @throws when no matching profile exists (caller falls back to direct-PG).
 */
export async function resolveAccessToken(opts = {}) {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now();
  const store = await readCredentialsStore(env);

  const profileKey = opts.appUrl
    ? appUrlToProfileKey(opts.appUrl)
    : (opts.profile ?? store.defaultProfile);
  if (!profileKey) {
    throw new Error("No Cinatra login profile. Run `cinatra login --app-url <url>` first.");
  }
  const record = store.profiles[profileKey];
  if (!record) {
    throw new Error(`No login profile "${profileKey}". Run \`cinatra login --app-url <url>\`.`);
  }

  const fresh =
    record.expiresAt == null || record.expiresAt - now > REFRESH_SKEW_MS;
  if (fresh) {
    return { accessToken: record.accessToken, origin: record.origin, profileKey };
  }

  // Near/over expiry → refresh.
  if (!record.refreshToken) {
    throw new Error(
      `Login for "${profileKey}" expired and has no refresh token. Run \`cinatra login\` again.`,
    );
  }
  const metadata = await discoverAuthorizationServerMetadata(record.origin);
  if (!metadata) {
    throw new Error(`Could not discover OAuth metadata at ${record.origin} to refresh.`);
  }
  const tokens = await refreshAuthorization(record.origin, {
    metadata,
    clientInformation: { client_id: record.clientId },
    refreshToken: record.refreshToken,
  });
  const updated = buildProfileRecord(
    {
      origin: record.origin,
      clientInformation: { client_id: record.clientId },
      tokens: {
        ...tokens,
        // A refresh response may omit refresh_token — keep the existing one.
        refresh_token: tokens.refresh_token ?? record.refreshToken,
      },
    },
    now,
  );
  await saveProfile(profileKey, updated, {}, env);
  return { accessToken: updated.accessToken, origin: record.origin, profileKey };
}

/** Mask a token for any human-facing diagnostic. NEVER print the raw token. */
export function maskToken(token) {
  if (typeof token !== "string" || token.length < 8) return "***";
  return `${token.slice(0, 4)}…${token.slice(-2)}`;
}

// ---------------------------------------------------------------------------
// Class-A remote client — authenticated calls to the instance control plane
// ---------------------------------------------------------------------------

/**
 * Resolve the target origin + a bearer token for a Class-A call. Prefers an
 * explicit `--app-url`; else the named/default profile.
 */
async function resolveTarget({ appUrl, profile, env } = {}) {
  const resolved = await resolveAccessToken({ appUrl, profile, env });
  // When --app-url was given, honor it as the request origin (the profile's
  // stored origin should match, but the caller's explicit choice wins).
  const origin = appUrl ? appUrlToProfileKey(appUrl) : resolved.origin;
  return { origin, accessToken: resolved.accessToken };
}

/**
 * Authenticated GET against the instance, returning parsed JSON. Throws a clean
 * error on a non-2xx (surfacing the server's `error` message when present).
 * NEVER logs the bearer token.
 */
export async function cliApiGet(path, { appUrl, profile, env, fetchFn = fetch } = {}) {
  const { origin, accessToken } = await resolveTarget({ appUrl, profile, env });
  const res = await fetchFn(`${origin}${path}`, {
    method: "GET",
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });
  if (!res.ok) {
    throw await httpError(res, accessToken);
  }
  return await res.json();
}

/**
 * Redact any token material from a string before it is surfaced to the user:
 * the exact access token, and any `Bearer <token>` pattern. Defense in depth —
 * the server should never echo the token, but if it did, the CLI must not print
 * it (the bin wrapper prints raw error messages).
 */
export function redactTokens(text, accessToken) {
  let out = String(text ?? "");
  if (accessToken && accessToken.length >= 8) {
    out = out.split(accessToken).join("[REDACTED]");
  }
  out = out.replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/gi, "Bearer [REDACTED]");
  return out;
}

/** Build a token-redacted error from a non-2xx response. */
async function httpError(res, accessToken) {
  let detail = "";
  try {
    const body = await res.json();
    if (body?.error) detail = `: ${redactTokens(body.error, accessToken)}`;
  } catch {
    // non-JSON body — ignore.
  }
  return new Error(`Request failed (${res.status} ${res.statusText})${detail}`);
}

/** `cinatra status` remote path — GET /api/cli/status. */
export async function fetchRemoteStatus(opts = {}) {
  return await cliApiGet("/api/cli/status", opts);
}

export { REFRESH_SKEW_MS };

#!/usr/bin/env node
// Headless Plane demo provisioning (cinatra#1238; owner ruling 2026-07-23
// (groganz) — Plane posture is AUTOMATIC, the manual-PAT carve-out is
// withdrawn).
//
// WHAT: after the demo bring-up has started the `--profile plane` stack, drive
// Plane CE's internal CSRF sign-in -> mint sequence HEADLESSLY (no browser) to
// (1) configure the god-mode instance admin, (2) create the ACME workspace +
// project, and (3) mint a user-level Personal Access Token for the OFFICIAL
// Plane MCP bridge (makeplane/plane-mcp-server). It then writes the bridge's
// env file + the app's demo env so the bridge boots holding that PAT and the
// connector's dev-setup hook auto-connects + wires the MCP row.
//
// WHY A SELF-CONTAINED COPY OF THE MINT: the connector's proven mint
// (plane-connector#40/#41, `src/plane-provision.ts`) is a TypeScript module
// guarded by `import "server-only"` and bound to the running app's host deps —
// it cannot be imported by this plain-Node demo bring-up script. This script
// therefore mirrors the SAME on-the-wire sequence (endpoints only, never a
// secret), version-pinned to Plane CE 1.3.1, for the DEMO profile only.
//
// DISCIPLINE (mirrors the connector's #41):
//   - REUSE-FIRST: a PAT already recorded in the bridge env that still
//     authenticates is reused (no re-mint) — idempotent across re-runs.
//   - VERSION-PINNED: the internal `/auth/sign-in/` + `/api/users/api-tokens/`
//     endpoints are undocumented + version-pinned; the scripted mint runs ONLY
//     against Plane CE 1.3.1 (the tag this repo's compose pins). Any other
//     reported version fails closed with the manual-paste hint. Brittleness
//     across Plane versions is ACCEPTED for the demo profile (owner ruling).
//   - SECRET-SAFE: dev-only, deterministic, loopback + reserved-TLD credentials
//     that are NOT secrets; only sha256 fingerprints (never a token/password)
//     are logged; the minted PAT is written ONLY to gitignored env files.
//
// Pure ESM, Node built-ins + global fetch only. Pure helpers are exported for
// unit tests; the network flow takes an injectable `fetchImpl`.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// scripts/fixtures/ -> repo root
const REPO_ROOT = path.resolve(__dirname, "..", "..");

/** Plane CE versions the scripted headless mint is validated against. Keep in
 *  lockstep with the `${PLANE_TAG:-v1.3.1@...}` pins in docker-compose.yml. */
export const SUPPORTED_PLANE_VERSIONS = ["1.3.1"];

// DEV/DEMO-ONLY, NOT SECRETS. The Plane stack is loopback-only (127.0.0.1:3400,
// docker-compose.dev.yml) and the admin lives at a reserved-TLD (.localhost)
// address that never resolves off-box. These are deterministic so re-runs are
// idempotent; a real deployment overrides them via env and uses the connector's
// prod auto-connect (plane-connector#41) instead.
export const DEMO_DEFAULTS = Object.freeze({
  baseUrl: "http://localhost:3400",
  adminEmail: "demo-admin@plane.localhost",
  // Low-entropy, dictionary-word dev password (satisfies Plane's min-length +
  // mixed-case/digit policy); clearly not a production secret.
  adminPassword: "Cinatra-demo-plane-0",
  workspaceName: "ACME Group",
  workspaceSlug: "acme",
  tokenLabel: "cinatra-plane-mcp-demo",
  // The loopback port docker-compose.dev.yml publishes for the bridge.
  bridgePort: "3450",
  // The path mcp-proxy serves the Streamable-HTTP endpoint on.
  bridgePath: "/mcp",
  // The Plane REST origin the bridge (inside the `plane` network) dials. The api
  // service is aliased `api` on the network and serves `/api/...` on :8000.
  bridgeInternalBaseUrl: "http://api:8000",
});

// The bridge's gitignored env file (compose `env_file`) — mirrors the
// docker/wayflow/.wayflow.env + docker/nango/.nango.env generated-env pattern.
export const BRIDGE_ENV_REL = "docker/plane-mcp/.plane-mcp.env";

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/** Strip trailing "/" in LINEAR time (avoids a ReDoS-prone `/\/+$/`). */
export function trimTrailingSlashes(s) {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47 /* "/" */) end -= 1;
  return s.slice(0, end);
}

/** Plane slug rules: lowercase, [a-z0-9-] only. */
export function slugify(s) {
  return (s || "workspace").toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

/** Idempotent single-line `.env` upsert: rewrite-if-present, append-if-absent.
 *  Returns the new file content (never mutates in place). Anchors on the exact
 *  `KEY=` at line start so a commented `# KEY=` is left untouched and a fresh
 *  active line is appended. */
export function upsertEnvContent(content, key, value) {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=.*$`, "m");
  // Replace with a FUNCTION so a `$`-bearing value (`$&`, `$'`, `` $` ``, `$1`)
  // is written verbatim — a plain-string replacement would interpret those as
  // special replacement patterns and corrupt the value.
  if (re.test(content)) return content.replace(re, () => line);
  const sep = content.length === 0 || content.endsWith("\n") ? "" : "\n";
  return `${content}${sep}${line}\n`;
}

/** Apply a batch of upserts to a file's content. */
export function upsertEnvAll(content, entries) {
  let out = content;
  for (const [k, v] of entries) out = upsertEnvContent(out, k, v);
  return out;
}

/** Read a KEY's value out of `.env`-style content, or null. */
export function readEnvValue(content, key) {
  const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=(.*)$`, "m");
  const m = re.exec(content);
  return m ? m[1] : null;
}

/** Plane encodes an auth outcome in a 302 Location's `error_code` query param
 *  (success = none). Returns the error_code, or null. */
export function redirectErrorCode(location, root) {
  if (!location) return null;
  try {
    return new URL(location, root).searchParams.get("error_code");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cookie jar (Node's fetch does NOT persist cookies across calls)
// ---------------------------------------------------------------------------

export class CookieJar {
  constructor() {
    this.jar = new Map();
  }
  absorb(res) {
    const getSetCookie = res?.headers?.getSetCookie;
    const raw = typeof getSetCookie === "function" ? getSetCookie.call(res.headers) : [];
    for (const line of raw) {
      const first = String(line).split(";", 1)[0] ?? "";
      const eq = first.indexOf("=");
      if (eq > 0) this.jar.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
    }
  }
  get(name) {
    return this.jar.get(name);
  }
  header() {
    return Array.from(this.jar.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }
}

/** sha256 fingerprint (first 12 hex) — the ONLY form a secret takes in a log. */
export async function fingerprint(secret) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 12);
}

// ---------------------------------------------------------------------------
// Network flow (injectable fetchImpl)
// ---------------------------------------------------------------------------

export class PlaneProvisionError extends Error {
  constructor(message, transient) {
    super(message);
    this.name = "PlaneProvisionError";
    this.transient = Boolean(transient);
  }
}

function isTransientStatus(status) {
  return status >= 500 || status === 408 || status === 425 || status === 429;
}

/** Probe the reported Plane version via the public `GET /api/instances/`. */
export async function probePlaneVersion(fetchImpl, baseUrl) {
  const root = trimTrailingSlashes(baseUrl);
  try {
    const res = await fetchImpl(`${root}/api/instances/`, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const nested = json?.instance?.current_version;
    if (typeof nested === "string") return nested;
    return typeof json?.current_version === "string" ? json.current_version : null;
  } catch {
    return null;
  }
}

/** Validate a PAT with an authenticated REST read (the SAME X-API-Key surface
 *  the connector uses at runtime). "ok" | "unauthorized" | "unreachable". */
export async function validatePlaneToken(fetchImpl, baseUrl, workspaceSlug, pat) {
  const root = trimTrailingSlashes(baseUrl);
  const url = `${root}/api/v1/workspaces/${encodeURIComponent(workspaceSlug)}/projects/`;
  let res;
  try {
    res = await fetchImpl(url, {
      method: "GET",
      headers: { "x-api-key": pat, accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return "unreachable";
  }
  if (res.status === 200) return "ok";
  if (res.status === 401 || res.status === 403) return "unauthorized";
  return "unreachable";
}

async function jarFetch(fetchImpl, jar, url, init) {
  const headers = new Headers(init.headers);
  const cookie = jar.header();
  if (cookie) headers.set("cookie", cookie);
  if (init.csrf) headers.set("x-csrftoken", init.csrf);
  headers.set("referer", url);
  let res;
  try {
    // redirect: "manual" is LOAD-BEARING: Plane's session-auth endpoints answer
    // 302 to the web-app URL with the outcome in the Location's error_code; a
    // server-to-server client must NOT follow it (the app URL may be unreachable
    // and the session cookie + outcome ride the 302 itself).
    res = await fetchImpl(url, { ...init, headers, redirect: "manual", signal: AbortSignal.timeout(30000) });
  } catch {
    // SECRET BOUNDARY: a fixed label only (a raw error can echo the request body).
    throw new PlaneProvisionError("upstream fetch failed (network/timeout)", true);
  }
  jar.absorb(res);
  return res;
}

async function getCsrf(fetchImpl, jar, root) {
  const res = await jarFetch(fetchImpl, jar, `${root}/auth/get-csrf-token/`, {
    method: "GET",
    headers: { accept: "application/json" },
  });
  if (res.status !== 200) {
    throw new PlaneProvisionError(`get-csrf -> HTTP ${res.status}`, isTransientStatus(res.status));
  }
  let token = null;
  try {
    const j = await res.json();
    if (typeof j?.csrf_token === "string") token = j.csrf_token;
  } catch {
    /* fall back to the cookie */
  }
  const csrf = token ?? jar.get("csrftoken") ?? null;
  if (!csrf) throw new PlaneProvisionError("no csrf token available", true);
  return csrf;
}

async function resolveProject(fetchImpl, jar, root, slug, pinned, wsName) {
  const listRes = await jarFetch(fetchImpl, jar, `${root}/api/workspaces/${encodeURIComponent(slug)}/projects/`, {
    method: "GET",
    headers: { accept: "application/json" },
  });
  if (listRes.status !== 200) {
    throw new PlaneProvisionError(`list projects -> HTTP ${listRes.status}`, isTransientStatus(listRes.status));
  }
  const body = await listRes.json().catch(() => null);
  const rows = Array.isArray(body) ? body : Array.isArray(body?.results) ? body.results : null;
  if (rows === null) throw new PlaneProvisionError("list projects -> unexpected response shape", false);
  const ids = rows.map((r) => (typeof r?.id === "string" ? r.id : "")).filter(Boolean);
  if (pinned) {
    if (ids.includes(pinned)) return pinned;
    throw new PlaneProvisionError(`pinned projectId not found in workspace ${slug}`, false);
  }
  if (ids.length > 0) return ids[0];
  if (rows.length > 0) throw new PlaneProvisionError("list projects -> rows present but no valid id", false);

  // None exist — create one (identifier required + upper-cased by Plane CE).
  const csrf = await getCsrf(fetchImpl, jar, root);
  const identifier = (slug.replace(/[^a-z0-9]/gi, "").slice(0, 5) || "CIN").toUpperCase();
  const createRes = await jarFetch(fetchImpl, jar, `${root}/api/workspaces/${encodeURIComponent(slug)}/projects/`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ name: `${wsName} project`, identifier }),
    csrf,
  });
  if (!createRes.ok) {
    throw new PlaneProvisionError(`create project -> HTTP ${createRes.status}`, isTransientStatus(createRes.status));
  }
  const created = await createRes.json().catch(() => ({}));
  if (typeof created?.id !== "string" || !created.id) {
    throw new PlaneProvisionError("create project -> no id in response", false);
  }
  return created.id;
}

/** Drive the headless CSRF sign-in + mint. Returns { pat, workspaceSlug,
 *  projectId }. Throws PlaneProvisionError (transient flag set) on failure. */
export async function mintPlaneToken(fetchImpl, opts) {
  const root = trimTrailingSlashes(opts.baseUrl);
  const slug = slugify(opts.workspaceSlug || opts.adminEmail.split("@")[0] || "workspace");
  const wsName = opts.workspaceName || slug;
  const jar = new CookieJar();

  // 1. Configure the god-mode instance admin (idempotent — a re-run returns a
  //    302 ADMIN_ALREADY_EXIST, which we tolerate; sign-in is the real gate).
  let csrf = await getCsrf(fetchImpl, jar, root);
  const signUp = await jarFetch(fetchImpl, jar, `${root}/api/instances/admins/sign-up/`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      email: opts.adminEmail,
      password: opts.adminPassword,
      first_name: "Cinatra",
      last_name: "Demo",
      company_name: wsName,
      is_telemetry_enabled: "0",
    }).toString(),
    csrf,
  });
  if (!signUp.ok && !(signUp.status >= 300 && signUp.status < 400)) {
    throw new PlaneProvisionError(`admin sign-up -> HTTP ${signUp.status}`, isTransientStatus(signUp.status));
  }

  // 2. Sign in (populates the session cookie). Outcome is in the 302 error_code.
  csrf = await getCsrf(fetchImpl, jar, root);
  const signIn = await jarFetch(fetchImpl, jar, `${root}/auth/sign-in/`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ email: opts.adminEmail, password: opts.adminPassword }).toString(),
    csrf,
  });
  if (isTransientStatus(signIn.status)) {
    throw new PlaneProvisionError(`sign-in -> HTTP ${signIn.status}`, true);
  }
  // The Location error_code is only a PRESENCE signal (never interpolated — it
  // is upstream-controlled). SECRET BOUNDARY: fixed label + safe HTTP status.
  const signInFailed = signIn.status >= 400 || redirectErrorCode(signIn.headers.get("location"), root) !== null;
  if (signInFailed) {
    throw new PlaneProvisionError(
      `sign-in failed (HTTP ${signIn.status}; credentials / SSO / disabled-password)`,
      false,
    );
  }

  // 3. Create the workspace (idempotent — 400/409 conflict tolerated).
  csrf = await getCsrf(fetchImpl, jar, root);
  const wsRes = await jarFetch(fetchImpl, jar, `${root}/api/workspaces/`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ name: wsName, slug, organization_size: "1-10" }),
    csrf,
  });
  if (!wsRes.ok && wsRes.status !== 400 && wsRes.status !== 409) {
    throw new PlaneProvisionError(`create workspace -> HTTP ${wsRes.status}`, isTransientStatus(wsRes.status));
  }

  // 4. Resolve/create the project.
  const projectId = await resolveProject(fetchImpl, jar, root, slug, opts.projectId, wsName);

  // 5. Mint the user PAT (session-authenticated).
  csrf = await getCsrf(fetchImpl, jar, root);
  const tokRes = await jarFetch(fetchImpl, jar, `${root}/api/users/api-tokens/`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ label: opts.tokenLabel || DEMO_DEFAULTS.tokenLabel }),
    csrf,
  });
  if (!tokRes.ok) {
    throw new PlaneProvisionError(`mint token -> HTTP ${tokRes.status}`, isTransientStatus(tokRes.status));
  }
  const tok = await tokRes.json().catch(() => ({}));
  const pat = typeof tok?.token === "string" ? tok.token : "";
  if (!pat) throw new PlaneProvisionError("mint token -> no token in response", false);

  return { pat, workspaceSlug: slug, projectId };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/** Resolve the effective options from an env bag (dev/demo defaults). */
export function resolveOptions(env = {}) {
  return {
    baseUrl: (env.PLANE_URL || DEMO_DEFAULTS.baseUrl).trim(),
    adminEmail: (env.PLANE_ADMIN_EMAIL || DEMO_DEFAULTS.adminEmail).trim(),
    adminPassword: env.PLANE_ADMIN_PASSWORD || DEMO_DEFAULTS.adminPassword,
    workspaceName: (env.PLANE_WORKSPACE_NAME || DEMO_DEFAULTS.workspaceName).trim(),
    workspaceSlug: slugify((env.PLANE_WORKSPACE_SLUG || DEMO_DEFAULTS.workspaceSlug).trim()),
    projectId: env.PLANE_PROJECT_ID?.trim() || undefined,
    tokenLabel: (env.PLANE_TOKEN_LABEL || DEMO_DEFAULTS.tokenLabel).trim(),
    bridgePort: (env.PLANE_MCP_BRIDGE_PORT || DEMO_DEFAULTS.bridgePort).trim(),
    bridgePath: (env.PLANE_MCP_BRIDGE_PATH || DEMO_DEFAULTS.bridgePath).trim(),
    bridgeInternalBaseUrl: (env.PLANE_MCP_BRIDGE_BASE_URL || DEMO_DEFAULTS.bridgeInternalBaseUrl).trim(),
  };
}

/**
 * Provision (idempotently) a Plane PAT for the demo MCP bridge + write the env
 * files. Reuse-first; version-gated to Plane CE 1.3.1; validate-before-write.
 * Returns a status object; never throws for an expected condition (transient /
 * version / definite failure all resolve a status).
 */
export async function provisionPlane({ env = {}, fetchImpl = fetch, log = () => {}, io } = {}) {
  const opts = resolveOptions(env);
  const root = trimTrailingSlashes(opts.baseUrl);
  const files = io ?? defaultIo();

  const bridgeEnvPath = path.resolve(REPO_ROOT, BRIDGE_ENV_REL);
  const mcpUrl = `http://localhost:${opts.bridgePort}${opts.bridgePath}`;

  // 1. REUSE-FIRST: a PAT already recorded in the bridge env that still
  //    authenticates is reused (idempotent).
  const priorBridgeEnv = files.readFileOr(bridgeEnvPath, "");
  const priorPat = readEnvValue(priorBridgeEnv, "PLANE_API_KEY");
  const priorSlug = readEnvValue(priorBridgeEnv, "PLANE_WORKSPACE_SLUG") || opts.workspaceSlug;
  if (priorPat) {
    const probe = await validatePlaneToken(fetchImpl, root, priorSlug, priorPat);
    if (probe === "ok") {
      const fp = await fingerprint(priorPat);
      log(`[provision-plane] existing bridge PAT valid (fp=${fp}) — reusing, no re-mint`);
      writeOutputs(files, { bridgeEnvPath, opts, root, pat: priorPat, slug: priorSlug, projectId: readEnvValue(priorBridgeEnv, "PLANE_PROJECT_ID") || opts.projectId || "", mcpUrl });
      return { status: "reused", connected: true, minted: false, workspaceSlug: priorSlug, mcpUrl, fingerprint: fp };
    }
    if (probe === "unreachable") {
      log("[provision-plane] existing bridge PAT validation unreachable — Plane not ready; skipping (kept existing)");
      return { status: "skipped", connected: false, minted: false, note: "validation-unreachable (Plane not ready)" };
    }
    log("[provision-plane] existing bridge PAT unauthorized — re-minting");
  }

  // 2. VERSION-PIN the scripted mint.
  const version = await probePlaneVersion(fetchImpl, root);
  if (!version) {
    log("[provision-plane] Plane version could not be probed — is the --profile plane stack up? Skipping.");
    return { status: "skipped", connected: false, minted: false, note: "version-unprobed (Plane not reachable)" };
  }
  if (!SUPPORTED_PLANE_VERSIONS.includes(version)) {
    log(
      `[provision-plane] Plane version ${version} is not in the validated set ` +
        `(${SUPPORTED_PLANE_VERSIONS.join(", ")}) — the scripted headless mint is version-pinned. ` +
        `Mint a PAT manually (Profile -> API tokens) and paste it in the connector setup page.`,
    );
    return { status: "skipped", connected: false, minted: false, version, note: "version-unsupported" };
  }

  // 3. Mint (never on a transient failure — leaves any existing token intact).
  let minted;
  try {
    minted = await mintPlaneToken(fetchImpl, opts);
  } catch (err) {
    const transient = err instanceof PlaneProvisionError ? err.transient : true;
    const label = err instanceof PlaneProvisionError ? err.message : "mint failed";
    log(`[provision-plane] mint ${transient ? "transient" : "definite"} failure — not writing (${label})`);
    return { status: transient ? "skipped" : "error", connected: false, minted: false, version, note: label };
  }

  // 4. VALIDATE-BEFORE-WRITE.
  const probe = await validatePlaneToken(fetchImpl, root, minted.workspaceSlug, minted.pat);
  if (probe !== "ok") {
    log(`[provision-plane] minted token failed validation (${probe}) — NOT writing`);
    return { status: "error", connected: false, minted: true, version, note: `minted-token-invalid (${probe})` };
  }

  writeOutputs(files, { bridgeEnvPath, opts, root, pat: minted.pat, slug: minted.workspaceSlug, projectId: minted.projectId, mcpUrl });
  const fp = await fingerprint(minted.pat);
  log(`[provision-plane] minted + validated + wired (fp=${fp}; workspace=${minted.workspaceSlug}; bridge=${mcpUrl})`);
  return { status: "connected", connected: true, minted: true, version, workspaceSlug: minted.workspaceSlug, projectId: minted.projectId, mcpUrl, fingerprint: fp };
}

/** Write the bridge env file + the app demo env (.env.local). Both gitignored. */
export function writeOutputs(files, { bridgeEnvPath, opts, root, pat, slug, projectId, mcpUrl }) {
  // Bridge env (the container's `env_file`): holds the PAT server-side.
  files.mkdirp(path.dirname(bridgeEnvPath));
  let bridgeContent = files.readFileOr(bridgeEnvPath, "");
  bridgeContent = upsertEnvAll(bridgeContent, [
    ["PLANE_API_KEY", pat],
    ["PLANE_WORKSPACE_SLUG", slug],
    ["PLANE_BASE_URL", opts.bridgeInternalBaseUrl],
    ["PLANE_PROJECT_ID", projectId || ""],
  ]);
  files.writeFile(bridgeEnvPath, bridgeContent);

  // App demo env (.env.local): the connector's dev-setup auto-connect reads the
  // admin creds (mints its OWN connector-config PAT — reuse-first) + pins the
  // same workspace/project, and probes PLANE_MCP_URL to wire the MCP row. The
  // PAT itself is NOT written here (it lives only in the bridge env file).
  const envLocalPath = path.resolve(REPO_ROOT, ".env.local");
  let envContent = files.readFileOr(envLocalPath, "");
  envContent = upsertEnvAll(envContent, [
    ["PLANE_URL", root],
    ["PLANE_ADMIN_EMAIL", opts.adminEmail],
    ["PLANE_ADMIN_PASSWORD", opts.adminPassword],
    ["PLANE_WORKSPACE_SLUG", slug],
    ["PLANE_PROJECT_ID", projectId || ""],
    ["PLANE_MCP_URL", mcpUrl],
  ]);
  files.writeFile(envLocalPath, envContent);
}

/** Default filesystem IO (overridable in tests). */
export function defaultIo() {
  return {
    readFileOr: (p, fallback) => (existsSync(p) ? readFileSync(p, "utf8") : fallback),
    writeFile: (p, content) => writeFileSync(p, content),
    mkdirp: (p) => {
      if (!existsSync(p)) mkdirSync(p, { recursive: true });
    },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const result = await provisionPlane({ env: process.env, log: (m) => console.log(m) });
  // A "skipped" outcome (Plane not ready / unsupported version) is NON-FATAL for
  // the demo bring-up — the connector re-attempts at the next boot and the
  // manual-paste path remains. Only a definite provisioning error is a failure.
  if (result.status === "error") {
    console.error(`[provision-plane] provisioning error: ${result.note ?? "unknown"}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`[provision-plane] unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}

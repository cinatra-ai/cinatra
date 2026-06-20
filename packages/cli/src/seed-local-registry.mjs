// -----------------------------------------------------------------------------
// Dev-only seed of the on-disk first-party extensions into the LOCAL bundled
// Verdaccio (cinatra#386).
//
// THE GAP: the repo ships ~80 first-party extension packages on disk at
// `extensions/<vendor>/<pkg>/` (e.g. `@cinatra-ai/blog-content-workflow`), but a
// fresh/bundled local Verdaccio (docker-compose `verdaccio` service at
// 127.0.0.1:4873) starts EMPTY — those packages were never published into it.
// The installer resolves REGISTRY-ONLY (pacote against the registry URL; no
// on-disk fallback), so a `GET /@cinatra-ai%2fblog-content-workflow` returns 404
// and the extension is uninstallable out of the box.
//
// THE FIX (the dev-side mirror of the production seeding contract): production
// installs resolve from immutable registry tarballs that a maintainer publishes
// to the production Verdaccio; here we do the dev equivalent — publish the
// on-disk first-party packages into the LOCAL registry during `cinatra setup
// dev`, so dev resolution matches the production "registry is the install
// backend" model WITHOUT teaching the installer a source-tree fallback (which
// would widen the install trust surface and let packaging defects hide until
// production).
//
// GUARDRAILS (codex-converged on cinatra#386):
//   - DEV-ONLY: called only from the `mode === "dev"` block of `runSetup`,
//     after the on-disk extension tree is materialized + manifests regenerated.
//     Never on the prod setup path and never on any install path.
//   - LOOPBACK-ONLY: the publish target is HARD-BOUND to a loopback host
//     (127.0.0.1 / ::1 / localhost). A non-loopback registry URL is REJECTED
//     before any publish — this seed must never push at a remote/production
//     registry. Arbitrary env registry values are not honored as a publish
//     target.
//   - REACHABILITY-GATED: if the local registry is down/unreadable, warn and
//     skip the whole step (loud-but-non-fatal — never abort setup).
//   - TEMP AUTH ONLY: self-register a throwaway Verdaccio user, write the auth
//     token only into a temp `--userconfig` file, and delete it in `finally`.
//     The real `~/.npmrc` is never read or mutated.
//   - IDEMPOTENT + NON-CLOBBERING: check the packument first; if `name@version`
//     already exists, SKIP (never force-publish / unpublish / overwrite a
//     dist-tag). Re-running setup is a cheap no-op.
//   - VERSION-SKEW DETECTION: if `name@version` already exists but the local
//     packed bytes differ from the registry tarball integrity, warn LOUDLY and
//     set a non-zero exit code (don't republish the same version) — the operator
//     must purge/reset the local Verdaccio or bump the extension version.
//   - PRIVATE/SHAPE FILTER: only publish packages whose `package.json` has a
//     valid `name` + `version` and is not `"private": true`.
//   - FAILURE DISCIPLINE: a per-package publish failure warns, continues to the
//     remaining packages, and leaves setup loud-but-non-fatal.
//
// This module is intentionally self-contained (node builtins + the `npm` binary
// that ships alongside node): like its `agents-install.mjs` sibling it cannot
// import the @cinatra-ai/registries TS source from a `.mjs` CLI script.
// -----------------------------------------------------------------------------

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

// The bundled local Verdaccio — the ONLY sanctioned publish target for this
// dev seed. Matches docker-compose `verdaccio` (host port 4873) and the
// `DEFAULT_REGISTRY_URL` the agents-install CLI already uses.
export const LOCAL_REGISTRY_URL = "http://127.0.0.1:4873";

// Hostnames that count as loopback. A publish target MUST resolve to one of
// these or the step refuses to run (never push at a remote/production registry).
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

// Per-call ceilings so a loopback service that ACCEPTS a connection then stalls
// can never hang setup. A timeout is always treated as warn-and-continue (the
// whole step is loud-but-non-fatal). Generous because publish writes a tarball.
const HTTP_TIMEOUT_MS = 15_000;
const PUBLISH_TIMEOUT_MS = 60_000;

/**
 * Compare two dotted numeric version cores (`major.minor.patch[...]`). Returns
 * 1 if `a > b`, -1 if `a < b`, 0 if equal. Pre-release/build metadata is
 * ignored (split off the first `-`/`+`); a non-numeric segment compares as 0.
 * Deliberately tiny — this only decides "would npm reject a lower publish?",
 * not full semver precedence.
 */
export function compareVersionCores(a, b) {
  const core = (v) => String(v).split(/[-+]/)[0].split(".").map((n) => Number.parseInt(n, 10) || 0);
  const av = core(a);
  const bv = core(b);
  const len = Math.max(av.length, bv.length);
  for (let i = 0; i < len; i++) {
    const x = av[i] ?? 0;
    const y = bv[i] ?? 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/**
 * True iff any published version is >= `onDiskVersion`. When this holds, `npm
 * publish` of the on-disk (lower-or-equal) version would be rejected as a lower
 * `latest`, so we skip gracefully instead of forcing a loud failure. When only
 * LOWER versions exist (e.g. after an on-disk version bump), this is false and
 * the caller proceeds to publish the new version.
 */
export function registryHasAtLeast(packument, onDiskVersion) {
  const versions = packument?.versions ? Object.keys(packument.versions) : [];
  return versions.some((v) => compareVersionCores(v, onDiskVersion) >= 0);
}

/**
 * True iff `registryUrl` is a well-formed http(s) URL whose host is loopback.
 * Defensive: a parse failure (or any non-loopback host) returns false so the
 * caller refuses to publish.
 */
export function isLoopbackRegistryUrl(registryUrl) {
  if (!registryUrl || typeof registryUrl !== "string") return false;
  let parsed;
  try {
    parsed = new URL(registryUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return LOOPBACK_HOSTS.has(parsed.hostname);
}

/**
 * Enumerate the on-disk first-party extension package dirs under
 * `<repoRoot>/extensions/<vendor>/<pkg>/` that carry a publishable
 * `package.json` (valid name+version, not private). Returns sorted entries
 * `{ dir, name, version, private }` for deterministic ordering.
 */
export function enumeratePublishableExtensions(repoRoot) {
  const extensionsRoot = path.join(repoRoot, "extensions");
  const out = [];
  if (!existsSync(extensionsRoot)) return out;

  let vendors;
  try {
    vendors = readdirSync(extensionsRoot, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const vendor of vendors) {
    if (!vendor.isDirectory()) continue;
    const vendorDir = path.join(extensionsRoot, vendor.name);
    let pkgs;
    try {
      pkgs = readdirSync(vendorDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const pkg of pkgs) {
      if (!pkg.isDirectory()) continue;
      const dir = path.join(vendorDir, pkg.name);
      const manifestPath = path.join(dir, "package.json");
      if (!existsSync(manifestPath)) continue;
      let manifest;
      try {
        manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      } catch {
        // Unreadable/invalid package.json — skip (a per-package warn happens
        // at the call site only for things we actually try to publish).
        continue;
      }
      if (manifest.private === true) continue;
      if (typeof manifest.name !== "string" || !manifest.name) continue;
      if (typeof manifest.version !== "string" || !manifest.version) continue;
      out.push({
        dir,
        name: manifest.name,
        version: manifest.version,
        private: false,
      });
    }
  }

  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/**
 * Probe the registry root. Returns true on a 2xx HTTP response, false on any
 * network error / non-2xx. Used to skip the whole step when Verdaccio is down.
 */
async function isRegistryReachable(registryUrl) {
  try {
    const res = await fetch(new URL("/", registryUrl), {
      method: "GET",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Read the registry packument for `name`. Returns the parsed JSON on 200, or
 * `null` on 404 / network error / non-200 (treated as "not present yet").
 */
async function fetchPackument(registryUrl, name) {
  // Scoped names must be URL-escaped (`@scope/name` → `@scope%2fname`).
  const escaped = name.replace("/", "%2f");
  try {
    const res = await fetch(new URL(`/${escaped}`, registryUrl), {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (res.status === 200) return await res.json();
    return null;
  } catch {
    return null;
  }
}

// The throwaway seed user. The password is DETERMINISTIC (and local-only): the
// only credential it ever guards is publish access to a loopback dev Verdaccio.
// Determinism is REQUIRED for idempotency — on a re-run the user already exists,
// so the second `cinatra setup dev` must be able to LOG BACK IN (anonymous
// adduser then returns 409) to get a fresh publish token. A random per-run
// password would lock the existing user out and break re-seeding.
const SEED_USER = "cinatra-dev-seed";
const SEED_PASSWORD = "cinatra-local-dev-seed-v1";
const SEED_EMAIL = "dev-seed@cinatra.local";

/**
 * Provision (or re-authenticate) the throwaway seed user on the LOOPBACK
 * registry and return a fresh publish token. Two-step:
 *   1. Anonymous PUT to the couchdb adduser endpoint — creates the user the
 *      first time (Verdaccio enables anonymous registration by default).
 *   2. If the user already exists (409 "already registered"), PUT again WITH
 *      Basic auth (the npm-login path) to mint a fresh token.
 * Returns `null` on any failure (the caller then skips the whole step
 * loud-but-non-fatally). NEVER include a response body in surfaced text — it may
 * reflect the password back.
 */
async function provisionSeedToken(registryUrl) {
  const base = registryUrl.replace(/\/$/, "");
  const url = `${base}/-/user/org.couchdb.user:${encodeURIComponent(SEED_USER)}`;
  const body = {
    _id: `org.couchdb.user:${SEED_USER}`,
    name: SEED_USER,
    password: SEED_PASSWORD,
    email: SEED_EMAIL,
    type: "user",
    roles: [],
    date: new Date().toISOString(),
  };

  // Step 1 — anonymous create (first-run).
  try {
    const res = await fetch(url, {
      method: "PUT",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (res.status === 201 || res.status === 200) {
      const parsed = await res.json().catch(() => null);
      if (parsed && typeof parsed.token === "string" && parsed.token) return parsed.token;
      return null;
    }
    // Any non-409 failure (e.g. registration disabled) → give up.
    if (res.status !== 409) return null;
  } catch {
    return null;
  }

  // Step 2 — the user already exists; re-authenticate with Basic auth (npm
  // login) using the deterministic seed password to mint a fresh token.
  try {
    const basic = Buffer.from(`${SEED_USER}:${SEED_PASSWORD}`).toString("base64");
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        authorization: `Basic ${basic}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ name: SEED_USER, password: SEED_PASSWORD }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (res.status === 201 || res.status === 200) {
      const parsed = await res.json().catch(() => null);
      if (parsed && typeof parsed.token === "string" && parsed.token) return parsed.token;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * `npm pack` the package dir into `outDir` and return the absolute tarball path
 * (no publish). Used for version-skew integrity comparison. Returns null on
 * failure.
 */
function packTarball(dir, outDir, registryUrl, userconfigPath) {
  const result = spawnSync(
    "npm",
    [
      "pack",
      "--pack-destination",
      outDir,
      "--registry",
      registryUrl,
      // Pure-source first-party packages — no pack lifecycle hooks are needed,
      // and ignoring scripts keeps a malicious/accidental prepack out of setup.
      "--ignore-scripts",
    ],
    {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, NPM_CONFIG_USERCONFIG: userconfigPath },
      timeout: PUBLISH_TIMEOUT_MS,
    },
  );
  if (result.status !== 0) return null;
  // npm pack prints the produced filename on the last non-empty stdout line.
  const lines = (result.stdout || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const file = lines[lines.length - 1];
  if (!file) return null;
  const abs = path.join(outDir, path.basename(file));
  return existsSync(abs) ? abs : null;
}

/** sha512 base64 integrity string (`sha512-<base64>`) for a tarball file. */
function tarballIntegrity(tarballPath) {
  const bytes = readFileSync(tarballPath);
  const digest = createHash("sha512").update(bytes).digest("base64");
  return `sha512-${digest}`;
}

/**
 * Seed every on-disk first-party extension into the LOCAL bundled Verdaccio.
 *
 * Loud-but-non-fatal: returns a summary and may set `process.exitCode = 1` on a
 * meaningful failure/skew, but NEVER throws past the caller and NEVER aborts
 * setup. Returns `{ status, registryUrl, published, skipped, failed, skew }`.
 *
 * `status`:
 *   - "skipped-not-loopback"  registry target is not loopback → refused
 *   - "skipped-unreachable"   local Verdaccio not up → nothing to do
 *   - "skipped-no-auth"       could not self-register a publish user
 *   - "skipped-empty"         no publishable extensions on disk
 *   - "ok"                    ran (see counts)
 */
export async function seedLocalRegistryExtensions({
  repoRoot,
  registryUrl = LOCAL_REGISTRY_URL,
} = {}) {
  const summary = {
    status: "ok",
    registryUrl,
    published: [],
    skipped: [],
    failed: [],
    skew: [],
    divergentVersion: [],
  };

  // GUARDRAIL: loopback-only. Refuse any non-loopback publish target outright.
  if (!isLoopbackRegistryUrl(registryUrl)) {
    summary.status = "skipped-not-loopback";
    console.warn(
      `\n⚠ Local registry seed SKIPPED: publish target '${registryUrl}' is not a loopback ` +
        `address. This dev seed only ever publishes to the local bundled Verdaccio.\n`,
    );
    return summary;
  }

  // GUARDRAIL: reachability. Verdaccio down → skip the whole step.
  if (!(await isRegistryReachable(registryUrl))) {
    summary.status = "skipped-unreachable";
    console.log(
      `- Local registry seed: skipped (Verdaccio not reachable at ${registryUrl}; ` +
        `start the docker stack and re-run \`cinatra setup dev\` to seed bundled extensions).`,
    );
    return summary;
  }

  const extensions = enumeratePublishableExtensions(repoRoot);
  if (extensions.length === 0) {
    summary.status = "skipped-empty";
    console.log("- Local registry seed: no publishable on-disk extensions found.");
    return summary;
  }

  // GUARDRAIL: temp auth only. Self-register and write the token into a temp
  // userconfig, removed in `finally` — the real ~/.npmrc is never touched.
  const token = await provisionSeedToken(registryUrl);
  if (!token) {
    summary.status = "skipped-no-auth";
    console.warn(
      "\n⚠ Local registry seed SKIPPED: could not provision a publish user on the local " +
        "Verdaccio (registration may be disabled). Bundled extensions will not be seeded.\n",
    );
    process.exitCode = 1;
    return summary;
  }

  let tmpDir;
  try {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "cinatra-seed-registry-"));
    const userconfigPath = path.join(tmpDir, ".npmrc");
    const host = new URL(registryUrl).host;
    writeFileSync(
      userconfigPath,
      `//${host}/:_authToken=${token}\nregistry=${registryUrl.replace(/\/$/, "")}/\n`,
      { mode: 0o600 },
    );
    for (const ext of extensions) {
      const id = `${ext.name}@${ext.version}`;
      const packument = await fetchPackument(registryUrl, ext.name);
      const existing = packument?.versions?.[ext.version];
      // IDEMPOTENT: already-present exact version → skip (or skew-check).
      if (existing) {
        // VERSION-SKEW DETECTION: compare local packed bytes to the registry
        // tarball integrity. A mismatch means the on-disk source diverged from
        // the already-published version — warn loudly, do NOT republish.
        const registryIntegrity =
          typeof existing.dist?.integrity === "string" ? existing.dist.integrity : null;
        if (registryIntegrity) {
          const packed = packTarball(ext.dir, tmpDir, registryUrl, userconfigPath);
          if (packed) {
            const localIntegrity = tarballIntegrity(packed);
            try {
              rmSync(packed, { force: true });
            } catch {
              /* ignore */
            }
            if (localIntegrity !== registryIntegrity) {
              summary.skew.push(id);
              console.warn(
                `\n⚠ Local registry seed: ${id} is already published but the on-disk source ` +
                  `differs from the published tarball. NOT republishing the same version. ` +
                  `Purge/reset the local Verdaccio or bump the extension version to refresh it.\n`,
              );
              process.exitCode = 1;
              continue;
            }
          }
        }
        summary.skipped.push(id);
        continue;
      }

      // DIVERGENT VERSION (dirty-registry tolerance): the package exists on the
      // registry but NOT at the on-disk version, AND a version >= the on-disk
      // version is already published (e.g. a higher version from a past ad-hoc
      // publish). npm would reject the lower `latest` publish; this is not a
      // fresh-instance failure, so record it as an informational skip (NON-fatal)
      // and leave the existing version(s) in place.
      //
      // IMPORTANT: when only LOWER versions exist (e.g. the on-disk version was
      // bumped since the last seed), this is FALSE — we fall through and publish
      // the new version, so a version bump actually lands. On a truly fresh
      // instance the packument is 404 → `packument` is null → we publish.
      if (registryHasAtLeast(packument, ext.version)) {
        const others = Object.keys(packument.versions).join(", ");
        summary.divergentVersion.push(id);
        console.log(
          `- Local registry seed: ${id} not published — the local registry already has ` +
            `${ext.name} at a version >= ${ext.version} (${others}). Leaving the existing version(s) in place.`,
        );
        continue;
      }

      // PUBLISH: `npm publish <dir>` against the loopback registry with the temp
      // userconfig. Per-package failure warns + continues (loud-but-non-fatal).
      const result = spawnSync(
        "npm",
        [
          "publish",
          ext.dir,
          "--registry",
          registryUrl,
          // default access keeps scoped packages public on Verdaccio.
          "--access",
          "public",
          // Pure-source first-party packages — no publish lifecycle hooks are
          // needed; ignoring scripts keeps a prepublish hook out of setup.
          "--ignore-scripts",
        ],
        {
          encoding: "utf8",
          env: { ...process.env, NPM_CONFIG_USERCONFIG: userconfigPath },
          timeout: PUBLISH_TIMEOUT_MS,
        },
      );
      if (result.status === 0) {
        summary.published.push(id);
      } else {
        summary.failed.push(id);
        const stderr = (result.stderr || "").trim().split("\n").slice(-3).join("\n");
        console.warn(`\n⚠ Local registry seed: failed to publish ${id}\n  ${stderr}\n`);
        process.exitCode = 1;
      }
    }

    console.log(
      `- Local registry seed: ${summary.published.length} published, ` +
        `${summary.skipped.length} already present, ${summary.failed.length} failed` +
        (summary.divergentVersion.length
          ? `, ${summary.divergentVersion.length} different-version (left as-is)`
          : "") +
        (summary.skew.length ? `, ${summary.skew.length} version-skew (NOT republished)` : "") +
        ` (bundled extensions → ${registryUrl}).`,
    );
  } catch (err) {
    // Any unexpected escape is loud-but-non-fatal — setup is not rolled back.
    console.warn(
      `\n⚠ Local registry seed encountered an error:\n  ${err && err.message ? err.message : err}\n`,
    );
    process.exitCode = 1;
  } finally {
    if (tmpDir) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  }

  return summary;
}

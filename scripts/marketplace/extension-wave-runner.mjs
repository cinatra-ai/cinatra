#!/usr/bin/env node
// ---------------------------------------------------------------------------
// extension-wave-runner — the controlled, observable driver for a marketplace
// publish WAVE (many 0-dependency cinatra-ai extensions submitted back-to-back).
//
// It does NOT invent a new publish path: each extension is submitted by shelling
// out to the same hardened `release-submit.mjs` (so the dependency-ordering gate,
// vendor auth, request timeout, and promotion-outcome assertion all apply
// identically). This runner adds the things a multi-extension wave needs that a
// single submit cannot know about — and that the marketplace publish-wave
// readiness audit called for before firing:
//
//   1. PACING. The marketplace credential broker rate-limits mutating ops on a
//      single bucket keyed by the vendor's HMAC keyId (burst 5, refill 10/min).
//      Each submit costs ~2 mutating ops (staging + final publish). Firing 50+
//      back-to-back trips a 429 cascade. We pace >= 13s between submits by default.
//   2. PRE-FLIGHT PACK. Pack every extension locally first and assert each is a
//      valid, <50MiB tarball that carries package.json + README + a cinatra.kind,
//      converting a mid-wave malformed/oversized surprise into a pre-wave gate.
//   3. AUTH PRE-FLIGHT. One cheap authenticated read (`cinatra-extension-get`)
//      before firing, so a bad/rotated token fails BEFORE any publish.
//   4. PROMOTION-STATE TRUTH. release-submit.mjs already throws on a half-failed
//      promotion (status=approved + promotion_state=failed). We record each
//      extension's terminal outcome in a RESUME manifest.
//   5. RESUME. A re-run skips extensions already confirmed listed (idempotent;
//      re-submitting the same version is safe but re-burns the rate budget).
//   6. RECONCILIATION. After the wave, query `cinatra-extension-get` + the public
//      storefront URL per extension and assert it is actually a renderable listing.
//   7. SAFETY. DRY-RUN by default; `--execute` is required to submit anything;
//      `--canary N` limits the number of NEW submits. The vendor token is read
//      from the environment and is NEVER printed, logged, or placed on argv.
//
// Usage:
//   node scripts/marketplace/extension-wave-runner.mjs [options]
//     (no --execute)        DRY RUN: enumerate + pre-flight pack + auth pre-flight
//                           + reconcile what is ALREADY listed. Submits nothing.
//     --execute             actually submit the not-yet-listed extensions (paced).
//     --canary <n>          submit at most <n> NEW extensions this run (ramp).
//     --only <a,b,c>        restrict to these extension slugs (cinatra-ai/<slug>).
//     --exclude <a,b>       skip these slugs (in addition to the always-skip set).
//     --pace-ms <ms>        delay between submits (default 13000; min 6000).
//     --state <path>        resume-manifest path (default /tmp/cinatra-wave-state.json).
//     --extensions-dir <p>  override the extensions root (default extensions/cinatra-ai).
//
// Token: CINATRA_MARKETPLACE_VENDOR_TOKEN (env only; never on argv).
// ---------------------------------------------------------------------------

import { readFile, writeFile, mkdir, readdir, stat, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve as resolvePath, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  vendorAuthHeader,
  classifySubmissionOutcome,
  MARKETPLACE_BASE_URL,
  extractCinatraDeps,
} from "../extensions/templates/release/release-submit.mjs";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const RELEASE_SUBMIT = resolvePath(HERE, "../extensions/templates/release/release-submit.mjs");
const MCP_ROUTE = "/wp-json/cinatra/mcp";

export const MAX_TARBALL_BYTES = 50 * 1024 * 1024; // mirror ExtensionSubmitForReview::MAX_TARBALL_BYTES
export const DEFAULT_PACE_MS = 13_000; // >= 2 mutating tokens must refill at 1 / 6s
export const MIN_PACE_MS = 6_000;
// Already published earlier (the first storefront publish) — never re-submit by default.
export const ALWAYS_SKIP_SLUGS = new Set(["blog-skills"]);
// Known-published, scoped package used to validate the vendor token in the auth
// pre-flight. cinatra-extension-get REQUIRES the scoped npm-style name (with the
// leading "@") — a bare "cinatra-ai/blog-skills" is rejected as not-scoped.
export const AUTH_PREFLIGHT_PACKAGE = "@cinatra-ai/blog-skills";

// --- pure helpers (unit-tested) ---------------------------------------------

/** True when a manifest declares NO @cinatra-ai/* dependency or peerDependency. */
export function isZeroDep(manifest) {
  return extractCinatraDeps(manifest).length === 0;
}

/** True when any dep/peer/dev/optional version is a `workspace:` protocol spec. */
export function hasWorkspaceSpec(manifest) {
  for (const f of ["dependencies", "peerDependencies", "devDependencies", "optionalDependencies"]) {
    const d = manifest?.[f];
    if (d && typeof d === "object") {
      for (const v of Object.values(d)) if (typeof v === "string" && v.startsWith("workspace:")) return true;
    }
  }
  return false;
}

/**
 * Transform a monorepo extension package.json into a PUBLISHABLE one: every
 * `workspace:*` dependency becomes a peerDependency `"*"` (a host-PROVIDED peer —
 * the cinatra host the extension installs into supplies it; `auto-install-peers=false`
 * means it is never fetched from a registry), real registry deps are kept verbatim,
 * and NO `workspace:` spec survives. Mirrors the extraction planner
 * (scripts/extensions/extract-extension-repos.mjs `planExtractionForPackage`) so a
 * connector tarball is installable outside the workspace. `private` is dropped (a
 * published extension is not private).
 */
export function transformPackageJsonForPublish(pkgJson) {
  const isWs = (v) => typeof v === "string" && v.startsWith("workspace:");
  // First-party = @cinatra-ai/* or @cinatra/* — host-internal, never published.
  const isFirstParty = (name) => /^@cinatra(?:-ai)?\//.test(name);
  const deps = {};
  const peers = { ...(pkgJson.peerDependencies || {}) };
  for (const [n, v] of Object.entries(pkgJson.dependencies || {})) {
    if (isWs(v)) peers[n] = "*";
    else deps[n] = v;
  }
  for (const [n, v] of Object.entries(peers)) if (isWs(v)) peers[n] = "*";
  const devDeps = {};
  for (const [n, v] of Object.entries(pkgJson.devDependencies || {})) devDeps[n] = isWs(v) ? "*" : v;
  const optionalDeps = {};
  for (const [n, v] of Object.entries(pkgJson.optionalDependencies || {})) optionalDeps[n] = isWs(v) ? "*" : v;
  // Mirror planExtractionForPackage: ANY first-party dep that landed in
  // dependencies/devDependencies (e.g. pinned to a real version, not workspace:*)
  // must be reclassified to a PEER — a standalone install must never try to fetch
  // an unpublished host-internal package (it would 404). Then mark every first-party
  // peer optional so install/pack stays quiet about the (intentionally) host-provided
  // missing peer.
  for (const bucket of [deps, devDeps]) {
    for (const n of Object.keys(bucket)) {
      if (isFirstParty(n)) {
        peers[n] = "*";
        delete bucket[n];
      }
    }
  }
  const peerDependenciesMeta = {};
  for (const n of Object.keys(peers)) if (isFirstParty(n)) peerDependenciesMeta[n] = { optional: true };
  const out = {
    name: pkgJson.name,
    version: pkgJson.version || "0.0.0",
    ...(pkgJson.license ? { license: pkgJson.license } : {}),
    ...(pkgJson.description ? { description: pkgJson.description } : {}),
    type: pkgJson.type || "module",
    ...(pkgJson.main ? { main: pkgJson.main } : {}),
    ...(pkgJson.module ? { module: pkgJson.module } : {}),
    ...(pkgJson.types ? { types: pkgJson.types } : {}),
    ...(pkgJson.exports ? { exports: pkgJson.exports } : {}),
    ...(pkgJson.bin ? { bin: pkgJson.bin } : {}),
    ...(pkgJson.files ? { files: pkgJson.files } : {}),
    ...(pkgJson.scripts ? { scripts: pkgJson.scripts } : {}),
    ...(Object.keys(deps).length ? { dependencies: deps } : {}),
    ...(Object.keys(peers).length ? { peerDependencies: peers } : {}),
    ...(Object.keys(peerDependenciesMeta).length ? { peerDependenciesMeta } : {}),
    ...(Object.keys(devDeps).length ? { devDependencies: devDeps } : {}),
    ...(Object.keys(optionalDeps).length ? { optionalDependencies: optionalDeps } : {}),
    ...(pkgJson.cinatra ? { cinatra: pkgJson.cinatra } : {}),
  };
  if (JSON.stringify(out).includes("workspace:")) {
    throw new Error(`transformPackageJsonForPublish: a workspace: spec survived in ${pkgJson.name}`);
  }
  return out;
}

/**
 * Extension-edge package names from the CANONICAL `cinatra.dependencies` manifest
 * field (a list of `{packageName, …}` objects, or a list of strings, or a name→spec
 * object). This is the authoritative cross-extension edge set — some connectors
 * declare an edge ONLY here and not in npm deps (e.g. linkedin→social-media,
 * resend→email).
 */
export function extractCinatraManifestDepNames(manifest) {
  const c = manifest?.cinatra?.dependencies;
  const out = new Set();
  if (Array.isArray(c)) {
    for (const e of c) {
      if (e && typeof e === "object" && typeof e.packageName === "string") out.add(e.packageName);
      else if (typeof e === "string") out.add(e.startsWith("@") ? e : `@cinatra-ai/${e}`);
    }
  } else if (c && typeof c === "object") {
    for (const k of Object.keys(c)) out.add(k);
  }
  return [...out];
}

/**
 * Split a manifest's @cinatra-ai/* deps into marketplace EXTENSION deps (must be
 * ordered/published first) vs HOST-INTERNAL deps (SDK/app packages — host-provided
 * peers, never published, excluded from ordering). EXTENSION deps are the UNION of
 * npm @cinatra-ai/* deps that are extensions AND the canonical cinatra.dependencies
 * edges — neither source alone is complete.
 */
export function classifyCinatraDeps(manifest, extensionNames = new Set()) {
  const ext = new Set();
  const host = new Set();
  for (const d of extractCinatraDeps(manifest)) {
    (extensionNames.has(d.name) ? ext : host).add(d.name);
  }
  for (const n of extractCinatraManifestDepNames(manifest)) {
    if (extensionNames.has(n)) ext.add(n);
  }
  return { extensionDeps: [...ext], hostInternalDeps: [...host] };
}

/**
 * Select the wave set. In the default (0-dep) mode a candidate with any
 * @cinatra-ai/* dep is INELIGIBLE. In `includeExtensionDeps` (connector) mode,
 * host-internal SDK deps are fine and extension deps are allowed (ordered later
 * by orderByExtensionDeps); only validity (scoped name / version / kind) gates.
 */
export function selectWaveExtensions(
  candidates,
  { only = null, exclude = [], extensionNames = new Set(), includeExtensionDeps = false } = {},
) {
  const onlySet = only && only.length ? new Set(only) : null;
  const exSet = new Set([...ALWAYS_SKIP_SLUGS, ...exclude]);
  const out = [];
  for (const c of candidates) {
    const m = c.manifest || {};
    const name = typeof m.name === "string" ? m.name : null;
    const kind = m.cinatra && typeof m.cinatra.kind === "string" ? m.cinatra.kind : null;
    const version = typeof m.version === "string" ? m.version : null;
    const { extensionDeps, hostInternalDeps } = classifyCinatraDeps(m, extensionNames);
    const reasons = [];
    if (!name || name.indexOf("/") < 0) reasons.push("missing scoped package name");
    if (!version) reasons.push("missing version");
    if (!kind) reasons.push("missing cinatra.kind");
    if (!includeExtensionDeps && !isZeroDep(m)) reasons.push("has @cinatra-ai/* dependency (not 0-dep)");
    if (onlySet && !onlySet.has(c.slug)) continue;
    if (exSet.has(c.slug)) continue;
    const base = { slug: c.slug, dir: c.dir, name, version, kind, extensionDeps, hostInternalDeps };
    out.push(reasons.length ? { ...base, eligible: false, reasons } : { ...base, eligible: true, reasons: [] });
  }
  out.sort((a, b) => a.slug.localeCompare(b.slug));
  return out;
}

/**
 * Order selected extensions so each publishes AFTER its in-wave extension deps
 * (a connector depending on another connector goes second). Deps not in the wave
 * are assumed already-published / host-internal and ignored. Throws on a cycle.
 */
export function orderByExtensionDeps(selected) {
  const byName = new Map(selected.map((s) => [s.name, s]));
  const ordered = [];
  const state = new Map(); // name → "visiting" | "done"
  const visit = (s, stack) => {
    const st = state.get(s.name);
    if (st === "done") return;
    if (st === "visiting") throw new Error(`extension dependency cycle: ${[...stack, s.name].join(" → ")}`);
    state.set(s.name, "visiting");
    for (const dn of s.extensionDeps || []) {
      const dep = byName.get(dn);
      if (dep) visit(dep, [...stack, s.name]);
    }
    state.set(s.name, "done");
    ordered.push(s);
  };
  for (const s of selected) visit(s, []);
  return ordered;
}

/** Validate `npm pack --json` output for one extension against the server caps. */
export function validatePackedTarball(packJson, { declaredKind } = {}) {
  const entry = Array.isArray(packJson) ? packJson[0] : packJson;
  const problems = [];
  const size = Number(entry?.size ?? NaN);
  if (!Number.isFinite(size)) problems.push("npm pack reported no size");
  else if (size > MAX_TARBALL_BYTES) problems.push(`tarball ${size}B exceeds the ${MAX_TARBALL_BYTES}B server cap`);
  const files = Array.isArray(entry?.files) ? entry.files.map((f) => String(f.path || "").toLowerCase()) : [];
  const has = (suffix) => files.some((p) => p === suffix || p.endsWith(`/${suffix}`));
  if (!has("package.json")) problems.push("tarball is missing package.json");
  if (!has("readme.md")) problems.push("tarball is missing README.md (storefront Description tab would be blank)");
  if (!declaredKind) problems.push("package.json has no cinatra.kind");
  return { ok: problems.length === 0, size, fileCount: files.length, problems };
}

/** Parse the stdout of release-submit.mjs into a structured outcome. */
export function parseSubmitStdout(stdout) {
  const grab = (k) => {
    const m = new RegExp(`^${k}:\\s*(.+)$`, "m").exec(stdout || "");
    return m ? m[1].trim() : null;
  };
  const submissionId = grab("submission_id");
  const status = grab("status");
  let promotionState = grab("promotion_state");
  if (promotionState === "n/a") promotionState = null;
  return { submissionId, status, promotionState };
}

export function clampPaceMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_PACE_MS;
  return Math.max(MIN_PACE_MS, Math.floor(n));
}

// --canary must FAIL CLOSED: a malformed value must never silently disable the
// cap (which would turn an intended canary into a full wave). This parses the
// VALUE of a PRESENT --canary flag — absence is handled by the caller (→ Infinity).
// A present flag with a missing/empty/non-integer/negative value → throw.
export function parseCanaryArg(raw) {
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) {
    throw new Error("--canary requires a non-negative integer value (e.g. --canary 1).");
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`--canary must be a non-negative integer (got "${raw}").`);
  }
  return n;
}

// Defensive normalization for the submit cap inside runWave: anything that is not
// a valid Infinity / non-negative integer collapses to 0 (submit nothing).
export function normalizeCanaryLimit(canary) {
  if (canary === Infinity) return Infinity;
  return Number.isInteger(canary) && canary >= 0 ? canary : 0;
}

// The per-iteration decision of the submit loop, extracted PURE so the
// submit/skip-resumed/blocked/canary-stopped branches are unit-testable (the loop
// itself is effectful: it submits + mutates listedNames on success). The loop
// calls this each iteration with the LIVE listedNames + submitted count, so the
// blocking branch reacts to ACTUAL outcomes (a dep that failed/never-listed this
// run still blocks its dependents).
//   ext         — { slug, name, version, extensionDeps }
//   prior       — state.extensions[ext.slug] (or undefined)
//   listedNames — Set of extension names proven LISTED so far (resume + this run)
//   inWaveNames — Set of all eligible extension names (wave responsibility)
//   submitted   — count submitted so far this run
//   canaryLimit — Infinity or a non-negative integer
// Returns { action: 'submit'|'skip-resumed'|'blocked'|'canary-stopped', reason, blockedBy? }.
export function decideWaveAction({ ext, prior, listedNames, inWaveNames, submitted, canaryLimit }) {
  if (prior && prior.outcome === "listed" && prior.version === ext.version) {
    return { action: "skip-resumed", reason: `already listed at ${ext.version}` };
  }
  const blockedBy = (ext.extensionDeps || []).filter((dn) => inWaveNames.has(dn) && !listedNames.has(dn));
  if (blockedBy.length) {
    return { action: "blocked", reason: "extension dep(s) not listed", blockedBy };
  }
  if (submitted >= canaryLimit) {
    return { action: "canary-stopped", reason: `canary limit (${canaryLimit}) reached` };
  }
  return { action: "submit", reason: "ready" };
}

// --- effectful helpers ------------------------------------------------------

async function loadCandidates(extensionsDir) {
  const root = resolvePath(process.cwd(), extensionsDir);
  if (!existsSync(root)) throw new Error(`extensions dir not found: ${root}`);
  const slugs = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  const candidates = [];
  for (const slug of slugs) {
    const dir = join(root, slug);
    const pkgPath = join(dir, "package.json");
    if (!existsSync(pkgPath)) continue;
    let manifest;
    try {
      manifest = JSON.parse(await readFile(pkgPath, "utf8"));
    } catch (err) {
      candidates.push({ slug, dir, manifest: {}, parseError: String(err) });
      continue;
    }
    candidates.push({ slug, dir, manifest });
  }
  return candidates;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadState(statePath) {
  if (!existsSync(statePath)) return { extensions: {} };
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    return { extensions: {} };
  }
}

async function saveState(statePath, state) {
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2));
}

/** Authenticated marketplace MCP read (used for auth pre-flight + reconciliation). */
async function mcpExtensionGet(packageName, { token, baseUrl, timeoutMs = 30_000 }) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl + MCP_ROUTE), {
    requestInit: { headers: vendorAuthHeader(token) },
  });
  const client = new Client({ name: "cinatra-wave-runner", version: "1.0.0" });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: "cinatra-extension-get", arguments: { package_name: packageName } }, undefined, {
      timeout: timeoutMs,
    });
    return { isError: !!result?.isError, content: result?.structuredContent ?? {}, raw: result };
  } finally {
    await client.close().catch(() => {});
  }
}

/** Public storefront renderability check (no auth; true end-to-end signal). */
export function assessStorefrontBody(slug, body) {
  // POSITIVE evidence the extension's OWN product page rendered — do not merely
  // negate a "coming soon" string (too weak; any page with the word "product"
  // would defeat it). Require BOTH the slug-specific permalink AND real WooCommerce
  // single-product chrome, AND the absence of the coming-soon placeholder.
  const comingSoon = /launching soon|coming soon/i.test(body || "");
  const slugMarker = new RegExp(`cinatra-ai-${slug}(?:[^a-z0-9-]|$)`, "i").test(body || "");
  const productMarker = /(add-to-cart|single-product|product_title|cin-ext-name)/i.test(body || "");
  return { listed: !comingSoon && slugMarker && productMarker, comingSoon, slugMarker, productMarker };
}

async function storefrontListed(slug, { baseUrl }) {
  const url = `${baseUrl}/extension/cinatra-ai-${slug}/`;
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) return { listed: false, status: res.status, url };
    const body = await res.text();
    const a = assessStorefrontBody(slug, body);
    return { ...a, status: res.status, url };
  } catch (err) {
    return { listed: false, url, error: err instanceof Error ? err.message : String(err) };
  }
}

async function packExtension(ext, packDir, { transform = false } = {}) {
  const srcManifest = JSON.parse(await readFile(join(ext.dir, "package.json"), "utf8"));
  // Fast path: no transform needed (0-dep extension, or no workspace: specs) —
  // pack in place exactly as the source dir is.
  if (!transform || !hasWorkspaceSpec(srcManifest)) {
    const { stdout } = await execFileAsync("npm", ["pack", "--json", "--pack-destination", packDir], { cwd: ext.dir, maxBuffer: 64 * 1024 * 1024 });
    const packJson = JSON.parse(stdout);
    const entry = Array.isArray(packJson) ? packJson[0] : packJson;
    return { packJson, tarballPath: join(packDir, entry.filename), transformed: false };
  }
  // Transform path (connectors): stage a CLEAN copy (no node_modules/.git), rewrite
  // package.json so `workspace:*` deps become host-provided peers (`"*"`), then pack
  // the stage. This NEVER mutates the source repo.
  const stageDir = join(packDir, "stage", ext.slug);
  await rm(stageDir, { recursive: true, force: true });
  await mkdir(stageDir, { recursive: true });
  await execFileAsync("rsync", ["-a", "--exclude=node_modules", "--exclude=.git", ext.dir + "/", stageDir + "/"], { maxBuffer: 16 * 1024 * 1024 });
  const published = transformPackageJsonForPublish(srcManifest);
  await writeFile(join(stageDir, "package.json"), JSON.stringify(published, null, 2) + "\n");
  const { stdout } = await execFileAsync("npm", ["pack", "--json", "--pack-destination", packDir], { cwd: stageDir, maxBuffer: 64 * 1024 * 1024 });
  const packJson = JSON.parse(stdout);
  const entry = Array.isArray(packJson) ? packJson[0] : packJson;
  return { packJson, tarballPath: join(packDir, entry.filename), transformed: true };
}

// --- orchestration ----------------------------------------------------------

export async function runWave(opts = {}) {
  const {
    execute = false,
    canary = Infinity,
    only = null,
    exclude = [],
    paceMs = DEFAULT_PACE_MS,
    statePath = "/tmp/cinatra-wave-state.json",
    extensionsDir = "extensions/cinatra-ai",
    includeExtensionDeps = false,
    skipDependencyCheck = false,
    baseUrl = (process.env.MARKETPLACE_BASE_URL || MARKETPLACE_BASE_URL).replace(/\/+$/, ""),
    log = (m) => process.stderr.write(m + "\n"),
  } = opts;

  const token = process.env.CINATRA_MARKETPLACE_VENDOR_TOKEN;
  const pace = clampPaceMs(paceMs);
  const canaryLimit = normalizeCanaryLimit(canary);

  // 1. Enumerate + select. The EXTENSION-name set is every candidate's package
  // name — so a connector's dep on another connector is recognised as an
  // extension dep (ordered), while @cinatra-ai/* packages NOT among the
  // candidates (sdk-extensions, sdk-ui, …) are host-internal (excluded).
  const candidates = await loadCandidates(extensionsDir);
  const extensionNames = new Set(candidates.map((c) => c.manifest?.name).filter((n) => typeof n === "string"));
  const selected = selectWaveExtensions(candidates, { only, exclude, extensionNames, includeExtensionDeps });
  let eligible = selected.filter((e) => e.eligible);
  const ineligible = selected.filter((e) => !e.eligible);
  // Connector mode: publish each extension AFTER its in-wave extension deps.
  if (includeExtensionDeps) eligible = orderByExtensionDeps(eligible);
  const modeLabel = includeExtensionDeps ? "eligible (extension-deps ordered)" : "eligible 0-dep";
  log(`Enumerated ${candidates.length} candidate dir(s) → ${eligible.length} ${modeLabel}, ${ineligible.length} skipped/ineligible.`);
  for (const x of ineligible) log(`  • skip ${x.slug}: ${x.reasons.join("; ")}`);
  if (includeExtensionDeps) {
    for (const e of eligible.filter((e) => (e.extensionDeps || []).length)) {
      log(`  order: ${e.slug} after [${e.extensionDeps.map((n) => n.split("/").pop()).join(", ")}]`);
    }
  }

  // 2. Pre-flight pack + validate every eligible extension.
  const packDir = "/tmp/cinatra-wave-pack";
  await mkdir(packDir, { recursive: true });
  const preflight = [];
  for (const ext of eligible) {
    try {
      const { packJson, tarballPath, transformed } = await packExtension(ext, packDir, { transform: includeExtensionDeps });
      const v = validatePackedTarball(packJson, { declaredKind: ext.kind });
      preflight.push({ ext, tarballPath, ...v });
      log(`  pack ${ext.slug}@${ext.version} (${ext.kind})${transformed ? " [transformed]" : ""} → ${v.ok ? `OK ${v.size}B` : `INVALID: ${v.problems.join("; ")}`}`);
    } catch (err) {
      preflight.push({ ext, ok: false, problems: [`npm pack failed: ${err instanceof Error ? err.message : String(err)}`] });
      log(`  pack ${ext.slug} → FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const packBad = preflight.filter((p) => !p.ok);
  if (packBad.length) log(`⚠ ${packBad.length} extension(s) failed pre-flight and will be skipped from submission.`);

  // 3. Auth pre-flight (only meaningful when we have a token + intend to act).
  let authOk = null;
  if (token) {
    try {
      const probe = await mcpExtensionGet(AUTH_PREFLIGHT_PACKAGE, { token, baseUrl });
      // A tool-level error (auth/permission) comes back as isError WITHOUT throwing —
      // it must NOT be treated as a green auth pre-flight.
      if (probe.isError) throw new Error("cinatra-extension-get returned a tool error (token rejected or insufficient permission)");
      authOk = true;
      log("Auth pre-flight: vendor token accepted by the marketplace MCP. ✓");
    } catch (err) {
      authOk = false;
      log(`Auth pre-flight FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    log("Auth pre-flight skipped: CINATRA_MARKETPLACE_VENDOR_TOKEN is not set.");
  }

  // 4. Resume manifest.
  const state = await loadState(statePath);
  state.extensions = state.extensions || {};

  // 5. Submit loop (only with --execute, a token, and a green auth pre-flight).
  const submittable = preflight.filter((p) => p.ok);
  const results = [];
  let submittedThisRun = 0;
  // Extension-dep safety: a dependent must NOT submit if an in-wave extension dep
  // is not proven LISTED — with the registry gate skipped (connector mode) nothing
  // else would catch it, and the dependent's host peer would be unsatisfiable. The
  // in-wave set is every ELIGIBLE extension (what the wave is responsible for
  // publishing) — NOT just the preflight-valid ones: a dep that fails pre-flight
  // will never be listed, so its dependents must still block.
  const inWaveNames = new Set(eligible.map((e) => e.name));
  const listedNames = new Set();
  if (!execute) {
    log("DRY RUN (no --execute): nothing will be submitted. Re-run with --execute to fire.");
  } else if (!token) {
    log("Refusing to submit: CINATRA_MARKETPLACE_VENDOR_TOKEN is not set.");
  } else if (authOk === false) {
    log("Refusing to submit: auth pre-flight failed.");
  } else {
    for (let i = 0; i < submittable.length; i++) {
      const { ext, tarballPath } = submittable[i];
      const prior = state.extensions[ext.slug];
      const decision = decideWaveAction({
        ext,
        prior,
        listedNames,
        inWaveNames,
        submitted: submittedThisRun,
        canaryLimit,
      });
      if (decision.action === "skip-resumed") {
        // Resume is VERSION-aware (a prior "listed" at an OLDER version does NOT
        // short-circuit publishing the new version — Verdaccio is immutable per version).
        log(`  skip ${ext.slug}: already listed at ${ext.version} (resume).`);
        listedNames.add(ext.name);
        results.push({ slug: ext.slug, outcome: "listed", resumed: true });
        continue;
      }
      if (decision.action === "blocked") {
        log(`  skip ${ext.slug}: BLOCKED — extension dep(s) not listed: ${decision.blockedBy.map((n) => n.split("/").pop()).join(", ")}`);
        state.extensions[ext.slug] = { outcome: "blocked", version: ext.version, at: new Date().toISOString(), blockedBy: decision.blockedBy };
        results.push({ slug: ext.slug, outcome: "blocked" });
        await saveState(statePath, state);
        continue;
      }
      if (decision.action === "canary-stopped") {
        log(`Canary limit (${canaryLimit}) reached — stopping before ${ext.slug}.`);
        break;
      }
      log(`→ submitting ${ext.name}@${ext.version} (${submittedThisRun + 1}${Number.isFinite(canaryLimit) ? `/${canaryLimit}` : ""})…`);
      try {
        const submitArgs = [RELEASE_SUBMIT, tarballPath];
        // Connector mode: the runner OWNS extension ordering, and the host-internal
        // SDK peers would 404 the registry gate — so skip release-submit's own gate.
        if (skipDependencyCheck) submitArgs.push("--skip-dependency-check");
        const { stdout } = await execFileAsync("node", submitArgs, {
          env: process.env, // token travels via env only — never argv/stdout
          maxBuffer: 16 * 1024 * 1024,
        });
        const parsed = parseSubmitStdout(stdout);
        const outcome = classifySubmissionOutcome({ status: parsed.status, promotionState: parsed.promotionState });
        state.extensions[ext.slug] = { ...parsed, outcome: outcome.kind, version: ext.version, at: new Date().toISOString() };
        results.push({ slug: ext.slug, ...parsed, outcome: outcome.kind });
        if (outcome.kind === "listed") listedNames.add(ext.name);
        log(`  ${ext.slug}: status=${parsed.status} promotion_state=${parsed.promotionState ?? "n/a"} → ${outcome.kind}`);
      } catch (err) {
        // release-submit.mjs exits non-zero (and prints the error) on a failed promotion.
        const msg = err && err.stdout ? `${err.stdout}\n${err.stderr || ""}` : err instanceof Error ? err.message : String(err);
        state.extensions[ext.slug] = { outcome: "error", version: ext.version, at: new Date().toISOString(), error: String(msg).slice(0, 500) };
        results.push({ slug: ext.slug, outcome: "error" });
        log(`  ${ext.slug}: SUBMIT FAILED — ${String(msg).split("\n")[0]}`);
      }
      await saveState(statePath, state);
      submittedThisRun++;
      if (i < submittable.length - 1 && submittedThisRun < canaryLimit) {
        log(`  …pacing ${pace}ms before next submit.`);
        await sleep(pace);
      }
    }
  }

  // 6. Reconciliation: confirm each eligible extension is a renderable listing.
  const reconciliation = [];
  for (const { ext } of submittable) {
    const sf = await storefrontListed(ext.slug, { baseUrl });
    let promoted = null;
    if (token) {
      try {
        const got = await mcpExtensionGet(ext.name, { token, baseUrl });
        // cinatra-extension-get returns the promoted version as `latest_version`.
        promoted = got.content?.latest_version ?? got.content?.version ?? got.content?.promoted_version ?? (got.isError ? null : "present");
      } catch {
        promoted = null;
      }
    }
    reconciliation.push({ slug: ext.slug, storefront: sf.listed, storefrontStatus: sf.status, promoted });
  }

  // 7. Report. NOT-listed must account for BOTH reconciled-but-unlisted AND the
  // pre-flight-invalid extensions (which were never submittable) — otherwise a
  // packing failure would be silently dropped and the wave would look complete.
  const preflightInvalidSlugs = packBad.map((p) => p.ext.slug);
  const blockedSlugs = results.filter((r) => r.outcome === "blocked").map((r) => r.slug);
  const listed = reconciliation.filter((r) => r.storefront).map((r) => r.slug);
  const notListed = [...reconciliation.filter((r) => !r.storefront).map((r) => r.slug), ...preflightInvalidSlugs];
  log("");
  log("===== WAVE REPORT =====");
  log(`eligible:              ${eligible.length}`);
  log(`pre-flight valid:      ${submittable.length}`);
  log(`pre-flight invalid:    ${packBad.length} (${preflightInvalidSlugs.join(", ") || "—"})`);
  log(`submitted this run:    ${submittedThisRun}`);
  if (blockedSlugs.length) log(`blocked (dep not listed): ${blockedSlugs.length} (${blockedSlugs.join(", ")})`);
  log(`storefront-listed:     ${listed.length} (${listed.join(", ") || "—"})`);
  log(`NOT yet listed:        ${notListed.length} (${notListed.join(", ") || "—"})`);
  if (authOk === false) log("⚠ auth pre-flight failed — token issue.");
  return { eligible, ineligible, preflight, authOk, results, reconciliation, listed, notListed, preflightInvalidSlugs, blockedSlugs, submittedThisRun, statePath };
}

// --- CLI --------------------------------------------------------------------

// Resolve a flag's value, supporting BOTH `--flag value` and `--flag=value`.
// Returns { present, value } where present distinguishes "flag absent" from
// "flag given without a value" (next token is another --flag or end-of-args) —
// the latter must NOT collapse to a default for fail-closed flags like --canary.
export function getFlagValue(args, flag) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === flag) {
      const next = args[i + 1];
      return { present: true, value: next !== undefined && !next.startsWith("--") ? next : undefined };
    }
    if (a.startsWith(flag + "=")) return { present: true, value: a.slice(flag.length + 1) };
  }
  return { present: false, value: undefined };
}

export function parseWaveArgs(argv) {
  const a = argv.slice(2);
  // A PRESENT value-flag must carry a value. A present-but-valueless value-flag
  // (bare, or immediately followed by another --flag) FAILS CLOSED rather than
  // silently widening the wave — e.g. a valueless `--only` must NOT collapse to
  // "no filter = run everything", and a valueless `--exclude` must not become
  // "exclude nothing". Absent flags return undefined (the caller's safe default).
  const requiredValue = (flag) => {
    const f = getFlagValue(a, flag);
    if (!f.present) return undefined;
    if (f.value === undefined || f.value === "") throw new Error(`${flag} requires a value.`);
    return f.value;
  };
  const list = (flag) => {
    const v = requiredValue(flag);
    if (v === undefined) return undefined;
    const items = v.split(",").map((s) => s.trim()).filter(Boolean);
    if (items.length === 0) throw new Error(`${flag} requires a non-empty comma-separated value.`);
    return items;
  };
  const canaryFlag = getFlagValue(a, "--canary");
  const paceRaw = requiredValue("--pace-ms");
  // `--connectors` is the convenience flag for the connector wave: include
  // extension-deps (with ordering + workspace→peer transform) AND skip
  // release-submit's registry gate (the host-internal SDK peers would 404; the
  // runner owns the real extension ordering). Either can also be set explicitly.
  const connectors = a.includes("--connectors");
  return {
    execute: a.includes("--execute"),
    // Absent → Infinity (whole set). Present (even without a value) → strict parse.
    canary: canaryFlag.present ? parseCanaryArg(canaryFlag.value) : Infinity,
    only: list("--only") ?? null,
    exclude: list("--exclude") ?? [],
    paceMs: paceRaw !== undefined ? Number(paceRaw) : DEFAULT_PACE_MS,
    statePath: requiredValue("--state") ?? "/tmp/cinatra-wave-state.json",
    extensionsDir: requiredValue("--extensions-dir") ?? "extensions/cinatra-ai",
    includeExtensionDeps: connectors || a.includes("--include-extension-deps"),
    skipDependencyCheck: connectors || a.includes("--skip-dependency-check"),
  };
}

async function main() {
  const opts = parseWaveArgs(process.argv);
  const out = await runWave(opts);
  // Non-zero exit if we attempted to execute but something is not listed.
  if (opts.execute && out.notListed.length > 0) process.exitCode = 1;
}

const invokedDirectly = process.argv[1] && resolvePath(process.argv[1]) === resolvePath(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write((err instanceof Error ? err.stack || err.message : String(err)) + "\n");
    process.exit(1);
  });
}

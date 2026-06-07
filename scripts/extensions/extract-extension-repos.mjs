#!/usr/bin/env node
// Extract every bundled Cinatra extension into its own standalone repo tree.
//
// --dry-run is the DEFAULT: prints a per-package plan and writes NOTHING outside
// of an explicit --out directory. With --out it materializes local standalone
// repo trees on disk. The opt-in --push flag goes further: it `gh repo create
// --public` + pushes a no-history snapshot of each tree — i.e. it CREATES PUBLIC
// GITHUB REPOS. --push is the launch-day owner step; it is IRREVERSIBLE, so it is
// hard-guard-railed (requires --out, refuses --dry-run, refuses an --out inside a
// git work tree, skip-exists never force-pushes, exists-but-empty resumes,
// fail-closed on duplicate names). Without --push the script only ever touches
// local disk.
//
// Flags:
//   --dry-run            (default) print the plan, write nothing
//   --out <dir>          materialize standalone repo trees under <dir>/<slug>/
//   --only <pkg,pkg>     restrict to a subset (match by package name or slug)
//   --push               (opt-in, IRREVERSIBLE) `gh repo create --public` + push
//                        each materialized tree; requires --out, refuses --dry-run
//   --org <org>          GitHub org/owner for --push (e.g. cinatra-ai)
//   --schema <anything>  accepted and ignored (irrelevant here)
//
// The pure planning logic lives in planExtractionForPackage() / shouldExtract()
// and is exported for unit testing without touching the filesystem or gh.

import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WORKTREE_ROOT = path.resolve(__dirname, "..", "..");
const EXTENSIONS_ROOT = path.join(WORKTREE_ROOT, "extensions");
const DEPENDENCY_GRAPH_PATH = path.join(
  WORKTREE_ROOT,
  "generated",
  "extension-dependency-graph.json",
);
const TEMPLATE_ROOT = path.join(__dirname, "templates", "extension-repo");

// ---------------------------------------------------------------------------
// Pure planning layer (no fs / no gh) — exported for tests.
// ---------------------------------------------------------------------------

// Extensions that are deliberately NOT extracted to their own repo. (anthropic-connector
// is un-exempt — extractable like every other connector. The set is kept (empty) so the
// exact-match carve-out machinery stays.)
export const CARVE_OUT_EXACT = new Set([]);
// Private scope prefixes (org-owned, not published as standalone OSS repos).
// Empty today; the prefix-match carve-out machinery stays for any future
// private-scoped extension that must be excluded from extraction.
export const CARVE_OUT_SCOPE_PREFIXES = [];

// Extensions whose effective license is GPL-2.0-or-later regardless of source.
// Empty today: the wordpress-agent / drupal-agent integrate with GPL CMSes over
// their HTTP/MCP APIs but are NOT derivative works of GPL code, so they carry the
// cinatra-ai default (Apache-2.0), matching their source LICENSE. The mechanism
// stays in place for any future genuinely-GPL-derived extension.
export const GPL_AGENT_SLUGS = new Set([]);
export const DEFAULT_LICENSE = "Apache-2.0";
export const GPL_LICENSE = "GPL-2.0-or-later";

/**
 * Derive the slug (last path segment of a scoped extension dir, or the bare
 * package name) from a package name and/or an explicit slug hint.
 */
export function deriveSlug({ name, slug } = {}) {
  if (slug) return slug;
  if (!name) return undefined;
  // e.g. "@cinatra-ai/wordpress-agent" -> "wordpress-agent"
  const segments = String(name).split("/");
  return segments[segments.length - 1];
}

/**
 * Decide whether a package should be extracted. Carve-outs:
 *   - exact slug/name matches (none today — anthropic-connector un-exempt)
 *   - private scope prefixes (none today)
 *
 * `extensionRelPath` is the "<scope>/<slug>" path under extensions/, when known
 * (used for scope-prefix carve-outs). Falls back to name-based checks.
 */
export function shouldExtract({ name, slug, extensionRelPath } = {}) {
  const resolvedSlug = deriveSlug({ name, slug });
  if (resolvedSlug && CARVE_OUT_EXACT.has(resolvedSlug)) return false;
  if (name && CARVE_OUT_EXACT.has(name)) return false;

  const candidates = [extensionRelPath, name].filter(Boolean).map(String);
  for (const prefix of CARVE_OUT_SCOPE_PREFIXES) {
    for (const candidate of candidates) {
      // normalize "@scope/foo" and "scope/foo" alike
      const normalized = candidate.replace(/^@/, "");
      if (normalized.startsWith(prefix)) return false;
    }
  }
  return true;
}

/** Map an extension to its effective SPDX license string. */
export function resolveLicense({ slug, name, sourceLicense } = {}) {
  const resolvedSlug = deriveSlug({ name, slug });
  if (resolvedSlug && GPL_AGENT_SLUGS.has(resolvedSlug)) return GPL_LICENSE;
  return sourceLicense || DEFAULT_LICENSE;
}

// SPDX values for which we ship a canonical LICENSE body template under
// templates/extension-repo/licenses/<SPDX>.txt.
export const LICENSE_BODY_TEMPLATES = new Set(["Apache-2.0", "GPL-2.0-or-later", "UNLICENSED"]);

/**
 * PURE decision for which LICENSE body an extracted repo gets. Returns
 * `{ vendored: true }` when the package is a vendored third-party (its UPSTREAM
 * LICENSE is preserved, never relicensed), else `{ templateFile: "<SPDX>.txt" }`
 * keyed by the effective SPDX. Throws (fail-closed) on an unsupported SPDX that
 * is not vendored — we never ship a placeholder/mismatched LICENSE to a public repo.
 */
export function resolveLicenseBody({ license, name, vendored } = {}) {
  if (vendored) return { vendored: true };
  if (!LICENSE_BODY_TEMPLATES.has(license)) {
    throw new Error(
      `extract: no LICENSE body template for SPDX "${license}" (${name ?? "?"}). ` +
        `Add scripts/extensions/templates/extension-repo/licenses/${license}.txt, ` +
        `or mark the package vendored (cinatra.vendoredFrom).`,
    );
  }
  return { templateFile: `${license}.txt` };
}

/** True if a dependency version spec is a workspace protocol spec. */
export function isWorkspaceSpec(version) {
  return typeof version === "string" && version.startsWith("workspace:");
}

/**
 * Split a deps map into:
 *   - workspaceDeps: names that used workspace:* (become peerDependencies "*")
 *   - externalDeps:  the remaining (real, registry) deps, kept verbatim
 */
export function partitionDependencies(deps = {}) {
  const workspaceDeps = {};
  const externalDeps = {};
  for (const [name, version] of Object.entries(deps || {})) {
    if (isWorkspaceSpec(version)) {
      workspaceDeps[name] = "*";
    } else {
      externalDeps[name] = version;
    }
  }
  return { workspaceDeps, externalDeps };
}

/**
 * THE pure planner. Given a source package.json object + options, compute the
 * standalone repo's package.json plus a copy/template plan. No fs, no gh.
 *
 * Returns:
 *   {
 *     slug, name, version, license, kind,
 *     packageJson,            // the emitted standalone package.json object
 *     workspaceDepsConverted, // names moved into peerDependencies
 *     warnings: string[],
 *   }
 *
 * Throws if any "workspace:*" survives in the emitted package.json (invariant).
 */
// True for a first-party package name (@cinatra-ai/* or @cinatra/*). These are
// host-internal monorepo packages (packages/* — sdk-extensions, sdk-ui, ...),
// never published to any registry today, so an extracted repo declares them as
// PEERS and never installs them standalone.
export function isFirstPartyDep(name) {
  return typeof name === "string" && /^@cinatra(?:-ai)?\//.test(name);
}

// Build the .npmrc for an extracted repo. Pure (→ string) so it is unit-testable.
//
// Extracted repos are SOURCE MIRRORS, not standalone-installable Cinatra app
// packages. The only first-party deps they carry are host-internal @cinatra-ai/*
// packages (sdk-extensions, sdk-ui, ...) that live ONLY in the cinatra monorepo
// workspace and are NOT published to any registry. They are declared as PEERS
// (see planExtractionForPackage) and provided by the monorepo when it clones the
// repo into its workspace — never installed standalone. So disable pnpm's default
// auto-install-peers: `pnpm install` then resolves external (npmjs) deps only and
// never tries to fetch an unpublished @cinatra-ai/* package (which 404s). No
// @cinatra-ai registry scope and no auth token: those packages are intentionally
// not registry artifacts today. (A future, deliberate npm move would re-introduce
// a registry scope here.)
export function buildNpmrc() {
  return ["auto-install-peers=false", ""].join("\n");
}

// True when the emitted package.json declares any first-party (@cinatra-ai/* or
// @cinatra/*) package across deps/peers/dev/optional — i.e. the repo is a source
// mirror that depends on host-internal monorepo packages and so is NOT
// standalone-typecheckable/-testable (the monorepo owns that). The per-repo CI
// reads package.json directly with the same predicate to skip those steps.
export function packageDeclaresFirstParty(pkgJson) {
  if (!pkgJson || typeof pkgJson !== "object") return false;
  const buckets = [
    pkgJson.dependencies,
    pkgJson.peerDependencies,
    pkgJson.devDependencies,
    pkgJson.optionalDependencies,
  ];
  for (const bucket of buckets) {
    if (bucket && typeof bucket === "object") {
      for (const key of Object.keys(bucket)) {
        if (isFirstPartyDep(key)) return true;
      }
    }
  }
  return false;
}

export function planExtractionForPackage(pkgJson, opts = {}) {
  if (!pkgJson || typeof pkgJson !== "object") {
    throw new Error("planExtractionForPackage: pkgJson must be an object");
  }
  const warnings = [];
  const name = pkgJson.name;
  const slug = deriveSlug({ name, slug: opts.slug });
  const cinatra = pkgJson.cinatra;
  if (!cinatra || typeof cinatra !== "object") {
    warnings.push("source package.json has no `cinatra` block");
  }
  const kind = cinatra && cinatra.kind;

  const license = resolveLicense({
    slug,
    name,
    sourceLicense: pkgJson.license,
  });

  const { workspaceDeps, externalDeps } = partitionDependencies(
    pkgJson.dependencies,
  );

  // Existing peerDependencies are preserved; workspace deps are folded in as "*".
  const existingPeers = { ...(pkgJson.peerDependencies || {}) };
  // Any peer that was itself workspace:* also collapses to "*".
  for (const [pn, pv] of Object.entries(existingPeers)) {
    if (isWorkspaceSpec(pv)) existingPeers[pn] = "*";
  }
  const peerDependencies = { ...existingPeers, ...workspaceDeps };

  // Convert any workspace:* devDependencies too (kept as devDeps "*").
  const devDependencies = {};
  for (const [dn, dv] of Object.entries(pkgJson.devDependencies || {})) {
    devDependencies[dn] = isWorkspaceSpec(dv) ? "*" : dv;
  }

  // Model B: host-internal @cinatra-ai/* packages (sdk-extensions, sdk-ui, ...)
  // live ONLY in the cinatra monorepo workspace and are never published to a
  // registry. An extracted repo is a SOURCE MIRROR: it must declare them as
  // PEERS (provided by the host/monorepo when it clones the repo into the
  // workspace), never as a normal dependency/devDependency that a standalone
  // `pnpm install` would try to fetch and 404 on. Reclassify any first-party dep
  // that landed in dependencies/devDependencies into peerDependencies, and mark
  // every first-party peer `optional` so a standalone install/pack stays quiet
  // about the (intentionally) missing peer. (An artifact's first-party
  // devDependency is moved here; connector sdk-extensions/sdk-ui workspace deps
  // already arrive via peerDependencies/workspaceDeps.)
  for (const bucket of [externalDeps, devDependencies]) {
    for (const dn of Object.keys(bucket)) {
      if (isFirstPartyDep(dn)) {
        peerDependencies[dn] = "*";
        delete bucket[dn];
      }
    }
  }
  const peerDependenciesMeta = {};
  for (const pn of Object.keys(peerDependencies)) {
    if (isFirstPartyDep(pn)) peerDependenciesMeta[pn] = { optional: true };
  }

  const packageJson = {
    name,
    version: pkgJson.version || "0.0.0",
    license,
    ...(pkgJson.description ? { description: pkgJson.description } : {}),
    ...(pkgJson.type ? { type: pkgJson.type } : { type: "module" }),
    ...(pkgJson.main ? { main: pkgJson.main } : {}),
    ...(pkgJson.module ? { module: pkgJson.module } : {}),
    ...(pkgJson.types ? { types: pkgJson.types } : {}),
    ...(pkgJson.exports ? { exports: pkgJson.exports } : {}),
    ...(pkgJson.bin ? { bin: pkgJson.bin } : {}),
    ...(pkgJson.files ? { files: pkgJson.files } : {}),
    ...(pkgJson.scripts ? { scripts: pkgJson.scripts } : {}),
    ...(Object.keys(externalDeps).length ? { dependencies: externalDeps } : {}),
    ...(Object.keys(peerDependencies).length ? { peerDependencies } : {}),
    ...(Object.keys(peerDependenciesMeta).length ? { peerDependenciesMeta } : {}),
    ...(Object.keys(devDependencies).length ? { devDependencies } : {}),
    // The cinatra manifest block is preserved verbatim.
    ...(cinatra ? { cinatra } : {}),
  };

  // Invariant: NO workspace:* may survive anywhere in the emitted package.json.
  assertNoWorkspaceSpecs(packageJson);

  return {
    slug,
    name,
    version: packageJson.version,
    license,
    kind,
    packageJson,
    workspaceDepsConverted: Object.keys(workspaceDeps),
    warnings,
  };
}

/** Throw if any string value "workspace:*" appears anywhere in the object. */
export function assertNoWorkspaceSpecs(obj) {
  const stack = [obj];
  while (stack.length) {
    const cur = stack.pop();
    if (cur && typeof cur === "object") {
      for (const v of Object.values(cur)) {
        if (typeof v === "string" && v.startsWith("workspace:")) {
          throw new Error(
            `extract: workspace protocol leaked into emitted package.json: "${v}"`,
          );
        }
        if (v && typeof v === "object") stack.push(v);
      }
    }
  }
}

/**
 * Compute the ordered, carve-out-filtered list of slugs to process, given the
 * raw dependency-graph object and the discovered extension entries. Pure.
 *
 * graph: parsed extension-dependency-graph.json (we look for an ordered list of
 *        package names/slugs under common shapes).
 * entries: [{ name, slug, extensionRelPath }] discovered on disk.
 * only: optional Set of name|slug to restrict to.
 */
/**
 * Fail-closed duplicate guard (launch preflight). Two entries sharing a slug OR
 * a package name would silently collapse in the by-slug/by-name maps below and
 * one repo would be skipped/overwritten on the IRREVERSIBLE --push. Throw instead
 * of deduping, so a collision is caught before any repo is created. Pure.
 */
export function assertNoDuplicateIdentifiers(entries) {
  const slugOwner = new Map();
  const nameOwner = new Map();
  const dups = [];
  for (const e of entries) {
    if (e.slug) {
      if (slugOwner.has(e.slug)) {
        dups.push(`duplicate slug "${e.slug}" (${slugOwner.get(e.slug)} vs ${e.name ?? e.slug})`);
      } else {
        slugOwner.set(e.slug, e.name ?? e.slug);
      }
    }
    if (e.name) {
      if (nameOwner.has(e.name)) dups.push(`duplicate package name "${e.name}"`);
      else nameOwner.set(e.name, true);
    }
  }
  if (dups.length) {
    throw new Error(`extract: duplicate extension identifiers (fail-closed):\n  - ${dups.join("\n  - ")}`);
  }
}

export function planExtractionOrder(graph, entries, only) {
  const onlySet =
    only && only.size
      ? new Set([...only].map((x) => x.trim()).filter(Boolean))
      : null;
  // Fail-closed BEFORE the by-slug ordering collapse below: run the duplicate
  // guard on the ACTUAL extraction targets (post carve-out + --only). Doing it
  // here — not on the collapsed `ordered` list, where a slug clash would already
  // have silently dropped one — is what makes a real repo-name collision a hard
  // error rather than a silent skip on the irreversible --push.
  const eligible = entries.filter(
    (e) => (!onlySet || onlySet.has(e.slug) || onlySet.has(e.name)) && shouldExtract(e),
  );
  assertNoDuplicateIdentifiers(eligible);

  // Build the ordering maps + append list from `eligible` ONLY — never raw
  // `entries`. Otherwise a carved-out entry sharing a slug with an eligible one
  // (e.g. a public repo vs a same-slug private-scoped one) can win `bySlug` and,
  // via a slug-keyed graph order, make planning resolve to the carved-out entry
  // → silently drop the real extracted repo (not fail-closed).
  const bySlug = new Map();
  const byName = new Map();
  for (const e of eligible) {
    if (e.slug) bySlug.set(e.slug, e);
    if (e.name) byName.set(e.name, e);
  }

  const order = extractOrderedIdentifiers(graph);
  const seen = new Set();
  const ordered = [];

  const pushEntry = (entry) => {
    if (!entry) return;
    const key = entry.slug || entry.name;
    if (seen.has(key)) return;
    seen.add(key);
    ordered.push(entry);
  };

  for (const id of order) {
    const entry =
      byName.get(id) ||
      bySlug.get(id) ||
      bySlug.get(deriveSlug({ name: id }));
    pushEntry(entry);
  }
  // Append any eligible entries not mentioned in the graph (stable by slug).
  for (const e of [...eligible].sort((a, b) =>
    String(a.slug).localeCompare(String(b.slug)),
  )) {
    pushEntry(e);
  }

  return ordered.filter((entry) => {
    if (onlySet && !(onlySet.has(entry.slug) || onlySet.has(entry.name))) {
      return false;
    }
    return shouldExtract(entry);
  });
}

/**
 * Best-effort extraction of an ordered identifier list from the dependency
 * graph file, tolerant of several shapes (array of strings, array of objects
 * with name/slug/id, or an { order: [...] } / { nodes: [...] } wrapper).
 */
export function extractOrderedIdentifiers(graph) {
  if (!graph) return [];
  const pick = (item) => {
    if (typeof item === "string") return item;
    if (item && typeof item === "object") {
      return item.package || item.name || item.slug || item.id || undefined;
    }
    return undefined;
  };
  const candidates = [
    // The canonical dependency-graph shape nests the ordered list under
    // `extractionOrder.order`; also tolerate a flat `extractionOrder` array.
    graph.extractionOrder && graph.extractionOrder.order,
    Array.isArray(graph.extractionOrder) ? graph.extractionOrder : undefined,
    graph.order,
    graph.nodes,
    graph.packages,
    graph.extensions,
    Array.isArray(graph) ? graph : undefined,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) {
      const ids = c.map(pick).filter(Boolean);
      if (ids.length) return ids;
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Side-effecting layer (fs only; NO gh, NO network). Kept deliberately thin.
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  // dry-run is the DEFAULT. `--out` materializes (still local-only; never gh)
  // UNLESS `--dry-run` was passed explicitly, which always wins.
  const args = {
    dryRun: true,
    explicitDryRun: false,
    out: null,
    only: null,
    schema: null,
    push: false,
    org: "cinatra-ai",
  };
  args.push = false;
  args.org = "cinatra-ai";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.explicitDryRun = true;
    else if (a === "--no-dry-run") args.dryRun = false;
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--only") args.only = new Set((argv[++i] || "").split(","));
    else if (a === "--schema") args.schema = argv[++i];
    else if (a === "--push") args.push = true;
    else if (a === "--org") args.org = argv[++i];
  }
  // With --out and no explicit --dry-run, switch to materialize mode.
  if (args.out && !args.explicitDryRun) args.dryRun = false;
  return args;
}

// True if `dir` resolves inside an existing git work tree. Used to REFUSE
// --push into a path inside the monorepo (or any repo): a `git init` in a
// subdir of an existing work tree can attach to the parent and push the wrong
// history. `execFileFn` is injected so this is testable. Returns false on any
// error (the safe default for the caller is "not inside" only when git is
// genuinely absent — callers pair this with their own existence checks).
export async function isInsideGitWorkTree(dir, execFileFn) {
  try {
    const { stdout } = await execFileFn(
      "git",
      ["-C", dir, "rev-parse", "--is-inside-work-tree"],
      {},
    );
    return String(stdout).trim() === "true";
  } catch {
    return false;
  }
}

// --push: create + push a materialized standalone repo to GitHub. Side-effectful,
// opt-in, irreversible — guard-railed:
//   - every extracted repo is PUBLIC (any private scope is carved out of
//     extraction entirely, so anything we push is public).
//   - skip-exists: if the repo already exists we do NOT force-push (never clobber
//     an existing repo's history); we report skip-exists and move on.
//   - no-history snapshot: fresh `git init` + a single commit, never the
//     monorepo's history.
// `execFileFn` is injected so this is testable without spawning git/gh.
export async function pushPackageRepo(plan, repoDir, org, log, execFileFn) {
  const fullName = `${org}/${plan.slug}`;
  const remoteUrl = `https://github.com/${fullName}.git`;

  // Build the no-history snapshot (fresh git init + ONE commit) once.
  async function buildSnapshot() {
    await execFileFn("git", ["init", "-q", "-b", "main"], { cwd: repoDir });
    await execFileFn("git", ["add", "-A"], { cwd: repoDir });
    await execFileFn(
      "git",
      ["commit", "-q", "-m", `Initial import of ${plan.name} (extracted from cinatra monorepo)`],
      { cwd: repoDir },
    );
  }
  async function pushTo() {
    // remote may already exist from a partial prior run; re-add idempotently.
    try {
      await execFileFn("git", ["remote", "remove", "origin"], { cwd: repoDir });
    } catch {
      /* no existing remote — fine */
    }
    await execFileFn("git", ["remote", "add", "origin", remoteUrl], { cwd: repoDir });
    await execFileFn("git", ["push", "-u", "origin", "main"], { cwd: repoDir });
  }

  // Does the repo already exist on GitHub?
  let exists = false;
  try {
    await execFileFn("gh", ["repo", "view", fullName, "--json", "name"], { cwd: repoDir });
    exists = true;
  } catch {
    exists = false;
  }

  if (exists) {
    // EXISTS-BUT-EMPTY COMPLETION: a prior run may have created the repo but
    // failed before pushing (create succeeded, remote-add/push failed). If the
    // remote has NO refs (no default branch / no commits), complete the push.
    // If it has ANY refs, skip and NEVER force-push (never clobber history).
    let hasRefs = true;
    try {
      const { stdout } = await execFileFn(
        "git",
        ["ls-remote", "--heads", remoteUrl],
        { cwd: repoDir },
      );
      hasRefs = String(stdout).trim().length > 0;
    } catch {
      // Can't determine remote state → conservative: treat as has-refs (skip).
      hasRefs = true;
    }
    if (hasRefs) {
      log(`skip-exists: ${fullName} already exists with content — NOT force-pushing`);
      return { slug: plan.slug, fullName, action: "skip-exists" };
    }
    log(`resume: ${fullName} exists but is EMPTY — completing the push`);
    await buildSnapshot();
    await pushTo();
    log(`resumed-push: ${fullName} (public)`);
    return { slug: plan.slug, fullName, action: "resumed-push" };
  }

  // Fresh create. Explicit 3-step create → remote → push: the one-shot
  // `gh repo create --source=. --push` is unreliable (its internal git
  // remote add can fail), so we drive each step ourselves.
  await buildSnapshot();
  await execFileFn(
    "gh",
    [
      "repo", "create", fullName, "--public",
      "--description", `${plan.name} — a Cinatra ${plan.kind || ""} extension`.trim(),
    ],
    { cwd: repoDir },
  );
  await pushTo();
  log(`created+pushed: ${fullName} (public)`);
  return { slug: plan.slug, fullName, action: "created" };
}

async function readJson(p) {
  const raw = await fs.readFile(p, "utf8");
  return JSON.parse(raw);
}

async function pathExists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function discoverExtensions() {
  const entries = [];
  const scopes = await fs.readdir(EXTENSIONS_ROOT, { withFileTypes: true });
  for (const scope of scopes) {
    if (!scope.isDirectory()) continue;
    const scopeDir = path.join(EXTENSIONS_ROOT, scope.name);
    const slugs = await fs.readdir(scopeDir, { withFileTypes: true });
    for (const slugDir of slugs) {
      if (!slugDir.isDirectory()) continue;
      const dir = path.join(scopeDir, slugDir.name);
      const pkgPath = path.join(dir, "package.json");
      if (!(await pathExists(pkgPath))) continue;
      let pkgJson;
      try {
        pkgJson = await readJson(pkgPath);
      } catch {
        continue;
      }
      entries.push({
        name: pkgJson.name,
        slug: slugDir.name,
        extensionRelPath: `${scope.name}/${slugDir.name}`,
        dir,
        pkgJson,
      });
    }
  }
  return entries;
}

// NOTE: LICENSE is deliberately NOT copied from source — it is WRITTEN from the
// effective SPDX (plan.license) below, so a stale source LICENSE (e.g. the
// wordpress/drupal agents shipping Apache text while declaring GPL-2.0-or-later)
// can never reach the extracted repo. Vendored third-party packages are the one
// exception (their upstream LICENSE is preserved).
// vitest.config.* is copied so the extracted repo's tests run with the SAME
// config as in-tree — including per-package test `exclude`s (some packages
// exclude host-coupled `@/`-importing tests). Without it the cloned tree's
// pinned monorepo test step would run a previously-excluded test under the wrong
// config.
const COPY_FILES = ["README.md", "AGENTS.md", "tsconfig.json", "vitest.config.ts", "vitest.config.mts"];
const COPY_DIRS = ["src", "cinatra", "skills", "runtime"];

async function copyRecursive(src, dest) {
  const stat = await fs.stat(src);
  if (stat.isDirectory()) {
    await fs.mkdir(dest, { recursive: true });
    const items = await fs.readdir(src);
    for (const item of items) {
      await copyRecursive(path.join(src, item), path.join(dest, item));
    }
  } else {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(src, dest);
  }
}

async function listTestFiles(dir) {
  const out = [];
  async function walk(d) {
    let items;
    try {
      items = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const full = path.join(d, it.name);
      if (it.isDirectory()) {
        if (it.name === "node_modules" || it.name === "dist") continue;
        await walk(full);
      } else if (/\.(test|spec)\.[mc]?[jt]sx?$/.test(it.name) || it.name === "__tests__") {
        out.push(full);
      }
    }
  }
  await walk(dir);
  return out;
}

// Collect the first-party (@cinatra-ai/* or @cinatra/*) packages a source tree
// IMPORTS (static `import ... from`, `import(...)`, or `require(...)`). Scans the
// repo's own .ts/.tsx/.mts/.cts/.js/.mjs/.cjs under src/ (skips node_modules/dist).
async function collectFirstPartyImports(dir) {
  const found = new Set();
  // Capture the PACKAGE name (@scope/name); allow an optional /subpath before the
  // closing quote so a subpath import (e.g. "@cinatra-ai/sdk-extensions/manifest")
  // still resolves to the package that must be declared.
  const re = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"](@cinatra(?:-ai)?\/[a-z0-9][a-z0-9-]*)(?:\/[^'"]*)?['"]/g;
  async function walk(d) {
    let items;
    try {
      items = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const full = path.join(d, it.name);
      if (it.isDirectory()) {
        if (it.name === "node_modules" || it.name === "dist") continue;
        await walk(full);
      } else if (/\.[mc]?[jt]sx?$/.test(it.name)) {
        const txt = await fs.readFile(full, "utf8");
        for (const m of txt.matchAll(re)) found.add(m[1]);
      }
    }
  }
  await walk(dir);
  return found;
}

// Fail-closed: a standalone extracted repo must DECLARE every first-party package
// its source imports, or its CI cannot resolve it (the monorepo workspace silently
// provided it). This is what made the artifacts — which `import type` from
// `@cinatra-ai/sdk-extensions` without declaring it — pass locally but fail
// standalone with TS2307. Classify by source imports ∪ declarations, not
// declarations alone.
export async function assertSourceImportsDeclared(srcDir, packageJson, name) {
  const imported = await collectFirstPartyImports(srcDir);
  if (!imported.size) return;
  const declared = new Set([
    ...Object.keys(packageJson.dependencies || {}),
    ...Object.keys(packageJson.peerDependencies || {}),
    ...Object.keys(packageJson.devDependencies || {}),
    ...Object.keys(packageJson.optionalDependencies || {}),
  ]);
  // A package importing ITSELF (rare) is fine.
  const undeclared = [...imported].filter((p) => p !== name && !declared.has(p));
  if (undeclared.length) {
    throw new Error(
      `extract: ${name} imports first-party package(s) not declared in package.json: ` +
        `${undeclared.join(", ")}. Declare them (devDependencies for type-only imports) so the ` +
        `standalone repo resolves them — the monorepo workspace hides this gap and CI fails TS2307.`,
    );
  }
}

async function renderTemplate(templateFile, replacements) {
  let content = await fs.readFile(templateFile, "utf8");
  for (const [key, value] of Object.entries(replacements)) {
    content = content.split(`{{${key}}}`).join(value);
  }
  return content;
}

// The placeholder step the template ci.yml carries in its `kind-gates` job.
const KIND_GATE_PLACEHOLDER = `      - name: No kind-specific gate
        run: echo "No kind-specific gate for this extension kind."`;

// The self-contained per-kind gate the extraction script ships INTO each
// agent/workflow repo (see materializePackage). Run with plain `node` — it is
// zero-dependency, so it works in a public repo's unauthenticated CI BEFORE the
// @cinatra-ai registry is reachable. The retired form
// (`pnpm dlx @cinatra-ai/extension-tools …`) resolved an UNPUBLISHED package and
// failed closed on a registry 404 for every agent/workflow repo.
export const KIND_GATE_SCRIPT = "extension-kind-gate.mjs";

// Real per-kind gate steps that replace the placeholder during materialization.
// Pure (string in → string out) so it is unit-testable without fs.
export function kindGateSteps(kind) {
  if (kind === "workflow") {
    return `      - uses: actions/setup-node@v4
        with:
          node-version: "24"
      - name: Workflow BPMN profile gate
        # Validate this repo's package shape + cinatra/workflow.bpmn via the
        # self-contained, zero-dependency gate shipped in this repo. The full
        # Profile-1.0 compile re-runs marketplace-side at publish/install.
        run: node ${KIND_GATE_SCRIPT} --package-root .`;
  }
  if (kind === "agent") {
    return `      - uses: actions/setup-node@v4
        with:
          node-version: "24"
      - name: Agent OAS validation gate
        # Validate this repo's cinatra/oas.json agent surface via the
        # self-contained, zero-dependency gate shipped in this repo.
        run: node ${KIND_GATE_SCRIPT} --package-root .`;
  }
  return null; // connector / artifact / skill: keep the placeholder
}

// Replace the template's placeholder kind-gate step with the real per-kind gate
// when one applies. Returns the ci.yml text unchanged for kinds with no gate.
export function applyKindGate(ciYaml, kind) {
  const steps = kindGateSteps(kind);
  if (!steps) return ciYaml;
  if (!ciYaml.includes(KIND_GATE_PLACEHOLDER)) return ciYaml;
  return ciYaml.replace(KIND_GATE_PLACEHOLDER, steps);
}

async function materializePackage(entry, plan, outDir, log) {
  const repoDir = path.join(outDir, plan.slug);
  await fs.mkdir(repoDir, { recursive: true });
  log(`out: ${repoDir}`);

  // package.json (computed by the pure planner)
  await fs.writeFile(
    path.join(repoDir, "package.json"),
    JSON.stringify(plan.packageJson, null, 2) + "\n",
    "utf8",
  );
  log("wrote package.json");

  // .npmrc — disable auto-install-peers so a standalone `pnpm install` never
  // tries to fetch the host-internal @cinatra-ai/* peers (sdk-extensions, ...),
  // which live ONLY in the cinatra monorepo workspace and are never published to
  // a registry. The repo is a source mirror; the monorepo provides those peers.
  await fs.writeFile(path.join(repoDir, ".npmrc"), buildNpmrc(), "utf8");
  const firstParty = packageDeclaresFirstParty(plan.packageJson);
  log(
    `wrote .npmrc (auto-install-peers=false${firstParty ? "; host-internal peers -> CI skips standalone typecheck/test" : ""})`,
  );

  // Copy source dirs/files that exist.
  for (const d of COPY_DIRS) {
    const src = path.join(entry.dir, d);
    if (await pathExists(src)) {
      await copyRecursive(src, path.join(repoDir, d));
      log(`copied dir: ${d}/`);
    }
  }
  for (const f of COPY_FILES) {
    const src = path.join(entry.dir, f);
    if (await pathExists(src)) {
      await fs.copyFile(src, path.join(repoDir, f));
      log(`copied file: ${f}`);
    }
  }
  // Copy any test files not already under src/.
  const tests = await listTestFiles(entry.dir);
  for (const t of tests) {
    const rel = path.relative(entry.dir, t);
    if (rel.startsWith("src" + path.sep)) continue; // already copied with src/
    const dest = path.join(repoDir, rel);
    await copyRecursive(t, dest);
    log(`copied test: ${rel}`);
  }

  // Apply template files where the source lacks them.
  if (!(await pathExists(path.join(repoDir, "tsconfig.json")))) {
    await fs.copyFile(
      path.join(TEMPLATE_ROOT, "tsconfig.json"),
      path.join(repoDir, "tsconfig.json"),
    );
    log("applied template tsconfig.json");
  }
  // LICENSE: write the SPDX-matched body from plan.license (authoritative),
  // OVERRIDING any stale source LICENSE. A vendored third-party package keeps its
  // UPSTREAM LICENSE instead (cinatra never relicenses vendored code); a vendored
  // package shipping no source LICENSE fails closed. An unsupported SPDX (no body
  // template + not vendored) fails closed rather than shipping a placeholder.
  {
    const decision = resolveLicenseBody({
      license: plan.license,
      name: plan.name,
      vendored: Boolean(entry.pkgJson?.cinatra?.vendoredFrom),
    });
    if (decision.vendored) {
      const srcLicense = path.join(entry.dir, "LICENSE");
      if (await pathExists(srcLicense)) {
        await fs.copyFile(srcLicense, path.join(repoDir, "LICENSE"));
        log(`preserved vendored upstream LICENSE (declared ${plan.license})`);
      } else {
        throw new Error(
          `extract: vendored package ${plan.name} declares "${plan.license}" but ships no source LICENSE to preserve`,
        );
      }
    } else {
      await fs.copyFile(
        path.join(TEMPLATE_ROOT, "licenses", decision.templateFile),
        path.join(repoDir, "LICENSE"),
      );
      log(`wrote ${plan.license} LICENSE body`);
    }
  }
  if (!(await pathExists(path.join(repoDir, "README.md")))) {
    const readme = await renderTemplate(
      path.join(TEMPLATE_ROOT, "README.md"),
      {
        NAME: plan.name || plan.slug,
        DESCRIPTION: entry.pkgJson.description || "A Cinatra extension.",
        KIND: plan.kind || "unknown",
      },
    );
    await fs.writeFile(path.join(repoDir, "README.md"), readme, "utf8");
    log("applied template README.md");
  }
  // CI workflow always comes from the template (standalone repos have none).
  // The template carries a placeholder "No kind-specific gate" step; for
  // workflow/agent kinds we replace it with the real kind gate so the ci.yml's
  // documented contract actually runs (otherwise it would only ever echo the
  // placeholder).
  const ciSrc = path.join(TEMPLATE_ROOT, ".github", "workflows", "ci.yml");
  const ciDest = path.join(repoDir, ".github", "workflows", "ci.yml");
  await fs.mkdir(path.dirname(ciDest), { recursive: true });
  let ci = await fs.readFile(ciSrc, "utf8");
  ci = applyKindGate(ci, plan.kind);
  await fs.writeFile(ciDest, ci, "utf8");
  log(`applied .github/workflows/ci.yml (kind gate: ${plan.kind || "none"})`);

  // Ship the self-contained kind-gate script for the kinds whose ci.yml runs it
  // (workflow/agent). It is zero-dependency so the extracted repo's public CI
  // passes WITHOUT resolving any @cinatra-ai package from the registry — the
  // hazard the retired `pnpm dlx @cinatra-ai/extension-tools` form created.
  if (plan.kind === "workflow" || plan.kind === "agent") {
    await fs.copyFile(
      path.join(TEMPLATE_ROOT, KIND_GATE_SCRIPT),
      path.join(repoDir, KIND_GATE_SCRIPT),
    );
    log(`applied ${KIND_GATE_SCRIPT} (self-contained ${plan.kind} gate)`);
  }

  // Ship the thin `release: published` caller into every extracted repo. It is
  // dormant until the org release infra exists (the cinatra-ai/.github reusable
  // workflow + the CINATRA_MARKETPLACE_VENDOR_TOKEN org secret) and a GitHub
  // Release is published — so it never fires during ordinary repo CI.
  const releaseSrc = path.join(TEMPLATE_ROOT, ".github", "workflows", "release.yml");
  if (await pathExists(releaseSrc)) {
    await fs.copyFile(releaseSrc, path.join(repoDir, ".github", "workflows", "release.yml"));
    log("applied .github/workflows/release.yml (marketplace publish-on-release caller)");
  }

  // (Repo creation + push is the SEPARATE, opt-in --push path: pushPackageRepo()
  // is invoked from main() AFTER all packages materialize, behind the --push
  // guard-rails. This function only writes the local tree.)
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const materialize = Boolean(args.out);
  const dryRun = !materialize ? true : args.dryRun;

  let graph = {};
  if (await pathExists(DEPENDENCY_GRAPH_PATH)) {
    try {
      graph = await readJson(DEPENDENCY_GRAPH_PATH);
    } catch (e) {
      console.warn(`warn: could not parse dependency graph: ${e.message}`);
    }
  } else {
    console.warn(`warn: dependency graph not found at ${DEPENDENCY_GRAPH_PATH}`);
  }

  const entries = await discoverExtensions();
  const planned = planExtractionOrder(graph, entries, args.only);

  // --push wiring + guards. Push is opt-in, side-effectful, and (with this
  // token) IRREVERSIBLE — so it is gated hard.
  let execFileAsync = null;
  if (args.push) {
    if (!args.out) {
      console.error("error: --push requires --out <dir> (a materialized tree to create+push)");
      process.exitCode = 1;
      return;
    }
    if (dryRun) {
      console.error("error: --push cannot run in dry-run mode (pass --out and not --dry-run)");
      process.exitCode = 1;
      return;
    }
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    execFileAsync = promisify(execFile);
    // Refuse pushing from inside a git work tree: a fresh `git init` in a subdir
    // of an existing repo can attach to the parent and push the wrong history.
    if (await isInsideGitWorkTree(args.out, execFileAsync)) {
      console.error(
        `error: --out (${args.out}) is inside a git work tree; refusing --push ` +
          `(materialize to a path outside any repo, e.g. /tmp, before pushing)`,
      );
      process.exitCode = 1;
      return;
    }
  }

  if (materialize && !dryRun) {
    await fs.mkdir(args.out, { recursive: true });
    await fs.mkdir(path.join(args.out, ".extract-logs"), { recursive: true });
  }

  console.log(
    `\nCinatra extension extraction — mode: ${
      dryRun ? "DRY-RUN (writes nothing)" : "MATERIALIZE"
    }`,
  );
  console.log(
    `discovered ${entries.length} extension(s); planning ${planned.length} after order + carve-outs\n`,
  );

  let ok = 0;
  let failed = 0;
  const pushResults = [];
  for (const entry of planned) {
    const logLines = [];
    const log = (m) => logLines.push(m);
    try {
      const plan = planExtractionForPackage(entry.pkgJson, { slug: entry.slug });
      log(`name=${plan.name} slug=${plan.slug} kind=${plan.kind} license=${plan.license}`);
      log(`workspace deps -> peerDependencies "*": ${plan.workspaceDepsConverted.join(", ") || "(none)"}`);
      for (const w of plan.warnings) log(`warning: ${w}`);

      // Fail-closed in EVERY mode (incl. dry-run): the source must not import a
      // first-party package it doesn't declare, or the standalone repo's CI fails
      // to resolve it. Runs before any materialize/push.
      await assertSourceImportsDeclared(
        path.join(entry.dir, "src"),
        plan.packageJson,
        plan.name,
      );

      // Compact console line.
      console.log(
        `  - ${plan.slug.padEnd(28)} ${String(plan.kind || "?").padEnd(9)} ${plan.license.padEnd(20)} peers:${plan.workspaceDepsConverted.length}`,
      );

      if (materialize && !dryRun) {
        await materializePackage(entry, plan, args.out, log);
        if (args.push) {
          const repoDir = path.join(args.out, plan.slug);
          const r = await pushPackageRepo(plan, repoDir, args.org, log, execFileAsync);
          pushResults.push(r);
          console.log(`      push: ${r.fullName} -> ${r.action}`);
        }
      } else {
        log("(dry-run) no files written");
      }
      ok++;

      if (materialize) {
        const logPath = path.join(args.out, ".extract-logs", `${plan.slug}.log`);
        if (!dryRun) {
          await fs.writeFile(logPath, logLines.join("\n") + "\n", "utf8");
        }
      }
    } catch (e) {
      failed++;
      console.error(`  ! ${entry.slug}: ${e.message}`);
      if (materialize && !dryRun) {
        const logPath = path.join(
          args.out,
          ".extract-logs",
          `${entry.slug}.error.log`,
        );
        await fs
          .writeFile(logPath, `${logLines.join("\n")}\nERROR: ${e.stack}\n`, "utf8")
          .catch(() => {});
      }
    }
  }

  console.log(
    `\nsummary: planned=${planned.length} ok=${ok} failed=${failed} ${
      dryRun ? "(dry-run — nothing written)" : `(written under ${args.out})`
    }\n`,
  );
  if (failed > 0) process.exitCode = 1;
}

// Only run main() when invoked directly (not when imported by tests).
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

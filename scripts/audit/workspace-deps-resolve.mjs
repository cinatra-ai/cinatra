#!/usr/bin/env node
/**
 * Workspace-dependency resolution gate (STRICT, not a ratchet).
 *
 * Every `workspace:`-protocol dependency declared in a workspace member's
 * package.json MUST resolve to a package that actually exists in the workspace.
 * A DANGLING declaration — a `"@cinatra-ai/foo": "workspace:*"` whose target
 * package was deleted (e.g. the removed package dir) — makes a forced-resolution
 * `pnpm install` hard-fail with ERR_PNPM_WORKSPACE_PKG_NOT_FOUND, so `main`
 * becomes uninstallable (cinatra#1669). A clean `pnpm install --frozen-lockfile`
 * does NOT catch this class: when the stale lockfile still matches the (also
 * stale) manifests, pnpm skips resolution and never validates workspace
 * membership. This gate validates the invariant DIRECTLY at the manifest level —
 * deterministic, hermetic, no install, no network.
 *
 * Scope: the IN-TREE, git-tracked workspace members — the root app + `packages/*`.
 * These are the only members a PR to THIS repo can add or delete, so they are
 * the complete surface for the #1669 regression. The companion-extension trees
 * (`extensions/*`, gitignored, materialized out-of-band from per-extension
 * repos) are DELIBERATELY out of scope: they can't be deleted by a PR here and
 * are validated by their own repos' CI. Excluding them keeps the gate hermetic
 * and deterministic — no `clone-extensions`, no network — and no in-tree
 * manifest declares a `workspace:` dependency on an extension anyway (verified),
 * so nothing is misreported. For each in-tree member's package.json the gate
 * checks every dependency (all four buckets) whose spec uses the `workspace:`
 * protocol and asserts its target resolves to a known in-tree member.
 *
 * Member-discovery is fail-closed: it errors if the globs match no members.
 *
 * Exit codes: 0 = clean, 1 = dangling workspace dep(s), 2 = scanner error.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = process.cwd();
const WORKSPACE_FILE = join(REPO_ROOT, "pnpm-workspace.yaml");
const DEP_BUCKETS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in __tests__/workspace-deps-resolve.test.mjs)
// ---------------------------------------------------------------------------

/** Parse the `packages:` glob list out of pnpm-workspace.yaml (no YAML dep). */
export function parseWorkspaceGlobs(yamlText) {
  const lines = yamlText.split(/\r?\n/);
  const globs = [];
  let inPackages = false;
  for (const line of lines) {
    if (/^packages:\s*$/.test(line)) { inPackages = true; continue; }
    if (inPackages && /^\S/.test(line)) break; // next top-level key
    if (!inPackages) continue;
    const m = line.match(/^\s*-\s*["']?([^"'#]+?)["']?\s*(#.*)?$/);
    if (m) globs.push(m[1].trim());
  }
  return globs;
}

/**
 * Given a dependency entry `[name, spec]`, if it uses the `workspace:` protocol
 * return the TARGET workspace package name it must resolve to, else null.
 *
 * - `"@scope/p": "workspace:*"` / `"^"` / `"~"` / `"1.2.3"` -> target is the key `@scope/p`.
 * - aliased `"alias": "workspace:@scope/p@*"` -> target is `@scope/p`.
 * - aliased `"alias": "workspace:p@^1"` -> target is `p`.
 */
export function resolveWorkspaceTarget(name, spec) {
  if (typeof spec !== "string" || !spec.startsWith("workspace:")) return null;
  const rest = spec.slice("workspace:".length);
  // Relative-path form (`workspace:../foo`, `workspace:./p`) has no package
  // NAME to return — it is validated by resolved PATH in
  // findDanglingWorkspaceDeps instead — so this name-resolver returns null.
  if (rest.startsWith(".") || rest.startsWith("/")) return null;
  // The ALIASED form is the only one carrying an explicit `<pkg>@<range>`, i.e.
  // it contains an `@` version separator (scoped: `@scope/name@range`;
  // unscoped: `name@range`). Everything else — ``, `*`, `^`, `~`, `1.2.3`,
  // `x`, `1.x`, `>=2`, … — is a bare range whose target is the dependency KEY.
  if (rest.startsWith("@")) {
    const body = rest.slice(1);                    // "scope/name" or "scope/name@range"
    return "@" + body.split("@")[0];                // "@scope/name"
  }
  if (rest.includes("@")) return rest.split("@")[0]; // unscoped alias "name@range"
  return name;                                      // bare range → the dependency key
}

/**
 * Find dangling workspace deps. `members` = [{ name, dir, deps: {bucket:{name:spec}} }].
 * Returns [{ member, dir, bucket, dep, spec, target }] for each `workspace:`
 * dependency whose target is not a known member — by NAME for the bare/aliased
 * forms, and by resolved PATH for the relative form (`workspace:../foo`).
 */
export function findDanglingWorkspaceDeps(members) {
  const memberNames = new Set(members.map((m) => m.name).filter(Boolean));
  const memberDirs = new Set(members.map((m) => normalize(m.dir)));
  const dangling = [];
  for (const m of members) {
    const identity = m.name || m.dir; // nameless members are still scanned
    for (const bucket of DEP_BUCKETS) {
      const entries = m.deps?.[bucket] ?? {};
      for (const [dep, spec] of Object.entries(entries)) {
        if (typeof spec !== "string" || !spec.startsWith("workspace:")) continue;
        const rest = spec.slice("workspace:".length);
        if (rest.startsWith(".") || rest.startsWith("/")) {
          // Relative-path workspace ref — resolve against the DECLARING member's
          // dir and require the resolved directory to be a known member.
          const targetDir = normalize(join(m.dir, rest));
          if (!memberDirs.has(targetDir)) {
            dangling.push({ member: identity, dir: m.dir, bucket, dep, spec, target: rest });
          }
          continue;
        }
        const target = resolveWorkspaceTarget(dep, spec);
        if (target && !memberNames.has(target)) {
          dangling.push({ member: identity, dir: m.dir, bucket, dep, spec, target });
        }
      }
    }
  }
  return dangling.sort((a, b) => (a.member + a.dep).localeCompare(b.member + b.dep));
}

// ---------------------------------------------------------------------------
// Filesystem scan
// ---------------------------------------------------------------------------

function expandGlob(pattern) {
  // One-level-per-segment glob: `*` within a single segment; no `**`.
  const segs = pattern.split("/");
  let dirs = [REPO_ROOT];
  for (const seg of segs) {
    const next = [];
    const hasWild = seg.includes("*");
    const re = hasWild ? new RegExp("^" + seg.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$") : null;
    for (const d of dirs) {
      if (!hasWild) { const p = join(d, seg); if (existsSync(p) && statSync(p).isDirectory()) next.push(p); continue; }
      let entries;
      try {
        entries = readdirSync(d, { withFileTypes: true });
      } catch (err) {
        // A legitimately-absent intermediate dir is fine to skip; any OTHER
        // read error (permissions, IO) fails closed so a partial scan can't pass.
        if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) continue;
        throw err;
      }
      for (const e of entries) if (e.isDirectory() && re.test(e.name)) next.push(join(d, e.name));
    }
    dirs = next;
  }
  return dirs;
}

function readMember(dir) {
  const pj = join(dir, "package.json");
  if (!existsSync(pj)) return null;
  let raw;
  try { raw = readFileSync(pj, "utf8"); }
  catch (err) { throw new Error(`unreadable manifest ${pj}: ${err.message}`); }
  let pkg;
  // Fail closed on malformed JSON — a manifest we can't parse might hide a
  // dangling dep; never silently skip it.
  try { pkg = JSON.parse(raw); }
  catch (err) { throw new Error(`malformed manifest ${pj}: ${err.message}`); }
  const deps = {};
  for (const bucket of DEP_BUCKETS) if (pkg[bucket]) deps[bucket] = pkg[bucket];
  // A nameless manifest can't be a dependency TARGET, but its own deps are
  // still scanned (identity falls back to its dir).
  return { name: pkg.name ?? null, dir, deps };
}

function discoverMembers() {
  // In-tree globs only: drop the companion-extension trees (materialized
  // out-of-band; out of scope — see the file header) so the scan is hermetic
  // and deterministic whether or not extensions happen to be on disk.
  const globs = parseWorkspaceGlobs(readFileSync(WORKSPACE_FILE, "utf8"))
    .filter((g) => !g.startsWith("extensions/"));
  const byDir = new Map();
  // The root app IS a pnpm workspace member and declares `workspace:*` deps of
  // its own, so a dangling declaration there breaks install identically — scan
  // it too (and register its name so a dep targeting the root resolves).
  const root = readMember(REPO_ROOT);
  if (root) byDir.set(REPO_ROOT, root);
  let globCount = 0; // members matched by the in-tree globs (excludes the root)
  for (const g of globs) for (const dir of expandGlob(g)) {
    if (dir === REPO_ROOT) continue;
    const m = readMember(dir);
    if (m) { byDir.set(dir, m); globCount++; }
  }
  return { members: [...byDir.values()], globCount };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  let members, globCount;
  try {
    ({ members, globCount } = discoverMembers());
  } catch (err) {
    console.error(`[workspace-deps-resolve] scanner error: ${err?.message ?? err}`);
    process.exit(2);
  }
  // Fail closed: if the in-tree globs matched NO members (only the root was
  // found), pnpm-workspace.yaml is broken — the gate must not pass vacuously (a
  // broken scan could otherwise hide a dangling dep).
  if (globCount === 0) {
    console.error("[workspace-deps-resolve] FAIL — the in-tree workspace globs matched no members (broken pnpm-workspace.yaml?). Refusing to pass vacuously.");
    process.exit(2);
  }

  const dangling = findDanglingWorkspaceDeps(members);
  if (dangling.length === 0) {
    console.log(`[workspace-deps-resolve] OK — every workspace: dependency targets an existing in-tree member (${members.length} members scanned).`);
    process.exit(0);
  }

  console.error(`[workspace-deps-resolve] FAIL — ${dangling.length} dangling workspace dependenc${dangling.length === 1 ? "y" : "ies"} (target package not in the workspace):`);
  for (const d of dangling) {
    console.error(`  ${d.member} (${d.bucket}): "${d.dep}": "${d.spec}" -> no workspace package named "${d.target}"`);
  }
  console.error(`\nA package the manifest still depends on was removed. Delete the stale declaration (and regenerate pnpm-lock.yaml), or restore the package.`);
  process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();

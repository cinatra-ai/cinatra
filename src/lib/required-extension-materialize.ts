// Required-extension OAS materialization (cinatra-ai/ops#436).
//
// Reconciles the image-owned required-extension OAS SEED (built at image-build
// time by scripts/extensions/build-required-oas-seed.mjs, baked into the runtime
// image) into the live agent-install dir (`resolveAgentInstallDir()`) on every
// boot. This is what makes the required-extension set MATERIALIZABLE ON DEPLOY:
// a new image tag carries a new seed, and this reconcile refreshes the on-disk
// `<vendor>/<slug>/cinatra/oas.json` trees that BOTH WayFlow (`:/agents:ro`
// mount) and the cinatra host process scan — instead of the trees being frozen
// in a persistent named volume seeded once (the cinatra-ai/ops#431 regression).
//
// Design (converged):
//   - The install dir is treated as a RECONSTRUCTABLE CACHE for the required
//     set, exactly as `/data/extensions/packages` is the durable USER store.
//   - Atomic per slug: each required slug dir is written to a temp sibling and
//     renamed into place, so a concurrent WayFlow scan never sees a half-written
//     tree. Idempotent: a slug whose on-disk OAS bytes already match the seed is
//     left untouched (no churn, no needless WayFlow reload).
//   - OWNERSHIP-BOUNDED PRUNE: a slug dir is pruned ONLY when it carries the
//     seed ownership marker (`.cinatra-required-seed.json`) AND is absent from
//     the current seed manifest. A coexisting user/operator dir (no marker) is
//     NEVER pruned. User-installed extensions live in a SEPARATE root
//     (`/data/extensions/packages`) and are never read or written here.
//   - FAIL-CLOSED in prod: a missing/unreadable seed dir or manifest throws, so
//     the prod boot does not come up with WayFlow pointed at an empty tree while
//     the required-activation assert (which checks the in-process registry, not
//     the filesystem) still passes.
//   - Guard: the resolved install dir must NOT be the user store root or a child
//     of it — refuse to materialize/prune there.

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

// Kept in sync with scripts/extensions/build-required-oas-seed.mjs (the build-
// time producer). Duplicated as plain consts rather than imported because the
// producer is a build-only .mjs not part of the server bundle.
const SEED_MARKER_FILENAME = ".cinatra-required-seed.json";
const SEED_MANIFEST_FILENAME = "manifest.json";
const OAS_REL_PATH = path.join("cinatra", "oas.json");
// Reserved hidden prefix for atomic-swap staging dirs. Leading `.` guarantees it
// can never be a valid slug (all `.`-prefixed entries are skipped), so the prune
// scan can never delete a real slug mistaken for a staging leftover.
const STAGE_PREFIX = ".cinatra-stage-";

// The image-baked seed location (mirrors the Dockerfile COPY destination).
export const DEFAULT_REQUIRED_OAS_SEED_DIR = "/app/.cinatra-required-oas-seed";

// The durable user-install store — NEVER a valid materialize target. Exported so the
// boot-time user-store-mount-check (cinatra#789 item 5) validates the SAME path this
// module refuses to write into — one source of truth, no drift.
export const USER_STORE_ROOT = "/data/extensions/packages";

export type MaterializeResult = {
  /** required slug dirs created or refreshed (OAS bytes differed) */
  materialized: string[];
  /** required slug dirs whose on-disk OAS already matched the seed */
  unchanged: string[];
  /** stale seed-owned slug dirs pruned (absent from the current seed) */
  pruned: string[];
  /** true when anything on disk changed (drives a post-reconcile WayFlow reload) */
  changed: boolean;
  /** set when the reconcile was a no-op for a benign reason (e.g. empty seed) */
  note?: string;
};

type SeedManifest = {
  kind?: string;
  slugs?: Array<{ vendor: string; slug: string }>;
};

function isUnderUserStore(dir: string): boolean {
  const resolved = path.resolve(dir);
  const store = path.resolve(USER_STORE_ROOT);
  return resolved === store || resolved.startsWith(store + path.sep);
}

function readJsonOrNull<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * Enumerate the relative PLAIN-FILE paths under a dir (sorted, POSIX-separated).
 * Returns null if a symlink or a non-file/dir entry is encountered (the caller
 * treats that as "differs" → clean re-materialize, which the copy guard rejects
 * loudly on a tampered seed).
 */
function listPlainFiles(root: string): string[] | null {
  if (!existsSync(root)) return null;
  const out: string[] = [];
  const walk = (rel: string): boolean => {
    const abs = path.join(root, rel || ".");
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) return false;
    if (st.isDirectory()) {
      for (const name of readdirSync(abs).sort()) {
        if (!walk(rel ? path.join(rel, name) : name)) return false;
      }
      return true;
    }
    if (st.isFile()) {
      out.push(rel.split(path.sep).join("/"));
      return true;
    }
    return false;
  };
  try {
    if (!walk("")) return null;
  } catch {
    return null;
  }
  return out.sort();
}

// Files the host runtime writes INTO an agent dir AFTER materialization (not part
// of the seed surface). These are allowed to exist on the live side without
// counting as drift — otherwise the marker the agent-marker-backfill writes would
// force a re-materialize every boot. Top-level basenames only.
const RUNTIME_WRITTEN_LIVE_FILES = new Set([
  ".cinatra-published.json", // wayflow published-marker (engineering #418)
  ".cinatra-in-progress.json", // chat-authoring in-progress-draft guard
]);

/**
 * Idempotence test: the live slug dir matches the seed iff their PROJECTED FILE
 * SURFACES are byte-identical — same file set, same bytes — after excluding the
 * narrow allowlist of runtime-written files the host adds post-materialization.
 * This (a) refreshes on ANY seed change incl. package.json/skills edits, (b)
 * detects a REMOVED seed file (a stale live-only file that is NOT runtime-written
 * is drift → re-materialize, which rebuilds the dir from the seed and drops it),
 * and (c) ignores the `.cinatra-published.json` marker so a settled tree does not
 * churn every boot.
 */
function slugMatchesSeed(seedSlugDir: string, liveSlugDir: string): boolean {
  if (!existsSync(path.join(liveSlugDir, OAS_REL_PATH))) return false;
  const seedFiles = listPlainFiles(seedSlugDir);
  const liveFilesAll = listPlainFiles(liveSlugDir);
  if (seedFiles === null || liveFilesAll === null) return false;

  // Live file set minus the runtime-written allowlist (top-level basenames).
  const liveFiles = liveFilesAll.filter(
    (rel) => !(rel.indexOf("/") === -1 && RUNTIME_WRITTEN_LIVE_FILES.has(rel)),
  );

  // Exact set equality on the projected surface.
  if (liveFiles.length !== seedFiles.length) return false;
  const seedSet = new Set(seedFiles);
  for (const rel of liveFiles) {
    if (!seedSet.has(rel)) return false; // a live-only (non-runtime) file ⇒ drift
  }

  // Byte equality for every seed file.
  for (const rel of seedFiles) {
    try {
      if (lstatSync(path.join(liveSlugDir, rel)).isSymbolicLink()) return false;
      if (!readFileSync(path.join(liveSlugDir, rel)).equals(readFileSync(path.join(seedSlugDir, rel)))) {
        return false;
      }
    } catch {
      return false; // missing on the live side (or unreadable) ⇒ differs
    }
  }
  return true;
}

// Copy a slug subtree symlink-free (the seed is already symlink-free; this guard
// is defense-in-depth so a tampered seed cannot inject a symlink into the live
// install dir that WayFlow then follows).
function copyPlainTree(src: string, dest: string): void {
  cpSync(src, dest, {
    recursive: true,
    dereference: false,
    filter: (s) => {
      if (lstatSync(s).isSymbolicLink()) {
        throw new Error(
          `[required-extension-materialize] refusing to copy a symlink from the seed: ${s}`,
        );
      }
      return true;
    },
  });
}

/**
 * Reconcile the required-extension OAS seed into the live install dir.
 *
 * @param opts.installDir   resolved agent-install dir (the WayFlow-mounted tree)
 * @param opts.seedDir      image-baked seed dir
 * @param opts.failClosed   throw on a missing/unreadable seed (prod); dev passes
 *                          false so a minimal checkout with no seed is a no-op.
 */
export function materializeRequiredExtensions(opts: {
  installDir: string;
  seedDir?: string;
  failClosed: boolean;
}): MaterializeResult {
  const { installDir, failClosed } = opts;
  const seedDir = opts.seedDir ?? DEFAULT_REQUIRED_OAS_SEED_DIR;

  const empty: MaterializeResult = {
    materialized: [],
    unchanged: [],
    pruned: [],
    changed: false,
  };

  // Guard: never materialize/prune into the durable user store.
  if (isUnderUserStore(installDir)) {
    throw new Error(
      `[required-extension-materialize] refusing to materialize into the user-install store ` +
        `(${installDir} is at or under ${USER_STORE_ROOT}); the install dir must be a ` +
        `separate, reconstructable required-set cache.`,
    );
  }

  const manifest = readJsonOrNull<SeedManifest>(path.join(seedDir, SEED_MANIFEST_FILENAME));
  if (!manifest || !Array.isArray(manifest.slugs)) {
    if (failClosed) {
      throw new Error(
        `[required-extension-materialize] required-extension OAS seed missing or unreadable at ` +
          `${seedDir} (no ${SEED_MANIFEST_FILENAME}). A prod image must bake the seed so the ` +
          `required set is materializable on deploy. Refusing to boot with an unrefreshable tree.`,
      );
    }
    return { ...empty, note: `seed absent at ${seedDir} (non-prod no-op)` };
  }

  // Validate every manifest entry: vendor/slug must be non-empty plain path
  // segments (no separators, no `..`) — defense-in-depth so a tampered manifest
  // cannot path-traverse out of the seed/install roots.
  const isSafeSegment = (s: unknown): s is string =>
    typeof s === "string" &&
    s.length > 0 &&
    !s.startsWith(".") &&
    !s.includes("/") &&
    !s.includes("\\") &&
    s !== ".." &&
    !s.includes("\0");
  for (const entry of manifest.slugs) {
    if (!entry || !isSafeSegment(entry.vendor) || !isSafeSegment(entry.slug)) {
      if (failClosed) {
        throw new Error(
          `[required-extension-materialize] seed manifest has an invalid slug entry ` +
            `${JSON.stringify(entry)} — corrupt seed.`,
        );
      }
      return { ...empty, note: `seed manifest invalid entry (non-prod no-op)` };
    }
  }

  mkdirSync(installDir, { recursive: true });

  const seedSlugKeys = new Set(manifest.slugs.map((s) => `${s.vendor}/${s.slug}`));
  const result: MaterializeResult = {
    materialized: [],
    unchanged: [],
    pruned: [],
    changed: false,
  };

  // 1. Materialize / refresh each seeded required slug.
  for (const { vendor, slug } of manifest.slugs) {
    const key = `${vendor}/${slug}`;
    const seedSlugDir = path.join(seedDir, vendor, slug);
    if (!existsSync(path.join(seedSlugDir, OAS_REL_PATH))) {
      // Manifest/seed inconsistency — fail-closed in prod, skip otherwise.
      if (failClosed) {
        throw new Error(
          `[required-extension-materialize] seed manifest lists ${key} but ${OAS_REL_PATH} is ` +
            `missing under ${seedSlugDir} — corrupt seed.`,
        );
      }
      continue;
    }

    const liveSlugDir = path.join(installDir, vendor, slug);
    // Idempotence on the WHOLE projected tree (oas.json + package.json +
    // skills/** + marker), not just oas.json — a deploy must refresh a same-OAS
    // package.json/skills change too.
    if (existsSync(liveSlugDir) && slugMatchesSeed(seedSlugDir, liveSlugDir)) {
      result.unchanged.push(key);
      continue;
    }

    // Atomic-as-possible per-slug replace. POSIX `rename(2)` over an existing
    // dir fails (ENOTEMPTY), so to keep the window where the slug is ABSENT as
    // small as possible we: (1) copy the seed into a temp sibling; (2) move any
    // existing live dir aside to a backup sibling; (3) rename the temp into
    // place; (4) drop the backup. Steps 2+3 are two adjacent renames (metadata
    // ops, no copy) — far tighter than the old "rm then copy-into-place". On a
    // crash between 2 and 3 the next boot re-materializes from the seed (the
    // live dir is reconstructable), and a leftover backup is cleaned on the next
    // pass; correctness does not depend on it surviving.
    // Staging dirs use a RESERVED HIDDEN prefix that can never collide with a
    // valid slug (slugs starting with `.` are skipped everywhere, incl. the
    // prune scan) — so the prune logic can never mistake a real slug for a
    // staging leftover. Placed as siblings of the slug under the vendor dir.
    const vendorDir = path.join(installDir, vendor);
    mkdirSync(vendorDir, { recursive: true });
    const stamp = `${process.pid}-${Date.now()}`;
    const tmpDir = path.join(vendorDir, `${STAGE_PREFIX}tmp-${slug}-${stamp}`);
    const bakDir = path.join(vendorDir, `${STAGE_PREFIX}bak-${slug}-${stamp}`);
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(bakDir, { recursive: true, force: true });
    // The seed slug dir already carries the ownership marker (copied here), so a
    // later boot can prune this dir if the seed drops it.
    copyPlainTree(seedSlugDir, tmpDir);
    const hadLive = existsSync(liveSlugDir);
    if (hadLive) renameSync(liveSlugDir, bakDir);
    renameSync(tmpDir, liveSlugDir);
    if (hadLive) rmSync(bakDir, { recursive: true, force: true });
    result.materialized.push(key);
  }

  // 2. Prune stale SEED-OWNED slug dirs no longer in the current seed. Only dirs
  // carrying the ownership marker are eligible — coexisting user/operator dirs
  // (no marker) are left untouched.
  if (existsSync(installDir)) {
    for (const vendorEntry of readdirSync(installDir, { withFileTypes: true })) {
      if (!vendorEntry.isDirectory() || vendorEntry.name.startsWith(".")) continue;
      const vendor = vendorEntry.name;
      const vendorDir = path.join(installDir, vendor);
      for (const slugEntry of readdirSync(vendorDir, { withFileTypes: true })) {
        if (!slugEntry.isDirectory()) continue;
        const slug = slugEntry.name;
        // Sweep leftover staging dirs from a crashed prior reconcile (they carry
        // the reserved hidden prefix, which no valid slug can).
        if (slug.startsWith(STAGE_PREFIX)) {
          rmSync(path.join(vendorDir, slug), { recursive: true, force: true });
          continue;
        }
        // Any other `.`-prefixed entry (e.g. .DS_Store dirs) is never a managed
        // slug — skip it entirely (never a prune target).
        if (slug.startsWith(".")) continue;
        const key = `${vendor}/${slug}`;
        if (seedSlugKeys.has(key)) continue; // still required — keep
        const liveSlugDir = path.join(vendorDir, slug);
        const markerPath = path.join(liveSlugDir, SEED_MARKER_FILENAME);
        if (!existsSync(markerPath)) continue; // not seed-owned — never prune
        rmSync(liveSlugDir, { recursive: true, force: true });
        result.pruned.push(key);
      }
    }
  }

  // Record the reconciled manifest in the install dir for observability/debug
  // (NOT used as the prune authority — the per-dir marker is).
  try {
    writeFileSync(
      path.join(installDir, SEED_MANIFEST_FILENAME),
      JSON.stringify(
        { kind: "required-oas-materialized", reconciledAt: new Date().toISOString(), slugs: manifest.slugs },
        null,
        2,
      ) + "\n",
      "utf8",
    );
  } catch {
    // Best-effort breadcrumb; never fail the reconcile on it.
  }

  result.changed = result.materialized.length > 0 || result.pruned.length > 0;
  return result;
}

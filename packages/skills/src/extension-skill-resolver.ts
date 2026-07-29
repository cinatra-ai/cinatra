import "server-only";

// Generic, install/uninstall-aware skill registration.
//
// Before this module, every prod consumer of an extension's skill (blog
// generation, the chat runner, skill-prefill) carried its OWN hardcoded
// "self-heal": a literal skill-id list, a literal `@cinatra-ai/<pkg>` package
// name, and literal `extensions/<vendor>/<pkg>/skills/<slug>/SKILL.md` candidate
// paths, then called `registerExtensionSkill` to push the SKILL.md body into the
// `cinatra.skills` catalog. That is exactly the static extension-INSTANCE
// coupling the `core-extension-instance-coupling-ban` gate exists to kill: core
// naming a specific extension by package + on-disk path.
//
// The reason those self-heals existed: the generic boot scan
// (`loadAllSkillPackagesAtBoot`) is DEV-ONLY (gated on
// `CINATRA_RUNTIME_MODE==="development"`), so in prod nothing populated the
// skill BODY in the catalog until each consumer registered it on demand.
//
// This module replaces all of them with ONE generic, kind-agnostic, prod-safe,
// idempotent lazy resolver. A caller names either:
//   - a stable, package-OWNED capability key (e.g. `blog.generate-ideas`), which
//     the resolver maps to the active extension declaring it via
//     `cinatra.capabilities` in that extension's package.json — so core never
//     names the extension, its package, or its disk path; or
//   - a concrete skillId, which the resolver locates by deriving each active
//     skill extension's skill-ids and matching.
//
// Discovery is filesystem-driven (the install/uninstall-aware substrate for
// bundled + marketplace extensions): an uninstalled extension's directory is
// gone, so it stops resolving. On top of that, the coarse `installed_extension`
// lifecycle gate IS applied at the resolver entry points (the live runtime
// installer has shipped): an extension whose canonical rows exist but are ALL
// retired (effective status "archived") is skipped — the explicit-tombstone
// semantics proven by the StaticBundleLoader's `gateRetiredStaticRecords`. A
// package with NO rows is KEPT (bundled extensions are not necessarily
// lifecycle-tracked — "no row" must not read as "retired", so unseeded prod
// rows cannot regress), and a failed status read keeps everything (fail-open).

import { existsSync, realpathSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { revalidatePath } from "next/cache";
import { replaceSkillCatalogInDatabase } from "@/lib/database";
import { registerExtensionSkill } from "./register-extension-skill";
import { resolveSkillOwnerPackageCandidates } from "./manifest-identity";
import { commitSkillChange } from "./storage/git-commit";
import {
  getSkillStoreRootPath,
  getSkillsDataRootPath,
  isRealpathContained,
  readSkillsCatalog,
} from "./skills-store";

// ---------------------------------------------------------------------------
// Skill-ID derivation (canonical home — re-exported by the dev watcher).
// ---------------------------------------------------------------------------

export type SkillRegistration = { packageName: string; skillId: string };

/**
 * The FIVE injectable successor packages of the retired
 * `@cinatra-ai/assistant-skills` pack (cinatra#2090 S3 fold). Their bundles
 * register under the `@cinatra-ai/chat:` namespace so they stay consistent
 * with the runner's chat skill-ids and the auth-policy carve-out (which
 * matches the `@cinatra-ai/chat:chat-` prefix — a security-sensitive auth
 * boundary + DB row key; do NOT change).
 *
 * SECURITY: this is an EXACT (manifest-name, dir) allowlist. Matching the
 * dir basename alone (the pre-fold `assistant-skills` special case) would let
 * a foreign package mint privileged `@cinatra-ai/chat:chat-*` ids just by
 * sitting in a directory with the right name; membership therefore requires
 * BOTH the canonical dir basename AND the manifest `name` equal to that
 * basename under the first-party vendor scope — i.e. exactly the five
 * (`@cinatra-ai/<dir>`, `<dir>`) pairs, nothing wider. Expressed as
 * dir-basename + scope-equality (not literal scoped names) per the
 * instance-coupling gate: core carries no extension package-name literal;
 * the semantics are the same exact-pair allowlist. The internal
 * hitl-prompt-drive package is deliberately NOT here — it registers under
 * its own scoped namespace and is resolved by capability, never by
 * chat-namespace id.
 */
const CHAT_NAMESPACE_DIR_BASENAMES: ReadonlySet<string> = new Set([
  "chat-assistant-core-skill",
  "extension-authoring-skill",
  "automation-authoring-skill",
  "company-research-skill",
  "blog-content-skill",
]);
const CHAT_NAMESPACE_VENDOR_SCOPE = "@cinatra-ai/";

/**
 * Skill-ID derivation. The five injectable chat successor packages (exact
 * scoped-name allowlist above) register under the `@cinatra-ai/chat:`
 * namespace; every other skill package uses its own scoped name as the id
 * prefix.
 *
 * RESERVED-NAMESPACE guard: `@cinatra-ai/chat` is a privileged VIRTUAL
 * namespace (the auth carve-out reads `@cinatra-ai/chat:chat-*`), never a
 * real installable package. Without this guard a foreign package could mint
 * carve-out ids by simply NAMING itself `@cinatra-ai/chat` (or the bare
 * `cinatra-ai/chat`, which the normalization below would @-prefix) — the
 * generic branch would emit the privileged prefix verbatim. Such a package
 * is refused outright (throws); the fail-soft registration loop skips it.
 *
 * The storage path (separate from the skillId namespace) mirrors the on-disk
 * source package path; that mapping lives in `register-extension-skill.ts`.
 */
export function deriveSkillRegistration(
  pkgName: string,
  pkgDirName: string,
  slug: string,
): SkillRegistration {
  if (
    CHAT_NAMESPACE_DIR_BASENAMES.has(pkgDirName) &&
    pkgName === `${CHAT_NAMESPACE_VENDOR_SCOPE}${pkgDirName}`
  ) {
    return { packageName: "@cinatra-ai/chat", skillId: `@cinatra-ai/chat:${slug}` };
  }
  const packageName = pkgName.startsWith("@") ? pkgName : `@${pkgName}`;
  if (packageName === "@cinatra-ai/chat") {
    throw new Error(
      `deriveSkillRegistration: package "${pkgName}" (dir "${pkgDirName}") claims the reserved ` +
        `@cinatra-ai/chat namespace but is not an allowlisted successor package — refusing to mint a privileged skill id.`,
    );
  }
  return { packageName, skillId: `${packageName}:${slug}` };
}

/**
 * Scan-loop-safe variant: a package the reserved-namespace guard refuses
 * yields `null` (skip THIS package) instead of aborting the surrounding
 * extension scan — an installed impostor must degrade only itself, never all
 * skill delivery.
 */
function safeDeriveSkillRegistration(
  pkgName: string,
  pkgDirName: string,
  slug: string,
): SkillRegistration | null {
  try {
    return deriveSkillRegistration(pkgName, pkgDirName, slug);
  } catch {
    return null;
  }
}

/**
 * Register every co-located `<pkgDir>/skills/<slug>/SKILL.md` at WORKSPACE
 * level via `registerExtensionSkill`. Shared by the dev boot/watcher scan and
 * the lazy resolver below. Fail-soft per skill (one bad SKILL.md never aborts
 * the rest); returns the skill-ids that ACTUALLY registered (callers that only
 * need a count use `.length`). Returning the id set — not just a count — lets
 * the lazy resolver verify the SPECIFIC requested skill registered rather than
 * trusting that any sibling did. Missing `skills/` dir ⇒ [].
 */
export async function registerColocatedWorkspaceSkills(input: {
  pkgDir: string;
  pkgName: string;
  pkgDirName: string;
}): Promise<string[]> {
  const skillsRoot = path.join(input.pkgDir, "skills");
  if (!existsSync(skillsRoot)) return [];
  let slugEntries;
  try {
    slugEntries = await readdir(skillsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const registered: string[] = [];
  for (const slugEntry of slugEntries) {
    if (!slugEntry.isDirectory()) continue;
    const slug = slugEntry.name;
    const skillMdPath = path.join(skillsRoot, slug, "SKILL.md");
    if (!existsSync(skillMdPath)) continue;
    try {
      // Inside the fail-soft frame: the reserved-namespace guard in
      // `deriveSkillRegistration` throws for a package impersonating
      // `@cinatra-ai/chat`, and that refusal must skip THIS package's slug,
      // never abort the whole scan.
      const { packageName, skillId } = deriveSkillRegistration(
        input.pkgName,
        input.pkgDirName,
        slug,
      );
      await registerExtensionSkill({ skillId, packageName, skillMdPath });
      registered.push(skillId);
    } catch (err) {
      console.warn(
        `[cinatra:skills] skill register skipped (${input.pkgDirName}/${slug}):`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return registered;
}

// ---------------------------------------------------------------------------
// Generic extension scan + lazy resolver.
// ---------------------------------------------------------------------------

const DEFAULT_ALLOW_KINDS = ["skill"] as const;

/**
 * One `cinatra.dependencies` entry, narrowed to the fields the projection needs.
 *
 * Deliberately re-declared here instead of imported from
 * `@cinatra-ai/extensions`: that package already consumes `@cinatra-ai/skills`,
 * so importing it back would invert the layering (the same reason the lifecycle
 * gate above reaches for it only through a fail-soft dynamic import). The shape
 * is the canonical `ExtensionDependency`; the structural filter below accepts
 * only entries that carry the fields it reads.
 */
export type DeclaredExtensionDependency = {
  packageName: string;
  edgeType: string;
  requirement: string;
  kind?: string;
  /**
   * The edge ROLE (cinatra#2090) — which host surface this skill edge feeds.
   * `matcher` / `authoring` per `DEPENDENCY_SKILL_ROLES`; ABSENT means the
   * plain injectable delivery wave 2 landed. Read as an opaque string here for
   * the same layering reason the rest of this type is re-declared: the
   * canonical vocabulary lives in `@cinatra-ai/extensions`, which already
   * consumes this package.
   */
  role?: string;
};

/** Keep only structurally well-formed `cinatra.dependencies` entries. */
function readDeclaredDependencies(raw: unknown): DeclaredExtensionDependency[] {
  if (!Array.isArray(raw)) return [];
  const out: DeclaredExtensionDependency[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.packageName !== "string" || e.packageName.length === 0) continue;
    if (typeof e.edgeType !== "string" || typeof e.requirement !== "string") continue;
    out.push({
      packageName: e.packageName,
      edgeType: e.edgeType,
      requirement: e.requirement,
      kind: typeof e.kind === "string" ? e.kind : undefined,
      role: typeof e.role === "string" ? e.role : undefined,
    });
  }
  return out;
}

export type SkillExtensionDescriptor = {
  /** Absolute path to the extension package dir. */
  pkgDir: string;
  /** `package.json` name (lifecycle/package identity). */
  pkgName: string;
  /** Directory basename — drives the `deriveSkillRegistration` special-case. */
  pkgDirName: string;
  /** `cinatra.kind`. */
  kind: string;
  /**
   * The package's DECLARED `cinatra.dependencies` edges, structurally filtered
   * to the well-formed entries (cinatra#2090 S3). Carried on the descriptor so
   * the dependency→injection projection below can read a consumer's declared
   * skill edge from the SAME single filesystem scan the rest of this module
   * uses. `[]` when the manifest declares none / declares them malformed.
   */
  dependencies: DeclaredExtensionDependency[];
  /** `cinatra.capabilities` map: stable capability key → co-located skill slug. */
  capabilities: Record<string, string>;
  /** Co-located `skills/<slug>` dirs that contain a `SKILL.md`. */
  slugs: string[];
};

/**
 * Resolve the extension roots to scan. Bundled extensions ship in the image at
 * `cwd/extensions` (dev + prod); dynamically-installed (marketplace/git)
 * extensions live under the configured install dir. `@cinatra-ai/skills` must
 * NOT hard-depend on `@cinatra-ai/agents` (agents already depends on skills),
 * so the install-dir resolver is loaded via a fail-soft dynamic import; the
 * bundled `cwd/extensions` root is always present as the floor. Deduped by
 * realpath (the install-dir default IS `cwd/extensions`).
 */
async function resolveExtensionRoots(): Promise<string[]> {
  const candidates: string[] = [path.join(process.cwd(), "extensions")];
  try {
    const { resolveAgentRuntimeMountDir } = await import("@cinatra-ai/agents/agent-runtime-mount");
    candidates.push(resolveAgentRuntimeMountDir());
  } catch {
    // Bundled root is sufficient for image-shipped extensions.
  }
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const c of candidates) {
    if (!existsSync(c)) continue;
    let real: string;
    try {
      real = realpathSync(c);
    } catch {
      real = c;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    roots.push(c);
  }
  return roots;
}

/**
 * Walk `<root>/<vendor>/<pkg>` across all extension roots and return a
 * descriptor for every package carrying a `cinatra.kind`. Deduped by package
 * dir realpath (bundled root wins over a same-path install root). Fail-soft.
 */
export async function scanSkillExtensions(): Promise<SkillExtensionDescriptor[]> {
  const roots = await resolveExtensionRoots();
  const out: SkillExtensionDescriptor[] = [];
  const seenPkgDir = new Set<string>();
  for (const root of roots) {
    let vendors;
    try {
      vendors = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const vendor of vendors) {
      if (!vendor.isDirectory() || vendor.name === "node_modules" || vendor.name.startsWith(".")) {
        continue;
      }
      const vendorDir = path.join(root, vendor.name);
      let pkgs;
      try {
        pkgs = await readdir(vendorDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const pkg of pkgs) {
        if (!pkg.isDirectory() || pkg.name === "node_modules" || pkg.name.startsWith(".")) {
          continue;
        }
        const pkgDir = path.join(vendorDir, pkg.name);
        let realPkgDir: string;
        try {
          realPkgDir = realpathSync(pkgDir);
        } catch {
          realPkgDir = pkgDir;
        }
        if (seenPkgDir.has(realPkgDir)) continue;
        const pkgJsonPath = path.join(pkgDir, "package.json");
        if (!existsSync(pkgJsonPath)) continue;
        let pkgJson: {
          name?: string;
          cinatra?: { kind?: string; capabilities?: unknown; dependencies?: unknown };
        };
        try {
          pkgJson = JSON.parse(await readFile(pkgJsonPath, "utf8"));
        } catch {
          continue;
        }
        const kind = pkgJson?.cinatra?.kind;
        if (!kind) continue;
        seenPkgDir.add(realPkgDir);
        const rawCaps = pkgJson?.cinatra?.capabilities;
        const capabilities: Record<string, string> = {};
        if (rawCaps && typeof rawCaps === "object" && !Array.isArray(rawCaps)) {
          for (const [k, v] of Object.entries(rawCaps as Record<string, unknown>)) {
            if (typeof v === "string" && v) capabilities[k] = v;
          }
        }
        const skillsRoot = path.join(pkgDir, "skills");
        let slugs: string[] = [];
        if (existsSync(skillsRoot)) {
          try {
            slugs = (await readdir(skillsRoot, { withFileTypes: true }))
              .filter(
                (e) => e.isDirectory() && existsSync(path.join(skillsRoot, e.name, "SKILL.md")),
              )
              .map((e) => e.name);
          } catch {
            slugs = [];
          }
        }
        out.push({
          pkgDir,
          pkgName: pkgJson.name ?? pkg.name,
          pkgDirName: pkg.name,
          kind,
          dependencies: readDeclaredDependencies(pkgJson?.cinatra?.dependencies),
          capabilities,
          slugs,
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Coarse `installed_extension` lifecycle gate (explicit-tombstone semantics).
// ---------------------------------------------------------------------------
//
// Mirrors the StaticBundleLoader's proven `gateRetiredStaticRecords`: drop a
// scanned extension ONLY when its package has canonical `installed_extension`
// rows AND none are live (effective status "archived"). "No row" is KEPT —
// bundled extensions are not necessarily lifecycle-tracked, so an unseeded
// prod row must never stop skill resolution. The status read goes through a
// FAIL-SOFT dynamic import of `@cinatra-ai/extensions` (same posture as the
// `@cinatra-ai/agents/agent-runtime-mount` import above — skills must not
// hard-depend on the extensions package, which itself consumes skills);
// any import/DB failure keeps every extension (fail-open, like the loader).
//
// Identity drift: `installed_extension.package_name` is not always the npm
// form (slugified rows exist — see manifest-identity.ts), so each extension is
// matched by its candidate-key union from `resolveSkillOwnerPackageCandidates`.

async function readLifecycleStatusFailOpen(
  candidateNames: string[],
): Promise<Map<string, "active" | "archived"> | null> {
  if (candidateNames.length === 0) return new Map();
  try {
    const { readEffectiveStatusByPackageNames } = await import("@cinatra-ai/extensions");
    return await readEffectiveStatusByPackageNames(candidateNames);
  } catch (err) {
    console.warn(
      "[cinatra:skills] lifecycle status read failed — keeping all scanned extensions (fail-open):",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Drop scanned extensions that are explicitly RETIRED (tombstoned) in the
 * canonical `installed_extension` lifecycle store. Keep on no-row and on a
 * failed status read. Exported for tests.
 */
export async function filterRetiredSkillExtensions(
  exts: SkillExtensionDescriptor[],
): Promise<SkillExtensionDescriptor[]> {
  if (exts.length === 0) return exts;
  const candidatesByExt = exts.map((ext) =>
    resolveSkillOwnerPackageCandidates({ packageName: ext.pkgName }),
  );
  const statusMap = await readLifecycleStatusFailOpen([...new Set(candidatesByExt.flat())]);
  if (statusMap === null) return exts; // fail-open
  const kept: SkillExtensionDescriptor[] = [];
  for (let i = 0; i < exts.length; i++) {
    const statuses = candidatesByExt[i]!
      .map((c) => statusMap.get(c))
      .filter((s): s is "active" | "archived" => s !== undefined);
    const live = statuses.includes("active");
    const tombstoned = !live && statuses.includes("archived");
    if (tombstoned) {
      console.info(
        `[cinatra:skills] skipping retired (tombstoned) extension "${exts[i]!.pkgName}" — ` +
          "its installed_extension rows are all archived",
      );
      continue;
    }
    kept.push(exts[i]!);
  }
  return kept;
}

/**
 * FAIL-CLOSED liveness check for ONE extension, for the auth carve-out path.
 *
 * Unlike `filterRetiredSkillExtensions` (fail-OPEN: a degraded lifecycle-status
 * read keeps every extension), this denies on ANY of:
 *   - the lifecycle-status read failing (`null` from the fail-open reader), or
 *   - the extension being explicitly tombstoned (`archived` with no `active`).
 *
 * It returns `true` ONLY when the status store affirmatively reports the owning
 * package live — OR reports NO lifecycle rows at all (the bundled-image floor:
 * image-shipped extensions like the WordPress/Drupal connectors have no
 * `installed_extension` rows; the no-row case is "live by being on disk", same
 * rule the scan filter uses, but here a READ FAILURE is NOT conflated with
 * no-rows). The widget carve-out must never widen on a degraded status store.
 */
async function isSkillExtensionLiveFailClosed(
  ext: SkillExtensionDescriptor,
): Promise<boolean> {
  const candidates = resolveSkillOwnerPackageCandidates({ packageName: ext.pkgName });
  const statusMap = await readLifecycleStatusFailOpen([...new Set(candidates)]);
  if (statusMap === null) return false; // read failed → fail CLOSED (deny)
  const statuses = candidates
    .map((c) => statusMap.get(c))
    .filter((s): s is "active" | "archived" => s !== undefined);
  if (statuses.includes("active")) return true; // affirmatively live
  if (statuses.includes("archived")) return false; // tombstoned → deny
  return true; // no lifecycle rows → image-shipped floor (live by being on disk)
}

/**
 * The subset of `skillIds` whose OWNER package is explicitly tombstoned.
 * Owner identity is derived from the skillId's package prefix (`@scope/pkg:slug`)
 * through the same candidate union as the scan filter; the chat successor
 * packages' carve-out prefix (`@cinatra-ai/chat`) has no lifecycle rows →
 * kept, by the no-row rule. Fail-open: a failed status read tombstones nothing.
 */
async function tombstonedSkillIds(skillIds: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (skillIds.length === 0) return out;
  const candidatesById = new Map(
    skillIds.map((id) => [
      id,
      resolveSkillOwnerPackageCandidates({ packageName: id.split(":")[0] ?? id }),
    ]),
  );
  const statusMap = await readLifecycleStatusFailOpen([
    ...new Set([...candidatesById.values()].flat()),
  ]);
  if (statusMap === null) return out; // fail-open
  for (const [id, candidates] of candidatesById) {
    const statuses = candidates
      .map((c) => statusMap.get(c))
      .filter((s): s is "active" | "archived" => s !== undefined);
    if (!statuses.includes("active") && statuses.includes("archived")) out.add(id);
  }
  return out;
}

// Memoize SUCCESSFUL (and in-flight) registrations per skillId. A miss or a
// zero-registration outcome is NOT cached, so a later install is picked up on
// the next call (guardrail: do not negative-cache misses). A memoized success
// is RE-GATED against the lifecycle store on every call (below): an extension
// archived AFTER its skill registered must stop resolving without a process
// restart, and its dropped memo lets a later RESTORE re-register.
const registrationMemo = new Map<string, Promise<void>>();

/**
 * Lazily register the SKILL.md body of whichever active extension provides
 * `skillId` into the `cinatra.skills` catalog. Generic replacement for the
 * per-consumer hardcoded self-heals. Fail-soft: never throws — a subsequent
 * catalog miss in the caller (`installed.get(skillId)`) surfaces the error.
 */
export function ensureInstalledSkillRegistered(
  skillId: string,
  opts?: { allowKinds?: readonly string[] },
): Promise<void> {
  const existing = registrationMemo.get(skillId);
  if (existing) {
    // Live-state re-gate of a memoized success: an extension archived AFTER
    // its skill registered must not keep resolving until process restart.
    // Fail-open (a failed status read trusts the memo). Dropping the memo
    // lets a later RESTORE re-register through the scan path.
    return (async () => {
      if ((await tombstonedSkillIds([skillId])).has(skillId)) {
        if (registrationMemo.get(skillId) === existing) registrationMemo.delete(skillId);
        console.info(
          `[cinatra:skills] memoized registration for "${skillId}" dropped — its owner extension is retired (tombstoned)`,
        );
        return;
      }
      return existing;
    })();
  }
  const allow = new Set(opts?.allowKinds ?? DEFAULT_ALLOW_KINDS);
  const run = (async () => {
    const exts = await filterRetiredSkillExtensions(await scanSkillExtensions());
    for (const ext of exts) {
      if (!allow.has(ext.kind)) continue;
      const provides = ext.slugs.some(
        (slug) => safeDeriveSkillRegistration(ext.pkgName, ext.pkgDirName, slug)?.skillId === skillId,
      );
      if (!provides) continue;
      const registered = await registerColocatedWorkspaceSkills({
        pkgDir: ext.pkgDir,
        pkgName: ext.pkgName,
        pkgDirName: ext.pkgDirName,
      });
      // Keep the memo ONLY if the SPECIFIC requested skill registered — a
      // sibling succeeding while this one's upsert failed must NOT be cached as
      // done (it would never retry until process restart).
      if (registered.includes(skillId)) return;
      break;
    }
    // The requested skill did not register — drop the memo so a later call
    // (transient fs/DB failure healed, or extension installed) retries.
    registrationMemo.delete(skillId);
    console.warn(
      `[cinatra:skills] ensureInstalledSkillRegistered: no active skill extension provides "${skillId}" — ` +
        "skill delivery will degrade until the providing extension is installed/fixed",
    );
  })().catch((err) => {
    registrationMemo.delete(skillId);
    console.error(
      `[cinatra:skills] ensureInstalledSkillRegistered("${skillId}") failed:`,
      err instanceof Error ? err.message : err,
    );
  });
  registrationMemo.set(skillId, run);
  return run;
}

/**
 * Batch variant of {@link ensureInstalledSkillRegistered}: ensure EVERY skillId
 * in `skillIds` is registered, scanning extension roots ONCE and registering
 * each providing package's co-located skills at most once. Per-id memo
 * semantics are preserved exactly — an id whose upsert succeeded is cached, and
 * an id that did NOT register (its package missing, or its own upsert failed
 * while a sibling succeeded) is left uncached so a later call retries it.
 *
 * Use this when a consumer needs a fixed SET of skills present (e.g. the chat
 * runner's `CHAT_SKILL_IDS`, all co-located in one extension package): it avoids
 * the N-full-package-scans-and-re-registrations cost of calling the single-id
 * variant in a loop, while keeping each id independently retryable. Fail-soft:
 * never throws. The returned promise settles once every requested id's
 * registration (in-flight or freshly started here) has completed.
 */
export async function ensureInstalledSkillsRegistered(
  skillIds: readonly string[],
  opts?: { allowKinds?: readonly string[] },
): Promise<void> {
  const allow = new Set(opts?.allowKinds ?? DEFAULT_ALLOW_KINDS);
  const unique = [...new Set(skillIds)];
  // Live-state re-gate of memoized successes (mirrors the single-id entry
  // point, one batched status read): drop the memo of any id whose owner
  // extension is now tombstoned so it is neither trusted as registered nor
  // re-registered (the scan filter excludes its package), and a later restore
  // retries. Fail-open on a failed status read.
  const memoized = unique.filter((id) => registrationMemo.has(id));
  if (memoized.length > 0) {
    for (const id of await tombstonedSkillIds(memoized)) {
      registrationMemo.delete(id);
      console.info(
        `[cinatra:skills] memoized registration for "${id}" dropped — its owner extension is retired (tombstoned)`,
      );
    }
  }
  const pending = unique.filter((id) => !registrationMemo.has(id));

  if (pending.length > 0) {
    const run = (async () => {
      const exts = await filterRetiredSkillExtensions(await scanSkillExtensions());
      const registeredAll = new Set<string>();
      const packagesDone = new Set<string>();
      for (const ext of exts) {
        if (!allow.has(ext.kind)) continue;
        if (packagesDone.has(ext.pkgDir)) continue;
        const provided = ext.slugs.flatMap((slug) => {
          const reg = safeDeriveSkillRegistration(ext.pkgName, ext.pkgDirName, slug);
          return reg ? [reg.skillId] : [];
        });
        // Register a package only if it provides at least one still-pending id,
        // and register each providing package at most once.
        if (!pending.some((id) => provided.includes(id))) continue;
        packagesDone.add(ext.pkgDir);
        const registered = await registerColocatedWorkspaceSkills({
          pkgDir: ext.pkgDir,
          pkgName: ext.pkgName,
          pkgDirName: ext.pkgDirName,
        });
        for (const id of registered) registeredAll.add(id);
      }
      // Drop the memo for any pending id that did NOT register, so a later call
      // (transient fs/DB failure healed, or extension installed) retries it.
      for (const id of pending) {
        if (registeredAll.has(id)) continue;
        registrationMemo.delete(id);
        console.warn(
          `[cinatra:skills] ensureInstalledSkillsRegistered: no active skill extension ` +
            `registered "${id}" — skill delivery will degrade until the providing extension ` +
            "is installed/fixed",
        );
      }
    })().catch((err) => {
      for (const id of pending) registrationMemo.delete(id);
      console.error(
        "[cinatra:skills] ensureInstalledSkillsRegistered failed:",
        err instanceof Error ? err.message : err,
      );
    });
    // Share the in-flight promise across every pending id (concurrent callers
    // dedupe); the run tail deletes the memo for ids that ultimately failed.
    for (const id of pending) registrationMemo.set(id, run);
  }

  // Settle on every requested id — those just started here AND any that were
  // already in-flight from a concurrent caller.
  return Promise.allSettled(
    unique.map((id) => registrationMemo.get(id) ?? Promise.resolve()),
  ).then(() => undefined);
}

/**
 * Resolve the ON-DISK `SKILL.md` source path of whichever active extension
 * provides `skillId`, or null when none does. Same discovery substrate as
 * {@link ensureInstalledSkillRegistered} (scan + derive + match), but returns
 * the path WITHOUT touching the catalog — for consumers that need a raw disk
 * read as a catalog-unavailable fallback (e.g. the chat runner's system-prompt
 * fallback), replacing per-consumer hardcoded extension path candidates.
 */
export async function resolveInstalledSkillSourcePath(
  skillId: string,
  opts?: { allowKinds?: readonly string[] },
): Promise<string | null> {
  const allow = new Set(opts?.allowKinds ?? DEFAULT_ALLOW_KINDS);
  const exts = await scanSkillExtensions();
  for (const ext of exts) {
    if (!allow.has(ext.kind)) continue;
    for (const slug of ext.slugs) {
      if (safeDeriveSkillRegistration(ext.pkgName, ext.pkgDirName, slug)?.skillId === skillId) {
        return path.join(ext.pkgDir, "skills", slug, "SKILL.md");
      }
    }
  }
  return null;
}

/**
 * Map a stable, package-OWNED capability key (e.g. `blog.generate-ideas`) to
 * the concrete skillId of the active extension declaring it via
 * `cinatra.capabilities`. Returns null when no active extension provides the
 * capability. This is the indirection that lets core name a capability instead
 * of a specific extension/package/skillId.
 *
 * `opts.unique` (fail-closed ambiguity): when true, MORE than one active
 * extension declaring the capability throws instead of returning the first
 * match. First-match is fine for a delivery the user sees and can correct; a
 * capability that feeds an INTERNAL system prompt (e.g.
 * `chat.hitl-prompt-drive`) must never depend on filesystem scan order to
 * pick between two rival providers.
 */
export async function resolveSkillIdForCapability(
  capabilityKey: string,
  opts?: { allowKinds?: readonly string[]; unique?: boolean },
): Promise<string | null> {
  const allow = new Set(opts?.allowKinds ?? DEFAULT_ALLOW_KINDS);
  const exts = await filterRetiredSkillExtensions(await scanSkillExtensions());
  const matches: { pkgName: string; skillId: string }[] = [];
  for (const ext of exts) {
    if (!allow.has(ext.kind)) continue;
    const slug = ext.capabilities[capabilityKey];
    if (!slug) continue;
    const skillId = safeDeriveSkillRegistration(ext.pkgName, ext.pkgDirName, slug)?.skillId;
    if (!skillId) continue;
    if (!opts?.unique) return skillId;
    matches.push({ pkgName: ext.pkgName, skillId });
  }
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new Error(
      `Capability "${capabilityKey}" is declared by ${matches.length} active extensions ` +
        `(${matches.map((m) => m.pkgName).join(", ")}) — refusing an order-dependent pick.`,
    );
  }
  return matches[0].skillId;
}

/**
 * Capability-key prefix that marks an unauthenticated in-CMS widget-chat skill
 * (e.g. `widget-chat.wordpress-content-editor`). The widget SSE stream serves
 * an UNAUTHENTICATED browser embed, so its skill must be resolvable by the
 * roleless internal-model actor with no org/user identity. That read is
 * authorized by a narrow carve-out in `requireResourceAccess`; this prefix is
 * the AUTHORITATIVE source of truth for which skill ids that carve-out covers.
 */
const WIDGET_CHAT_CAPABILITY_PREFIX = "widget-chat.";

/**
 * AUTHORITATIVE predicate: is `skillId` the skill of an ACTIVE extension that
 * declares it under a `widget-chat.*` capability key AND ships a bundled
 * `SKILL.md` for that slug?
 *
 * The auth boundary is the deliberate manifest contract (`cinatra.capabilities`
 * keyed `widget-chat.*`), NOT a string/slug naming convention — an arbitrary
 * workspace skill whose id merely LOOKS like a widget skill is not covered.
 * Scans extensions of BOTH `skill` and `connector` kinds (a widget-chat skill
 * may be co-located in a connector — e.g. WordPress — or in a sibling skill
 * package — e.g. Drupal).
 *
 * FAIL-CLOSED — this feeds an AUTHORIZATION carve-out, so it is stricter than
 * the lazy-registration scan:
 *   - Any scan/IO error ⇒ `false` (deny).
 *   - The matched capability slug MUST be a real co-located skill dir with a
 *     bundled `SKILL.md` (`ext.slugs.includes(slug)`); a manifest pointer alone
 *     is not enough (keeps the invariant "package-bundled widget prompt").
 *   - The owning extension MUST be verifiably live: a tombstoned (archived)
 *     extension is denied, AND a FAILED lifecycle-status read is ALSO denied
 *     (unlike `filterRetiredSkillExtensions`, which is fail-OPEN for the
 *     non-auth registration path). A widget-chat skill resolving for an
 *     unauthenticated embed must never depend on a degraded status store.
 */
export async function isWidgetChatSkillId(skillId: string): Promise<boolean> {
  try {
    const exts = await scanSkillExtensions();
    for (const ext of exts) {
      if (ext.kind !== "skill" && ext.kind !== "connector") continue;
      for (const [capabilityKey, slug] of Object.entries(ext.capabilities)) {
        if (!capabilityKey.startsWith(WIDGET_CHAT_CAPABILITY_PREFIX)) continue;
        if (safeDeriveSkillRegistration(ext.pkgName, ext.pkgDirName, slug)?.skillId !== skillId) {
          continue;
        }
        // The capability must point at a slug that actually ships a bundled
        // SKILL.md (scanSkillExtensions only lists slugs with a SKILL.md).
        if (!ext.slugs.includes(slug)) continue;
        // Fail-CLOSED liveness: a degraded status read denies (does not allow).
        if (await isSkillExtensionLiveFailClosed(ext)) return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Resolve a capability key to its skillId AND ensure that skill's body is in
 * the catalog, returning the skillId. Throws when no active extension provides
 * the capability (a configuration/install error the caller should surface),
 * and — with `opts.unique` — when MORE than one does (fail-closed ambiguity;
 * see `resolveSkillIdForCapability`).
 */
export async function ensureSkillForCapability(
  capabilityKey: string,
  opts?: { allowKinds?: readonly string[]; unique?: boolean },
): Promise<string> {
  const skillId = await resolveSkillIdForCapability(capabilityKey, opts);
  if (!skillId) {
    throw new Error(
      `No active extension provides the skill capability "${capabilityKey}". ` +
        "Install/enable the extension that declares it under cinatra.capabilities.",
    );
  }
  await ensureInstalledSkillRegistered(skillId, opts);
  return skillId;
}

// ---------------------------------------------------------------------------
// Dependency → injection projection (cinatra#2090 S3, epic #2086).
//
// The separation rule says a non-skill extension must not SHIP a skill: the
// bundle moves into its own `kind:"skill"` extension and the producing
// extension DECLARES a dependency edge on it. Nothing consumed that edge at
// runtime — the declared graph drove install closure only — so an extracted
// bundle would simply stop reaching the run.
//
// This is the projection that closes that gap for the extension-mount surface:
// consumer dir slug → its declared skill edge → the RESOLVED provider package's
// single bundle (its on-disk router plus the skillId the catalog knows it by).
// It is deliberately the same filesystem substrate as the rest of this module,
// so an uninstalled/tombstoned provider stops resolving, exactly like every
// other resolver entry point here.
//
// FAIL-CLOSED at every RESOLUTION ambiguity, because the alternative is mounting
// the WRONG instructions into a run:
//   - the consumer dir must resolve to exactly ONE scanned package;
//   - the consumer must be a kind the separation rule actually covers (agent /
//     artifact / connector). A `kind:"skill"` package is a PROVIDER; letting one
//     resolve its own declared edge would chain skill→skill deliveries that no
//     plan text describes;
//   - it must declare exactly ONE `kind:"skill"` edge that is `runtime` AND
//     `required` AND carries the ROLE the calling surface asked for
//     (cinatra#2090 S3 — see `edgeMatchesRole`). Deliberately NARROWER than the
//     install closure's install-blocking predicate (which also admits
//     `install-time`): an install-time edge says "must be present to install",
//     not "deliver these instructions into every run". Zero or several ⇒ null.
//     An edge declared for ANOTHER role is never a fallback: mounting a
//     classifier's rules into a run as instructions to follow, because they
//     were the only skill edge on the package, is exactly the confusion the
//     role vocabulary exists to prevent;
//   - the provider must be a `kind:"skill"` package shipping exactly ONE bundle
//     (the S2 packaging contract) ⇒ otherwise null.
//
// LIFECYCLE liveness is NOT fail-closed here, and the difference matters enough
// to name: this uses `filterRetiredSkillExtensions`, which drops an EXPLICITLY
// tombstoned provider (canonical rows all `archived`) but KEEPS everything when
// the status read itself fails (fail-OPEN), exactly like the registration path
// above. That is deliberate — the surface this feeds is an extension mounting
// its own declared instructions, not an authorization decision, and the
// behaviour it REPLACES (a bundle embedded in the consumer) had no lifecycle
// check at all, so a degraded status store must not newly strip an installed
// extension's own skill. The fail-CLOSED posture belongs to the auth carve-out
// (`isWidgetChatSkillId`), which denies on a degraded read.
//
// The declared VERSION CONSTRAINT is not re-checked here: what is on disk is
// what the install closure resolved and materialized, and this module never
// selects among versions. Version-pinned revision selection belongs to the S4
// injection contract (cinatra#2091), which consumes this projection.
// ---------------------------------------------------------------------------

/** A consumer's declared skill edge, resolved to a concrete bundle. */
export type DeclaredSkillEdgeResolution = {
  /** The PROVIDER package (`@vendor/<slug>-skill`). */
  packageName: string;
  /** The provider's single bundle slug (its `skills/<slug>/` dir name). */
  slug: string;
  /** The canonical catalog id — `deriveSkillRegistration`, one derivation. */
  skillId: string;
  /** Absolute path to the provider's `SKILL.md` router. */
  sourcePath: string;
};

/**
 * Is this edge a RUNTIME skill dependency — the only kind that means "deliver
 * this skill into the run"? Narrower than the closure's install-blocking
 * predicate on purpose (see the block comment above).
 */
function isRuntimeSkillEdge(dep: DeclaredExtensionDependency): boolean {
  return dep.kind === "skill" && dep.requirement === "required" && dep.edgeType === "runtime";
}

/**
 * The EDGE-ROLE selector (cinatra#2090 S3).
 *
 * `null` selects the ROLE-LESS edge — the plain injectable delivery wave 2
 * landed, where the consumer's whole declared bundle is mounted into its own
 * run. A named role (`"matcher"` / `"authoring"`) selects the edge that feeds
 * that specific host surface.
 *
 * The distinction is load-bearing, not cosmetic. Before roles existed the
 * projection matched ANY single runtime skill edge, so an artifact extension
 * that declared exactly one edge — its CLASSIFIER's rules — would have had
 * that classifier prompt mounted into runs as if it were instructions for the
 * model to follow. Selecting by role means each surface reads only the edge
 * that was declared FOR it, and an edge declared for another surface is not a
 * fallback.
 */
function edgeMatchesRole(dep: DeclaredExtensionDependency, role: string | null): boolean {
  return role === null ? dep.role === undefined : dep.role === role;
}

/**
 * The one place a consumer's declared edge is turned into a concrete bundle.
 * Shared by both entry points below; `matchConsumer` is the only thing that
 * differs (directory slug vs package name).
 */
async function resolveDeclaredSkillEdge(
  matchConsumer: (ext: SkillExtensionDescriptor) => boolean,
  role: string | null,
  onScanFailure: "null" | "throw",
): Promise<DeclaredSkillEdgeResolution | null> {
  let exts: SkillExtensionDescriptor[];
  try {
    exts = await filterRetiredSkillExtensions(await scanSkillExtensions());
  } catch (err) {
    // ABSENT vs UNAVAILABLE (cinatra#2090 S3, codex round 2). A clean `null`
    // means "this consumer declares no such edge" — a fact about the
    // declaration. A SCAN FAILURE means the question could not be asked at
    // all, and collapsing the two lets an fs blip look exactly like a
    // deliberate non-declaration. The run-MOUNT surface must never throw, so
    // it asks for `"null"`; the surfaces whose fail-closed policy would be
    // user-visible ask for `"throw"` and fall back on it.
    if (onScanFailure === "throw") throw err;
    return null;
  }

  const consumers = exts.filter(matchConsumer);
  // A bare dir slug cannot disambiguate two vendors shipping the same slug —
  // the same fail-closed rule the bridge's own mount probe applies.
  if (consumers.length !== 1) return null;
  if (!DECLARED_EDGE_CONSUMER_KINDS.has(consumers[0]!.kind)) return null;

  const edges = consumers[0]!.dependencies
    .filter(isRuntimeSkillEdge)
    .filter((dep) => edgeMatchesRole(dep, role));
  if (edges.length !== 1) return null;
  const providerName = edges[0]!.packageName;

  const providers = exts.filter((e) => e.kind === "skill" && e.pkgName === providerName);
  if (providers.length !== 1) return null;
  const provider = providers[0]!;
  // The S2 packaging contract: one `kind:"skill"` extension ships exactly one
  // bundle. Anything else is not a package this projection can mount from.
  if (provider.slugs.length !== 1) return null;
  const slug = provider.slugs[0]!;

  const reg = safeDeriveSkillRegistration(provider.pkgName, provider.pkgDirName, slug);
  if (!reg) return null; // reserved-namespace impostor: never mount from it
  const { packageName, skillId } = reg;
  return {
    packageName,
    slug,
    skillId,
    sourcePath: path.join(provider.pkgDir, "skills", slug, "SKILL.md"),
  };
}

/**
 * The extension kinds the separation rule makes CONSUMERS: the non-skill kinds
 * that used to embed a bundle. A `kind:"skill"` package is a provider, never a
 * consumer, on this surface.
 */
const DECLARED_EDGE_CONSUMER_KINDS: ReadonlySet<string> = new Set([
  "agent",
  "artifact",
  "connector",
]);

/**
 * Resolve the skill bundle a consumer extension DECLARES a dependency on, by
 * the consumer's package DIRECTORY name (the identity the agent runtime and the
 * llm-bridge carry — a bare slug like `web-research-agent`, never a scoped npm
 * name).
 *
 * Returns null — never throws — when the consumer is unknown or ambiguous, when
 * it is not a consumer kind, when it declares no single runtime skill edge, or when the provider is
 * absent/tombstoned/not a one-bundle skill package. A null means "no
 * declared-edge skill for this extension", which every caller treats as
 * "deliver nothing extra", not as an error. A FAILED lifecycle-status read
 * keeps the provider (fail-open — see the block comment above).
 */
export async function resolveDeclaredSkillEdgeForExtensionDir(
  consumerDirName: string,
): Promise<DeclaredSkillEdgeResolution | null> {
  if (typeof consumerDirName !== "string" || consumerDirName.length === 0) return null;
  // ROLE-LESS only: this surface MOUNTS the resolved bundle as instructions the
  // model follows. An edge declared for the classifier (`matcher`) or for the
  // chat's authoring path (`authoring`) is delivered by those surfaces, not
  // here, and must never be mounted into a run as a fallback.
  return resolveDeclaredSkillEdge((e) => e.pkgDirName === consumerDirName, null, "null");
}

/**
 * Resolve the skill bundle a consumer extension declares for ONE named ROLE,
 * by the consumer's npm PACKAGE NAME — the identity the artifact surfaces
 * carry (`matcherManifestRegistry` entries, the artifact manifest view), as
 * opposed to the bare directory slug the agent runtime and llm-bridge carry.
 *
 * This is the trust anchor the matcher/authoring surfaces re-key onto: a skill
 * is honoured because it is the RESOLVED TARGET of the consumer's declared
 * edge for that role, not because it happens to sit in the consumer's own
 * package. Same fail-closed resolution rules as
 * {@link resolveDeclaredSkillEdgeForExtensionDir}, with ONE difference that
 * matters: a `null` return means "this consumer declares no such edge" — a
 * fact about the DECLARATION — while a filesystem-SCAN FAILURE throws. The
 * callers of this function apply a fail-closed policy to `null` (refuse the
 * skill / refuse the emit), and a policy that refuses work must not be
 * triggered by an fs blip that made the question unanswerable. Callers catch
 * the throw and fall back to their pre-cutover behaviour.
 */
export async function resolveDeclaredSkillEdgeForPackage(
  consumerPackageName: string,
  role: "matcher" | "authoring",
): Promise<DeclaredSkillEdgeResolution | null> {
  if (typeof consumerPackageName !== "string" || consumerPackageName.length === 0) return null;
  return resolveDeclaredSkillEdge((e) => e.pkgName === consumerPackageName, role, "throw");
}

// ---------------------------------------------------------------------------
// Superseded chat-namespace retirement (cinatra#2090 S3 fold).
// ---------------------------------------------------------------------------

/**
 * EXACT-ID retirement of superseded extension-registered workspace skills
 * (cinatra#2090 S3 fold). The store is upsert-only for extension registration
 * and `isCustom`-preserving, so a catalog row whose slug was absorbed or
 * renamed by a package consolidation survives forever unless something
 * removes it — and a stale `@cinatra-ai/chat:<old-slug>` row keeps resolving
 * for matching/injection long after its package stopped shipping the bundle.
 *
 * Deliberately NARROW, never a namespace sweep:
 *   - only ids in the caller's EXACT list are touched (never "everything in
 *     the namespace that isn't current" — a user/personal row that happens to
 *     share the namespace must survive);
 *   - a row is only removed when it is NOT personally owned and NOT
 *     agent-bound (`ownerUserId`/`agentId` unset — the shape extension
 *     registration writes);
 *   - disk removal reuses the same lexical + realpath confinement as
 *     `deleteCustomSkill` (nothing outside the store/data roots is deleted).
 *
 * Idempotent: ids with no matching row are skipped silently. Returns the ids
 * actually retired.
 */
export async function retireExtensionSkillsByExactId(
  skillIds: readonly string[],
): Promise<string[]> {
  if (skillIds.length === 0) return [];
  const catalog = await readSkillsCatalog();
  const wanted = new Set(skillIds);
  const toRetire = catalog.skills.filter(
    (skill) =>
      wanted.has(skill.id) &&
      !skill.ownerUserId &&
      !skill.agentId,
  );
  if (toRetire.length === 0) return [];
  const retiredIds = new Set(toRetire.map((s) => s.id));

  replaceSkillCatalogInDatabase({
    skillPackages: catalog.skillPackages,
    skills: catalog.skills.filter((skill) => !retiredIds.has(skill.id)),
  });

  for (const skill of toRetire) {
    const skillDiskDir = skill.sourcePath ? path.dirname(skill.sourcePath) : null;
    if (!skillDiskDir) continue;
    const resolvedSkillDiskDir = path.resolve(skillDiskDir);
    const storeRoot = path.resolve(getSkillStoreRootPath());
    const legacyRoot = path.resolve(getSkillsDataRootPath());
    const insideStore =
      resolvedSkillDiskDir.startsWith(storeRoot + path.sep) &&
      isRealpathContained(resolvedSkillDiskDir, storeRoot);
    const insideLegacy =
      resolvedSkillDiskDir.startsWith(legacyRoot + path.sep) &&
      isRealpathContained(resolvedSkillDiskDir, legacyRoot);
    if (insideStore || insideLegacy) {
      await rm(resolvedSkillDiskDir, { recursive: true, force: true });
    }
  }
  commitSkillChange(
    `skill: retire superseded extension skills (${[...retiredIds].join(", ")})`,
  ).catch(() => undefined);

  try { revalidatePath("/skills"); } catch { /* best-effort: non-RSC contexts (boot/instrumentation) lack the static-generation store */ }

  return [...retiredIds];
}


/**
 * The `@cinatra-ai/chat:<slug>` catalog rows the retired
 * `@cinatra-ai/assistant-skills` pack registered whose slug NO LONGER exists
 * in the successor bundle set. Registration is upsert-only and the store
 * preserves `isCustom` rows, so without an explicit retirement these rows
 * survive the fold and keep resolving (matching, injection, shell mounts)
 * even though no installed package ships their bundle any more.
 *
 * EXACT ids, frozen at the fold: the successor routers keep
 * `chat-assistant-core`, `company-research` and `blog-content` under the same
 * namespace (those ids are NOT here), and `chat-hitl-prompt-drive` moved to
 * the internal package's own namespace (its OLD chat-namespace id IS here).
 * Never widen this to a namespace sweep — see
 * `retireExtensionSkillsByExactId`.
 */
export const RETIRED_CHAT_NAMESPACE_SKILL_IDS = [
  "@cinatra-ai/chat:chat-extension-authoring-core",
  "@cinatra-ai/chat:chat-agent-authoring",
  "@cinatra-ai/chat:chat-workflow-extension-authoring",
  "@cinatra-ai/chat:chat-artifact-extension-authoring",
  "@cinatra-ai/chat:chat-skill-extension-authoring",
  "@cinatra-ai/chat:chat-agent-dispatch",
  "@cinatra-ai/chat:chat-campaign-creation",
  "@cinatra-ai/chat:chat-appointment-schedules",
  "@cinatra-ai/chat:chat-run-polling",
  "@cinatra-ai/chat:chat-create-artifact",
  "@cinatra-ai/chat:chat-workflow-authoring",
  "@cinatra-ai/chat:chat-extension-discovery",
  "@cinatra-ai/chat:create-campaign",
  "@cinatra-ai/chat:create-trigger",
  "@cinatra-ai/chat:chat-hitl-prompt-drive",
] as const;

let retiredSupersededChatSkills: Promise<void> | null = null;

/**
 * Idempotent, memoized-per-process retirement of the superseded
 * chat-namespace rows, run AFTER the successor bundle registers (the caller
 * sequences it). Failures clear the memo so a later turn retries; they never
 * propagate — a failed cleanup must not take down a chat turn.
 */
export function retireSupersededChatSkillsOnce(): Promise<void> {
  if (retiredSupersededChatSkills) return retiredSupersededChatSkills;
  retiredSupersededChatSkills = (async () => {
    const retired = await retireExtensionSkillsByExactId(RETIRED_CHAT_NAMESPACE_SKILL_IDS);
    if (retired.length > 0) {
      console.log(
        `[cinatra:skills] retired ${retired.length} superseded chat skill row(s): ${retired.join(", ")}`,
      );
    }
  })().catch((err) => {
    retiredSupersededChatSkills = null;
    console.warn(
      "[cinatra:skills] superseded chat-skill retirement failed (will retry):",
      err instanceof Error ? err.message : err,
    );
  });
  return retiredSupersededChatSkills;
}

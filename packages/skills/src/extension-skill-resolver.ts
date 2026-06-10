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
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { registerExtensionSkill } from "./register-extension-skill";
import { resolveSkillOwnerPackageCandidates } from "./manifest-identity";

// ---------------------------------------------------------------------------
// Skill-ID derivation (canonical home — re-exported by the dev watcher).
// ---------------------------------------------------------------------------

export type SkillRegistration = { packageName: string; skillId: string };

/**
 * Skill-ID derivation. The chat's `assistant-skills` package is a special
 * case: its skills register under the `@cinatra-ai/chat:` namespace so they
 * stay consistent with the runner's chat skill-ids and the auth-policy
 * carve-out (which matches the `@cinatra-ai/chat:chat-` prefix — a
 * security-sensitive auth boundary + DB row key; do NOT change). Every other
 * skill package uses its own scoped name as the id prefix.
 *
 * The storage path (separate from the skillId namespace) mirrors the on-disk
 * source package path; that mapping lives in `register-extension-skill.ts`.
 */
export function deriveSkillRegistration(
  pkgName: string,
  pkgDirName: string,
  slug: string,
): SkillRegistration {
  if (pkgDirName === "assistant-skills") {
    return { packageName: "@cinatra-ai/chat", skillId: `@cinatra-ai/chat:${slug}` };
  }
  const packageName = pkgName.startsWith("@") ? pkgName : `@${pkgName}`;
  return { packageName, skillId: `${packageName}:${slug}` };
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
    const { packageName, skillId } = deriveSkillRegistration(
      input.pkgName,
      input.pkgDirName,
      slug,
    );
    try {
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

export type SkillExtensionDescriptor = {
  /** Absolute path to the extension package dir. */
  pkgDir: string;
  /** `package.json` name (lifecycle/package identity). */
  pkgName: string;
  /** Directory basename — drives the `deriveSkillRegistration` special-case. */
  pkgDirName: string;
  /** `cinatra.kind`. */
  kind: string;
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
    const { resolveAgentInstallDir } = await import("@cinatra-ai/agents/agent-install-path");
    candidates.push(resolveAgentInstallDir());
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
        let pkgJson: { name?: string; cinatra?: { kind?: string; capabilities?: unknown } };
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
// `@cinatra-ai/agents/agent-install-path` import above — skills must not
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
 * The subset of `skillIds` whose OWNER package is explicitly tombstoned.
 * Owner identity is derived from the skillId's package prefix (`@scope/pkg:slug`)
 * through the same candidate union as the scan filter; the assistant-skills
 * carve-out prefix (`@cinatra-ai/chat`) has no lifecycle rows → kept, by the
 * no-row rule. Fail-open: a failed status read tombstones nothing.
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
        (slug) => deriveSkillRegistration(ext.pkgName, ext.pkgDirName, slug).skillId === skillId,
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
        const provided = ext.slugs.map(
          (slug) => deriveSkillRegistration(ext.pkgName, ext.pkgDirName, slug).skillId,
        );
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
 * Map a stable, package-OWNED capability key (e.g. `blog.generate-ideas`) to
 * the concrete skillId of the active extension declaring it via
 * `cinatra.capabilities`. Returns null when no active extension provides the
 * capability. This is the indirection that lets core name a capability instead
 * of a specific extension/package/skillId.
 */
export async function resolveSkillIdForCapability(
  capabilityKey: string,
  opts?: { allowKinds?: readonly string[] },
): Promise<string | null> {
  const allow = new Set(opts?.allowKinds ?? DEFAULT_ALLOW_KINDS);
  const exts = await filterRetiredSkillExtensions(await scanSkillExtensions());
  for (const ext of exts) {
    if (!allow.has(ext.kind)) continue;
    const slug = ext.capabilities[capabilityKey];
    if (!slug) continue;
    return deriveSkillRegistration(ext.pkgName, ext.pkgDirName, slug).skillId;
  }
  return null;
}

/**
 * Resolve a capability key to its skillId AND ensure that skill's body is in
 * the catalog, returning the skillId. Throws when no active extension provides
 * the capability (a configuration/install error the caller should surface).
 */
export async function ensureSkillForCapability(
  capabilityKey: string,
  opts?: { allowKinds?: readonly string[] },
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

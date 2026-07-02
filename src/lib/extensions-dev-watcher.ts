import "server-only";

// Dev-mode-only hot-reload for the `extensions/` tree.
//
// Boot already scans extensions/<vendor>/<slug>/cinatra/oas.json for agents
// (src/instrumentation.node.ts, dev-gated). This module adds:
//   1. loadAllExtensionPackages() — a per-package loader covering BOTH
//      kinds (agent → ensureAgentPackageFromGitFile; skill → register each
//      SKILL.md). Reused at boot (skill packages) and by the watcher.
//   2. startDevExtensionsWatcher() — a debounced recursive fs.watch that
//      re-runs the loader on any change/add under extensions/ while the
//      dev server runs.
//
// All operations are idempotent (ensureAgentPackageFromGitFile is
// version-guarded; registerExtensionSkill upserts) so a full re-scan
// per settled change is safe. Dev-mode only; never throws into boot.

import { existsSync, realpathSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { watch } from "node:fs";
import path from "node:path";
// The generic-vendor policy boundary is ENFORCED at the connector-load path.
// A
// connector package whose name↔realpath doesn't match, or that escapes
// the extensions root via symlink, is refused recognition.
import {
  checkConnectorRealpathMatch,
  GENERIC_VENDOR_CONNECTOR_NAME_RE,
} from "@cinatra-ai/extensions/connector-handler";
// Re-run the object-registry descriptor bridge when a kind:"artifact"
// extension changes, so a new/edited artifact type
// is picked up live (boot registration is done by registerAllObjectTypes).
import { registerArtifactExtensions } from "@cinatra-ai/objects/register-artifact-extensions";
// The canonical skill-id derivation + co-located-skill
// registration live in `@cinatra-ai/skills` so the dev watcher and the
// generic prod lazy resolver share ONE implementation. Do not re-fork them
// here.
import {
  deriveSkillRegistration,
  registerColocatedWorkspaceSkills,
} from "@cinatra-ai/skills";

/**
 * One-shot lazy registration of a single artifact extension's co-located
 * skill bundle, by package
 * name. The boot/dev extension scan is fire-and-forget, so a first
 * artifact-create right
 * after restart can run the matcher before the owning package's
 * matcher skill is in the catalog. The matcher calls this on a
 * catalog miss for that package, then retries the lookup once.
 *
 * Scans `extensions/<vendor>/<slug>` for the dir whose `package.json`
 * `name` === `packageName` AND `cinatra.kind === "artifact"`, then
 * runs the SAME `registerColocatedWorkspaceSkills` the boot scan
 * uses. Returns the count registered (0 if the package dir cannot be
 * located / has no skills/). Never throws.
 */
export async function registerArtifactExtensionSkillsForPackage(
  packageName: string,
): Promise<number> {
  const extensionsRoot = path.join(
    process.cwd(),
    "extensions",
    "cinatra-ai",
  );
  if (!existsSync(extensionsRoot)) return 0;
  let pkgEntries;
  try {
    pkgEntries = await readdir(extensionsRoot, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of pkgEntries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const pkgDir = path.join(extensionsRoot, entry.name);
    const pkgJsonPath = path.join(pkgDir, "package.json");
    if (!existsSync(pkgJsonPath)) continue;
    let pkgJson: { name?: string; cinatra?: { kind?: string } };
    try {
      pkgJson = JSON.parse(await readFile(pkgJsonPath, "utf8"));
    } catch {
      continue;
    }
    if (pkgJson.name !== packageName) continue;
    if (pkgJson.cinatra?.kind !== "artifact") {
      // The trust anchor requires the skills be owned by an ARTIFACT
      // extension. A name match on a non-artifact package is not a
      // valid matcher-skill source — refuse.
      return 0;
    }
    return (await registerColocatedWorkspaceSkills({
      pkgDir,
      pkgName: pkgJson.name ?? entry.name,
      pkgDirName: entry.name,
    })).length;
  }
  return 0;
}

// Structured load result so callers (boot scan + hot-reload watcher) can emit
// per-package logs at parity across all extension kinds. This keeps `skill`,
// `connector`, and unknown packages observable instead of silent or ambiguous.
type LoadResult = {
  /** True iff an agent package was (re)loaded — drives WayFlow reload. */
  agentChanged: boolean;
  /** What kind the package dir resolved to. `unknown` = no oas.json and
   *  no recognizable `cinatra.kind` in package.json. */
  kind: "agent" | "skill" | "connector" | "artifact" | "workflow" | "unknown";
  /** Number of SKILL.md entries registered (skill kind only). */
  skillsRegistered: number;
  pkgDirName: string;
  // Populated for skill/connector/artifact/workflow kinds (after
  // package.json is parsed) so the boot scan can log per-package lines at
  // parity with the per-agent
  // `[cinatra:extensions:agent] @cinatra-ai/<name> v<version>` lines. Also
  // populated on the post-parse `unknown` fallthrough (malformed
  // `cinatra.kind`) so its log line names the offending package; left
  // undefined on the pre-parse `unknown` returns (no package.json, or
  // unparseable JSON — no name available). All extension-load logs share
  // the unified `[cinatra:extensions:<kind>]` scheme (kind-specific:
  // agent|skill|connector|artifact|workflow|unknown) for kind-bound lines,
  // flat `[cinatra:extensions]` for scan/watcher/generic lines; this is a
  // log-string-only convention (zero behavior change). Agent kind keeps
  // its own internal ensureAgentPackageFromGitFile log (now
  // `[cinatra:extensions:agent]`) and returns before package.json is read,
  // so these stay undefined for the agent kind.
  packageName?: string;
  packageVersion?: string;
};

// Record a dev version (`0.0.0-dev.<sha>` local source) against the canonical
// manifest so the lifecycle UI can render "dev / <sha>" for in-tree edits.
// Idempotent + dev-mode-only (no-op in prod); fail-soft so a recording error
// never breaks the watcher / boot scan. Dynamic import keeps the server-only
// dev-version module out of any non-dev bundle. Called after BOTH loadOnePackage
// sites (whole-tree rescan AND fine-grained file-change reload).
export async function recordDevVersionForLoadedPackage(
  res: { kind: string; packageName?: string | null },
  pkgDir: string,
): Promise<void> {
  if (res.kind === "unknown" || !res.packageName) return;
  try {
    const { recordDevExtensionVersion } = await import(
      "@cinatra-ai/extensions/dev-version"
    );
    await recordDevExtensionVersion(res.packageName, pkgDir, {
      actorSource: "dev-watcher",
    });
  } catch (err) {
    console.warn(
      `[cinatra:extensions] dev-version record skipped (${res.packageName}):`,
      err instanceof Error ? err.message : err,
    );
  }
}

async function loadOnePackage(
  pkgDir: string,
  opts?: { skipAgents?: boolean },
): Promise<LoadResult> {
  const pkgDirName = path.basename(pkgDir);

  // --- agent kind: cinatra/oas.json present → ensureAgentPackageFromGitFile
  const oasPath = path.join(pkgDir, "cinatra", "oas.json");
  if (existsSync(oasPath)) {
    // skipAgents: boot scan in instrumentation.node.ts already
    // runs the dedicated per-agent ensureAgentPackageFromGitFile loop;
    // re-processing the AGENT here would double-process + double-log.
    // The agent-extension SKILL.md walk MUST still run on the boot path
    // (`skipAgents:true`),
    // because the dedicated per-agent boot loop only processes the agent
    // and never registers co-located skills. Restructure: only the
    // `ensureAgentPackageFromGitFile` call is gated by skipAgents; the
    // skill-walk is unconditional so `loadAllSkillPackagesAtBoot()` actually
    // populates the catalog from `kind:"agent"` extensions.
    let agentChanged = false;
    if (!opts?.skipAgents) {
      try {
        const { ensureAgentPackageFromGitFile } = await import(
          "@cinatra-ai/agents"
        );
        // licenseAcknowledged: a live edit to a first-party GPL agent must
        // hot-reload without the copyleft gate (only HONORED for verified
        // first-party in-tree agents — see ensureAgentPackageFromGitFile).
        await ensureAgentPackageFromGitFile({ oasSourcePath: oasPath, licenseAcknowledged: true });
        agentChanged = true;
      } catch (err) {
        console.warn(
          `[cinatra:extensions] agent load skipped (${pkgDirName}):`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    // Per-agent skill ownership: `kind:"agent"` extensions co-locate their
    // methodology skills under `<pkgDir>/skills/<slug>/SKILL.md`.
    // Walk them and register via the same `registerExtensionSkill` path
    // the `kind:"skill"` branch uses below. Fail-soft on missing/malformed
    // package.json or missing skills/ dir (the agent itself already loaded above).
    let agentSkillsRegistered = 0;
    let agentPackageName: string | undefined;
    let agentPackageVersion: string | undefined;
    const agentPkgJsonPath = path.join(pkgDir, "package.json");
    if (existsSync(agentPkgJsonPath)) {
      try {
        const agentPkgJson = JSON.parse(
          await readFile(agentPkgJsonPath, "utf8"),
        ) as { name?: string; version?: string };
        agentPackageName = agentPkgJson.name;
        agentPackageVersion = agentPkgJson.version;
        const agentSkillsRoot = path.join(pkgDir, "skills");
        if (existsSync(agentSkillsRoot)) {
          // Register at `level:"agent"` with `agentId:<owning agent package>`
          // so `resolveForAgent`'s direct-
          // self-match picks the skill up deterministically (no LLM matcher
          // run, no skill_matches row required, no workspace requireResource-
          // Access filtering). Workspace-level registration would only
          // resolve via the batch matcher — empty on a dev-fresh DB.
          const { registerPackageAgentSkill } = await import(
            "@cinatra-ai/skills"
          );
          const owningAgentId = agentPkgJson.name ?? pkgDirName;
          const agentSlugEntries = await readdir(agentSkillsRoot, {
            withFileTypes: true,
          });
          for (const slugEntry of agentSlugEntries) {
            if (!slugEntry.isDirectory()) continue;
            const slug = slugEntry.name;
            const skillMdPath = path.join(agentSkillsRoot, slug, "SKILL.md");
            if (!existsSync(skillMdPath)) continue;
            const { packageName, skillId } = deriveSkillRegistration(
              owningAgentId,
              pkgDirName,
              slug,
            );
            try {
              await registerPackageAgentSkill({
                skillId,
                packageName,
                skillMdPath,
                agentId: owningAgentId,
              });
              agentSkillsRegistered += 1;
            } catch (err) {
              console.warn(
                `[cinatra:extensions] agent-skill register skipped (${pkgDirName}/${slug}):`,
                err instanceof Error ? err.message : err,
              );
            }
          }
        }
      } catch {
        // Malformed package.json: log nothing extra (the agent itself
        // already loaded); just skip skill registration.
      }
    }
    return {
      agentChanged,
      kind: "agent",
      skillsRegistered: agentSkillsRegistered,
      pkgDirName,
      packageName: agentPackageName,
      packageVersion: agentPackageVersion,
    };
  }

  const pkgJsonPath = path.join(pkgDir, "package.json");
  if (!existsSync(pkgJsonPath))
    return { agentChanged: false, kind: "unknown", skillsRegistered: 0, pkgDirName };
  let pkgJson: { name?: string; version?: string; cinatra?: { kind?: string } };
  try {
    pkgJson = JSON.parse(await readFile(pkgJsonPath, "utf8"));
  } catch {
    return { agentChanged: false, kind: "unknown", skillsRegistered: 0, pkgDirName };
  }

  // --- connector kind: workspace-compiled. There is no runtime
  //     (re)load step — connectors self-bind from `register(ctx)` against the
  //     host services published at boot
  //     (src/lib/register-host-connector-services.ts). Identify it explicitly
  //     so the watcher can log a truthful "no-op, restart to apply" instead
  //     of a misleading "reloaded".
  if (pkgJson.cinatra?.kind === "connector") {
    // Enforce the generic-vendor policy boundary at the load path. pkgDir is
    // `<extensionsRoot>/<vendor>/<slug>`; the package name must be a
    // well-formed `@<vendor>/<slug>-connector` AND its realpath must
    // resolve to exactly that location under realpath(extensionsRoot)
    // (rejects symlink-escape + name↔path mismatch). A failing connector
    // is refused recognition (logged + treated as "unknown") so a
    // mis-placed / symlinked package can never be wired as a live
    // connector. Default visibility is `admin` unless the package
    // explicitly opts into `cinatra.visibility:"workspace"`.
    const pkgName = typeof pkgJson.name === "string" ? pkgJson.name : "";
    let f1: { valid: true } | { valid: false; reason: string } = {
      valid: false,
      reason: "not evaluated",
    };
    try {
      const extensionsRootRealpath = realpathSync(
        path.dirname(path.dirname(pkgDir)),
      );
      const packageRealpath = realpathSync(pkgDir);
      f1 = !GENERIC_VENDOR_CONNECTOR_NAME_RE.test(pkgName)
        ? {
            valid: false,
            reason: `package name "${pkgName}" fails the generic-vendor regex`,
          }
        : checkConnectorRealpathMatch({
            packageName: pkgName,
            packageRealpath,
            extensionsRootRealpath,
          });
    } catch (err) {
      f1 = {
        valid: false,
        reason: `realpath resolution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!f1.valid) {
      console.warn(
        `[cinatra:extensions:connector] REFUSED "${pkgName || pkgDirName}" — ` +
          `generic-vendor policy boundary violation: ${f1.reason}. ` +
          `Connector NOT recognized.`,
      );
      return {
        agentChanged: false,
        kind: "unknown",
        skillsRegistered: 0,
        pkgDirName,
        packageName: pkgJson.name,
        packageVersion: pkgJson.version,
      };
    }
    return {
      agentChanged: false,
      kind: "connector",
      skillsRegistered: 0,
      pkgDirName,
      packageName: pkgJson.name,
      packageVersion: pkgJson.version,
    };
  }

  // --- artifact kind: metadata-only extension. No
  //     (re)load step here — the descriptor is registered by the
  //     object-registry bridge at boot. Identify it explicitly so the
  //     watcher logs a truthful "descriptor (re)registered" line instead of
  //     falling through to "unknown".
  if (pkgJson.cinatra?.kind === "artifact") {
    // An artifact extension's auditor-pattern skill bundle
    // (matchers/authoring/validators/enrichers) ships
    // co-located under `skills/<slug>/SKILL.md`, IDENTICAL layout to a
    // skill-kind package. Without this registration, the matcher runtime
    // has nothing to resolve and package-owned trust rejects every
    // artifact-owned matcher. The descriptor itself is still registered
    // separately by the object-registry bridge at boot — this only adds the
    // skill-catalog registration the bundle needs.
    const skillsRegistered = (await registerColocatedWorkspaceSkills({
      pkgDir,
      pkgName: pkgJson.name ?? pkgDirName,
      pkgDirName,
    })).length;
    return {
      agentChanged: false,
      kind: "artifact",
      skillsRegistered,
      pkgDirName,
      packageName: pkgJson.name,
      packageVersion: pkgJson.version,
    };
  }

  // --- workflow kind: declarative marketplace template. Like the
  //     connector kind, there is no scanner-side install step here —
  //     workflow templates are handled by the workflow marketplace
  //     install path (`installWorkflowTemplate` in
  //     `packages/workflows/src/extension-ops.ts`). Identify it
  //     explicitly so the watcher logs a truthful "no-op, install via
  //     marketplace" line instead of falling through to "unknown".
  if (pkgJson.cinatra?.kind === "workflow") {
    return {
      agentChanged: false,
      kind: "workflow",
      skillsRegistered: 0,
      pkgDirName,
      packageName: pkgJson.name,
      packageVersion: pkgJson.version,
    };
  }

  // --- skill kind: package.json cinatra.kind === "skill" → register each
  //     skills/<slug>/SKILL.md into the catalog.
  if (pkgJson.cinatra?.kind !== "skill")
    return {
      agentChanged: false,
      kind: "unknown",
      skillsRegistered: 0,
      pkgDirName,
      packageName: pkgJson.name,
      packageVersion: pkgJson.version,
    };

  // The skill-walk loop uses the shared `registerColocatedWorkspaceSkills`
  // helper so the artifact branch can reuse the same registration path.
  // Missing/unreadable `skills/` ⇒ 0, fail-soft per skill.
  const skillsRegistered = (await registerColocatedWorkspaceSkills({
    pkgDir,
    pkgName: pkgJson.name ?? pkgDirName,
    pkgDirName,
  })).length;
  return {
    agentChanged: false,
    kind: "skill",
    skillsRegistered,
    pkgDirName,
    packageName: pkgJson.name,
    packageVersion: pkgJson.version,
  };
}

/**
 * Test-only export of the per-package loader. Lets the unit test drive the
 * `kind:"artifact"` branch against a temp
 * fixture dir without standing up the full boot scan. Production paths
 * call `loadAllExtensionPackages` / the watcher, not this.
 */
export const __loadOnePackageForTests = loadOnePackage;

/**
 * Walk every extensions/<vendor>/<slug> package and (re)load it. Idempotent.
 * Returns whether any agent package was (re)loaded so the caller can
 * coalesce a single WayFlow reload.
 */
// Multi-scope discovery contract.
//
// This loader walks `extensions/<vendor>/<pkg>/` GENERICALLY: every
// top-level entry under `extensions/` is treated as a vendor scope.
// Existing precedent: a private in-tree generic-vendor connector under `extensions/<vendor>/` and
// `extensions/anthropics/` for the vendored `@anthropics/skills` bundle.
// Do NOT special-case any scope — the scope-policy gate runs in tests, not here. Adding a new
// vendored bundle is a 0-line change in this loader.
//
// See packages/extensions/src/__tests__/naming-conformance.test.ts for
// the scope-policy enforcement and packages/extensions/__tests__/
// loader-vendor-scope.test.ts for the fixture test that proves a
// fixture extensions/anthropics/skills/ dir mounts correctly.
export async function loadAllExtensionPackages(
  extensionsRoot: string,
  opts?: { skipAgents?: boolean },
): Promise<{ agentChanged: boolean }> {
  let agentChanged = false;
  if (!existsSync(extensionsRoot)) return { agentChanged };
  let vendorEntries;
  try {
    vendorEntries = await readdir(extensionsRoot, { withFileTypes: true });
  } catch {
    return { agentChanged };
  }
  // Aggregate per-kind tallies so the boot scan logs one
  // summary line covering skill + connector kinds at parity with the
  // per-agent `[cinatra:extensions:agent]` lines.
  let skillPkgs = 0;
  let skillsRegistered = 0;
  let connectorPkgs = 0;
  let artifactPkgs = 0;
  let workflowPkgs = 0;
  for (const vendorEntry of vendorEntries) {
    if (!vendorEntry.isDirectory()) continue;
    if (vendorEntry.name === "node_modules" || vendorEntry.name.startsWith("."))
      continue;
    const vendorDir = path.join(extensionsRoot, vendorEntry.name);
    let pkgEntries;
    try {
      pkgEntries = await readdir(vendorDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const pkgEntry of pkgEntries) {
      if (!pkgEntry.isDirectory()) continue;
      const pkgDir = path.join(vendorDir, pkgEntry.name);
      const res = await loadOnePackage(pkgDir, opts);
      if (res.agentChanged) agentChanged = true;
      // Record a dev version so the lifecycle UI can render "dev / <sha>" for
      // in-tree edits (fail-soft, dev-only, idempotent — see helper).
      await recordDevVersionForLoadedPackage(res, pkgDir);
      // Emit one per-package line for skill + connector kinds,
      // at visual parity with the per-agent
      // `[cinatra:extensions:agent] @cinatra-ai/<name> v<version>` lines
      // (agent kind keeps its own internal log; unknown kind is silent). The
      // aggregate summary console.info below is intentionally retained.
      if (res.kind === "skill") {
        skillPkgs += 1;
        skillsRegistered += res.skillsRegistered;
        console.info(
          `[cinatra:extensions:skill] ${res.packageName ?? res.pkgDirName} ` +
            `v${res.packageVersion ?? "?"} — ${res.skillsRegistered} SKILL.md registered`,
        );
      } else if (res.kind === "connector") {
        connectorPkgs += 1;
        console.info(
          `[cinatra:extensions:connector] ${res.packageName ?? res.pkgDirName} ` +
            `v${res.packageVersion ?? "?"} — connector (workspace-compiled; ` +
            `wired against register-host-connector-services at boot, not by this scan)`,
        );
      } else if (res.kind === "artifact") {
        artifactPkgs += 1;
        // Artifact extensions also register their co-located auditor-pattern
        // skill bundle
        // (matchers/authoring/validators/enrichers). The descriptor is
        // still registered separately by the object-registry bridge.
        skillsRegistered += res.skillsRegistered;
        console.info(
          `[cinatra:extensions:artifact] ${res.packageName ?? res.pkgDirName} ` +
            `v${res.packageVersion ?? "?"} — artifact type (descriptor via ` +
            `object-registry bridge; ${res.skillsRegistered} co-located ` +
            `SKILL.md registered)`,
        );
      } else if (res.kind === "workflow") {
        workflowPkgs += 1;
        console.info(
          `[cinatra:extensions:workflow] ${res.packageName ?? res.pkgDirName} ` +
            `v${res.packageVersion ?? "?"} — workflow template (handled by the ` +
            `workflow marketplace install path / installWorkflowTemplate, not by this scan)`,
        );
        // Safety net: unknown-kind packages are logged so mis-declared
        // packages are visible. packageName/packageVersion may be undefined
        // when no package.json exists — the ?? fallbacks handle that.
      } else if (res.kind === "unknown") {
        console.info(
          `[cinatra:extensions:unknown] ${res.packageName ?? res.pkgDirName} v${res.packageVersion ?? "?"} — unrecognized extension kind (no cinatra/oas.json, missing or unrecognized cinatra.kind in package.json)`,
        );
      }
    }
  }
  // This fires once per call — boot AND each watcher whole-tree fallback
  // rescan — so the label is "scan", not "boot scan".
  console.info(
    `[cinatra:extensions] scan: ${skillsRegistered} skill(s) registered ` +
      `from ${skillPkgs} skill package(s) + ${artifactPkgs} ` +
      `artifact-type package(s) (artifact descriptors via object-registry ` +
      `bridge; their co-located auditor-pattern skill bundles registered ` +
      `into the catalog); ${connectorPkgs} connector ` +
      `package(s) present (workspace-compiled — wired by ` +
      `register-host-connector-services at boot, not by this scan); ` +
      `${workflowPkgs} workflow template(s) present (handled by the ` +
      `workflow marketplace install path / installWorkflowTemplate, not by this scan).`,
  );

  // Surface a dev-boot diagnostic when an app-root declared vendoredSkillBundle's
  // destination is missing on disk. Cold checkouts that ran `pnpm install`
  // WITHOUT `CINATRA_RUNTIME_MODE=development` skip the postinstall fetch,
  // and the bundle simply isn't there. The scan summary above would then
  // under-count by exactly that bundle's skill count, with no obvious
  // signal pointing the operator at the cause.
  try {
    const appRootPkgJsonPath = path.join(extensionsRoot, "..", "package.json");
    if (existsSync(appRootPkgJsonPath)) {
      const appRootPkg = JSON.parse(await readFile(appRootPkgJsonPath, "utf8")) as {
        cinatra?: { vendoredSkillBundles?: Array<{ packageName?: string; destination?: string }> };
      };
      const bundles = appRootPkg.cinatra?.vendoredSkillBundles ?? [];
      const missing = bundles.filter((b) => {
        if (typeof b?.destination !== "string") return false;
        const destAbs = path.join(extensionsRoot, "..", b.destination);
        return !existsSync(destAbs);
      });
      if (missing.length > 0) {
        const names = missing.map((b) => b.packageName ?? "<unknown>").join(", ");
        console.warn(
          `[cinatra:extensions] WARNING: ${missing.length} vendoredSkillBundle(s) declared in package.json ` +
            `but missing on disk: ${names}. ` +
            `Run \`CINATRA_RUNTIME_MODE=development pnpm vendor:skills\` to fetch them, ` +
            `or re-run \`pnpm install\` with the env var set so the postinstall hook fires.`,
        );
      }
    }
  } catch {
    // best-effort diagnostic — never block boot on a parse hiccup.
  }

  return { agentChanged };
}

/**
 * Dev-mode-only: load all SKILL-kind extension packages at boot so the
 * skills library is populated on restart/start (not only lazily on the
 * first chat turn). Agent packages are handled by the existing boot scan
 * in instrumentation.node.ts.
 */
export async function loadAllSkillPackagesAtBoot(
  extensionsRoot: string,
): Promise<void> {
  if (process.env.CINATRA_RUNTIME_MODE !== "development") return;
  try {
    // skipAgents: this boot wrapper is SKILL-only by contract (see docstring);
    // agents are handled by instrumentation.node.ts. Suppressing the agent
    // branch here removes the duplicate boot agent block.
    await loadAllExtensionPackages(extensionsRoot, { skipAgents: true });
  } catch (err) {
    console.warn(
      "[cinatra:extensions] boot skill load skipped:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Dev-mode-only recursive watcher: re-runs ONLY the per-package loader for
 * the extension whose file changed (debounced 500ms; coalesced). The
 * `<vendor>/<slug>` segments are parsed from the `fs.watch` `filename`
 * (relative-path under `extensionsRoot`). If `filename` is unusable
 * (rename without final name, or top-level change), we fall back to a
 * whole-tree rescan. Otherwise only the changed extension is loaded freshly.
 */
export function startDevExtensionsWatcher(extensionsRoot: string): void {
  if (process.env.CINATRA_RUNTIME_MODE !== "development") return;
  if (!existsSync(extensionsRoot)) return;

  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let rerun = false;
  // Pending set of "<vendor>/<slug>" packages to reload on next debounce
  // settle. Special sentinel "*" forces a whole-tree rescan when we can't
  // identify the specific package (e.g. ambiguous rename event).
  const pending = new Set<string>();

  const runSettled = async () => {
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    const targets = Array.from(pending);
    pending.clear();
    try {
      let agentChanged = false;
      if (targets.length === 0 || targets.includes("*")) {
        const res = await loadAllExtensionPackages(extensionsRoot);
        agentChanged = res.agentChanged;
        console.info(
          `[cinatra:extensions] reloaded all packages (whole-tree rescan)`,
        );
      } else {
        for (const vendorSlug of targets) {
          const pkgDir = path.join(extensionsRoot, vendorSlug);
          if (!existsSync(pkgDir)) {
            console.info(
              `[cinatra:extensions] reloaded ${vendorSlug} skipped (dir absent — likely deleted)`,
            );
            continue;
          }
          const res = await loadOnePackage(pkgDir);
          if (res.agentChanged) agentChanged = true;
          // Record the dev version on the fine-grained reload path too (the
          // common in-editor case), not just the whole-tree rescan.
          await recordDevVersionForLoadedPackage(res, pkgDir);
          // Log what actually happened, per kind. An unconditional
          // "reloaded <pkg>" is misleading for connector dirs
          // (loadOnePackage no-ops them) and uninformative for skill dirs
          // (it doesn't say how many SKILL.md entries re-registered).
          if (res.kind === "agent") {
            console.info(
              `[cinatra:extensions:agent] reloaded ${vendorSlug} (agent — WayFlow reload follows)`,
            );
          } else if (res.kind === "skill") {
            console.info(
              `[cinatra:extensions:skill] reloaded ${vendorSlug} (skill — ${res.skillsRegistered} SKILL.md re-registered)`,
            );
          } else if (res.kind === "connector") {
            console.info(
              `[cinatra:extensions:connector] ${vendorSlug} changed (connector — workspace-compiled; ` +
                `restart \`pnpm dev\` to apply, no live reload)`,
            );
          } else if (res.kind === "artifact") {
            const n = registerArtifactExtensions(extensionsRoot);
            console.info(
              `[cinatra:extensions:artifact] ${vendorSlug} changed (artifact type — ` +
                `object-registry bridge re-ran; ${n} artifact type(s) registered)`,
            );
          } else if (res.kind === "workflow") {
            console.info(
              `[cinatra:extensions:workflow] ${vendorSlug} changed (workflow template — ` +
                `handled by the workflow marketplace install path / installWorkflowTemplate, no live reload)`,
            );
          } else {
            console.info(
              `[cinatra:extensions:unknown] ${vendorSlug} changed (unrecognized extension kind — nothing to reload)`,
            );
          }
        }
      }
      if (agentChanged) {
        const { triggerWayflowReload } = await import("@cinatra-ai/agents");
        await triggerWayflowReload();
      }
    } catch (err) {
      console.warn(
        "[cinatra:extensions] hot reload skipped:",
        err instanceof Error ? err.message : err,
      );
    } finally {
      running = false;
      if (rerun) {
        rerun = false;
        schedule();
      }
    }
  };

  const schedule = (changedRelPath?: string) => {
    // Try to identify the specific <vendor>/<slug> package the change belongs
    // to. If we can't (rename without name, top-level change, etc.), mark
    // "*" to force a whole-tree rescan on the settle.
    if (!changedRelPath) {
      pending.add("*");
    } else {
      const parts = changedRelPath.split(path.sep);
      if (
        parts.length >= 2 &&
        parts[0] &&
        parts[1] &&
        !parts[0].startsWith(".") &&
        parts[0] !== "node_modules"
      ) {
        pending.add(`${parts[0]}/${parts[1]}`);
      } else {
        pending.add("*");
      }
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void runSettled(), 500);
  };

  try {
    const watcher = watch(
      extensionsRoot,
      { recursive: true },
      (_event, filename) => {
        if (
          filename &&
          (filename.includes("node_modules") || filename.includes(".git"))
        )
          return;
        schedule(filename ?? undefined);
      },
    );
    watcher.on("error", (err) =>
      console.warn("[cinatra:extensions] watcher error:", err),
    );
    console.info(
      `[cinatra:extensions] watching ${extensionsRoot} for live reload (dev mode; per-package fine-grained reload)`,
    );
  } catch (err) {
    console.warn(
      "[cinatra:extensions] watcher unavailable:",
      err instanceof Error ? err.message : err,
    );
  }
}

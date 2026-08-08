// Pure Node.js module — no "use server". Safe to import from instrumentation.node.ts.
// Reads a system-provided agent ZIP from data/downloads/, injects the
// packageName/packageVersion via a synthetic sibling package.json (NOT into
// agent.json — the compiler reads identity from the sibling package.json), and
// upserts the template via importAgentTemplate. The git-file loader
// (ensureAgentPackageFromGitFile) resolves the version solely from the sibling
// package.json#version.

import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import * as semver from "semver";
import { readAgentTemplateByPackageName, setAgentTemplatePackageName } from "./store";
import {
  normalizeLifecycle,
  serializeLifecycleConfig,
} from "@/lib/lifecycle/lifecycle-policy";
import { isReservedWorkspaceSlug } from "./reserved-workspace-slugs";
import { readZipFiles, createZipBuffer } from "./zip-helpers";
import { importAgentTemplateCore } from "./import-agent-core";

// ---------------------------------------------------------------------------
// "already up to date" REQUIRES a live install record (cinatra#2536).
//
// The version-skip guards below compare the loader's manifest version against
// `agent_templates.package_version`. That comparison says NOTHING about
// `installed_extension` — a reset/reinstall (or a producer whose artifact was
// never pulled into the install closure, cinatra#2537) can leave the template
// row current while the canonical install record is ABSENT. The importer then
// reports "already up to date" forever, the package loads and is runnable, and
// every artifact-producing run fails materialization because no install record
// means no `artifact_type_claims` row.
//
// So the skip now ALSO requires the record. An ABSENT record is repaired
// (idempotently) and the package is RE-IMPORTED at the same version; a
// deliberately archived record, an unreadable store, or an unverifiable source
// keeps the skip (never a per-boot re-import loop) and is SURFACED instead of
// being reported as "up to date".
//
// COST: one indexed canonical-store read per version-matched package per boot
// (the previous skip did zero DB work). That is the price of the guarantee —
// the whole defect is that the loader asserted an install state it never read
// — and it is paid on a detached boot scan, never on a request path. The
// REPAIR write happens at most once per broken package.
// ---------------------------------------------------------------------------

/** The heal seam — injectable so unit tests drive the decision without a DB. */
export type InstallRecordHealFn = (input: {
  packageName: string;
  kind: "agent";
  packageDir?: string;
  version?: string;
}) => Promise<{ outcome: string; rowId?: string; reason?: string }>;

async function defaultHealInstallRecord(input: {
  packageName: string;
  kind: "agent";
  packageDir?: string;
  version?: string;
}): Promise<{ outcome: string; rowId?: string; reason?: string }> {
  const { healMissingInstallRecord } = await import("@/lib/extension-install-record-heal");
  return healMissingInstallRecord(input);
}

type InstallRecordGateVerdict = {
  /** Re-import at the same version — ONLY after an actual repair. */
  reImport: boolean;
  /** Is the package install-active? Gates the "already up to date" line. */
  recordLive: boolean;
  outcome: string;
  reason?: string;
};

/**
 * Decide whether a version-matched package may be reported "already up to
 * date". Returns the heal outcome so the caller can log the TRUTH.
 *
 * `reImport` is true ONLY when the repair actually created the missing record —
 * the one case where re-importing at the same version is both meaningful and
 * self-limiting (the next boot finds the record and skips again).
 *
 * `recordLive` is separate on purpose (codex round 1): a refused/failed repair
 * must NOT re-import (that would loop every boot) AND must NOT be reported as
 * "already up to date" (that is the misleading signal this whole issue is
 * about). Those two are different questions and the caller answers both.
 */
async function installRecordGate(
  packageName: string,
  packageDir: string | undefined,
  packageVersion: string | undefined,
  heal: InstallRecordHealFn,
): Promise<InstallRecordGateVerdict> {
  let result: { outcome: string; rowId?: string; reason?: string };
  try {
    result = await heal({ packageName, kind: "agent", packageDir, version: packageVersion });
  } catch (err) {
    // The heal is non-throwing by contract; a thrown error is still never
    // allowed to break a boot importer. Keep the skip, report the truth.
    return {
      reImport: false,
      recordLive: false,
      outcome: "failed",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  return {
    reImport: result.outcome === "repaired",
    recordLive: result.outcome === "already-live" || result.outcome === "repaired",
    outcome: result.outcome,
    reason: result.reason,
  };
}

/** One truthful line per non-healthy install-record state. */
function logInstallRecordState(
  packageName: string,
  packageVersion: string | undefined,
  gate: InstallRecordGateVerdict,
): void {
  if (gate.outcome === "already-live") return;
  const v = `v${packageVersion ?? "unknown"}`;
  if (gate.outcome === "repaired") {
    console.info(
      `[cinatra:extensions:agent] ${packageName} ${v} re-importing at the same version — its canonical ` +
        `installed_extension record was ABSENT and has been repaired; "already up to date" requires a live ` +
        `install record (cinatra#2536)`,
    );
    return;
  }
  console.warn(
    `[cinatra:extensions:agent] ${packageName} ${v} loads but is NOT install-active — ` +
      `${gate.reason ?? gate.outcome}. Its artifact_type_claims will not seed, so every artifact-producing ` +
      `run will fail to materialize until the install record is restored (cinatra#2536).`,
  );
}

export async function ensureAgentPackage(opts: {
  zipFileName: string;
  packageName: string;
  packageVersion?: string;
  name?: string;
  /** Test seam — see `InstallRecordHealFn`. */
  healInstallRecord?: InstallRecordHealFn;
}): Promise<{ templateId: string; upserted: boolean; skipped: boolean }> {
  // --- Version-skip guard ---
  // Avoid redundant DB writes on every restart when the version is already current.
  const existing = await readAgentTemplateByPackageName(opts.packageName);
  if (existing && existing.packageVersion === opts.packageVersion) {
    // …but a version match alone is NOT "already up to date" (cinatra#2536).
    // This system-ZIP path carries no on-disk package dir, so the repair cannot
    // PROVE the package's identity and refuses to mint a row — the gate still
    // runs, so an absent/archived record is SURFACED here instead of being
    // silently reported as healthy. (The git-file loader below owns the actual
    // repair; that is the boot path the issue's instance runs.)
    const gate = await installRecordGate(
      opts.packageName,
      undefined,
      opts.packageVersion,
      opts.healInstallRecord ?? defaultHealInstallRecord,
    );
    logInstallRecordState(opts.packageName, opts.packageVersion, gate);
    if (!gate.reImport) {
      // "already up to date" is claimed ONLY for a package that really is
      // install-active; a refused/failed record already logged the truth above
      // and must not be contradicted here (codex round 1).
      if (gate.recordLive) {
        console.info(
          `[ensureAgentPackage] ${opts.packageName} v${opts.packageVersion ?? "unknown"} skipped — already up to date`,
        );
      }
      return { templateId: existing.id, upserted: false, skipped: true };
    }
  }

  // --- Read ZIP from data/downloads/ (server-controlled path) ---
  const zipPath = join(process.cwd(), "data", "downloads", opts.zipFileName);
  const zipBuf = await readFile(zipPath);

  // --- Inject packageName/packageVersion via a synthetic package.json ---
  // packageName / packageVersion live in package.json, not agent.json;
  // the OAS compiler reads them from the sibling package.json. If the input ZIP
  // doesn't already carry a package.json, synthesize one from opts.
  const files = readZipFiles(zipBuf);
  const agentRaw = files.get("agent.json");
  if (!agentRaw) {
    throw new Error(`[ensureAgentPackage] ${opts.zipFileName}: agent.json not found in ZIP`);
  }

  const agentJson = JSON.parse(agentRaw) as Record<string, unknown>;
  if (opts.name !== undefined) agentJson.name = opts.name;

  const syntheticPackageJson = JSON.stringify(
    { name: opts.packageName, version: opts.packageVersion },
    null,
    2,
  );

  // Rebuild ZIP — keep every non-agent.json / non-package.json file verbatim;
  // inject the synthetic package.json and the (possibly renamed) agent.json.
  const allFiles: { name: string; content: string }[] = [];
  let packageJsonInjected = false;
  // Did the ZIP carry a REAL, parseable author manifest — or is the
  // `package.json` the importer will read one WE synthesized? (cinatra#2044 GAP 2,
  // codex round 2.) Only the first speaks for the author's `cinatra.lifecycle`;
  // a synthesized `{name, version}` carries none for reasons that have nothing to
  // do with intent, and must never be projected as an explicit CLEAR over an
  // installed row. Same rule `ensureAgentPackageFromGitFile` applies to its own
  // synthesis below.
  let authorManifestPresent = false;
  for (const [fileName, content] of files.entries()) {
    if (fileName === "agent.json") {
      allFiles.push({ name: fileName, content: JSON.stringify(agentJson, null, 2) });
    } else if (fileName === "package.json") {
      // Prefer opts' packageName/packageVersion but keep any extra metadata.
      try {
        const parsed = JSON.parse(content) as Record<string, unknown>;
        parsed.name = opts.packageName;
        if (opts.packageVersion !== undefined) parsed.version = opts.packageVersion;
        allFiles.push({ name: fileName, content: JSON.stringify(parsed, null, 2) });
        // The author's own manifest, carried through with its cinatra block (and
        // so its lifecycle declaration) intact — authoritative.
        authorManifestPresent = true;
      } catch {
        // Unparseable: REPLACED by our synthesis, which declares nothing.
        allFiles.push({ name: fileName, content: syntheticPackageJson });
      }
      packageJsonInjected = true;
    } else {
      allFiles.push({ name: fileName, content });
    }
  }
  if (!packageJsonInjected) {
    // No manifest in the ZIP at all — likewise our synthesis, not the author's.
    allFiles.push({ name: "package.json", content: syntheticPackageJson });
  }
  const modifiedZip = createZipBuffer(allFiles);
  const modifiedBase64 = modifiedZip.toString("base64");

  // --- Delegate to importAgentTemplate (handles upsert-by-packageName internally) ---
  const result = await importAgentTemplateCore(modifiedBase64, opts.name, {
    redirect: false,
    lifecycleDeclarationAuthoritative: authorManifestPresent,
  });

  // --- Set packageName identity (idempotent one-time write) ---
  // setAgentTemplatePackageName guards with WHERE package_name IS NULL, so calling it
  // again on restart is safe — it is a no-op if the identity is already established.
  await setAgentTemplatePackageName(result.templateId, opts.packageName, opts.packageVersion);

  // --- Startup diagnostics logging ---
  console.info(
    `[ensureAgentPackage] ${opts.packageName} v${opts.packageVersion ?? "unknown"} upserted`,
  );

  return { templateId: result.templateId, upserted: result.upserted, skipped: false };
}

// ---------------------------------------------------------------------------
// Sibling package.json fallback
// ---------------------------------------------------------------------------
// When agents/<slug>/cinatra/oas.json lacks top-level metadata.cinatra.packageName,
// derive packageName/packageVersion from the workspace package.json one level up
// (agents/<slug>/package.json). That file is the source of truth for workspace
// packages and already carries the canonical @cinatra/<slug> name.
//
// The result is DISCRIMINATED, because "there is no sibling manifest" and "there
// is one but it could not be read" must not be conflated (cinatra#2044 GAP 2).
// The synthesized ZIP's `package.json` is AUTHORITATIVE at the persistence hop:
// a manifest present in the ZIP that declares no `cinatra.lifecycle` CLEARS
// `agent_templates.lifecycle_config`. So an unreadable sibling must never be
// flattened into a hollow-but-well-formed synthesized manifest — that would let
// one truncated write or a transient EACCES during a boot scan silently erase a
// real `repairCapable` declaration and send every subsequent repair back to
// `human_escalation`. `absent` is different and honest: with genuinely no
// sibling manifest the git-file source declares nothing, and null is correct.
type SiblingIdentity = {
  name?: string;
  version?: string;
  description?: string;
  license?: string;
  agentDependencies?: Record<string, string>;
  type?: string;
  produces?: unknown[];
  lifecycle?: unknown;
};
type SiblingRead =
  | { status: "ok"; identity: SiblingIdentity }
  /** No `package.json` beside the agent, on either supported layout (ENOENT). */
  | { status: "absent" }
  /** Present but unusable — EACCES, a truncated/invalid JSON body, etc. */
  | { status: "unreadable"; reason: string };

// The manifest location is DERIVED FROM THE LAYOUT, never guessed. Both shapes
// the dev-boot scan (src/lib/boot/phases/dev-boot.ts) hands this loader are
// distinguishable from the OAS path alone:
//   agents/<slug>/cinatra/{oas,agent}.json -> ../package.json  (canonical)
//   agents/<slug>/agent.json               -> ./package.json   (legacy flat,
//                                                               dev-boot.ts:150)
//
// Resolving to ONE path rather than probing a candidate LIST is deliberate
// (codex round 1). A list ordered [parent, adjacent] is ambiguous in both
// directions: for the flat layout the parent candidate is an unrelated
// VENDOR-level `package.json` (e.g. `extensions/<vendor>/package.json`) that
// would silently shadow the agent's real adjacent manifest, and an unreadable
// unrelated candidate would even refuse the import. No such file exists in the
// tree today, so this was latent rather than live — but the layout is knowable,
// so it is read directly instead of relying on that absence.
//
// Probing only the canonical location (the behaviour before cinatra#2044 GAP 2)
// left the flat layout with NO manifest at all. That merely lost
// `description`/`produces` before; WITH the version-skip drift check below it
// would turn destructive — "declares nothing" would re-import on every boot and
// CLEAR a legitimately-installed `lifecycle_config` (codex round 0).
function siblingManifestPath(oasSourcePath: string): string {
  const oasDir = dirname(oasSourcePath);
  return basename(oasDir) === "cinatra"
    ? join(oasDir, "..", "package.json")
    : join(oasDir, "package.json");
}

async function readSiblingPackageJsonIdentity(oasSourcePath: string): Promise<SiblingRead> {
  let raw: string;
  try {
    raw = await readFile(siblingManifestPath(oasSourcePath), "utf8");
  } catch (err) {
    // ENOENT — this layout's manifest genuinely does not exist. Identity falls
    // back to the OAS and the synthesized ZIP honestly declares nothing.
    if ((err as { code?: string } | null)?.code === "ENOENT") return { status: "absent" };
    // EACCES, EISDIR, … — the agent's OWN manifest is there and unreadable.
    // Refuse, so the caller never writes a synthesized "declares nothing" over
    // a real declaration on the installed row.
    return { status: "unreadable", reason: err instanceof Error ? err.message : String(err) };
  }
  try {
    const parsed = JSON.parse(raw) as { name?: unknown; version?: unknown; description?: unknown; license?: unknown; cinatra?: unknown };
    const name = typeof parsed.name === "string" && parsed.name ? parsed.name : undefined;
    const version =
      typeof parsed.version === "string" && parsed.version ? parsed.version : undefined;
    const description = typeof parsed.description === "string" && parsed.description ? parsed.description : undefined;
    const license = typeof parsed.license === "string" && parsed.license ? parsed.license : undefined;
    const cinatraBlock =
      parsed.cinatra && typeof parsed.cinatra === "object" && !Array.isArray(parsed.cinatra)
        ? (parsed.cinatra as Record<string, unknown>)
        : undefined;
    const agentDependencies = cinatraBlock?.agentDependencies as Record<string, string> | undefined;
    const type = typeof cinatraBlock?.type === "string" ? cinatraBlock.type : undefined;
    // `cinatra.produces` is CONTRACT-LOAD-BEARING for the OAS compiler's sibling
    // read (oas-compiler.ts readSiblingPackageJson): a declared EndNode artifact
    // binding fail-closes when produces is absent/[]. The git-file loader
    // synthesizes the sibling package.json for the import ZIP, so produces MUST
    // ride through the synthesis or dev import of any binding-bearing agent
    // errors (cinatra#1454). Carried as a raw passthrough array (the compiler
    // re-parses each {extension, objectTypeId?} entry tolerantly).
    const produces = Array.isArray(cinatraBlock?.produces)
      ? (cinatraBlock.produces as unknown[])
      : undefined;
    // `cinatra.lifecycle` is CONTRACT-LOAD-BEARING for the repair route
    // (cinatra#2044 GAP 2): `importAgentTemplateCore` compiles it onto
    // `agent_templates.lifecycle_config`, the column `resolveRepairCapable`
    // reads to route a reviewer's `changes_requested` to the producer instead of
    // a human. Dropping it during the ZIP synthesis is exactly the cinatra#2047
    // D-1 failure re-introduced on the loader path: a real install of a
    // repair-capable producer left the column NULL and every repair escalated.
    // Carried as a raw passthrough (readManifestLifecycle/normalizeLifecycle in
    // `@/lib/lifecycle/lifecycle-policy` is the fail-soft normalizer, applied
    // once at the persistence hop).
    // Arrays are excluded here as well as by `normalizeLifecycle` downstream —
    // the declaration is an OBJECT, and the neighbouring `produces` reader keeps
    // the same explicit-shape discipline.
    const lifecycle =
      cinatraBlock?.lifecycle &&
      typeof cinatraBlock.lifecycle === "object" &&
      !Array.isArray(cinatraBlock.lifecycle)
        ? cinatraBlock.lifecycle
        : undefined;
    // A manifest that parsed but carries no usable `name` is still a REAL
    // manifest, and its other declarations are still the author's intent. It is
    // reported `ok` with `name: undefined` rather than `absent` so that:
    //   - identity keeps falling back to the OAS's
    //     `metadata.cinatra.packageName` exactly as before (the caller already
    //     does `cinatraPackageName ?? sibling?.name`, and skips when BOTH are
    //     missing), and
    //   - its `lifecycle`/`produces`/`license` are NOT discarded — returning
    //     `absent` here would synthesize an authoritative "declares nothing",
    //     which the drift check below would then write over a real declaration
    //     (codex round 0, adopted; same clobber class as the layout probe above).
    return {
      status: "ok",
      identity: { name, version, description, license, agentDependencies, type, produces, lifecycle },
    };
  } catch (err) {
    // A JSON.parse SyntaxError on a manifest we DID read. The file exists and is
    // unusable, so this is a refusal, never a silent "declares nothing".
    return { status: "unreadable", reason: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// ensureAgentPackageFromGitFile — load a git-native agent JSON into the DB
// ---------------------------------------------------------------------------
// Reads an agents/<slug>/cinatra/oas.json file (canonical; legacy
// flat agents/<slug>/agent.json also supported — callers resolve the path)
// directly from the repo, builds an in-memory ZIP envelope, and upserts via
// importAgentTemplate. This git-native path keeps the DB as a derived cache
// of the files committed under agents/.

export async function ensureAgentPackageFromGitFile(opts: {
  oasSourcePath: string;
  // First-party in-tree git-file loads (dev-boot scan, hot-reload watcher,
  // cinatra setup) pass true: the operator owns these agents, so a copyleft
  // (GPL) license needs no interactive acknowledgement. Defaults false. NOTE:
  // this request is only HONORED for a VERIFIED first-party agent (`@cinatra-ai/*`
  // under `extensions/cinatra-ai/`); for any other vendor scope the copyleft gate
  // still fires, so the auto-ack cannot leak to third-party agents.
  licenseAcknowledged?: boolean;
  /** Test seam — see `InstallRecordHealFn`. */
  healInstallRecord?: InstallRecordHealFn;
}): Promise<{ templateId: string; upserted: boolean; skipped: boolean }> {
  const raw = await readFile(opts.oasSourcePath, "utf8");
  const content = JSON.parse(raw) as {
    name?: string;
    description?: string;
    metadata?: { cinatra?: { packageName?: string; agentDependencies?: Record<string, string> } };
    [key: string]: unknown;
  };

  const cinatraPackageName = content.metadata?.cinatra?.packageName;

  // Fall back to sibling package.json for the packageName and presentation
  // fields (description, agentDependencies) that live in package.json, not
  // the OAS source.
  const siblingRead = await readSiblingPackageJsonIdentity(opts.oasSourcePath);
  // A sibling manifest that EXISTS but cannot be read is a refusal, not a
  // fallback (cinatra#2044 GAP 2). Every manifest-derived column — version,
  // license, produces, agentDependencies and now lifecycle — would otherwise be
  // synthesized as "declares nothing" and written to the row as if that were the
  // author's intent. Skipping leaves the installed row exactly as it is; the
  // next boot or watcher event picks the agent up once the file is readable
  // again. (Matches this function's existing graceful skip contract — boot and
  // watcher callers already handle `skipped`.)
  if (siblingRead.status === "unreadable") {
    console.warn(
      `[cinatra:extensions:agent] skipped: sibling package.json beside ${opts.oasSourcePath} is unreadable (${siblingRead.reason}) — refusing to import a synthesized manifest over the installed row`,
    );
    return { templateId: "", upserted: false, skipped: true };
  }
  const sibling: SiblingIdentity | undefined =
    siblingRead.status === "ok" ? siblingRead.identity : undefined;
  const packageName: string | undefined = cinatraPackageName ?? sibling?.name;
  // Version resolves SOLELY from the sibling package.json#version — the
  // canonical source. We intentionally do NOT read metadata.cinatra.packageVersion
  // from the OAS: that copy is a non-typed passthrough kept (if at all) only for
  // provenance, and reading it first risked OAS<->package.json drift that could
  // make the version-skip guard below short-circuit a re-import of bumped code.
  const packageVersion: string | undefined = sibling?.version;

  if (!packageName) {
    console.warn(
      // Startup filesystem extension loader has no request context; prefix is part of the unified [cinatra:extensions:<kind>] scheme.
      `[cinatra:extensions:agent] skipped: no packageName in ${opts.oasSourcePath}`,
    );
    return { templateId: "", upserted: false, skipped: true };
  }

  // Reserved workspace slug guard. An agent named @cinatra-ai/<workspace-slug> would
  // be structurally indistinguishable from a workspace TS package. Skip it
  // here (graceful, matching this function's skip contract — boot/watcher
  // callers handle skipped) rather than register a colliding identity.
  if (isReservedWorkspaceSlug(packageName)) {
    console.warn(
      `[cinatra:extensions:agent] skipped: "${packageName}" collides with a reserved workspace package slug (${opts.oasSourcePath})`,
    );
    return { templateId: "", upserted: false, skipped: true };
  }

  // --- Version-skip guard — same pattern as ensureAgentPackage ---
  // Avoids redundant DB writes on every restart when the version is current.
  const existing = await readAgentTemplateByPackageName(packageName);
  if (existing && existing.packageVersion === packageVersion) {
    // …but a version match alone is NOT "up to date": the row must also already
    // carry every column this loader DERIVES from the manifest.
    //
    // cinatra#2044 GAP 2 — why this second condition exists. Until the change
    // that introduced it, this path never projected `cinatra.lifecycle` onto
    // `agent_templates.lifecycle_config` at all. So every instance that had
    // ALREADY installed a repair-capable producer at the current version (the
    // live wave124 state: `@cinatra-ai/wordpress-agent@0.1.6` installed, column
    // NULL, every `changes_requested` escalating to a human) would take this
    // early return on every boot forever — the fix would ship and change
    // nothing until the next version bump. Comparing the compiled projection
    // and falling through on drift REPAIRS such a row on the next boot.
    //
    // Convergent and self-limiting: the re-import writes exactly this projection
    // (the synthesis below carries the same block the persistence hop compiles),
    // so the very next boot matches and skips again. One extra import per
    // drifted template, once — no re-import loop, and no cost at all for the
    // overwhelmingly common already-current case (the sibling manifest is
    // already read above, so this adds no I/O).
    //
    // The comparison is only meaningful when a sibling manifest was actually
    // READ. With none on disk this loader derives no declaration at all, and the
    // import below is told so (`lifecycleDeclarationAuthoritative: false`), so it
    // leaves the column untouched — comparing anyway would report permanent
    // "drift" against a populated row and re-import on EVERY boot without ever
    // changing it. Treating absent as "nothing to compare" keeps the guard
    // convergent in both directions (codex round 1).
    const declaredLifecycleConfig =
      siblingRead.status === "ok"
        ? serializeLifecycleConfig(normalizeLifecycle(sibling?.lifecycle))
        : (existing.lifecycleConfig ?? null);
    if ((existing.lifecycleConfig ?? null) === declaredLifecycleConfig) {
      // …and NEITHER is a version+projection match "already up to date" while
      // the CANONICAL INSTALL RECORD is absent (cinatra#2536 — see the module
      // note above the gate). The package dir is the agent's own manifest dir
      // (the layout-derived sibling location), which is what the repair reads
      // to PROVE the package's identity before it mints a row.
      const gate = await installRecordGate(
        packageName,
        dirname(siblingManifestPath(opts.oasSourcePath)),
        packageVersion,
        opts.healInstallRecord ?? defaultHealInstallRecord,
      );
      logInstallRecordState(packageName, packageVersion, gate);
      if (!gate.reImport) {
        // Only a genuinely install-active package earns the "already up to
        // date" line; a refused/failed record already logged the truth and must
        // not be contradicted by a healthy-sounding one (codex round 1).
        if (gate.recordLive) {
          console.info(
            `[cinatra:extensions:agent] ${packageName} v${packageVersion ?? "unknown"} skipped — already up to date (bump packageVersion to force re-import)`,
          );
        }
        return { templateId: existing.id, upserted: false, skipped: true };
      }
      // Repaired: fall through and re-import at the same version. Convergent —
      // the record now exists, so the next boot takes the skip above.
    } else {
      console.info(
        `[cinatra:extensions:agent] ${packageName} v${packageVersion ?? "unknown"} re-importing at the same version — the installed row's lifecycle_config drifted from the manifest declaration (cinatra#2044)`,
      );
    }
  }

  // --- Downgrade guard — semver.gt check ---
  // If the DB row holds a version strictly greater than the git-file version,
  // the UI-installed version is preserved. We only run both semver.valid()
  // pre-checks to make the null/invalid-string fallthrough explicit.
  if (
    existing &&
    packageVersion &&
    existing.packageVersion &&
    semver.valid(existing.packageVersion) &&
    semver.valid(packageVersion) &&
    semver.gt(existing.packageVersion, packageVersion)
  ) {
    console.warn(
      `[cinatra:extensions:agent] ${packageName} skipped — installed v${existing.packageVersion} is newer than git-file v${packageVersion} (UI-installed version preserved)`,
    );
    return { templateId: existing.id, upserted: false, skipped: true };
  }

  // --- Inject sibling description into in-memory content for DB storage ---
  // description is sourced from package.json, not agent.json.
  // agentDependencies / packageName / packageVersion are NOT injected into
  // agent.json — the compiler reads them from the sibling package.json.
  if (sibling?.description && !content.description) {
    content.description = sibling.description;
  }
  const agentJsonForZip = JSON.stringify(content, null, 2);

  // --- Build an in-memory ZIP containing agent.json + manifest.json + package.json ---
  // importAgentTemplate expects a base64-encoded ZIP with a manifest at v1.
  // Include the sibling package.json in the ZIP so importAgentTemplateCore
  // can read packageName, packageVersion, and agentDependencies from it (the compiler
  // reads sibling package.json via the ZIP-extracted tmp directory).
  const manifestJson = JSON.stringify({ version: 1 });
  const cinatraForZip: Record<string, unknown> = {};
  if (sibling?.type) cinatraForZip.type = sibling.type;
  if (sibling?.agentDependencies) cinatraForZip.agentDependencies = sibling.agentDependencies;
  // Carry `cinatra.produces` through the synthesis: the OAS compiler's sibling
  // read fail-closes a declared artifact binding when produces is absent, so
  // dropping it here breaks dev git-file import of every binding-bearing agent
  // (cinatra#1454). Preserve the raw declared entries verbatim.
  if (sibling?.produces) cinatraForZip.produces = sibling.produces;
  // Carry `cinatra.lifecycle` through the synthesis (cinatra#2044 GAP 2). Without
  // it the ZIP the loader hands `importAgentTemplateCore` has no lifecycle
  // declaration to compile, so `agent_templates.lifecycle_config` stays NULL for
  // every git-file/ZIP install and a repair-capable producer's
  // `changes_requested` routes `human_escalation` instead of `producer_repair`.
  if (sibling?.lifecycle) cinatraForZip.lifecycle = sibling.lifecycle;
  const packageJsonForZip = JSON.stringify(
    {
      name: packageName,
      version: packageVersion,
      description: sibling?.description,
      // Propagate sibling package.json#license to
      // the synthesized zip so detectSpdxLicense at import-agent-core.ts:135
      // can validate it. The repo-wide invariant (every extensions/cinatra-ai/*/
      // package.json has an explicit license field) is enforced at
      // author/review time by scanAgentForRequiredLicense, not runtime-defaulted here.
      license: sibling?.license,
      cinatra: Object.keys(cinatraForZip).length > 0 ? cinatraForZip : undefined,
    },
    null,
    2,
  );
  // Include sibling LICENSE files so importAgentCore's
  // license-detection step finds them. Without this the
  // git-file loader synthesizes a license-less zip and EVERY agent that needs
  // re-import (version bumped vs DB) gets rejected with LicenseDetectionRejectedError.
  const licenseEntries: Array<{ name: string; content: string }> = [];
  for (const licenseFile of ["LICENSE", "LICENSE.md", "COPYING", ".spdx"]) {
    try {
      const licenseContent = await readFile(
        join(dirname(opts.oasSourcePath), "..", licenseFile),
        "utf8",
      );
      licenseEntries.push({ name: licenseFile, content: licenseContent });
    } catch {
      // try sibling-dir variant (flat layout: agent.json next to LICENSE)
      try {
        const licenseContent = await readFile(
          join(dirname(opts.oasSourcePath), licenseFile),
          "utf8",
        );
        licenseEntries.push({ name: licenseFile, content: licenseContent });
      } catch {
        // not present, skip
      }
    }
  }
  const zipBuf = createZipBuffer([
    { name: "agent.json", content: agentJsonForZip },
    { name: "manifest.json", content: manifestJson },
    { name: "package.json", content: packageJsonForZip },
    ...licenseEntries,
  ]);
  const zipBase64 = zipBuf.toString("base64");

  // --- Delegate to importAgentTemplate (upsert-by-packageName) ---
  // A caller's licenseAcknowledged:true is only HONORED for a VERIFIED
  // first-party in-tree agent (package `@cinatra-ai/*` checked out under
  // `extensions/cinatra-ai/`). A third-party copyleft agent checked out under
  // any other vendor scope still requires explicit (UI/MCP) acknowledgement —
  // the auto-ack can't leak to it even if a caller passes true.
  const isFirstPartyInTree =
    packageName.startsWith("@cinatra-ai/") &&
    opts.oasSourcePath.replace(/\\/g, "/").includes("/extensions/cinatra-ai/");
  const result = await importAgentTemplateCore(zipBase64, undefined, {
    redirect: false,
    status: "published",
    licenseAcknowledged: (opts.licenseAcknowledged ?? false) && isFirstPartyInTree,
    // The `package.json` in the ZIP above is SYNTHESIZED by this loader, so it
    // only speaks for the author's lifecycle declaration when a sibling manifest
    // was actually read (cinatra#2044 GAP 2, codex round 1). With none on disk
    // the synthesis is hollow, and letting the importer read that as "the author
    // declares nothing" would CLEAR a correct lifecycle_config off the installed
    // row — including one the registry install path legitimately wrote.
    lifecycleDeclarationAuthoritative: siblingRead.status === "ok",
  });

  // --- Set packageName identity (idempotent one-time write) ---
  // setAgentTemplatePackageName guards with WHERE package_name IS NULL, so
  // calling it on every restart is safe — no-op once identity is established.
  await setAgentTemplatePackageName(
    result.templateId,
    packageName,
    packageVersion ?? undefined,
  );

  console.info(
    `[cinatra:extensions:agent] ${packageName} v${packageVersion ?? "unknown"} upserted`,
  );

  return { templateId: result.templateId, upserted: result.upserted, skipped: false };
}

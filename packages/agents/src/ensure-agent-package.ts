// Pure Node.js module — no "use server". Safe to import from instrumentation.node.ts.
// Reads a system-provided agent ZIP from data/downloads/, injects packageName/packageVersion
// into agent.json, and upserts the template via importAgentTemplate.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as semver from "semver";
import { readAgentTemplateByPackageName, setAgentTemplatePackageName } from "./store";
import { isReservedWorkspaceSlug } from "./reserved-workspace-slugs";
import { readZipFiles, createZipBuffer } from "./zip-helpers";
import { importAgentTemplateCore } from "./import-agent-core";

export async function ensureAgentPackage(opts: {
  zipFileName: string;
  packageName: string;
  packageVersion?: string;
  name?: string;
}): Promise<{ templateId: string; upserted: boolean; skipped: boolean }> {
  // --- Version-skip guard ---
  // Avoid redundant DB writes on every restart when the version is already current.
  const existing = await readAgentTemplateByPackageName(opts.packageName);
  if (existing && existing.packageVersion === opts.packageVersion) {
    console.info(
      `[ensureAgentPackage] ${opts.packageName} v${opts.packageVersion ?? "unknown"} skipped — already up to date`,
    );
    return { templateId: existing.id, upserted: false, skipped: true };
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
      } catch {
        allFiles.push({ name: fileName, content: syntheticPackageJson });
      }
      packageJsonInjected = true;
    } else {
      allFiles.push({ name: fileName, content });
    }
  }
  if (!packageJsonInjected) {
    allFiles.push({ name: "package.json", content: syntheticPackageJson });
  }
  const modifiedZip = createZipBuffer(allFiles);
  const modifiedBase64 = modifiedZip.toString("base64");

  // --- Delegate to importAgentTemplate (handles upsert-by-packageName internally) ---
  const result = await importAgentTemplateCore(modifiedBase64, opts.name, { redirect: false });

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
// When agents/<slug>/cinatra/agent.json lacks top-level metadata.cinatra.packageName,
// derive packageName/packageVersion from the workspace package.json one level up
// (agents/<slug>/package.json). That file is the source of truth for workspace
// packages and already carries the canonical @cinatra/<slug> name.
async function readSiblingPackageJsonIdentity(
  agentJsonPath: string,
): Promise<{ name?: string; version?: string; description?: string; license?: string; agentDependencies?: Record<string, string>; type?: string } | null> {
  try {
    const pkgPath = join(dirname(agentJsonPath), "..", "package.json");
    const raw = await readFile(pkgPath, "utf8");
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
    if (!name) return null;
    return { name, version, description, license, agentDependencies, type };
  } catch {
    // ENOENT, EACCES, JSON.parse SyntaxError, etc. — fallback unavailable.
    return null;
  }
}

// ---------------------------------------------------------------------------
// ensureAgentPackageFromGitFile — load a git-native agent JSON into the DB
// ---------------------------------------------------------------------------
// Reads an agents/<slug>/cinatra/agent.json file (canonical; legacy
// flat agents/<slug>/agent.json also supported — callers resolve the path)
// directly from the repo, builds an in-memory ZIP envelope, and upserts via
// importAgentTemplate. This git-native path keeps the DB as a derived cache
// of the files committed under agents/.

export async function ensureAgentPackageFromGitFile(opts: {
  agentJsonPath: string;
  // First-party in-tree git-file loads (dev-boot scan, hot-reload watcher,
  // cinatra setup) pass true: the operator owns these agents, so a copyleft
  // (GPL) license needs no interactive acknowledgement. Defaults false. NOTE:
  // this request is only HONORED for a VERIFIED first-party agent (`@cinatra-ai/*`
  // under `extensions/cinatra-ai/`); for any other vendor scope the copyleft gate
  // still fires, so the auto-ack cannot leak to third-party agents.
  licenseAcknowledged?: boolean;
}): Promise<{ templateId: string; upserted: boolean; skipped: boolean }> {
  const raw = await readFile(opts.agentJsonPath, "utf8");
  const content = JSON.parse(raw) as {
    name?: string;
    description?: string;
    metadata?: { cinatra?: { packageName?: string; packageVersion?: string; agentDependencies?: Record<string, string> } };
    [key: string]: unknown;
  };

  const cinatraPackageName = content.metadata?.cinatra?.packageName;
  const cinatraPackageVersion = content.metadata?.cinatra?.packageVersion;

  // Fall back to sibling package.json for identity fields
  // (packageName / packageVersion) and presentation fields (description,
  // agentDependencies) that live in package.json, not agent.json.
  const sibling = await readSiblingPackageJsonIdentity(opts.agentJsonPath);
  const packageName: string | undefined = cinatraPackageName ?? sibling?.name;
  const packageVersion: string | undefined = cinatraPackageVersion ?? sibling?.version;

  if (!packageName) {
    console.warn(
      // Startup filesystem extension loader has no request context; prefix is part of the unified [cinatra:extensions:<kind>] scheme.
      `[cinatra:extensions:agent] skipped: no packageName in ${opts.agentJsonPath}`,
    );
    return { templateId: "", upserted: false, skipped: true };
  }

  // Reserved workspace slug guard. An agent named @cinatra-ai/<workspace-slug> would
  // be structurally indistinguishable from a workspace TS package. Skip it
  // here (graceful, matching this function's skip contract — boot/watcher
  // callers handle skipped) rather than register a colliding identity.
  if (isReservedWorkspaceSlug(packageName)) {
    console.warn(
      `[cinatra:extensions:agent] skipped: "${packageName}" collides with a reserved workspace package slug (${opts.agentJsonPath})`,
    );
    return { templateId: "", upserted: false, skipped: true };
  }

  // --- Version-skip guard — same pattern as ensureAgentPackage ---
  // Avoids redundant DB writes on every restart when the version is current.
  const existing = await readAgentTemplateByPackageName(packageName);
  if (existing && existing.packageVersion === packageVersion) {
    console.info(
      `[cinatra:extensions:agent] ${packageName} v${packageVersion ?? "unknown"} skipped — already up to date (bump packageVersion to force re-import)`,
    );
    return { templateId: existing.id, upserted: false, skipped: true };
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
        join(dirname(opts.agentJsonPath), "..", licenseFile),
        "utf8",
      );
      licenseEntries.push({ name: licenseFile, content: licenseContent });
    } catch {
      // try sibling-dir variant (flat layout: agent.json next to LICENSE)
      try {
        const licenseContent = await readFile(
          join(dirname(opts.agentJsonPath), licenseFile),
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
    opts.agentJsonPath.replace(/\\/g, "/").includes("/extensions/cinatra-ai/");
  const result = await importAgentTemplateCore(zipBase64, undefined, {
    redirect: false,
    status: "published",
    licenseAcknowledged: (opts.licenseAcknowledged ?? false) && isFirstPartyInTree,
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

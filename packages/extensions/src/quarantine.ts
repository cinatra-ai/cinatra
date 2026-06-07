import "server-only";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Pre-purge quarantine.
 *
 * Verdaccio unpublish is the one IRREVERSIBLE step in the purge pipeline.
 * Before any version is removed we snapshot everything needed to manually
 * restore the package: every version tarball + the registry packument
 * metadata (dist-tags, version manifests) + the installed `agent_templates`
 * row snapshot. Lives under `data/extension-quarantine/` (the `data/` tree is
 * gitignored runtime state — never committed). This converts "irreversible"
 * into "irreversible after the operator deletes the quarantine dir".
 */

export type QuarantineInput = {
  packageName: string;
  versions: string[];
  distTags: Record<string, string>;
  /** The FULL agent_templates row (or null when no installed row exists). */
  templateSnapshot: unknown;
  /**
   * The raw registry packument (every version manifest + dist-tags) for a
   * complete forensic recovery snapshot. null/undefined when the package is
   * already absent from the registry.
   */
  packument?: unknown;
  /**
   * Download one version's tarball into `destPath`. Injected so this module
   * stays free of pacote / the agents Verdaccio client (dependency direction).
   * Returns false when the version is already absent (partial re-run).
   */
  downloadTarball: (version: string, destPath: string) => Promise<boolean>;
};

export type QuarantineResult = {
  quarantineDir: string;
  tarballs: string[];
  missingTarballs: string[];
};

function sanitizeForPath(packageName: string): string {
  // "@cinatra-ai/foo-agent" -> "cinatra-ai__foo-agent"
  return packageName.replace(/^@/, "").replace(/\//g, "__").replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function extensionQuarantineRoot(): string {
  return path.join(process.cwd(), "data", "extension-quarantine");
}

export async function quarantineExtensionBeforePurge(
  input: QuarantineInput,
): Promise<QuarantineResult> {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const quarantineDir = path.join(
    extensionQuarantineRoot(),
    `${sanitizeForPath(input.packageName)}-${ts}`,
  );
  await mkdir(quarantineDir, { recursive: true });

  const tarballs: string[] = [];
  const missingTarballs: string[] = [];
  for (const version of input.versions) {
    const tarPath = path.join(
      quarantineDir,
      `${sanitizeForPath(input.packageName)}-${version}.tgz`,
    );
    const got = await input.downloadTarball(version, tarPath);
    if (got) tarballs.push(tarPath);
    else missingTarballs.push(version);
  }

  const manifest = {
    packageName: input.packageName,
    quarantinedAt: new Date().toISOString(),
    versions: input.versions,
    distTags: input.distTags,
    tarballs: tarballs.map((p) => path.basename(p)),
    missingTarballs,
    templateSnapshot: input.templateSnapshot,
  };
  await writeFile(
    path.join(quarantineDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );

  // Full registry packument snapshot for forensic recovery.
  if (input.packument != null) {
    await writeFile(
      path.join(quarantineDir, "packument.json"),
      JSON.stringify(input.packument, null, 2),
      "utf8",
    );
  }

  return { quarantineDir, tarballs, missingTarballs };
}

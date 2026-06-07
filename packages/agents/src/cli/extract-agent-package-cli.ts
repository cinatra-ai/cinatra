// CLI-safe extractAgentPackage implementation.
// Does NOT import "server-only" — safe for plain Node.js CLI processes.
// Uses config-base.ts (env-only) instead of config.ts (server-only).

import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as pacote from "pacote";
import {
  requireVerdaccioConfig,
  type VerdaccioConfig,
} from "../verdaccio/config-base";
import {
  parseAgentPackageManifest,
  parseAgentPackagePayload,
  type AgentPackageManifest,
  type AgentPackagePayload,
} from "../verdaccio/package-contract";

export type ExtractedAgentPackageCli = {
  packageName: string;
  packageVersion: string;
  manifest: AgentPackageManifest;
  payload: AgentPackagePayload;
  readme: string | null;
  tempDir: string;
};

function pacoteOptions(
  config: VerdaccioConfig,
  extra: Record<string, unknown> = {},
) {
  const base = config.registryUrl.endsWith("/")
    ? config.registryUrl
    : `${config.registryUrl}/`;
  return {
    registry: base,
    token: config.token ?? undefined,
    ...extra,
  };
}

function packageSpec(packageName: string, version?: string): string {
  return version ? `${packageName}@${version}` : packageName;
}

export async function extractAgentPackageCli(input: {
  packageName: string;
  packageVersion?: string;
}): Promise<ExtractedAgentPackageCli> {
  const config = requireVerdaccioConfig();
  const tempDir = await mkdtemp(path.join(tmpdir(), "cinatra-agent-extract-"));

  try {
    await pacote.extract(
      packageSpec(input.packageName, input.packageVersion),
      tempDir,
      pacoteOptions(config),
    );

    const [manifestRaw, payloadRaw] = await Promise.all([
      readFile(path.join(tempDir, "package.json"), "utf8"),
      readFile(path.join(tempDir, "agent.json"), "utf8"),
    ]);
    const readmePath = path.join(tempDir, "README.md");
    const hasReadme = await access(readmePath)
      .then(() => true)
      .catch(() => false);
    const readme = hasReadme ? await readFile(readmePath, "utf8") : null;

    const manifest = parseAgentPackageManifest(JSON.parse(manifestRaw));
    const payload = parseAgentPackagePayload(JSON.parse(payloadRaw));

    return {
      packageName: manifest.name,
      packageVersion: manifest.version,
      manifest,
      payload,
      readme,
      tempDir,
    };
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

export async function cleanupExtractedAgentPackageCli(
  tempDir: string,
): Promise<void> {
  await rm(tempDir, { recursive: true, force: true });
}

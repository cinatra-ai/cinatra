import "server-only";

// Verdaccio client is WRITE-SIDE ONLY.
// Read-side (listAgentPackages, getAgentPackage, extractAgentPackage,
// cleanupExtractedAgentPackage) has been lifted to @cinatra-ai/registries.
// Consumers that need read-side access should import from @cinatra-ai/registries
// directly; this module retains only publish / deprecate / delete / setDistTag.
//
// Explicit dependency injection of `VerdaccioConfig`: every server-context entry-point function in this
// module accepts an optional `config?: VerdaccioConfig` parameter as its last
// argument; the body resolves it via `ensureConfig(config, "<fnName>")` from
// @cinatra-ai/registries. Host-app callers (server actions in src/app/**) await
// `loadVerdaccioConfigForServer()` once at the boundary and thread the
// resolved config down. NO global module-init facility is used here because it
// creates fragile import-order coupling and tighter architectural coupling.

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

const execFileAsync = promisify(execFile);
import { tmpdir } from "node:os";
import path from "node:path";
import * as pacote from "pacote";
import { c as tarCreate } from "tar";
import { requireVerdaccioToken, type VerdaccioConfig } from "./config";
import { ensureConfig } from "@cinatra-ai/registries";
import { buildRegistryAuthArgs } from "./cli-flags";
import { buildAgentPackageFiles, type BuildAgentPackageInput } from "./package-files";
import { compileOasAgentJson } from "../oas-compiler";

export type PublishAgentPackageInput = BuildAgentPackageInput;

export type PublishAgentPackageResult = {
  packageName: string;
  packageVersion: string;
  registryUrl: string;
  published: boolean;
  alreadyPublished: boolean;
};

type RegistryPackument = {
  versions?: Record<string, { deprecated?: string }>;
  "dist-tags"?: Record<string, string>;
};

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function encodePackageName(packageName: string): string {
  return encodeURIComponent(packageName);
}

/**
 * Best-effort secret scrubber for log/UI propagation.
 *
 * Documented contract:
 *   - LITERAL substring match using `String.prototype.replaceAll(searchValue, ...)`
 *     where `searchValue` is a string (NOT a regex). This is intentional —
 *     replaceAll with a string literal is safe even when the token contains
 *     regex-special characters (`.`, `*`, `[`, `]`, etc.). DO NOT rewrite
 *     this helper to use `value.replace(/.../g, ...)` without escaping.
 *   - URL-encoded tokens (e.g. an `=` percent-encoded as `%3D`) are NOT
 *     covered — they don't match the literal token bytes.
 *   - Multi-byte / partial-token leaks (e.g. a token that happens to span
 *     a stderr line boundary) are NOT covered.
 *   - For the current Verdaccio token format (opaque base64 strings, no
 *     special chars in the alphabet), literal-substring redaction is
 *     adequate. Stronger mitigation lives in the spawn-side code paths
 *     that should not put the token in argv at all, plus the operator
 *     ~/.npmrc fallback in deleteAgentPackageVersion.
 */
function redactToken(value: string, token: string | null): string {
  if (!token || !value.includes(token)) return value;
  return value.replaceAll(token, "[redacted]");
}

function pacoteOptions(config: VerdaccioConfig, extra: Record<string, unknown> = {}) {
  return {
    registry: ensureTrailingSlash(config.registryUrl),
    token: config.token ?? undefined,
    ...extra,
  };
}

async function registryJson<T>(
  config: VerdaccioConfig,
  relativePath: string,
  init: RequestInit = {},
): Promise<T> {
  const url = new URL(relativePath.replace(/^\//, ""), ensureTrailingSlash(config.registryUrl));
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (config.token) {
    headers.set("authorization", `Bearer ${config.token}`);
  }
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(url, { ...init, headers });
  if (!response.ok) {
    const body = await response.text();
    const message = body || `Registry request failed with ${response.status}.`;
    const error = new Error(redactToken(message, config.token)) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }

  return (await response.json()) as T;
}

async function isVersionPublished(config: VerdaccioConfig, packageName: string, version: string): Promise<boolean> {
  // Single packument fetch — eliminates the TOCTOU race from two sequential calls.
  try {
    const packument = (await pacote.packument(packageName, pacoteOptions(config, { fullMetadata: true }))) as RegistryPackument;
    return Boolean(packument.versions?.[version]);
  } catch (error) {
    const status = (error as { statusCode?: number; code?: string }).statusCode;
    const code = (error as { code?: string }).code;
    if (status === 404 || code === "E404") {
      return false;
    }
    throw error;
  }
}

export async function publishAgentPackage(
  input: PublishAgentPackageInput,
  config?: VerdaccioConfig,
): Promise<PublishAgentPackageResult> {
  const resolvedConfig = ensureConfig(config, "publishAgentPackage");
  const packageFiles = buildAgentPackageFiles(input, resolvedConfig);

  if (await isVersionPublished(resolvedConfig, packageFiles.packageName, packageFiles.packageVersion)) {
    return {
      packageName: packageFiles.packageName,
      packageVersion: packageFiles.packageVersion,
      registryUrl: resolvedConfig.registryUrl,
      published: false,
      alreadyPublished: true,
    };
  }

  const tempDir = await mkdtemp(path.join(tmpdir(), "cinatra-agent-publish-"));

  try {
    await Promise.all(
      Object.entries(packageFiles.files).map(([fileName, contents]) =>
        writeFile(path.join(tempDir, fileName), contents, "utf8"),
      ),
    );

    // pacote.tarball() on a local dir requires Arborist in v21+ — use `tar` directly.
    // npm tarballs require all paths prefixed with "package/".
    const entries = await readdir(tempDir);
    const tarballData: Buffer = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      tarCreate({ gzip: true, cwd: tempDir, prefix: "package" }, entries)
        .on("data", (chunk: Buffer) => chunks.push(chunk))
        .on("end", () => resolve(Buffer.concat(chunks)))
        .on("error", (err: unknown) => reject(err));
    });
    // Publish directly via the npm registry HTTP protocol — avoids libnpmpublish's
    // npm-registry-fetch auth resolution which doesn't pick up our Bearer token.
    const tarballBase64 = tarballData.toString("base64");
    const tarballName = `${packageFiles.packageName}-${packageFiles.packageVersion}.tgz`;
    const { createHash } = await import("node:crypto");
    const tarballShasum = createHash("sha1").update(tarballData).digest("hex");
    const tarballIntegrity = `sha512-${createHash("sha512").update(tarballData).digest("base64")}`;
    const publishBody = {
      _id: packageFiles.packageName,
      name: packageFiles.packageName,
      "dist-tags": { latest: packageFiles.packageVersion },
      versions: {
        [packageFiles.packageVersion]: {
          ...(packageFiles.manifest as Record<string, unknown>),
          dist: {
            tarball: `${ensureTrailingSlash(resolvedConfig.registryUrl)}-/${encodeURIComponent(packageFiles.packageName)}/-/${tarballName}`,
            shasum: tarballShasum,
            integrity: tarballIntegrity,
          },
        },
      },
      _attachments: {
        [tarballName]: {
          content_type: "application/octet-stream",
          data: tarballBase64,
          length: tarballData.byteLength,
        },
      },
    };
    await registryJson<void>(resolvedConfig, `/${encodeURIComponent(packageFiles.packageName)}`, {
      method: "PUT",
      body: JSON.stringify(publishBody),
    });

    return {
      packageName: packageFiles.packageName,
      packageVersion: packageFiles.packageVersion,
      registryUrl: resolvedConfig.registryUrl,
      published: true,
      alreadyPublished: false,
    };
  } catch (error) {
    const message = error instanceof Error ? redactToken(error.message, resolvedConfig.token) : "Verdaccio publish failed.";
    throw new Error(message);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function publishAgentPackageFromGitDir(
  input: {
    agentDir: string;
    changelog?: string | null;
  },
  config?: VerdaccioConfig,
): Promise<PublishAgentPackageResult> {
  const resolvedConfig = ensureConfig(config, "publishAgentPackageFromGitDir");
  // Last-resort guard. The MCP handlers (agent_source_compile +
  // agent_source_publish) gate on the sibling-file scan first, so callers that
  // go through MCP never reach this point with a credentialled package. But the
  // tarball-build below copies EVERY file recursively (no skip-list beyond
  // top-level package.json/agent.json). If a future internal caller skips the
  // MCP gate, we still refuse to ship.
  const { scanPackageSiblingFilesForLiteralSecrets } = await import("../scan-package-siblings");
  const lastResortFindings = await scanPackageSiblingFilesForLiteralSecrets(input.agentDir);
  const lastResortBlockers = lastResortFindings.filter((f) => f.severity === "blocker");
  if (lastResortBlockers.length > 0) {
    const summary = lastResortBlockers.slice(0, 3).map((b) => b.location ?? b.code).join(", ");
    throw new Error(`publishAgentPackageFromGitDir refusing to publish package with ${lastResortBlockers.length} credential/forbidden-file blocker${lastResortBlockers.length === 1 ? "" : "s"} (${summary}${lastResortBlockers.length > 3 ? ", …" : ""}). Route through agent_source_publish for the structured \{ code: "review_blocked\", blockers \} response.`);
  }


  // Read canonical name and version from package.json
  const pkgJsonPath = path.join(input.agentDir, "package.json");
  let gitPkgJson: Record<string, unknown>;
  try {
    const raw = await readFile(pkgJsonPath, "utf8");
    gitPkgJson = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`Cannot read package.json from ${input.agentDir}`);
  }

  const packageName = typeof gitPkgJson.name === "string" ? gitPkgJson.name : null;
  const packageVersion = typeof gitPkgJson.version === "string" ? gitPkgJson.version : null;
  if (!packageName || !packageVersion) {
    throw new Error("package.json must have name and version fields.");
  }

  // Overwrite guard — refuse to publish a version that already exists
  if (await isVersionPublished(resolvedConfig, packageName, packageVersion)) {
    return { packageName, packageVersion, registryUrl: resolvedConfig.registryUrl, published: false, alreadyPublished: true };
  }

  // Read the agent definition. Probe order:
  //   1. cinatra/oas.json — canonical
  //   2. cinatra/agent.json — transitional
  //   3. agent.json — flat legacy
  let agentJsonPath: string | null = null;
  let raw: string | null = null;
  for (const candidate of [
    path.join(input.agentDir, "cinatra", "oas.json"),
    path.join(input.agentDir, "cinatra", "agent.json"),
    path.join(input.agentDir, "agent.json"),
  ]) {
    try {
      raw = await readFile(candidate, "utf8");
      agentJsonPath = candidate;
      break;
    } catch {
      // try next rung
    }
  }
  if (!agentJsonPath || raw === null) {
    throw new Error(`Cannot read oas.json or agent.json from ${input.agentDir}`);
  }
  let gitAgentJson: Record<string, unknown>;
  try {
    gitAgentJson = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`Failed to parse ${agentJsonPath}`);
  }

  const cinatra = ((gitAgentJson.metadata as Record<string, unknown> | undefined)?.cinatra ?? {}) as Record<string, unknown>;
  const agentId = typeof gitAgentJson.id === "string" ? gitAgentJson.id : randomUUID();
  const description = typeof gitPkgJson.description === "string" ? gitPkgJson.description : null;

  // Compile the OAS flow to derive approvalPolicy, inputSchema, taskSpec, and type.
  // Flow-type agents don't store these in metadata.cinatra — they're derived from the
  // flow graph at compile time. Fall back to metadata.cinatra values if compilation
  // fails (e.g. leaf agents whose agentJsonPath is already fully baked).
  let compiledApprovalPolicy: { steps: Array<{ requiresApproval?: boolean }> } | null = null;
  let compiledInputSchema: Record<string, unknown> | null = null;
  let compiledTaskSpec: string | null = null;
  let compiledAgentType: string | null = null;
  let compiledHitlScreens: string[] | null = null;
  try {
    const compileResult = await compileOasAgentJson({ packageName });
    if (compileResult.ok) {
      const v = compileResult.value;
      if (v.approvalPolicy) compiledApprovalPolicy = v.approvalPolicy as { steps: Array<{ requiresApproval?: boolean }> };
      if (v.inputSchema) compiledInputSchema = v.inputSchema as Record<string, unknown>;
      if (v.prompt) compiledTaskSpec = v.prompt;
      if (v.type) compiledAgentType = v.type;
      if (Array.isArray(v.hitlScreens) && v.hitlScreens.length > 0) compiledHitlScreens = v.hitlScreens as string[];
    }
  } catch {
    // Non-fatal — fall through to metadata.cinatra fallbacks below
  }

  const agentType = compiledAgentType ?? (cinatra.type ?? "leaf") as string;
  const executionProvider = typeof cinatra.executionProvider === "string" ? cinatra.executionProvider : null;
  const inputSchema = compiledInputSchema ?? (cinatra.inputSchema ?? { type: "object", properties: {}, required: [] }) as Record<string, unknown>;
  const compiledPlan = (cinatra.compiledPlan ?? []) as unknown[];
  const approvalPolicy = compiledApprovalPolicy ?? (cinatra.approvalPolicy ?? { steps: [] }) as { steps: Array<{ requiresApproval?: boolean }> };
  const taskSpec = compiledTaskSpec ?? (typeof cinatra.taskSpec === "string" ? cinatra.taskSpec : null);
  const agentDeps = ((gitPkgJson.cinatra as Record<string, unknown> | undefined)?.agentDependencies ?? {}) as Record<string, string>;
  // Surface connector dependencies into the published manifest + payload so the
  // install resolver can resolve them via pacote without re-reading the source
  // git package.json.
  const connectorDeps = ((gitPkgJson.cinatra as Record<string, unknown> | undefined)?.connectorDependencies ?? {}) as Record<string, string>;
  // Carry the canonical cross-kind `cinatra.dependencies[]` edges through publish.
  // The closed `cinatraAgentPackageMetadataSchema` strips unknown keys, so this
  // must be emitted explicitly into distManifest.cinatra below — otherwise the
  // backfilled field is lost on publish.
  const cinatraDeps = ((gitPkgJson.cinatra as Record<string, unknown> | undefined)?.dependencies ?? []) as unknown[];
  const hasApprovalGates = approvalPolicy.steps.some((s) => s.requiresApproval);
  const publishedAt = new Date().toISOString();

  const { createHash } = await import("node:crypto");
  const sourceTemplateId = agentId;
  const sourceVersionId = randomUUID();
  const contentHash = createHash("sha256").update(JSON.stringify(gitAgentJson)).digest("hex").slice(0, 16);

  // Preserve the agent's source license. The license-detection helper
  // (packages/extensions/src/license-detection.ts) checks `package.json#license`
  // first, and the OAS-source review treats a missing package license as a
  // blocker (validate-agent-json.ts). Dropping it here propagates through the
  // post-publish reinstall (which atomically replaces the source dir with the
  // materialized tarball contents) and breaks the NEXT publish with
  // "License could not be determined (missing)". Carry it through.
  const license =
    typeof gitPkgJson.license === "string" && gitPkgJson.license.trim().length > 0
      ? gitPkgJson.license
      : undefined;

  // Build distribution-format package.json (satisfies AgentPackageManifest schema)
  const distManifest: Record<string, unknown> = {
    name: packageName,
    version: packageVersion,
    description,
    ...(license ? { license } : {}),
    keywords: ["cinatra", "cinatra-agent"],
    publishConfig: { registry: resolvedConfig.registryUrl },
    cinatra: {
      packageType: "agent",
      manifestVersion: 1,
      sourceTemplateId,
      sourceVersionId,
      sourceVersionNumber: 1,
      type: agentType,
      riskLevel: "low",
      hasApprovalGates,
      toolAccess: [],
      ownerOrgId: null,
      ...(Object.keys(agentDeps).length > 0 ? { agentDependencies: agentDeps } : {}),
      ...(Object.keys(connectorDeps).length > 0 ? { connectorDependencies: connectorDeps } : {}),
      ...(Array.isArray(cinatraDeps) && cinatraDeps.length > 0 ? { dependencies: cinatraDeps } : {}),
      ...(executionProvider && executionProvider !== "default" ? { executionProvider } : {}),
      // Unconditionally force kind + apiVersion on the published manifest.
      // Without normalization, chat-created packages can lack `cinatra.kind`,
      // so the marketplace `?tab=agent` filter excludes them (registry manifest
      // reader returns kind=null when cinatra.kind is missing). This pipeline is
      // agent-only; coercing missing/stale kind to "agent" is the safer default.
      // agent_source_write_files applies the same normalization pre-write;
      // this is defense-in-depth for any on-disk package.json that bypassed it.
      kind: "agent",
      apiVersion: "cinatra.ai/v1",
    },
  };

  // Build distribution-format agent.json (satisfies AgentPackagePayload schema)
  const distPayload: Record<string, unknown> = {
    formatVersion: 2,
    packageName,
    packageVersion,
    publishedAt,
    title: typeof gitAgentJson.name === "string" ? gitAgentJson.name : packageName,
    description,
    changelog: input.changelog?.trim() || null,
    template: {
      sourceTemplateId,
      ownerOrgId: null,
      name: typeof gitAgentJson.name === "string" ? gitAgentJson.name : packageName,
      description,
      sourceNl: taskSpec ?? "",
      type: agentType,
      compiledPlan,
      inputSchema,
      outputSchema: null,
      approvalPolicy,
      taskSpec,
      status: "published",
      ...(executionProvider && executionProvider !== "default" ? { executionProvider } : {}),
      ...(compiledHitlScreens ? { hitlScreens: compiledHitlScreens } : {}),
    },
    version: {
      sourceVersionId,
      sourceVersionNumber: 1,
      contentHash,
      snapshot: { name: typeof gitAgentJson.name === "string" ? gitAgentJson.name : packageName, type: agentType, compiledPlan, inputSchema, approvalPolicy, taskSpec },
    },
    publish: {
      riskLevel: "low",
      toolAccess: [],
      hasApprovalGates,
      ...(Object.keys(agentDeps).length > 0 ? { agentDependencies: agentDeps } : {}),
      ...(Object.keys(connectorDeps).length > 0 ? { connectorDependencies: connectorDeps } : {}),
    },
  };

  // Build tarball: distribution package.json + agent.json, plus preserved SKILL.md and cinatra/ sidecar
  const tempDir = await mkdtemp(path.join(tmpdir(), "cinatra-agent-git-publish-"));
  try {
    await writeFile(path.join(tempDir, "package.json"), `${JSON.stringify(distManifest, null, 2)}\n`, "utf8");
    await writeFile(path.join(tempDir, "agent.json"), `${JSON.stringify(distPayload, null, 2)}\n`, "utf8");

    // Align the tarball file-set with the sibling-scanner file-set. A blind
    // recursive copy would include node_modules/, dist/, .git/, etc. — files
    // the scanner skips. A credential placed in any skipped-but-copied dir
    // would slip through both the sibling-scan gate and the last-resort guard.
    //
    // Now: walkPackageFiles() is the single source of truth for "publishable
    // files". The scanner sees the same list. Generated dirs, symlinks, and
    // blocked .env* files are excluded from both.
    const { walkPackageFiles } = await import("../scan-package-siblings");
    const publishableFiles = await walkPackageFiles(input.agentDir);
    for (const file of publishableFiles) {
      // Top-level package.json + agent.json are synthesized above (distManifest
      // + distPayload), so skip the original-on-disk versions.
      if (file.relPath === "package.json" || file.relPath === "agent.json") continue;
      // .env* files (other than .env.example) MUST NOT ship. The sibling scan
      // would have rejected the package at the gate; this is defense-in-depth.
      if (file.isEnvBlocked) continue;
      const dstPath = path.join(tempDir, file.relPath);
      await mkdir(path.dirname(dstPath), { recursive: true });
      if (file.isBinary) {
        // Preserve binary content verbatim (do not UTF-8-decode + re-encode).
        const bytes = await readFile(file.absPath);
        await writeFile(dstPath, bytes);
      } else {
        await writeFile(dstPath, await readFile(file.absPath, "utf8"), "utf8");
      }
    }

    const tarEntries = await readdir(tempDir);
    const tarballData: Buffer = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      tarCreate({ gzip: true, cwd: tempDir, prefix: "package" }, tarEntries)
        .on("data", (chunk: Buffer) => chunks.push(chunk))
        .on("end", () => resolve(Buffer.concat(chunks)))
        .on("error", (err: unknown) => reject(err));
    });

    const tarballBase64 = tarballData.toString("base64");
    const tarballName = `${packageName}-${packageVersion}.tgz`;
    const tarballShasum = createHash("sha1").update(tarballData).digest("hex");
    const tarballIntegrity = `sha512-${createHash("sha512").update(tarballData).digest("base64")}`;

    const publishBody = {
      _id: packageName,
      name: packageName,
      "dist-tags": { latest: packageVersion },
      versions: {
        [packageVersion]: {
          ...(distManifest as Record<string, unknown>),
          dist: {
            tarball: `${ensureTrailingSlash(resolvedConfig.registryUrl)}-/${encodeURIComponent(packageName)}/-/${tarballName}`,
            shasum: tarballShasum,
            integrity: tarballIntegrity,
          },
        },
      },
      _attachments: {
        [tarballName]: {
          content_type: "application/octet-stream",
          data: tarballBase64,
          length: tarballData.byteLength,
        },
      },
    };

    await registryJson<void>(resolvedConfig, `/${encodeURIComponent(packageName)}`, {
      method: "PUT",
      body: JSON.stringify(publishBody),
    });

    return { packageName, packageVersion, registryUrl: resolvedConfig.registryUrl, published: true, alreadyPublished: false };
  } catch (error) {
    const message = error instanceof Error ? redactToken(error.message, resolvedConfig.token) : "Verdaccio publish failed.";
    throw new Error(message);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function deprecateAgentPackageVersion(
  input: {
    packageName: string;
    packageVersion: string;
    message?: string;
  },
  config?: VerdaccioConfig,
): Promise<void> {
  const resolvedConfig = ensureConfig(config, "deprecateAgentPackageVersion");
  requireVerdaccioToken(resolvedConfig);

  const packagePath = encodePackageName(input.packageName);
  const packument = await registryJson<{
    versions?: Record<string, Record<string, unknown>>;
  }>(resolvedConfig, `${packagePath}?write=true`);

  if (!packument.versions?.[input.packageVersion]) {
    throw new Error(`Package version not found: ${input.packageName}@${input.packageVersion}`);
  }

  packument.versions[input.packageVersion].deprecated =
    input.message ?? "Deprecated by Cinatra registry management.";

  await registryJson<Record<string, unknown>>(resolvedConfig, packagePath, {
    method: "PUT",
    body: JSON.stringify(packument),
  });
}

export async function deleteAgentPackageVersion(
  input: {
    packageName: string;
    packageVersion: string;
  },
  config?: VerdaccioConfig,
): Promise<{ deleted: boolean; notFound: boolean }> {
  const resolvedConfig = ensureConfig(config, "deleteAgentPackageVersion");

  // Check if the version exists first
  const packagePath = encodePackageName(input.packageName);
  let packument: { versions?: Record<string, unknown> };
  try {
    packument = await registryJson<{ versions?: Record<string, unknown> }>(resolvedConfig, packagePath);
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 404) return { deleted: false, notFound: true };
    throw error;
  }

  if (!packument.versions?.[input.packageVersion]) {
    return { deleted: false, notFound: true };
  }

  // Verdaccio's PUT endpoint does not support version removal. Use npm unpublish.
  // Use explicit --registry= + --//<host>/:_authToken= flags built via
  // buildRegistryAuthArgs(resolvedConfig). NO ~/.npmrc mutation anywhere in
  // this path; the helper produces the flags from the explicitly threaded
  // VerdaccioConfig.
  const authArgs = buildRegistryAuthArgs(resolvedConfig);
  try {
    await execFileAsync("npm", [
      "unpublish",
      `${input.packageName}@${input.packageVersion}`,
      ...authArgs,
    ]);
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    const stdout = (error as { stdout?: string }).stdout ?? "";
    // Tolerate "version not found" from npm (already deleted)
    if (stderr.includes("is not in the npm registry") || stdout.includes("is not in the npm registry")) {
      return { deleted: false, notFound: true };
    }
    // If service token rejected, fall back to operator's pre-existing ~/.npmrc
    // credentials (no explicit token flag). Cinatra never WRITES ~/.npmrc
    // Reading whatever the operator already configured is acceptable
    // as a recovery escape hatch when the service token lacks unpublish rights.
    // Fallback path — no token flag, by design.
    if (stderr.includes("authorization required") || stderr.includes("403")) {
      try {
        await execFileAsync("npm", [
          "unpublish",
          `${input.packageName}@${input.packageVersion}`,
          `--registry=${resolvedConfig.registryUrl}`,
        ]);
      } catch (fallbackError) {
        // Redact the registry token before re-throwing. The fallback path
        // doesn't carry the token in argv, but stderr/stdout can still echo the
        // original primary-path argv from npm's error context, so apply the
        // same redaction defensively.
        const fbStderr = (fallbackError as { stderr?: string }).stderr ?? "";
        const fbStdout = (fallbackError as { stdout?: string }).stdout ?? "";
        const fbMessage = redactToken(
          `npm unpublish failed (fallback): ${fbStderr || fbStdout}`,
          resolvedConfig.token,
        );
        throw new Error(fbMessage);
      }
    } else {
      // npm spawns receive `--//<host>/:_authToken=<token>` in argv (built by buildRegistryAuthArgs).
      // npm regularly echoes its parsed argv when emitting argument-parse
      // errors, deprecation notices, or "unknown command" failures, so the
      // cleartext registry token can surface in the propagated Error.message
      // (and from there into Next.js dev/prod logs and any UI surface that
      // serializes the error). Apply redactToken to substitute the literal
      // token with "[redacted]" before throwing.
      const message = redactToken(
        `npm unpublish failed: ${stderr || stdout}`,
        resolvedConfig.token,
      );
      throw new Error(message);
    }
  }

  return { deleted: true, notFound: false };
}

/**
 * Enumerate every published version of a package in Verdaccio.
 *
 * Returns the sorted version list plus dist-tags. Returns an empty list when
 * the package is absent (404) so callers can treat "nothing to unpublish" as
 * success (idempotent purge).
 */
export async function listAgentPackageVersions(
  packageName: string,
  config?: VerdaccioConfig,
): Promise<{ versions: string[]; distTags: Record<string, string> }> {
  const resolvedConfig = ensureConfig(config, "listAgentPackageVersions");
  const packagePath = encodePackageName(packageName);
  let packument: RegistryPackument;
  try {
    packument = await registryJson<RegistryPackument>(resolvedConfig, packagePath);
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 404) return { versions: [], distTags: {} };
    throw error;
  }
  // Numeric (semver-ish) order, NOT lexicographic: "0.10.0" must sort after
  // "0.9.0" so callers picking the "last" version (e.g. purge rollback
  // fallback) don't grab the wrong one.
  const versions = Object.keys(packument.versions ?? {}).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
  return { versions, distTags: { ...(packument["dist-tags"] ?? {}) } };
}

/**
 * Read the AUTHORITATIVE extension kind from the registry packument. npm
 * stores the full package.json per version, so `versions[<v>].cinatra.kind` is
 * the package.json field as published — trustworthy for skill/connector
 * packages that have NO agent.json payload (getAgentPackage throws for those).
 * Returns the latest version's declared kind, or null when absent / no explicit
 * kind (legacy agents).
 */
export async function getRegistryPackageKind(
  packageName: string,
  config?: VerdaccioConfig,
): Promise<string | null> {
  const resolvedConfig = ensureConfig(config, "getRegistryPackageKind");
  const packagePath = encodePackageName(packageName);
  let packument: {
    versions?: Record<string, { cinatra?: { kind?: string } }>;
    "dist-tags"?: Record<string, string>;
  };
  try {
    packument = await registryJson(resolvedConfig, packagePath);
  } catch (error) {
    if ((error as { status?: number }).status === 404) return null;
    throw error;
  }
  const versions = packument.versions ?? {};
  // dist-tags.latest is authoritative. Fallback (malformed packument with no
  // latest tag): pick the numerically-highest version, not lexicographic
  // ("0.10.0" must beat "0.9.0").
  const latest =
    packument["dist-tags"]?.latest ??
    Object.keys(versions)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .pop() ??
    null;
  if (!latest) return null;
  return versions[latest]?.cinatra?.kind ?? null;
}

/**
 * Raw registry packument JSON for the purge quarantine (full forensic
 * snapshot: every version manifest + dist-tags). Returns null when the package
 * is absent (404) so the purge flow can still quarantine tarballs/DB-row and
 * proceed.
 */
export async function getRegistryPackument(
  packageName: string,
  config?: VerdaccioConfig,
): Promise<unknown> {
  const resolvedConfig = ensureConfig(config, "getRegistryPackument");
  const packagePath = encodePackageName(packageName);
  try {
    return await registryJson(resolvedConfig, packagePath);
  } catch (error) {
    if ((error as { status?: number }).status === 404) return null;
    throw error;
  }
}

export type UnpublishAllResult = {
  /** Versions successfully unpublished this run. */
  unpublished: string[];
  /** Versions already absent (idempotent — treated as success). */
  notFound: string[];
  /** Versions whose unpublish threw — pipeline MUST stop before DB/disk. */
  failed: { version: string; error: string }[];
  /** Versions still present in the registry after this run. */
  remaining: string[];
};

/**
 * Unpublish EVERY version of a package from Verdaccio.
 *
 * Enumerates the packument then loops the single-version
 * `deleteAgentPackageVersion` (Verdaccio has no whole-package atomic delete;
 * `npm unpublish pkg --force` is intentionally NOT used — per-version is
 * observable, idempotent, retryable). Attempts every version even if one
 * fails, then reports. The caller (purge pipeline) MUST treat a non-empty
 * `failed`/`remaining` as fail-closed: do NOT proceed to DB/disk deletion;
 * a later re-run retries only the `remaining` versions (notFound = success).
 */
export async function unpublishAllAgentPackageVersions(
  input: { packageName: string },
  config?: VerdaccioConfig,
): Promise<UnpublishAllResult> {
  const resolvedConfig = ensureConfig(
    config,
    "unpublishAllAgentPackageVersions",
  );
  const { versions } = await listAgentPackageVersions(
    input.packageName,
    resolvedConfig,
  );
  const result: UnpublishAllResult = {
    unpublished: [],
    notFound: [],
    failed: [],
    remaining: [],
  };
  for (const version of versions) {
    try {
      const r = await deleteAgentPackageVersion(
        { packageName: input.packageName, packageVersion: version },
        resolvedConfig,
      );
      if (r.deleted) result.unpublished.push(version);
      else if (r.notFound) result.notFound.push(version);
    } catch (error) {
      result.failed.push({
        version,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  // Re-enumerate so `remaining` reflects ground truth, not just our tally
  // (covers concurrent publishers / unexpected registry state).
  try {
    const after = await listAgentPackageVersions(
      input.packageName,
      resolvedConfig,
    );
    result.remaining = after.versions;
  } catch (error) {
    // If we cannot re-confirm registry state we must NOT let the caller proceed
    // to DB/disk deletion. A computed "remaining" can be empty (all
    // originally-listed deleted) yet a version could have been concurrently
    // published. Record a hard failure so the caller's `failed.length > 0`
    // fail-closed guard trips unconditionally.
    result.failed.push({
      version: "<re-enumeration>",
      error: `post-unpublish re-enumeration failed; cannot confirm registry is empty: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
    result.remaining = versions.filter(
      (v) => !result.unpublished.includes(v) && !result.notFound.includes(v),
    );
  }
  return result;
}

/**
 * Download one version's tarball to `destPath` for the purge quarantine
 * (recovery hedge before the irreversible Verdaccio unpublish). Best-effort:
 * returns false (does not throw) if the version is already gone so a partial
 * re-run still proceeds.
 */
export async function downloadAgentPackageTarball(
  input: { packageName: string; packageVersion: string; destPath: string },
  config?: VerdaccioConfig,
): Promise<boolean> {
  const resolvedConfig = ensureConfig(config, "downloadAgentPackageTarball");
  try {
    const buf = (await pacote.tarball(
      `${input.packageName}@${input.packageVersion}`,
      pacoteOptions(resolvedConfig),
    )) as Buffer;
    const { writeFile } = await import("node:fs/promises");
    await writeFile(input.destPath, buf);
    return true;
  } catch (error) {
    const status = (error as { statusCode?: number; code?: string }).statusCode;
    const code = (error as { code?: string }).code;
    if (status === 404 || code === "E404") return false;
    throw error;
  }
}

export async function setRegistryDistTag(
  input: {
    packageName: string;
    tag: string;
    version: string;
  },
  config?: VerdaccioConfig,
): Promise<void> {
  const resolvedConfig = ensureConfig(config, "setRegistryDistTag");
  requireVerdaccioToken(resolvedConfig);

  const packagePath = encodePackageName(input.packageName);
  await registryJson<unknown>(
    resolvedConfig,
    `/-/package/${packagePath}/dist-tags/${encodeURIComponent(input.tag)}`,
    {
      method: "PUT",
      body: JSON.stringify(input.version),
      headers: { "content-type": "application/json" },
    },
  );
}

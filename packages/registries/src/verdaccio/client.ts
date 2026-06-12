// Explicit dependency injection of `VerdaccioConfig`.
// Every server-context entry-point function in this module accepts an optional
// `config?: VerdaccioConfig` parameter as its last argument; the body resolves
// it via `ensureConfig(config, "<fnName>")`, which fail-fast throws a typed
// error if the caller forgot to supply config. The host-app composition wrapper
// at src/lib/verdaccio-config.ts is the single place that turns
// `loadVerdaccioConfigAsync(...)` into a `VerdaccioConfig` and threads it down
// through callers. No global module-init facility is used here; that avoids
// fragile import-order coupling and architectural coupling.

import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import * as pacote from "pacote";
import * as semver from "semver";
import { registryScopedAuthOptions } from "./registry-auth";
import type {
  AgentPackageDetail,
  AgentPackageOrigin,
  AgentPackageSummary,
  VerdaccioConfig,
} from "../types";

/**
 * Fail-fast DI guard.
 *
 * Each server-context entry-point function calls this on entry to surface a
 * typed error when the caller forgets to thread an explicit config. This
 * avoids "register-not-called-at-boot" silent failure modes from global state.
 */
function ensureConfig(
  config: VerdaccioConfig | undefined,
  fnName: string,
): VerdaccioConfig {
  if (!config) {
    throw new Error(
      `config parameter required: ${fnName} must be called with explicit VerdaccioConfig. ` +
        "Host-app callers should `await loadVerdaccioConfigForServer()` once and pass it down.",
    );
  }
  return config;
}

export { ensureConfig };

export type ExtractedAgentPackage = {
  packageName: string;
  packageVersion: string;
  /** Raw parsed package.json — packages/agents re-validates via agentPackageManifestSchema. */
  manifest: unknown;
  /** Raw parsed agent.json — packages/agents re-validates via agentPackagePayloadSchema. */
  payload: unknown;
  readme: string | null;
  tempDir: string;
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
 *   - LITERAL substring match via `String.prototype.replaceAll(searchValue, ...)`
 *     where `searchValue` is a string (NOT a regex). Safe for tokens
 *     containing regex-special chars (`.`, `*`, `[`, `]`, etc.). DO NOT
 *     rewrite to `value.replace(/.../g, ...)` without character escaping.
 *   - URL-encoded tokens, multi-byte boundary splits, and partial-token
 *     leaks are NOT covered.
 *   - Stronger argv-side mitigation lives in the spawn paths that avoid
 *     putting the token in argv (operator ~/.npmrc fallback in
 *     deleteAgentPackageVersion).
 */
function redactToken(value: string, token: string | null): string {
  if (!token || !value.includes(token)) return value;
  return value.replaceAll(token, "[redacted]");
}

/**
 * Options for every pacote call in this module.
 *
 * Credentials MUST be passed as a registry-scoped `'//<host>/:_authToken'`
 * key (see registryScopedAuthOptions) — npm-registry-fetch ignores a flat
 * `token` option entirely, which made every "authenticated" pacote read in
 * this module send no Authorization header (#179). Pinned by
 * tests/registry-auth-options.test.ts (options shape) and
 * tests/registry-auth.integration.test.ts (live 401/200 proof).
 */
function pacoteOptions(config: VerdaccioConfig, extra: Record<string, unknown> = {}) {
  return {
    registry: ensureTrailingSlash(config.registryUrl),
    ...registryScopedAuthOptions(config.registryUrl, config.token),
    ...extra,
  };
}

function packageSpec(packageName: string, version?: string): string {
  return version ? `${packageName}@${version}` : packageName;
}

// Extract a payload-title field defensively — the raw payload is `unknown`
// at this layer, so we probe with type guards.
function getField<T = unknown>(obj: unknown, key: string): T | undefined {
  if (obj && typeof obj === "object" && key in obj) {
    return (obj as Record<string, unknown>)[key] as T;
  }
  return undefined;
}

/**
 * Read the `cinatra.origin` block from a package's `cinatra` payload (the
 * `manifest.cinatra` sub-object). Surfaces visibility + scope so the
 * catalog / search filters can correctly distinguish public, locked_public,
 * and private packages WITHOUT re-fetching each package's full manifest.
 *
 * Returns null when the package has no origin block (legacy packages that
 * pre-date the convention) — callers treat null as the grandfather case
 * "public, visible to everyone."
 */
function extractOriginFromCinatraPayload(
  payload: unknown,
  packageName: string,
): AgentPackageOrigin | null {
  if (!payload || typeof payload !== "object") return null;
  const originRaw = (payload as { origin?: unknown }).origin;
  if (!originRaw || typeof originRaw !== "object") return null;
  const visibility = (originRaw as { visibility?: unknown }).visibility;
  const scope = (originRaw as { scope?: unknown }).scope;
  if (
    visibility !== "public" &&
    visibility !== "locked_public" &&
    visibility !== "private"
  ) {
    return null;
  }
  // If scope is missing on the origin block but the package is scoped,
  // infer it from the package name (`@acme/foo` → `@acme`). That's the
  // safer default — better than dropping the row to null and letting the
  // caller grandfather it as public.
  const inferredScope =
    typeof scope === "string" && scope !== ""
      ? scope
      : packageName.startsWith("@")
        ? packageName.split("/")[0]
        : null;
  if (inferredScope === null) return null;
  return { visibility, scope: inferredScope };
}

function toSummary(
  config: VerdaccioConfig,
  manifest: unknown,
  payload: unknown,
  deprecated: boolean,
): AgentPackageSummary {
  const packageName = getField<string>(manifest, "name") ?? "";
  const packageVersion = getField<string>(manifest, "version") ?? "";
  const title = getField<string>(payload, "title") ?? packageName;
  const description = getField<string | null>(payload, "description") ?? null;
  const changelog = getField<string | null>(payload, "changelog") ?? null;
  const publish = getField<Record<string, unknown>>(payload, "publish") ?? {};
  const template = getField<Record<string, unknown>>(payload, "template") ?? {};
  const publishedAt = getField<string>(payload, "publishedAt") ?? "";
  const riskLevel =
    (publish.riskLevel as AgentPackageSummary["riskLevel"] | undefined) ?? "low";
  const hasApprovalGates = Boolean(publish.hasApprovalGates);
  const toolAccess = Array.isArray(publish.toolAccess)
    ? (publish.toolAccess as string[])
    : [];
  const executionMode =
    (template.executionMode as AgentPackageSummary["executionMode"] | undefined) ?? "agentic";
  const ownerOrgId = (template.ownerOrgId as string | null | undefined) ?? null;

  // Read top-level author from manifest (npm spec: string OR { name, email, url }).
  const authorRaw = getField<unknown>(manifest, "author");
  const rawAuthorString: string | null =
    typeof authorRaw === "string"
      ? authorRaw
      : authorRaw && typeof authorRaw === "object" && "name" in authorRaw
        ? String((authorRaw as { name: string }).name)
        : null;
  // Cap at 120 chars to prevent arbitrarily long publisher-controlled strings
  // from distorting card layout in the marketplace UI.
  const author: string | null = rawAuthorString ? rawAuthorString.slice(0, 120) : null;

  // Read kind from the optional cinatra manifest block.
  const cinatraBlock = getField<Record<string, unknown>>(manifest, "cinatra") ?? {};
  const kindRaw = cinatraBlock.kind;
  // Workflow is included so registry-driven discovery matches deriveTypeId
  // and handler bootstrap.
  const kind: "agent" | "skill" | "connector" | "artifact" | "workflow" | null =
    kindRaw === "agent" ||
    kindRaw === "skill" ||
    kindRaw === "connector" ||
    kindRaw === "artifact" ||
    kindRaw === "workflow"
      ? kindRaw
      : null;

  return {
    packageName,
    packageVersion,
    title,
    description,
    changelog,
    riskLevel,
    hasApprovalGates,
    toolAccess,
    executionMode,
    ownerOrgId,
    publishedAt,
    registryUrl: config.registryUrl,
    registryUiUrl: config.uiUrl ?? config.registryUrl,
    deprecated,
    author,
    kind,
    // origin lives on the package.json's `cinatra` block (the same source
    // `cinatraBlock` is read from above for `kind`), NOT on the agent.json
    // `payload` — those are different documents. Passing `payload` here
    // would return null for every package because agent.json doesn't carry
    // origin metadata.
    origin: extractOriginFromCinatraPayload(cinatraBlock, packageName),
  };
}

async function registryJson<T>(
  config: VerdaccioConfig,
  relativePath: string,
  init: RequestInit = {},
): Promise<T> {
  const url = new URL(
    relativePath.replace(/^\//, ""),
    ensureTrailingSlash(config.registryUrl),
  );
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
    const error = new Error(redactToken(message, config.token)) as Error & {
      status?: number;
    };
    error.status = response.status;
    throw error;
  }

  return (await response.json()) as T;
}

export async function extractAgentPackage(
  input: {
    packageName: string;
    packageVersion?: string;
  },
  config?: VerdaccioConfig,
): Promise<ExtractedAgentPackage> {
  const resolvedConfig = ensureConfig(config, "extractAgentPackage");
  const tempDir = await mkdtemp(path.join(tmpdir(), "cinatra-agent-extract-"));

  try {
    await pacote.extract(
      packageSpec(input.packageName, input.packageVersion),
      tempDir,
      pacoteOptions(resolvedConfig),
    );

    const [manifestRaw, payloadRaw] = await Promise.all([
      readFile(path.join(tempDir, "package.json"), "utf8"),
      readFile(path.join(tempDir, "agent.json"), "utf8"),
    ]);
    const readmePath = path.join(tempDir, "README.md");
    const hasReadme = await access(readmePath).then(() => true).catch(() => false);
    const readme = hasReadme ? await readFile(readmePath, "utf8") : null;

    // Raw parse — agent-specific validation stays in packages/agents
    // (install-from-package.ts re-applies agentPackageManifestSchema /
    // agentPackagePayloadSchema).
    const manifest = JSON.parse(manifestRaw);
    const payload = JSON.parse(payloadRaw);
    const packageName =
      (getField<string>(manifest, "name") as string | undefined) ?? input.packageName;
    const packageVersion =
      (getField<string>(manifest, "version") as string | undefined) ?? (input.packageVersion ?? "");

    return {
      packageName,
      packageVersion,
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

export async function cleanupExtractedAgentPackage(tempDir: string): Promise<void> {
  await rm(tempDir, { recursive: true, force: true });
}

/**
 * Kind-agnostic extractor.
 *
 * `extractAgentPackage` above eagerly reads `agent.json` and throws for any
 * package that doesn't ship one. That made it impossible to install
 * `kind:"skill"`, `kind:"connector"`, or `kind:"artifact"` packages via the
 * same Verdaccio path. This sibling extractor reads ONLY `package.json` and
 * exposes the temp dir to the caller for per-kind walking. The skill
 * install path uses this to walk `skills/<slug>/SKILL.md` files in the
 * extracted tree.
 *
 * Caller is responsible for `cleanupExtractedPackage(tempDir)` after use.
 */
export interface ExtractedExtensionPackage {
  packageName: string;
  packageVersion: string;
  manifest: unknown;
  tempDir: string;
}

export async function extractExtensionPackage(
  input: { packageName: string; packageVersion?: string },
  config?: VerdaccioConfig,
): Promise<ExtractedExtensionPackage> {
  const resolvedConfig = ensureConfig(config, "extractExtensionPackage");
  const tempDir = await mkdtemp(path.join(tmpdir(), "cinatra-extension-extract-"));
  try {
    await pacote.extract(
      packageSpec(input.packageName, input.packageVersion),
      tempDir,
      pacoteOptions(resolvedConfig),
    );
    const manifestRaw = await readFile(path.join(tempDir, "package.json"), "utf8");
    const manifest = JSON.parse(manifestRaw) as Record<string, unknown>;
    const packageName =
      (manifest.name as string | undefined) ?? input.packageName;
    const packageVersion =
      (manifest.version as string | undefined) ?? (input.packageVersion ?? "");
    return { packageName, packageVersion, manifest, tempDir };
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

export async function cleanupExtractedPackage(tempDir: string): Promise<void> {
  await rm(tempDir, { recursive: true, force: true });
}

/**
 * Resolve the published tarball's dist integrity + the registry it lives on, for
 * the runtime install pipeline. Reads `versions[ver].dist.integrity` (the
 * npm-canonical sha512 SRI — the materialize/boot-verify ROOT OF TRUST) from the
 * packument via the SAME authed pacote path `getPublishedExtensionSummary` uses
 * (`registry.cinatra.ai` stays AUTHENTICATED — the host threads a `VerdaccioConfig`
 * from `loadVerdaccioConfigForServer()`). When the registry also carries a sha256
 * (a multi-hash SRI, or a future marketplace attestation), it is parsed out as an
 * ADDITIVE attestation — never a replacement for sha512.
 */
export async function resolveExtensionDistIntegrity(
  input: { packageName: string; packageVersion?: string },
  config?: VerdaccioConfig,
): Promise<{
  integrity: string;
  registryUrl: string;
  sha256?: string;
  /**
   * The base64 Ed25519 signature the marketplace publishes alongside the tarball,
   * read from the packument's `versions[ver].dist.cinatraSignature` (the canonical
   * packument signature field — it binds packageName + RESOLVED version + the
   * sha512 integrity, the same payload `extension-signature.ts` verifies). `null`
   * when the registry carries no signature (the pre-signing default).
   */
  signature: string | null;
  /**
   * The CONCRETE version the (possibly dist-tag) input resolved to. The signature
   * payload + provenance MUST bind this resolved version, never the caller's tag
   * input — a dist-tag install would otherwise verify against the wrong version.
   */
  resolvedVersion: string;
}> {
  const resolvedConfig = ensureConfig(config, "resolveExtensionDistIntegrity");
  const packument = (await pacote.packument(
    input.packageName,
    pacoteOptions(resolvedConfig, { fullMetadata: true }),
  )) as {
    versions?: Record<string, { dist?: { integrity?: string; cinatraSignature?: string } }>;
    "dist-tags"?: Record<string, string>;
  };
  const versions = packument.versions ?? {};
  let resolvedVersion: string | undefined;
  if (input.packageVersion) {
    if (versions[input.packageVersion]) {
      resolvedVersion = input.packageVersion;
    } else {
      // `packageVersion` may be a dist-tag (e.g. "latest", "next") rather than an
      // exact version — resolve it through the packument's dist-tags.
      const tagged = packument["dist-tags"]?.[input.packageVersion];
      if (tagged && versions[tagged]) {
        resolvedVersion = tagged;
      } else {
        throw new Error(
          `resolveExtensionDistIntegrity: version/tag ${input.packageVersion} of ${input.packageName} not found in the registry`,
        );
      }
    }
  } else {
    const keys = Object.keys(versions);
    const semverSorted = keys.filter((v) => semver.valid(v)).sort(semver.rcompare);
    resolvedVersion =
      packument["dist-tags"]?.latest ??
      semverSorted[0] ??
      keys.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
  }
  const dist = resolvedVersion ? versions[resolvedVersion]?.dist : undefined;
  const rawIntegrity = dist?.integrity;
  if (!rawIntegrity || !resolvedVersion) {
    throw new Error(
      `resolveExtensionDistIntegrity: no dist.integrity for ${input.packageName}` +
        (resolvedVersion ? `@${resolvedVersion}` : "") +
        " in the registry packument",
    );
  }
  // Model B: sha512 SRI is the trust root. The packument's `dist.integrity` may
  // carry multiple space-separated hashes (e.g. `sha512-… sha256-…`); REQUIRE a
  // sha512 candidate and return ONLY that as `integrity` (it never degrades to
  // sha256). The sha256, when present, is parsed out as an additive attestation.
  const sha512Sri = pickSha512Sri(rawIntegrity);
  if (!sha512Sri) {
    throw new Error(
      `resolveExtensionDistIntegrity: dist.integrity for ${input.packageName}` +
        (resolvedVersion ? `@${resolvedVersion}` : "") +
        ` carries no sha512 SRI (model B requires sha512 as the integrity root); got "${rawIntegrity}"`,
    );
  }
  const sha256 = parseSha256FromSri(rawIntegrity);
  // The marketplace publishes the Ed25519 signature in the packument's per-version
  // `dist.cinatraSignature` (non-secret; binds packageName + resolvedVersion +
  // sha512 integrity). Absent until the marketplace signing pipeline lands → null
  // (the consumer treats a null signature as "no signature", per the bootstrap
  // transition). A non-string value is normalized to null (defensive).
  const rawSignature = dist?.cinatraSignature;
  const signature = typeof rawSignature === "string" && rawSignature.trim() ? rawSignature : null;
  return {
    integrity: sha512Sri,
    registryUrl: resolvedConfig.registryUrl,
    ...(sha256 ? { sha256 } : {}),
    signature,
    resolvedVersion,
  };
}

/**
 * Pick the `sha512-<base64>` SRI token from a (possibly multi-hash, space-
 * separated) SRI string. sha512 is the model-B trust root, so the integrity
 * returned to the installer is always the sha512 token (never sha256).
 */
function pickSha512Sri(sri: string): string | undefined {
  for (const part of sri.trim().split(/\s+/)) {
    if (/^sha512-.+/.test(part)) return part;
  }
  return undefined;
}

/**
 * Best-effort extraction of a sha256 hash (hex) from an SRI string that may carry
 * multiple space-separated hashes (e.g. `sha512-... sha256-...`). Returns the
 * sha256 in hex if present, else undefined. The sha512 stays authoritative.
 */
function parseSha256FromSri(sri: string): string | undefined {
  for (const part of sri.trim().split(/\s+/)) {
    const m = /^sha256-(.+)$/.exec(part);
    if (m) {
      try {
        return Buffer.from(m[1], "base64").toString("hex");
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * Fetch the EXACT tarball bytes for a package (runtime installer).
 * When `expectedIntegrity` is supplied, pacote enforces the SRI and throws
 * `EINTEGRITY` on a mismatch BEFORE returning — i.e. integrity is verified over
 * the downloaded bytes. Returns the bytes + the resolved SRI so the
 * materializer can record/re-verify it. Download only — no lifecycle scripts run.
 */
export async function fetchExtensionTarballBytes(
  input: { packageName: string; packageVersion?: string; expectedIntegrity?: string },
  config?: VerdaccioConfig,
): Promise<{ bytes: Buffer; integrity: string }> {
  const resolvedConfig = ensureConfig(config, "fetchExtensionTarballBytes");
  const opts = pacoteOptions(
    resolvedConfig,
    input.expectedIntegrity ? { integrity: input.expectedIntegrity } : {},
  );
  const data = await pacote.tarball(
    packageSpec(input.packageName, input.packageVersion),
    opts,
  );
  const bytes = Buffer.from(data);
  const integrity =
    input.expectedIntegrity ??
    `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  return { bytes, integrity };
}

// ---------------------------------------------------------------------------
// Generic kind-agnostic README extractor
//
// The agent-shaped extractor above (`extractAgentPackage`) reads README as a
// side effect of its agent.json read. That path only works for `kind:"agent"`
// packages. The marketplace catalog sync worker needs to surface READMEs for
// every package kind (agent / skill / connector / artifact / workflow), so the
// extractor below works against any tarball with a `package.json` and an
// (optional) `README.md` — no kind-specific payload required.
//
// Size cap is enforced at extraction (NOT at render). The contract treats a
// synced README as UNTRUSTED input: render-side sanitization owns XSS / script
// injection; this extractor owns size-bound + "is there even a README" so the
// catalog can store a bounded `readmeMarkdown` field (or null) without surprise.
// ---------------------------------------------------------------------------

/**
 * Default size cap for synced READMEs: 256 KB.
 *
 * Rationale:
 *   - The OpenAI workspace agent template README contract caps at ~2500 bytes;
 *     the in-tree extensions ship canonical 250-2500 byte READMEs.
 *   - A 256 KB ceiling leaves headroom for vendor-authored READMEs that include
 *     screenshots-as-base64, ASCII art, or longer-form prose — but stops a
 *     denial-of-service via a multi-MB README from blowing up the catalog row,
 *     the sync worker memory, and the detail-page render path.
 *
 * Override via `maxReadmeBytes` on the call. Anything that exceeds the cap
 * resolves to `{ readme: null, oversized: true, sizeBytes: <actual> }`.
 */
export const DEFAULT_README_SIZE_CAP_BYTES = 256 * 1024;

export interface ExtractedReadme {
  /**
   * The README content as a UTF-8 string, or `null` when the package ships
   * no `README.md` OR when the README exceeds `maxReadmeBytes`.
   */
  readme: string | null;
  /** Always present — size of the README on disk (0 when missing). */
  sizeBytes: number;
  /** True when a README existed but exceeded the size cap. */
  oversized: boolean;
}

/**
 * Read `README.md` from an already-extracted package directory, applying the
 * size cap. Pure local file I/O — no Verdaccio call. Use when you already
 * called `extractExtensionPackage()` and want the README as a sibling read.
 *
 * The size check uses `fs.stat` BEFORE reading bytes so an attacker-uploaded
 * 100 MB README never lands in process memory just to be discarded.
 */
export async function readReadmeFromExtractedPackage(
  tempDir: string,
  options?: { maxReadmeBytes?: number },
): Promise<ExtractedReadme> {
  const maxReadmeBytes = options?.maxReadmeBytes ?? DEFAULT_README_SIZE_CAP_BYTES;
  const readmePath = path.join(tempDir, "README.md");
  try {
    const stats = await stat(readmePath);
    const sizeBytes = stats.size;
    if (sizeBytes > maxReadmeBytes) {
      return { readme: null, sizeBytes, oversized: true };
    }
    const readme = await readFile(readmePath, "utf8");
    return { readme, sizeBytes, oversized: false };
  } catch (error: unknown) {
    // ENOENT is the expected "no README in this package" case.
    const code = (error as { code?: string } | undefined)?.code;
    if (code === "ENOENT") {
      return { readme: null, sizeBytes: 0, oversized: false };
    }
    throw error;
  }
}

/**
 * Convenience: extract a package + read its README + clean up the temp dir.
 *
 * Use when the only thing you want is the README (the sync worker calls this
 * per package on each periodic sweep). The caller does NOT receive the temp
 * dir — it's removed before return regardless of success.
 */
export async function getPackageReadme(
  input: { packageName: string; packageVersion?: string },
  config?: VerdaccioConfig,
  options?: { maxReadmeBytes?: number },
): Promise<ExtractedReadme & { packageName: string; packageVersion: string }> {
  const resolvedConfig = ensureConfig(config, "getPackageReadme");
  const extracted = await extractExtensionPackage(input, resolvedConfig);
  try {
    const result = await readReadmeFromExtractedPackage(extracted.tempDir, options);
    return {
      ...result,
      packageName: extracted.packageName,
      packageVersion: extracted.packageVersion,
    };
  } finally {
    await cleanupExtractedPackage(extracted.tempDir);
  }
}

export async function getAgentPackage(
  input: {
    packageName: string;
    packageVersion?: string;
  },
  config?: VerdaccioConfig,
): Promise<AgentPackageDetail> {
  const resolvedConfig = ensureConfig(config, "getAgentPackage");
  const packument = (await pacote.packument(
    input.packageName,
    pacoteOptions(resolvedConfig, { fullMetadata: true }),
  )) as RegistryPackument;
  const extracted = await extractAgentPackage(input, resolvedConfig);

  try {
    const availableVersions = Object.entries(packument.versions ?? {})
      .map(([version, manifest]) => ({
        version,
        deprecated: Boolean(manifest?.deprecated),
      }))
      .sort((left, right) =>
        right.version.localeCompare(left.version, undefined, { numeric: true }),
      );

    const deprecated = Boolean(
      packument.versions?.[extracted.packageVersion]?.deprecated,
    );

    return {
      ...toSummary(resolvedConfig, extracted.manifest, extracted.payload, deprecated),
      manifest: extracted.manifest,
      payload: extracted.payload,
      readme: extracted.readme,
      distTags: packument["dist-tags"] ?? {},
      availableVersions,
    };
  } finally {
    await cleanupExtractedAgentPackage(extracted.tempDir);
  }
}

/**
 * Kind-agnostic extension-kind resolver.
 *
 * `getAgentPackage()` extracts agent.json and throws for skill/connector/
 * artifact packages (no agent payload). Install dispatch must therefore NOT
 * derive kind from a `getAgentPackage(...).catch(()=>null)` failure (that
 * silently falls back to "agent"). This reads the published package.json
 * `cinatra.kind` straight from the packument — authoritative for every kind,
 * no tarball extraction, no agent.json requirement.
 */
/**
 * Kind-agnostic packument summary.
 *
 * Returns kind + the resolved version's manifest in a single packument
 * read. Used by the extension lifecycle dispatcher to apply visibility
 * checks WITHOUT extracting the tarball (which would fail for non-agent
 * kinds via `extractAgentPackage`'s mandatory agent.json read).
 */
export interface PublishedExtensionSummary {
  kind: "agent" | "skill" | "connector" | "artifact" | "workflow" | null;
  resolvedVersion: string | null;
  manifest: Record<string, unknown> | null;
}

export async function getPublishedExtensionSummary(
  input: { packageName: string; packageVersion?: string },
  config?: VerdaccioConfig,
): Promise<PublishedExtensionSummary> {
  const resolvedConfig = ensureConfig(config, "getPublishedExtensionSummary");
  const packument = (await pacote.packument(
    input.packageName,
    pacoteOptions(resolvedConfig, { fullMetadata: true }),
  )) as RegistryPackument;
  const versions = packument.versions ?? {};
  let resolvedVersion: string | undefined;
  if (input.packageVersion) {
    if (!versions[input.packageVersion]) {
      throw new Error(
        `getPublishedExtensionSummary: version ${input.packageVersion} of ${input.packageName} not found in the registry`,
      );
    }
    resolvedVersion = input.packageVersion;
  } else {
    const keys = Object.keys(versions);
    const semverSorted = keys
      .filter((v) => semver.valid(v))
      .sort(semver.rcompare);
    resolvedVersion =
      packument["dist-tags"]?.latest ??
      semverSorted[0] ??
      keys.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
  }
  const manifest = resolvedVersion ? (versions[resolvedVersion] as Record<string, unknown> | undefined) : undefined;
  // Workflow kind is included in detection.
  const kindRaw = (manifest as { cinatra?: { kind?: unknown } } | undefined)?.cinatra?.kind;
  const kind =
    kindRaw === "agent" ||
    kindRaw === "skill" ||
    kindRaw === "connector" ||
    kindRaw === "artifact" ||
    kindRaw === "workflow"
      ? kindRaw
      : null;
  return {
    kind,
    resolvedVersion: resolvedVersion ?? null,
    manifest: manifest ?? null,
  };
}

/**
 * Resolve the highest version satisfying a semver RANGE from the packument
 * (#180 dev-path dependency resolution — live-verify finding):
 * `resolveExtensionDistIntegrity` / pacote resolve exact versions and
 * dist-tags but NOT ranges against Verdaccio. Prereleases are excluded
 * unless the range itself carries one.
 */
export async function resolveMaxSatisfyingVersion(
  input: { packageName: string; range: string },
  config?: VerdaccioConfig,
): Promise<string | null> {
  const resolvedConfig = ensureConfig(config, "resolveMaxSatisfyingVersion");
  const packument = (await pacote.packument(
    input.packageName,
    pacoteOptions(resolvedConfig, { fullMetadata: false }),
  )) as RegistryPackument;
  const versions = Object.keys(packument.versions ?? {});
  return semver.maxSatisfying(versions, input.range, { includePrerelease: false });
}

export async function getPublishedExtensionKind(
  input: { packageName: string; packageVersion?: string },
  config?: VerdaccioConfig,
): Promise<"agent" | "skill" | "connector" | "artifact" | "workflow" | null> {
  const resolvedConfig = ensureConfig(config, "getPublishedExtensionKind");
  const packument = (await pacote.packument(
    input.packageName,
    pacoteOptions(resolvedConfig, { fullMetadata: true }),
  )) as RegistryPackument;
  const versions = packument.versions ?? {};
  let resolvedVersion: string | undefined;
  if (input.packageVersion) {
    // An explicit-but-absent version is a hard error,
    // never "borrow another version's kind".
    if (!versions[input.packageVersion]) {
      throw new Error(
        `getPublishedExtensionKind: version ${input.packageVersion} of ${input.packageName} not found in the registry`,
      );
    }
    resolvedVersion = input.packageVersion;
  } else {
    const keys = Object.keys(versions);
    // True semver ordering (rcompare) over valid
    // versions — `2.0.0` must beat `2.0.0-alpha.1`, which numeric
    // localeCompare gets wrong. Non-semver keys fall back to numeric order.
    const semverSorted = keys
      .filter((v) => semver.valid(v))
      .sort(semver.rcompare);
    resolvedVersion =
      packument["dist-tags"]?.latest ??
      semverSorted[0] ??
      keys.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
  }
  const manifest = resolvedVersion ? versions[resolvedVersion] : undefined;
  const kindRaw = (manifest as { cinatra?: { kind?: unknown } } | undefined)
    ?.cinatra?.kind;
  return kindRaw === "agent" ||
    kindRaw === "skill" ||
    kindRaw === "connector" ||
    kindRaw === "artifact" ||
    kindRaw === "workflow"
    ? kindRaw
    : null;
}

/**
 * Kind-agnostic + multi-scope catalog lister.
 *
 * `listAgentPackages` is kept for backward compatibility below. It filters
 * only `resolvedConfig.packageScope` and calls `getAgentPackage` per result,
 * which extracts the tarball and throws for non-agent kinds, silently dropping
 * skill/connector/artifact packages.
 *
 * This sibling:
 *   - Accepts an OPTIONAL `allowedScopes` allowlist. When omitted (the
 *     default), NO scope pre-prune happens — every package in the
 *     registry is considered, and visibility is decided via the
 *     `viewerScope` filter applied INSIDE this function (so the `limit`
 *     slice runs AFTER filtering). The prior `[resolvedConfig.packageScope,
 *     "@anthropics"]` default silently dropped every public vendor's
 *     packages from cross-vendor browsing — operator-explicit allowlists
 *     can still be passed when admin tooling genuinely needs one.
 *   - Uses `getPublishedExtensionSummary` (kind-agnostic packument read)
 *     to build per-package metadata WITHOUT extracting the tarball, so
 *     skill/connector/artifact packages survive.
 *
 * The result shape mirrors AgentPackageSummary for caller compatibility
 * but the `kind` field is now authoritative (never null for packages
 * that declared cinatra.kind).
 */
export async function listExtensionPackages(
  options: {
    query?: string;
    limit?: number;
    offset?: number;
    allowedScopes?: string[];
    /**
     * The viewer's npm scope, used by the visibility filter for `private`
     * packages. When set, packages whose `cinatra.origin.visibility ===
     * "private"` are kept ONLY when their scope matches `viewerScope`.
     * When unset, private packages are dropped entirely (the caller has
     * no identity to match against). Public + locked_public packages are
     * always kept regardless of viewerScope; legacy packages with null
     * origin are grandfathered as public.
     *
     * Visibility filtering is done INSIDE the function so `limit` slices
     * AFTER visible packages have been identified — without this, a
     * caller asking for `limit: 20` could see zero visible rows when the
     * first 20 sorted entries are all foreign-private.
     */
    viewerScope?: string;
  } = {},
  config?: VerdaccioConfig,
): Promise<AgentPackageSummary[]> {
  const resolvedConfig = ensureConfig(config, "listExtensionPackages");
  const allPackages = await registryJson<Record<string, unknown>>(
    resolvedConfig,
    "/-/all",
  );

  // Scope filter: `allowedScopes: undefined` (or omitted) means NO scope
  // pre-prune — return every package the registry exposes, and let the
  // caller's visibility post-filter on `origin.visibility` decide what to
  // show. The prior default `[resolvedConfig.packageScope, "@anthropics"]`
  // silently dropped every public vendor's published packages from
  // cross-vendor browsing. Callers who genuinely want a fixed allowlist
  // (e.g. admin tooling) can still pass an explicit array.
  let packageNames = Object.keys(allPackages).filter((key) => !key.startsWith("_"));
  if (options.allowedScopes && options.allowedScopes.length > 0) {
    const allowedPrefixes = options.allowedScopes.map((s) => `${s}/`);
    packageNames = packageNames.filter((key) => allowedPrefixes.some((p) => key.startsWith(p)));
  }

  const query = options.query?.trim().toLowerCase();
  if (query) {
    packageNames = packageNames.filter((name) => name.toLowerCase().includes(query));
  }

  packageNames.sort();
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 20;
  // NOTE: offset/limit are applied AFTER the visibility filter below, so a
  // caller asking for `limit: 20` always sees up to 20 visible rows even
  // when the first N alphabetical packages are all foreign-private.

  const results = await Promise.allSettled(
    packageNames.map((packageName) =>
      getPublishedExtensionSummary({ packageName }, resolvedConfig).then((summary) => ({
        packageName,
        summary,
      })),
    ),
  );
  const summaries = results.flatMap((result) => {
    if (result.status !== "fulfilled") return [];
    const { packageName, summary } = result.value;
    const manifest = summary.manifest ?? {};
    const payload = ((manifest as { cinatra?: Record<string, unknown> }).cinatra ?? {}) as Record<string, unknown>;
    const m = manifest as Record<string, unknown>;
    const authorRaw = m.author;
    const authorString: string | null =
      typeof authorRaw === "string"
        ? authorRaw
        : authorRaw && typeof authorRaw === "object" && "name" in (authorRaw as object)
          ? String((authorRaw as { name?: unknown }).name)
          : null;
    const sum: AgentPackageSummary = {
      packageName,
      packageVersion: summary.resolvedVersion ?? "",
      title: (m.title as string | undefined) ?? packageName,
      description: (m.description as string | undefined) ?? null,
      changelog: null,
      riskLevel: "low",
      hasApprovalGates: false,
      toolAccess: [],
      executionMode: "agentic",
      ownerOrgId: null,
      publishedAt: "",
      registryUrl: resolvedConfig.registryUrl,
      registryUiUrl: resolvedConfig.uiUrl ?? resolvedConfig.registryUrl,
      deprecated: false,
      author: authorString ? authorString.slice(0, 120) : null,
      kind: summary.kind,
      origin: extractOriginFromCinatraPayload(payload, packageName),
    };
    return [sum];
  });
  // Apply the visibility filter BEFORE limit/offset so the caller gets up
  // to `limit` actually-visible packages.
  const visible = summaries.filter((s) => isPackageVisible(s, options.viewerScope));
  return visible.slice(offset, offset + limit);
}

/**
 * Visibility predicate matching the marketplace's vendor visibility state
 * machine: `null` (legacy) → grandfather public; `public` / `locked_public`
 * → visible to everyone; `private` → visible only to packages in
 * `viewerScope`. Centralised so listExtensionPackages, listAgentPackages,
 * and any future read paths apply identical semantics.
 *
 * Exported so unit tests can pin the contract without spinning up a real
 * Verdaccio.
 *
 * NOTE on the current "always-null-origin" state: cinatra's publish path
 * does NOT yet write `cinatra.origin` into the tarball manifest (origin
 * lives in cinatra-side DB rows post-publish). So this predicate today
 * essentially returns "visible" for every package via the legacy
 * grandfather clause. The cross-vendor read leak it can't yet prevent is
 * held back by Verdaccio's read ACL (`access: $authenticated`) and the
 * marketplace catalog's separate per-vendor visibility model. Once
 * publish-time origin injection lands, this
 * predicate becomes the real cinatra-side defense-in-depth gate.
 */
export function isPackageVisible(
  summary: AgentPackageSummary,
  viewerScope: string | undefined,
): boolean {
  if (summary.origin === null) return true;
  if (
    summary.origin.visibility === "public" ||
    summary.origin.visibility === "locked_public"
  ) {
    return true;
  }
  if (summary.origin.visibility === "private") {
    return viewerScope !== undefined && summary.origin.scope === viewerScope;
  }
  return false;
}

export async function listAgentPackages(
  options: {
    query?: string;
    limit?: number;
    offset?: number;
    /** See listExtensionPackages.viewerScope for semantics. */
    viewerScope?: string;
  } = {},
  config?: VerdaccioConfig,
): Promise<AgentPackageSummary[]> {
  const resolvedConfig = ensureConfig(config, "listAgentPackages");

  // Verdaccio v6's /-/v1/search does not support scope-based filtering.
  // Use /-/all which returns every package in the registry, then filter by scope.
  const allPackages = await registryJson<Record<string, unknown>>(
    resolvedConfig,
    "/-/all",
  );
  const scopePrefix = `${resolvedConfig.packageScope}/`;
  let packageNames = Object.keys(allPackages).filter(
    (key) => !key.startsWith("_") && key.startsWith(scopePrefix),
  );

  const query = options.query?.trim().toLowerCase();
  if (query) {
    packageNames = packageNames.filter((name) => name.toLowerCase().includes(query));
  }

  // Sort alphabetically. Pagination is applied AFTER the visibility filter
  // below so the caller gets up to `limit` actually-visible rows.
  packageNames.sort();
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 20;

  const results = await Promise.allSettled(
    packageNames.map((packageName) => getAgentPackage({ packageName }, resolvedConfig)),
  );
  const items = results.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  const summaries = items.map(
    ({
      manifest: _manifest,
      payload: _payload,
      readme: _readme,
      distTags: _distTags,
      availableVersions: _versions,
      ...summary
    }) => summary,
  );
  // Callers MUST pass an explicit `viewerScope` resolved via the canonical
  // helper (`getEffectiveViewerScope`) when private-visibility access is
  // required. The historical fallback to `resolvedConfig.packageScope` was
  // spoofable: the config's packageScope is derived from the freely-editable
  // `instanceNamespace`, so a not-yet-approved consumer could see private
  // packages of any scope they renamed themselves to. No fallback now — an
  // undefined viewerScope means public-only view, matching the helper's
  // semantics for unprivileged callers.
  const visible = summaries.filter((s) =>
    isPackageVisible(s, options.viewerScope),
  );
  return visible.slice(offset, offset + limit);
}

// Re-export helpers that may be useful to callers building custom
// registry-level interactions while keeping the write-side functions
// in packages/agents. Kept for completeness.
export { encodePackageName, redactToken };

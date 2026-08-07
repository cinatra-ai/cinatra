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
import * as pacoteImpl from "pacote";
import { c as tarCreate } from "tar";
import { requireVerdaccioToken, type VerdaccioConfig } from "./config";
import { createRedactingPacote, ensureConfig, registryScopedAuthOptions } from "@cinatra-ai/registries";

/**
 * Redacting facade over pacote — see @cinatra-ai/registries verdaccio/registry-auth.
 * Since pacote 22 / npm-registry-fetch 20 a registry response body's `message`
 * is folded into the thrown `Error.message`, so a registry or proxy that echoes
 * the inbound request would otherwise surface the bearer token there. Every
 * pacote call in this module goes through this binding, never the raw module.
 */
const pacote = createRedactingPacote(pacoteImpl);
import { buildRegistryAuthArgs } from "./cli-flags";
import { buildAgentPackageFiles, type BuildAgentPackageInput } from "./package-files";
import { compileOasAgentJson } from "../oas-compiler";
import {
  ARTIFACT_PRODUCES_ENFORCEMENT,
  evaluateProducesMaterializationContract,
  resolveTypedProducesContract,
  agentProducesSchema,
  artifactDepVersionQuery,
} from "./package-contract";
// The AUTHORITATIVE `cinatra.consumes` parser is imported DYNAMICALLY inside
// carryManifestConsumes (route-graph ratchet: keeps the sdk consumes module
// off every locked route's static graph); only the erased type rides here.
import type { ConsumedPrimitive } from "@cinatra-ai/sdk-extensions/consumes";

export type PublishAgentPackageInput = BuildAgentPackageInput;

/**
 * Carry a source package.json's `cinatra.consumes` declarations into the
 * publisher's REBUILT cinatra block (cinatra#1032 deliverable 3).
 *
 * ONE truth source: the SDK's `parseConsumedPrimitives` validates — a
 * malformed block (non-array, explicit null, malformed entry, blank
 * primitive, duplicate primitive) THROWS `ConsumesManifestError` and ABORTS
 * the publish; nothing is silently dropped or normalized into validity.
 * Well-formed entries are projected to the exact `{ primitive, requirement }`
 * contract shape (extra keys are claims-metadata the contract does not carry).
 * Returns `undefined` when the source declares nothing (absence stays
 * absent), and `[]` when the source EXPLICITLY declares an empty array
 * (declared-nothing is preserved, not erased).
 */
export async function carryManifestConsumes(
  gitPkgJson: Record<string, unknown>,
  packageName: string,
): Promise<ConsumedPrimitive[] | undefined> {
  const raw = (gitPkgJson.cinatra as Record<string, unknown> | undefined)?.consumes;
  if (raw === undefined) return undefined;
  const { parseConsumedPrimitives } = await import("@cinatra-ai/sdk-extensions/consumes");
  return parseConsumedPrimitives({ name: packageName, cinatra: { consumes: raw } }, { packageName });
}

/**
 * Carry the source `cinatra.logo` into the generated distribution manifest
 * (cinatra#2469 — "every extension kind must be able to self-define
 * `cinatra.logo`"; maintainer decision 2026-08-06).
 *
 * `publishAgentPackageFromGitDir` BUILDS A FRESH `cinatra` block rather than
 * spreading the source one, so any field not explicitly carried is LOST on
 * publish — the same trap `produces`, `consumes` and `license` each needed their
 * own carry for. For `logo` the loss was especially quiet: `walkPackageFiles`
 * copies the package's `logo.svg` INTO the tarball while the synthesized
 * package.json replaces the on-disk one, so the ASSET shipped and its manifest
 * POINTER was erased, leaving a dangling logo. A logo-less manifest generates
 * `logo: null`, and the card reverts to the generic kind emblem — exactly the
 * silent degradation #1482/#2467 made loud everywhere else.
 *
 * (The erasure was not repaired downstream either: installation projects the
 * tarball through the materializer's own allowlisted file set, the same reason
 * `license` and the LICENSE/NOTICE files each needed their own explicit carry
 * there. Deliberately NOT restating which directory that projection targets —
 * the long-standing prose in `_copyRuntimeFiles` says "the source dir" and codex
 * round-2 reports that is stale post-#793; the carry is required either way, so
 * this comment does not depend on resolving it.)
 *
 * The ASSET half of the round-trip is closed in `materialize-agent-package.ts`
 * (`_copyDeclaredLogo`): carrying the pointer without carrying the file it
 * points at would only move the breakage one step later.
 *
 * Carried as an OPAQUE STRING and deliberately NOT resolved/sanitized here (the
 * same data-only discipline the artifact allowlist uses). The path's safety —
 * `.svg`-only, in-package containment, symlink escape, size budget and the SVG
 * sanitizer verdict — is owned FAIL-CLOSED by `resolveDeclaredLogo` at
 * manifest-generation time, which is also the ONLY producer of the inline data
 * URI any surface renders.
 *
 * ABSENT (missing or explicit `null`) → `undefined`: absence stays absence, the
 * documented default, byte-mirroring `resolveDeclaredLogo`'s no-error pair.
 *
 * PRESENT but malformed (non-string, blank) → THROWS, exactly like
 * `carryManifestConsumes`. An earlier version returned `undefined` for these,
 * which looked conservative and was the opposite: it made a broken declaration
 * indistinguishable from an absent one, so the generator downstream had nothing
 * left to fail loudly on — the silent degradation #1482/#2467 exist to end,
 * reintroduced at the publish seam.
 */
export function carryManifestLogo(gitPkgJson: Record<string, unknown>): string | undefined {
  const cinatra = gitPkgJson.cinatra;
  if (typeof cinatra !== "object" || cinatra === null || Array.isArray(cinatra)) return undefined;
  const raw = (cinatra as Record<string, unknown>).logo;
  // ABSENT (missing or explicit null) is the documented default — byte-mirroring
  // `resolveDeclaredLogo`, which returns `{dataUri:null, error:null}` for exactly
  // those two and an ERROR for everything else malformed.
  if (raw === undefined || raw === null) return undefined;
  // PRESENT but malformed is an authoring error, and it must NOT be laundered
  // into `undefined` (codex round-6): dropping it here publishes a manifest
  // indistinguishable from one that never declared a logo, so the generator
  // downstream has nothing left to fail loudly on — the silent degradation
  // #1482/#2467 exist to end, reintroduced at the publish seam.
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error(
      `cinatra.logo must be a non-empty package-relative ".svg" path ` +
        `(got ${typeof raw === "string" ? "an empty/blank string" : typeof raw})`,
    );
  }
  return raw;
}

/**
 * Refuse a publish whose carried `cinatra.logo` names a file that would NOT
 * ship in the tarball (cinatra#2469, codex round-2).
 *
 * `walkPackageFiles` — the single source of truth for "publishable files" — skips
 * generated directories (`dist/`, `build/`, `out/`, `node_modules/`, …), symlinks
 * and blocked `.env*` files. A declaration pointing into one of those satisfies
 * the generator's containment + `.svg` + sanitizer checks on the AUTHORING tree
 * and is still absent from the published package, so the manifest ships a
 * POINTER with no REFERENT — a dangling logo that renders as the generic kind
 * emblem for every consumer, with no signal to the author.
 *
 * THROWS rather than dropping the declaration, matching the `produces` /
 * `consumes` posture in this module: silently un-declaring the logo would be
 * indistinguishable from never declaring one, which is precisely the silent
 * degradation #1482/#2467 exist to end. The message names the offending path and
 * the fix.
 *
 * PATH SEMANTICS — deliberately IDENTICAL to the two components that will later
 * consume the published declaration, and NOT a bespoke string normalization
 * (codex round-3 BLOCKER on an earlier version that trimmed and folded `\` to
 * `/` for the COMPARISON while the manifest published the string VERBATIM):
 * the declaration is resolved against the package root exactly as
 * `resolveDeclaredLogo` (`scripts/extensions/generate-extension-manifest.mjs`)
 * and `_copyDeclaredLogo` (`materialize-agent-package.ts`) resolve it, and the
 * resulting package-relative path is compared to the walker's own `relPath`s.
 *
 * That mismatch was not cosmetic in either direction:
 *   - `"  ./logo.svg  "` and `"assets\\brand\\mark.svg"` PASSED the string form
 *     while the verbatim pointer resolves to NOTHING on POSIX — certifying one
 *     file and publishing a reference to another;
 *   - `"././logo.svg"`, `"assets/../logo.svg"` and duplicate separators were
 *     REJECTED even though the generator resolves all of them fine.
 * Resolving instead of rewriting makes both classes correct by construction.
 *
 * `relPaths` are POSIX-style package-relative paths as `walkPackageFiles`
 * produces them; a path that escapes `packageRoot` is refused outright (the
 * generator refuses it too, so it could never render).
 */
export function assertDeclaredLogoShips({
  logo,
  packageRoot,
  relPaths,
  packageName,
}: {
  logo: string | undefined;
  packageRoot: string;
  relPaths: readonly string[];
  packageName: string;
}): void {
  if (logo === undefined) return;
  // `.svg` on the TRIMMED value, path resolved RAW — the third copy of the one
  // rule (generator `resolveDeclaredLogo`, materializer `_copyDeclaredLogo`).
  // Without it the publisher was the LOOSE link (codex round-5): a shipped
  // `./logo.png` passed publish, then the generator rejects it outright and the
  // materializer skips it — a manifest published in a state its own consumers
  // cannot build. Refusing here reports the mistake to the author who made it.
  if (!logo.trim().toLowerCase().endsWith(".svg")) {
    throw new Error(
      `${packageName}: cinatra.logo "${logo}" is not a ".svg" path — the host inlines a sanitized SVG, ` +
        `no other format is read. Point the declaration at an SVG asset, or remove it.`,
    );
  }
  const abs = path.resolve(packageRoot, logo);
  const rootWithSep = path.resolve(packageRoot) + path.sep;
  if (abs.startsWith(rootWithSep)) {
    // Fold to the walker's POSIX relPath form for the lookup only — the value
    // PUBLISHED is still the author's verbatim string.
    const rel = path.relative(packageRoot, abs).split(path.sep).join("/");
    if (relPaths.includes(rel)) return;
  }
  throw new Error(
    `${packageName}: cinatra.logo "${logo}" does not resolve to a file that ships in the published package ` +
      `(the publishable file set excludes generated dirs like dist/build/out, symlinks, and .env* files). ` +
      `Move the asset into a published path (e.g. ./logo.svg or ./assets/logo.svg), or remove the declaration.`,
  );
}

/**
 * Carry the source `cinatra.displayName` / `cinatra.vendor` into the
 * generated distribution manifest (cinatra#2494 — same class as `cinatra.logo`
 * cinatra#2469 above: `publishAgentPackageFromGitDir` BUILDS A FRESH `cinatra`
 * block rather than spreading the source one, so any field not explicitly
 * carried is LOST on publish). #2469's own PR named this exact gap and scoped
 * it out deliberately, with codex agreement: "the sibling card-identity keys
 * admitted cross-kind by #1570/#1605 … are also not carried through the agent
 * publisher's manifest rebuild. That is pre-existing and identical in kind,
 * but outside #2469's mandate. Worth its own issue." This is that issue.
 *
 * Both fields are CROSS-KIND PRESENTATION metadata
 * (`ARTIFACT_ALLOWED_CINATRA_KEYS` in `@cinatra-ai/sdk-extensions/artifact-contract`)
 * carried through UNVALIDATED beyond shape — ownership/uniqueness is the
 * marketplace publish gate's job, not this publisher's or the SDK's (see that
 * file's `vendor`/`displayName` doc comment). Unlike `logo` there is no
 * separate ASSET a pointer can dangle from — both values live entirely inside
 * package.json — so there is no ship-check counterpart to
 * `assertDeclaredLogoShips` needed here, and no asset-copy counterpart to
 * `materialize-agent-package.ts`'s `_copyDeclaredLogo`: once the value
 * survives this rebuild, it rides package.json through every downstream
 * layer (tarball, install, the required-agent seed's wholesale
 * `PROJECTED_FILES = ["package.json"]` copy) exactly like every other
 * already-carried field (`produces`, `consumes`, `license`, `logo`).
 *
 * Mirrors the manifest generator's own resolution
 * (`resolveDisplayName`/`resolveVendor` in
 * `scripts/extensions/generate-extension-manifest.mjs`) rather than
 * `carryManifestLogo`'s fail-loud posture: a non-empty TRIMMED string for
 * `displayName`, a `{key,name}` object with both non-empty TRIMMED strings for
 * `vendor`. Anything else (wrong type, blank, explicit `null`, a malformed
 * vendor shape) resolves to ABSENT rather than throwing — these are soft
 * presentation hints the generator itself only ever silently degrades to
 * `null` for, unlike `logo`'s build-time fail-closed contract, so there is no
 * "malformed declaration laundered into silence" failure mode to guard
 * against here the way there is for `logo`.
 *
 * The DECLARATIVE (artifact|skill) publisher (`publishExtensionPackageFromDir`)
 * needs no equivalent call: it spreads `incomingCinatra` VERBATIM, so it never
 * dropped these fields — that publisher's `carryManifestLogo` call exists to
 * layer `logo`'s fail-closed VALIDATION on top of that verbatim spread, a
 * concern `displayName`/`vendor` do not have.
 */
export function carryManifestDisplayName(gitPkgJson: Record<string, unknown>): string | undefined {
  const cinatra = gitPkgJson.cinatra;
  if (typeof cinatra !== "object" || cinatra === null || Array.isArray(cinatra)) return undefined;
  const raw = (cinatra as Record<string, unknown>).displayName;
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

export function carryManifestVendor(
  gitPkgJson: Record<string, unknown>,
): { key: string; name: string } | undefined {
  const cinatra = gitPkgJson.cinatra;
  if (typeof cinatra !== "object" || cinatra === null || Array.isArray(cinatra)) return undefined;
  const raw = (cinatra as Record<string, unknown>).vendor;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const rawVendor = raw as Record<string, unknown>;
  const key = typeof rawVendor.key === "string" ? rawVendor.key.trim() : "";
  const name = typeof rawVendor.name === "string" ? rawVendor.name.trim() : "";
  if (key.length === 0 || name.length === 0) return undefined;
  return { key, name };
}

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

/**
 * Options for the pacote calls in this module. Credentials MUST be passed as
 * a registry-scoped `'//<host>/:_authToken'` key — npm-registry-fetch ignores
 * a flat `token` option entirely (#179; see registryScopedAuthOptions in
 * @cinatra-ai/registries, where the regression is pinned by tests).
 */
function pacoteOptions(config: VerdaccioConfig, extra: Record<string, unknown> = {}) {
  return {
    registry: ensureTrailingSlash(config.registryUrl),
    ...registryScopedAuthOptions(config.registryUrl, config.token),
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
      Object.entries(packageFiles.files).map(async ([fileName, contents]) => {
        const dest = path.join(tempDir, fileName);
        // File keys may be nested (e.g. "cinatra/oas.json"); ensure the parent
        // directory exists before writing. Top-level keys mkdir tempDir (a
        // no-op). readdir(tempDir) below returns "cinatra" as a top-level entry
        // and tar recurses into it, so the nested file is included.
        await mkdir(path.dirname(dest), { recursive: true });
        await writeFile(dest, contents, "utf8");
      }),
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
    // Publish directly via the npm registry HTTP protocol with an explicit
    // Bearer header (registryJson) instead of adding a libnpmpublish
    // dependency. NOTE: npm-registry-fetch DOES send credentials when given
    // registry-scoped '//<host>/:_authToken' option keys (see
    // registryScopedAuthOptions); the historical "doesn't pick up our token"
    // rationale described the flat `token` option shape, which it ignores (#179).
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
  let oasSourcePath: string | null = null;
  let raw: string | null = null;
  for (const candidate of [
    path.join(input.agentDir, "cinatra", "oas.json"),
    path.join(input.agentDir, "cinatra", "agent.json"),
    path.join(input.agentDir, "agent.json"),
  ]) {
    try {
      raw = await readFile(candidate, "utf8");
      oasSourcePath = candidate;
      break;
    } catch {
      // try next rung
    }
  }
  if (!oasSourcePath || raw === null) {
    throw new Error(`Cannot read oas.json or agent.json from ${input.agentDir}`);
  }
  let gitAgentJson: Record<string, unknown>;
  try {
    gitAgentJson = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`Failed to parse ${oasSourcePath}`);
  }

  const cinatra = ((gitAgentJson.metadata as Record<string, unknown> | undefined)?.cinatra ?? {}) as Record<string, unknown>;
  const agentId = typeof gitAgentJson.id === "string" ? gitAgentJson.id : randomUUID();
  const description = typeof gitPkgJson.description === "string" ? gitPkgJson.description : null;

  // Compile the OAS flow to derive approvalPolicy, inputSchema, taskSpec, and type.
  // Flow-type agents don't store these in metadata.cinatra — they're derived from the
  // flow graph at compile time. Fall back to metadata.cinatra values if compilation
  // fails (e.g. leaf agents whose oasSourcePath is already fully baked).
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
  // Carry the source `cinatra.produces` declaration through the generated
  // distribution manifest. The closed `cinatraAgentPackageMetadataSchema`
  // strips unknown keys, and this path BUILDS a fresh cinatra block (it does
  // not spread the source), so — like `dependencies`/`kind` above — `produces`
  // must be emitted explicitly or it is lost on publish. Losing it breaks the
  // run-completion materializer, which reads `cinatra.produces` from the
  // INSTALLED manifest to authorize each declared artifact (cinatra#923/#924).
  // FAIL-CLOSED (cinatra#1788): validate the source `cinatra.produces` block
  // with the SAME strict schema the install path enforces. A malformed entry
  // (bad `extension`, a smuggled key, or a present-but-malformed `objectTypeId`)
  // is REFUSED here — never silently laundered into a coarse `{ extension }`
  // entry that would then pass the typed-production contract. The validated
  // entries are emitted verbatim into distManifest.cinatra.produces below,
  // preserving the exact typed-production discriminator. Absent produces → [].
  const producesRaw = (gitPkgJson.cinatra as Record<string, unknown> | undefined)?.produces;
  let producesEntries: Array<{ extension: string; objectTypeId?: string }> = [];
  if (producesRaw !== undefined) {
    const parsedProduces = agentProducesSchema.safeParse(producesRaw);
    if (!parsedProduces.success) {
      throw new Error(
        `publishAgentPackageFromGitDir: invalid cinatra.produces for ${packageName}@${packageVersion} ` +
          `(cinatra#1788): ${parsedProduces.error.issues
            .map((i) => `${i.path.join(".") || "<root>"} ${i.message}`)
            .join("; ")}`,
      );
    }
    producesEntries = parsedProduces.data;
  }
  // Carry the source `cinatra.consumes` declarations through the generated
  // distribution manifest (same reasoning as `produces` above: this path
  // BUILDS a fresh cinatra block, so an un-carried field is lost on publish).
  // Losing it would erase a capability-binding claim the host enforces — the
  // pm-work-store PM-seat gate (cinatra#1032 deliverable 3) reads
  // `cinatra.consumes` from the INSTALLED manifest. ONE truth source, FAIL
  // LOUD: the SDK parser (parseConsumedPrimitives) validates — a malformed
  // block ABORTS the publish (silently dropping or laundering a
  // capability-binding claim is exactly the failure mode the field closes).
  // An explicitly-present empty array is PRESERVED (declared-nothing !=
  // undeclared); absence stays absent.
  const consumesEntries = await carryManifestConsumes(gitPkgJson, packageName);
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

  // Carry the source `cinatra.logo` through the generated distribution manifest
  // (cinatra#2469). Same class of trap as `produces`/`consumes`/`license` above:
  // this path BUILDS a FRESH cinatra block, so an un-carried field is lost on
  // publish. See `carryManifestLogo` for the full failure mode it closes.
  const logo = carryManifestLogo(gitPkgJson);
  // Carry the source `cinatra.displayName` / `cinatra.vendor` through the
  // generated distribution manifest (cinatra#2494 — the sibling card-identity
  // keys #2469 scoped out of its own mandate). Same class of trap: this path
  // BUILDS a FRESH cinatra block, so an un-carried field is lost on publish.
  // See `carryManifestDisplayName` / `carryManifestVendor` for the full
  // reasoning.
  const displayName = carryManifestDisplayName(gitPkgJson);
  const vendor = carryManifestVendor(gitPkgJson);

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
      ...(producesEntries.length > 0 ? { produces: producesEntries } : {}),
      ...(consumesEntries !== undefined ? { consumes: consumesEntries } : {}),
      // cinatra#2469: the agent's self-declared card logo survives the rebuild.
      ...(logo !== undefined ? { logo } : {}),
      // cinatra#2494: the agent's self-declared card displayName/vendor
      // survive the rebuild — same class of fix, same rebuild site as logo.
      ...(displayName !== undefined ? { displayName } : {}),
      ...(vendor !== undefined ? { vendor } : {}),
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

  // Layer 2 (cinatra#924) — publish-time produces-materialization contract.
  // Phase 1 is ADVISORY: a produces-declaring package with no materialization
  // edge logs a WARN and still publishes (the compile gate already hard-blocks
  // a malformed binding; an un-migrated repo is never refused here). The
  // Phase-2 flip to BLOCK is a one-line owner-gated change of
  // `ARTIFACT_PRODUCES_ENFORCEMENT` in package-contract.ts, after the fleet
  // migration completes.
  if (producesEntries.length > 0) {
    const contractFindings = evaluateProducesMaterializationContract({
      produces: producesEntries.map((e) => e.extension),
      oasDoc: gitAgentJson,
    });
    if (contractFindings.length > 0) {
      const summary = contractFindings
        .map((f) => `${f.code}: ${f.message}`)
        .join(" | ");
      if (ARTIFACT_PRODUCES_ENFORCEMENT === "block") {
        throw new Error(
          `publishAgentPackageFromGitDir: produces-materialization contract failed for ` +
            `${packageName}@${packageVersion} (cinatra#924 BLOCK phase): ${summary}`,
        );
      }
      console.warn(
        `[artifact-produces-contract] ${packageName}@${packageVersion}: ` +
          `${contractFindings.length} advisory finding(s) (WARN phase — cinatra#924): ${summary}`,
      );
    }
  }

  // Layer 3 (cinatra#1788, epic #1785) — publish-time TYPED-PRODUCTION contract,
  // enforced FAIL-CLOSED (no WARN phase — see package-contract.ts Layer 3, and
  // the install preflight in install-from-package.ts). Every `cinatra.produces`
  // entry must resolve to a REQUIRED artifact-kind dependency
  // (`cinatra.dependencies`, kind:"artifact") whose PUBLISHED manifest declares
  // the referenced object-type claim (the exact objectTypeId when present). The
  // required dependency manifests resolve from the registry (the same summary
  // the install closure planner reads); an unresolvable required dependency
  // contributes no claims → the typed entry BLOCKS. Runs BEFORE the tarball is
  // built and published (nothing is in the registry yet), so a refusal publishes
  // nothing. The dynamic import keeps the read-side summary off this write-side
  // module's static graph.
  if (producesEntries.length > 0) {
    const typedFindings = await resolveTypedProducesContract({
      produces: producesEntries,
      cinatraDependencies: cinatraDeps,
      resolveManifest: async (dep, versionConstraint) => {
        const { getPublishedExtensionSummary, resolveMaxSatisfyingVersion } = await import(
          "@cinatra-ai/registries"
        );
        try {
          // Resolve the manifest at the EXACT version the edge PINS — never
          // `latest`. An unsatisfiable range or a non-registry pin (git-ref /
          // malformed) FAILS CLOSED (return null → typed entry BLOCKS).
          const q = artifactDepVersionQuery(versionConstraint);
          let packageVersion: string;
          if ("exact" in q) {
            packageVersion = q.exact;
          } else if ("range" in q) {
            const resolved = await resolveMaxSatisfyingVersion(
              { packageName: dep, range: q.range },
              resolvedConfig,
            );
            if (!resolved) return null; // no satisfying version → fail closed
            packageVersion = resolved;
          } else {
            return null; // git-ref / malformed constraint → fail closed
          }
          const summary = await getPublishedExtensionSummary(
            { packageName: dep, packageVersion },
            resolvedConfig,
          );
          return summary.manifest;
        } catch {
          return null;
        }
      },
    });
    if (typedFindings.length > 0) {
      throw new Error(
        `publishAgentPackageFromGitDir: typed-production contract failed for ` +
          `${packageName}@${packageVersion} (cinatra#1788): ` +
          `${typedFindings.map((f) => f.message).join(" | ")}`,
      );
    }
  }

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
    // A carried `cinatra.logo` must name a file that ACTUALLY SHIPS (cinatra#2469,
    // codex round-2 BLOCKER). `walkPackageFiles` excludes generated dirs
    // (dist/, build/, out/, node_modules/, …), so a declaration like
    // `./dist/brand.svg` can satisfy the generator's containment + sanitizer
    // checks and still be absent from the tarball — publishing the POINTER
    // without its REFERENT, the exact dangling state this whole change closes.
    // FAIL LOUD (the `produces`/`consumes` posture), never silently drop the
    // declaration: a silently-dropped logo is indistinguishable from never
    // having declared one, which is the failure mode #1482/#2467 exist to end.
    //
    // Derived from the ACTUAL copy set, not the raw walk (codex round-4): the
    // loop below additionally drops the synthesized package.json/agent.json and
    // every `isEnvBlocked` file, so asserting against the unfiltered walk would
    // certify a file the tarball does not in fact contain. Same predicate, one
    // definition, so the two cannot drift.
    const shipsInTarball = (f: { relPath: string; isEnvBlocked: boolean }): boolean =>
      f.relPath !== "package.json" && f.relPath !== "agent.json" && !f.isEnvBlocked;
    assertDeclaredLogoShips({
      logo,
      packageRoot: input.agentDir,
      relPaths: publishableFiles.filter(shipsInTarball).map((f) => f.relPath),
      packageName,
    });
    for (const file of publishableFiles) {
      // Top-level package.json + agent.json are synthesized above (distManifest
      // + distPayload), so skip the original-on-disk versions. .env* files
      // (other than .env.example) MUST NOT ship — the sibling scan would have
      // rejected the package at the gate; this is defense-in-depth.
      if (!shipsInTarball(file)) continue;
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

/**
 * Publish a DECLARATIVE extension package directory (SDK-P5).
 *
 * Distinct from `publishAgentPackageFromGitDir`: it does NOT require/compile a
 * `cinatra/oas.json` and does NOT build the agent-shaped distManifest/distPayload
 * (no agent_templates coupling). It publishes the source package dir as-is for
 * a declarative kind (artifact / skill) — reading name/version/cinatra
 * from the dir's package.json, carrying the `cinatra` block through to the
 * distribution manifest, and reusing the same tarball-from-dir + npm-registry
 * PUT path. Connector (code-bearing) kinds are NOT accepted — they are gated on
 * SDK-P0 (#162). The same last-resort credential sibling-scan as the agent path
 * runs before any tarball is built.
 */
const DECLARATIVE_PUBLISHABLE_KINDS = new Set(["artifact", "skill"]);

export async function publishExtensionPackageFromDir(
  input: {
    packageDir: string;
    /** The declarative kind being published. Must match the dir's package.json#cinatra.kind. */
    kind: "artifact" | "skill";
  },
  config?: VerdaccioConfig,
): Promise<PublishAgentPackageResult> {
  const resolvedConfig = ensureConfig(config, "publishExtensionPackageFromDir");
  if (!DECLARATIVE_PUBLISHABLE_KINDS.has(input.kind)) {
    throw new Error(
      `publishExtensionPackageFromDir only publishes declarative kinds (artifact|skill); got "${input.kind}".`,
    );
  }

  // Last-resort credential guard — identical posture to publishAgentPackageFromGitDir.
  const { scanPackageSiblingFilesForLiteralSecrets } = await import("../scan-package-siblings");
  const lastResortFindings = await scanPackageSiblingFilesForLiteralSecrets(input.packageDir);
  const lastResortBlockers = lastResortFindings.filter((f) => f.severity === "blocker");
  if (lastResortBlockers.length > 0) {
    const summary = lastResortBlockers.slice(0, 3).map((b) => b.location ?? b.code).join(", ");
    throw new Error(
      `publishExtensionPackageFromDir refusing to publish package with ${lastResortBlockers.length} credential/forbidden-file blocker${lastResortBlockers.length === 1 ? "" : "s"} (${summary}${lastResortBlockers.length > 3 ? ", …" : ""}).`,
    );
  }

  const pkgJsonPath = path.join(input.packageDir, "package.json");
  let pkgJson: Record<string, unknown>;
  try {
    pkgJson = JSON.parse(await readFile(pkgJsonPath, "utf8")) as Record<string, unknown>;
  } catch {
    throw new Error(`Cannot read package.json from ${input.packageDir}`);
  }

  const packageName = typeof pkgJson.name === "string" ? pkgJson.name : null;
  const packageVersion = typeof pkgJson.version === "string" ? pkgJson.version : null;
  if (!packageName || !packageVersion) {
    throw new Error("package.json must have name and version fields.");
  }

  const incomingCinatra =
    pkgJson.cinatra && typeof pkgJson.cinatra === "object" && !Array.isArray(pkgJson.cinatra)
      ? (pkgJson.cinatra as Record<string, unknown>)
      : {};
  if (incomingCinatra.kind !== input.kind) {
    throw new Error(
      `package.json#cinatra.kind ("${String(incomingCinatra.kind ?? "<missing>")}") does not match the requested publish kind "${input.kind}".`,
    );
  }

  // Overwrite guard — refuse to publish a version that already exists.
  if (await isVersionPublished(resolvedConfig, packageName, packageVersion)) {
    return { packageName, packageVersion, registryUrl: resolvedConfig.registryUrl, published: false, alreadyPublished: true };
  }

  const license =
    typeof pkgJson.license === "string" && pkgJson.license.trim().length > 0 ? pkgJson.license : undefined;

  // Distribution manifest carries the declarative `cinatra` block through
  // verbatim (kind + apiVersion are authoritative; additive fields such as
  // dependencies pass through) so the registry manifest reader reports the
  // correct kind and the marketplace `?tab=<kind>` filter includes the package.
  const distManifest: Record<string, unknown> = {
    name: packageName,
    version: packageVersion,
    ...(typeof pkgJson.description === "string" ? { description: pkgJson.description } : {}),
    ...(license ? { license } : {}),
    keywords: ["cinatra", `cinatra-${input.kind}`],
    publishConfig: { registry: resolvedConfig.registryUrl },
    cinatra: {
      ...incomingCinatra,
      kind: input.kind,
      apiVersion: "cinatra.ai/v1",
    },
  };

  // Build the tarball from the SAME publishable-file set the sibling scan used
  // (walkPackageFiles is the single source of truth: it skips generated dirs,
  // node_modules, symlinks (anti-escape), and blocked .env* files, and tags
  // binaries for verbatim copy). This is the exact discipline
  // publishAgentPackageFromGitDir uses — a plain `cp -R` would reintroduce the
  // skipped-but-copied class. package.json is synthesized (distManifest), so
  // the on-disk original is skipped.
  const { walkPackageFiles } = await import("../scan-package-siblings");
  const tempDir = await mkdtemp(path.join(tmpdir(), "cinatra-ext-publish-"));
  try {
    const publishableFiles = await walkPackageFiles(input.packageDir);
    // The DECLARATIVE (artifact|skill) half of the cinatra#2469 logo contract.
    // This publisher spreads `incomingCinatra` VERBATIM, so unlike the agent
    // path it never dropped `cinatra.logo` — but it also never checked that the
    // declared asset SHIPS, leaving artifacts and skills able to publish a
    // dangling `./dist/brand.svg` or a `.svg`-less path that the generator will
    // then refuse to build (codex round-6). #2469 is explicitly cross-kind, so
    // the same two-step the agent publisher runs applies here: validate the
    // declaration shape, then prove its referent is in the tarball.
    const extShipsInTarball = (f: { relPath: string; isEnvBlocked: boolean }): boolean =>
      f.relPath !== "package.json" && !f.isEnvBlocked;
    assertDeclaredLogoShips({
      logo: carryManifestLogo({ cinatra: incomingCinatra }),
      packageRoot: input.packageDir,
      relPaths: publishableFiles.filter(extShipsInTarball).map((f) => f.relPath),
      packageName,
    });
    for (const file of publishableFiles) {
      // package.json is synthesized below (distManifest); .env* files must not ship.
      if (!extShipsInTarball(file)) continue;
      const dstPath = path.join(tempDir, file.relPath);
      await mkdir(path.dirname(dstPath), { recursive: true });
      if (file.isBinary) {
        await writeFile(dstPath, await readFile(file.absPath));
      } else {
        await writeFile(dstPath, await readFile(file.absPath, "utf8"), "utf8");
      }
    }
    await writeFile(path.join(tempDir, "package.json"), JSON.stringify(distManifest, null, 2) + "\n", "utf8");

    const entries = await readdir(tempDir);
    const tarballData: Buffer = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      tarCreate({ gzip: true, cwd: tempDir, prefix: "package" }, entries)
        .on("data", (chunk: Buffer) => chunks.push(chunk))
        .on("end", () => resolve(Buffer.concat(chunks)))
        .on("error", (err: unknown) => reject(err));
    });

    const tarballBase64 = tarballData.toString("base64");
    const tarballName = `${packageName}-${packageVersion}.tgz`;
    const { createHash } = await import("node:crypto");
    const tarballShasum = createHash("sha1").update(tarballData).digest("hex");
    const tarballIntegrity = `sha512-${createHash("sha512").update(tarballData).digest("base64")}`;
    const publishBody = {
      _id: packageName,
      name: packageName,
      "dist-tags": { latest: packageVersion },
      versions: {
        [packageVersion]: {
          ...distManifest,
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

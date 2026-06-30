// Install-only agent-payload resolver — closes the install-time tarball
// contract gap for agent packages published through the GIT-TAG RELEASE
// pipeline.
//
// THE GAP. A published `@cinatra-ai/*-agent` tarball ships an OAS Flow document
// at `cinatra/oas.json` and (for git-tag-released agents) NO root `agent.json`.
// The shared extractor (`@cinatra-ai/registries` `extractAgentPackage` →
// `readAgentPayloadFromExtractedPackage`) deliberately returns the OAS document
// as `payload` so the read-only marketplace DETAIL page renders (cinatra#582).
// But the INSTALL path (`install-from-package.ts`) then runs the STRICT
// `agentPackagePayloadSchema.parse(payload)`, which requires a
// `formatVersion: 2` DISTRIBUTION payload (`template{compiledPlan,inputSchema,
// approvalPolicy,…}`, `version.snapshot`, `publish{…}`) — an OAS Flow document
// is NOT that shape, so `agentPackagePayloadSchema.parse` throws
// "formatVersion expected 2" and the install fails. Only the in-app
// `publishAgentPackageFromGitDir` path materializes the dist payload; git-tag
// releases never did.
//
// THE FIX (codex-converged). Materialize the `formatVersion: 2` payload at
// INSTALL extract time, in the agent layer (NOT the shared registries
// extractor — that stays OAS-first for the detail page, and
// `@cinatra-ai/registries` must not import `@cinatra-ai/agents`):
//
//   1. If `extracted.payload` ALREADY validates against
//      `agentPackagePayloadSchema`, use it verbatim — this covers the in-app
//      `publishAgentPackageFromGitDir` artifacts and any future tarball that
//      ships a real root `agent.json` (build-pipeline materialization, the
//      follow-up to this fix). No behavior change for those.
//   2. Otherwise, COMPILE `cinatra/oas.json` into the dist payload via the
//      same `compileOasAgentJson` + assembly that `publishAgentPackageFromGitDir`
//      uses, so an OAS-only tarball installs without any republish (the
//      republish-to-installed path is owner-gated; this fixes ALREADY-published
//      agents at the consumer boundary).
//
// The synthesized identity fields (`sourceVersionId`, contentHash) are
// DETERMINISTIC over the OAS bytes + package identity — reproducible across
// reinstalls and stable in tests (the install path mints its OWN DB version
// IDs, so payload IDs are not install-identity-critical, but determinism is the
// safer default and keeps the synthesized payload byte-stable).

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { compileOasAgentJson } from "./oas-compiler";
import {
  agentPackagePayloadSchema,
  AGENT_PACKAGE_FORMAT_VERSION,
  type AgentPackageManifest,
  type AgentPackagePayload,
} from "./verdaccio/package-contract";

/** Lowercase-hex sha256 of `input`. */
function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Deterministic UUIDv4-shaped identifier derived from `seed`. The dist payload
 * `sourceVersionId` is declared `z.string().min(1)` (any non-empty string is
 * valid), but we emit a UUID-shaped value so it is indistinguishable from the
 * `randomUUID()` the in-app publisher emits — only deterministic, so the
 * synthesized payload is reproducible across reinstalls of the same tarball.
 */
function deterministicUuid(seed: string): string {
  const h = sha256Hex(seed);
  // Format the first 32 hex chars as 8-4-4-4-12 with the version (4) and
  // variant (8/9/a/b) nibbles forced, matching the v4 shape.
  const b = h.slice(0, 32).split("");
  b[12] = "4";
  b[16] = (((parseInt(b[16], 16) & 0x3) | 0x8) >>> 0).toString(16);
  const s = b.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

/**
 * Build a `formatVersion: 2` `AgentPackagePayload` by compiling the extracted
 * tarball's `cinatra/oas.json`. Mirrors the distribution-payload assembly in
 * `publishAgentPackageFromGitDir` (verdaccio/client.ts) so an OAS-only tarball
 * yields the identical install-time shape an in-app-published tarball would.
 *
 * @throws when `cinatra/oas.json` is absent/unreadable/malformed or the OAS
 *   cannot be compiled — a present-but-broken OAS is a real fault and must fail
 *   the install BEFORE any disk materialize, never degrade to a partial payload.
 */
export async function materializeAgentPayloadFromOas(input: {
  extractedTempDir: string;
  packageName: string;
  packageVersion: string;
  manifest: AgentPackageManifest;
  /**
   * Optional explicit global-component-registry path forwarded to
   * `compileOasAgentJson`. Production install omits it — the compiler resolves
   * the installed agents root's `_shared/cinatra/components.json` (reading the
   * configured install dir from the metadata table). Tests pass an explicit
   * path to stay hermetic (no DB).
   */
  registryPath?: string;
}): Promise<AgentPackagePayload> {
  const oasPath = path.join(input.extractedTempDir, "cinatra", "oas.json");

  let oasRaw: string;
  try {
    oasRaw = await readFile(oasPath, "utf8");
  } catch (err) {
    throw new Error(
      `[agent-install-payload] ${input.packageName}@${input.packageVersion}: cannot read cinatra/oas.json ` +
        `from the extracted tarball — the package ships neither a formatVersion:2 root agent.json nor an OAS ` +
        `payload to compile (${err instanceof Error ? err.message : String(err)}).`,
    );
  }

  let oasJson: Record<string, unknown>;
  try {
    oasJson = JSON.parse(oasRaw) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `[agent-install-payload] ${input.packageName}@${input.packageVersion}: cinatra/oas.json is malformed JSON ` +
        `(${err instanceof Error ? err.message : String(err)}).`,
    );
  }

  const cinatraManifest = input.manifest.cinatra;
  const executionProvider =
    typeof cinatraManifest.executionProvider === "string" ? cinatraManifest.executionProvider : null;

  // Compile the OAS flow to derive approvalPolicy, inputSchema, taskSpec, type,
  // compiledPlan, and hitlScreens — the SAME derivation
  // publishAgentPackageFromGitDir performs. Pass the explicit OAS path: the
  // packageName-only resolution searches the INSTALLED agents root, not the
  // extracted tarball.
  const compileResult = await compileOasAgentJson({
    packageName: input.packageName,
    agentJsonPath: oasPath,
    ...(input.registryPath ? { registryPath: input.registryPath } : {}),
    ...(executionProvider ? { executionProvider } : {}),
  });
  if (!compileResult.ok) {
    throw new Error(
      `[agent-install-payload] ${input.packageName}@${input.packageVersion}: failed to compile cinatra/oas.json ` +
        `into an install payload — ${compileResult.error}.`,
    );
  }
  const compiled = compileResult.value;

  // Manifest is authoritative for the published agent's identity + risk fields
  // (it is force-normalized at publish: kind/apiVersion/packageType/…). The OAS
  // top-level `name` is the human title; fall back to package name.
  const title = typeof oasJson.name === "string" && oasJson.name.trim().length > 0 ? oasJson.name : input.packageName;
  const description =
    typeof input.manifest.description === "string" && input.manifest.description.trim().length > 0
      ? input.manifest.description
      : null;

  const agentType = compiled.type ?? cinatraManifest.type ?? "leaf";
  const inputSchema = (compiled.inputSchema ?? { type: "object", properties: {}, required: [] }) as Record<
    string,
    unknown
  >;
  const approvalPolicy = compiled.approvalPolicy ?? { steps: [] };
  const taskSpec = compiled.prompt ?? null;
  const compiledPlan = compiled.compiledPlan ?? [];
  const hitlScreens = Array.isArray(compiled.hitlScreens) ? compiled.hitlScreens : [];

  // DETERMINISTIC identity over OAS bytes + package identity (prefer
  // deterministic over randomUUID for reproducible payloads).
  const contentHash = sha256Hex(oasRaw).slice(0, 16);
  const sourceVersionId = deterministicUuid(
    `${input.packageName}@${input.packageVersion}:version:${contentHash}`,
  );
  // The dist payload's sourceTemplateId mirrors the manifest's (the publisher
  // pins it). Fall back to a deterministic id when the manifest omits it.
  const sourceTemplateId =
    cinatraManifest.sourceTemplateId ?? deterministicUuid(`${input.packageName}:template`);
  const sourceVersionNumber = cinatraManifest.sourceVersionNumber ?? 1;

  const agentDependencies = cinatraManifest.agentDependencies ?? undefined;
  const connectorDependencies = cinatraManifest.connectorDependencies ?? undefined;

  const candidate = {
    formatVersion: AGENT_PACKAGE_FORMAT_VERSION,
    packageName: input.packageName,
    packageVersion: input.packageVersion,
    // Deterministic over the OAS content — NOT wall-clock — so reinstalling the
    // same tarball yields a byte-identical payload.
    publishedAt: `oas-content:${contentHash}`,
    title,
    description,
    changelog: null,
    template: {
      sourceTemplateId,
      ownerOrgId: cinatraManifest.ownerOrgId ?? null,
      name: title,
      description,
      sourceNl: taskSpec ?? "",
      type: agentType,
      compiledPlan,
      inputSchema,
      outputSchema: (compiled.outputSchema ?? null) as Record<string, unknown> | null,
      approvalPolicy,
      taskSpec,
      status: "published",
      ...(executionProvider && executionProvider !== "default" ? { executionProvider } : {}),
      ...(hitlScreens.length > 0 ? { hitlScreens } : {}),
    },
    version: {
      sourceVersionId,
      sourceVersionNumber,
      contentHash,
      snapshot: {
        name: title,
        type: agentType,
        compiledPlan,
        inputSchema,
        approvalPolicy,
        taskSpec,
      },
    },
    publish: {
      riskLevel: cinatraManifest.riskLevel,
      toolAccess: cinatraManifest.toolAccess ?? [],
      hasApprovalGates: cinatraManifest.hasApprovalGates,
      ...(agentDependencies && Object.keys(agentDependencies).length > 0 ? { agentDependencies } : {}),
      ...(connectorDependencies && Object.keys(connectorDependencies).length > 0 ? { connectorDependencies } : {}),
    },
  };

  // Parse through the canonical schema so a synthesis bug fails HERE with a
  // precise error, never at a half-applied downstream consumer.
  return agentPackagePayloadSchema.parse(candidate);
}

/**
 * Resolve the install-time `AgentPackagePayload` from an extracted agent
 * package, tolerating BOTH tarball shapes:
 *
 *   - A tarball whose extracted `payload` (root `agent.json`) ALREADY validates
 *     against `agentPackagePayloadSchema` → returned verbatim (in-app publisher
 *     artifacts; future build-pipeline-materialized tarballs).
 *   - An OAS-only tarball (the git-tag release shape: `cinatra/oas.json`, no
 *     conformant root payload) → the payload is COMPILED from the OAS so the
 *     install succeeds without a republish.
 *
 * Resolution order (root `agent.json` ALWAYS wins when conformant):
 *   1. `extracted.payload`, if it already validates — the shared extractor
 *      returns this directly only when it read a conformant root `agent.json`
 *      (i.e. the package ships NO `cinatra/oas.json`, so OAS-first didn't fire).
 *   2. A root `agent.json` read DIRECTLY from `<tempDir>`, if it validates.
 *      The shared extractor is OAS-FIRST (cinatra#582): a tarball shipping BOTH
 *      a conformant root `agent.json` AND `cinatra/oas.json` hands us the OAS
 *      doc as `extracted.payload`, so step 1 misses the real root payload. We
 *      re-read the root file ourselves so the published dist payload — not a
 *      re-derived one — wins whenever it is present (build-materialized tarballs,
 *      the follow-up to this fix).
 *   3. Compile `cinatra/oas.json` into the dist payload (OAS-only tarballs).
 *
 * @param extractedPayload  the raw `payload` `extractAgentPackage` returned —
 *   the OAS Flow document for git-tag agents, the dist payload otherwise.
 * @throws when NONE of a valid extracted payload, a valid root `agent.json`,
 *   nor a compilable OAS is present.
 */
export async function resolveInstallAgentPayload(input: {
  extractedPayload: unknown;
  extractedTempDir: string;
  packageName: string;
  packageVersion: string;
  manifest: AgentPackageManifest;
  /** Forwarded to the OAS-compile fallback; see {@link materializeAgentPayloadFromOas}. */
  registryPath?: string;
}): Promise<AgentPackagePayload> {
  // 1. The extracted payload is already a conformant dist payload.
  const direct = agentPackagePayloadSchema.safeParse(input.extractedPayload);
  if (direct.success) {
    return direct.data;
  }

  // 2. A conformant root agent.json that the OAS-first extractor passed over.
  //    Read it ourselves so a published dist payload always wins over a
  //    re-derived one. A present-but-non-conformant / malformed root agent.json
  //    is NOT a fault here — fall through to the OAS compile (the OAS is the
  //    canonical authoring source); only a present-AND-conformant file short-
  //    circuits.
  const rootAgentJsonPath = path.join(input.extractedTempDir, "agent.json");
  try {
    const rootRaw = await readFile(rootAgentJsonPath, "utf8");
    const rootParsed = agentPackagePayloadSchema.safeParse(JSON.parse(rootRaw));
    if (rootParsed.success) {
      return rootParsed.data;
    }
  } catch {
    // ENOENT / parse error → no usable root payload; compile the OAS.
  }

  // 3. Compile cinatra/oas.json into the dist payload.
  return materializeAgentPayloadFromOas({
    extractedTempDir: input.extractedTempDir,
    packageName: input.packageName,
    packageVersion: input.packageVersion,
    manifest: input.manifest,
    ...(input.registryPath ? { registryPath: input.registryPath } : {}),
  });
}

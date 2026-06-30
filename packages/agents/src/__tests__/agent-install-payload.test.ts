/**
 * Install-time agent-payload resolution.
 *
 * Proves the install path tolerates an OAS-only agent tarball — the shape the
 * git-tag release pipeline produces (`cinatra/oas.json`, no formatVersion:2 root
 * `agent.json`) — by COMPILING the OAS into a schema-valid `AgentPackagePayload`
 * at extract time, while still using a conformant root `agent.json` verbatim
 * when one ships. The fixture is a REAL published agent OAS
 * (`media-transcript-agent`) staged into a temp dir that mirrors what
 * `extractAgentPackage` populates.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/agent-install-payload.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  materializeAgentPayloadFromOas,
  resolveInstallAgentPayload,
} from "../agent-install-payload";
import {
  agentPackagePayloadSchema,
  type AgentPackageManifest,
} from "../verdaccio/package-contract";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const REAL_OAS_PATH = path.join(
  REPO_ROOT,
  "extensions/cinatra-ai/media-transcript-agent/cinatra/oas.json",
);
const REAL_PKG_PATH = path.join(
  REPO_ROOT,
  "extensions/cinatra-ai/media-transcript-agent/package.json",
);

const PACKAGE_NAME = "@cinatra-ai/media-transcript-agent";
const PACKAGE_VERSION = "0.1.3";

function loadManifest(): AgentPackageManifest {
  return JSON.parse(fs.readFileSync(REAL_PKG_PATH, "utf8")) as AgentPackageManifest;
}

function loadOasDocument(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(REAL_OAS_PATH, "utf8")) as Record<string, unknown>;
}

/**
 * Stage a temp dir that looks like what `extractAgentPackage` populates for an
 * OAS-only tarball: `<dir>/cinatra/oas.json` + `<dir>/package.json`, no root
 * `agent.json`. Also drops an empty global-component registry at
 * `<dir>/_shared/cinatra/components.json` and returns its path so the test
 * stays hermetic — `compileOasAgentJson` is given the explicit `registryPath`
 * and never reads the metadata table (no DB) the production install path uses.
 */
async function stageExtractedOasTarball(): Promise<{ dir: string; registryPath: string }> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-install-payload-"));
  await fsp.mkdir(path.join(dir, "cinatra"), { recursive: true });
  await fsp.copyFile(REAL_OAS_PATH, path.join(dir, "cinatra", "oas.json"));
  await fsp.copyFile(REAL_PKG_PATH, path.join(dir, "package.json"));
  const registryPath = path.join(dir, "_shared", "cinatra", "components.json");
  await fsp.mkdir(path.dirname(registryPath), { recursive: true });
  await fsp.writeFile(registryPath, JSON.stringify({ components: {} }), "utf8");
  return { dir, registryPath };
}

describe("agent-install-payload — OAS-only tarball install contract", () => {
  let tempDir: string;
  let registryPath: string;

  beforeEach(async () => {
    const staged = await stageExtractedOasTarball();
    tempDir = staged.dir;
    registryPath = staged.registryPath;
  });

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it("materializeAgentPayloadFromOas compiles the OAS into a schema-valid formatVersion:2 payload", async () => {
    const manifest = loadManifest();
    const payload = await materializeAgentPayloadFromOas({
      extractedTempDir: tempDir,
      packageName: PACKAGE_NAME,
      packageVersion: PACKAGE_VERSION,
      manifest,
      registryPath,
    });

    // The output IS the canonical install payload — re-parse to be exact.
    const reparsed = agentPackagePayloadSchema.parse(payload);
    expect(reparsed.formatVersion).toBe(2);
    expect(reparsed.packageName).toBe(PACKAGE_NAME);
    expect(reparsed.packageVersion).toBe(PACKAGE_VERSION);
    // Risk fields come from the (authoritative) manifest.
    expect(reparsed.publish.riskLevel).toBe(manifest.cinatra.riskLevel);
    expect(reparsed.publish.hasApprovalGates).toBe(manifest.cinatra.hasApprovalGates);
    // Template identity mirrors the manifest's pinned sourceTemplateId.
    expect(reparsed.template.sourceTemplateId).toBe(manifest.cinatra.sourceTemplateId);
    // The compiled flow drives the install-consumed structured fields.
    expect(reparsed.template.inputSchema).toBeTypeOf("object");
    expect(reparsed.version.snapshot).toBeTypeOf("object");
    expect(reparsed.version.contentHash.length).toBeGreaterThan(0);
  });

  it("is DETERMINISTIC — re-resolving the same tarball yields a byte-identical payload", async () => {
    const manifest = loadManifest();
    const a = await materializeAgentPayloadFromOas({
      extractedTempDir: tempDir,
      packageName: PACKAGE_NAME,
      packageVersion: PACKAGE_VERSION,
      manifest,
      registryPath,
    });
    // A SECOND independently-staged extract of the same source.
    const staged2 = await stageExtractedOasTarball();
    try {
      const b = await materializeAgentPayloadFromOas({
        extractedTempDir: staged2.dir,
        packageName: PACKAGE_NAME,
        packageVersion: PACKAGE_VERSION,
        manifest,
        registryPath: staged2.registryPath,
      });
      expect(JSON.stringify(b)).toEqual(JSON.stringify(a));
      // No wall-clock leakage in the deterministic identity fields.
      expect(a.version.sourceVersionId).toEqual(b.version.sourceVersionId);
      expect(a.publishedAt).toEqual(b.publishedAt);
    } finally {
      await fsp.rm(staged2.dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("resolveInstallAgentPayload compiles the OAS when the extracted payload is the raw OAS document (#582 detail shape)", async () => {
    const manifest = loadManifest();
    // The extractor returns the OAS Flow document as `payload` for git-tag
    // agents — which is NOT a formatVersion:2 dist payload.
    const rawOasPayload = loadOasDocument();
    expect(() => agentPackagePayloadSchema.parse(rawOasPayload)).toThrow();

    const payload = await resolveInstallAgentPayload({
      extractedPayload: rawOasPayload,
      extractedTempDir: tempDir,
      packageName: PACKAGE_NAME,
      packageVersion: PACKAGE_VERSION,
      manifest,
      registryPath,
    });
    expect(payload.formatVersion).toBe(2);
    expect(payload.packageName).toBe(PACKAGE_NAME);
  });

  it("resolveInstallAgentPayload uses a conformant extracted payload verbatim (no cinatra/oas.json)", async () => {
    const manifest = loadManifest();
    // Compile once to obtain a real conformant dist payload, then feed it back
    // in as the extracted payload — it must be returned UNCHANGED (no recompile).
    const conformant = await materializeAgentPayloadFromOas({
      extractedTempDir: tempDir,
      packageName: PACKAGE_NAME,
      packageVersion: PACKAGE_VERSION,
      manifest,
      registryPath,
    });
    const sentinel = { ...conformant, title: "VERBATIM-SENTINEL-TITLE" };

    const resolved = await resolveInstallAgentPayload({
      extractedPayload: sentinel,
      extractedTempDir: tempDir,
      packageName: PACKAGE_NAME,
      packageVersion: PACKAGE_VERSION,
      manifest,
      registryPath,
    });
    // The verbatim path wins — the sentinel title survives (a recompile would
    // have overwritten it with the OAS-derived title).
    expect(resolved.title).toBe("VERBATIM-SENTINEL-TITLE");
  });

  it("a conformant root agent.json WINS even when the OAS-first extractor passed the OAS doc (both files present)", async () => {
    const manifest = loadManifest();
    // Realistic shape: the shared extractor is OAS-first (cinatra#582), so for a
    // tarball that ships BOTH a conformant root agent.json AND cinatra/oas.json
    // it hands us the OAS Flow document as `extractedPayload`. The resolver must
    // still honor the published root agent.json (probe it directly), NOT compile
    // the OAS and discard the real payload.
    const conformant = await materializeAgentPayloadFromOas({
      extractedTempDir: tempDir,
      packageName: PACKAGE_NAME,
      packageVersion: PACKAGE_VERSION,
      manifest,
      registryPath,
    });
    const rootPayload = { ...conformant, title: "ROOT-AGENT-JSON-WINS" };
    await fsp.writeFile(
      path.join(tempDir, "agent.json"),
      JSON.stringify(rootPayload, null, 2),
      "utf8",
    );

    const resolved = await resolveInstallAgentPayload({
      // The OAS doc — what the OAS-first extractor returns.
      extractedPayload: loadOasDocument(),
      extractedTempDir: tempDir,
      packageName: PACKAGE_NAME,
      packageVersion: PACKAGE_VERSION,
      manifest,
      registryPath,
    });
    expect(resolved.title).toBe("ROOT-AGENT-JSON-WINS");
  });

  it("a malformed root agent.json falls through to the OAS compile (OAS is canonical)", async () => {
    const manifest = loadManifest();
    await fsp.writeFile(path.join(tempDir, "agent.json"), "{ not json", "utf8");
    const resolved = await resolveInstallAgentPayload({
      extractedPayload: loadOasDocument(),
      extractedTempDir: tempDir,
      packageName: PACKAGE_NAME,
      packageVersion: PACKAGE_VERSION,
      manifest,
      registryPath,
    });
    // Compiled from the OAS — formatVersion:2, OAS-derived title.
    expect(resolved.formatVersion).toBe(2);
    expect(resolved.title).not.toBe("{ not json");
  });

  it("a present-but-malformed cinatra/oas.json FAILS LOUD (never a partial payload)", async () => {
    const manifest = loadManifest();
    await fsp.writeFile(path.join(tempDir, "cinatra", "oas.json"), "{ not json", "utf8");
    await expect(
      resolveInstallAgentPayload({
        // Raw payload is irrelevant — it does not validate, so the fallback runs.
        extractedPayload: { component_type: "Flow" },
        extractedTempDir: tempDir,
        packageName: PACKAGE_NAME,
        packageVersion: PACKAGE_VERSION,
        manifest,
      }),
    ).rejects.toThrow(/malformed JSON/);
  });

  it("a MISSING cinatra/oas.json with no conformant root payload FAILS LOUD", async () => {
    const manifest = loadManifest();
    await fsp.rm(path.join(tempDir, "cinatra", "oas.json"), { force: true });
    await expect(
      resolveInstallAgentPayload({
        extractedPayload: null,
        extractedTempDir: tempDir,
        packageName: PACKAGE_NAME,
        packageVersion: PACKAGE_VERSION,
        manifest,
      }),
    ).rejects.toThrow(/cannot read cinatra\/oas\.json/);
  });
});

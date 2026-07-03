// cinatra#794 — the workflow extension adapter's package-root resolution.
//
// The no-saga install path (`installWorkflowExtension`) must source the
// package payload from the FINALIZED unified runtime store (the digest dir the
// journal-gated DB anchor pins, resolved via `@/lib/extension-store-payload`),
// keeping the dev extensions tree as a development-only authoring fallback and
// the explicit `extensionsRoot` override as the hermetic test/tooling contract.
//
// The store seam + the DB-writing stores are mocked (unit test); the on-disk
// package fixtures are real files parsed by the real BPMN sidecar chain.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("@/lib/extension-store-payload", () => ({
  resolveFinalizedStorePayload: vi.fn(),
}));

vi.mock("../store", () => ({
  materializeTemplateFromManifest: vi.fn(async () => ({ id: "tpl-store-payload-1" })),
  findWorkflowTemplate: vi.fn(),
  isTemplateInUse: vi.fn(async () => false),
  deleteWorkflowTemplate: vi.fn(),
  arePackageTemplatesInUse: vi.fn(async () => false),
}));

vi.mock("@cinatra-ai/dashboards/extension-materialization", () => ({
  materializeExtensionTemplate: vi.fn(async () => ({})),
  archiveExtensionDashboards: vi.fn(async () => 0),
  restoreExtensionDashboards: vi.fn(async () => 0),
  validateDashboardConfigV12: vi.fn(() => ({ ok: true })),
}));

import { resolveFinalizedStorePayload } from "@/lib/extension-store-payload";
import { materializeTemplateFromManifest } from "../store";
import {
  materializeExtensionTemplate,
  restoreExtensionDashboards,
} from "@cinatra-ai/dashboards/extension-materialization";
import { installWorkflowExtension } from "../extension-ops";

const PKG = "@cinatra-ai/store-payload-stub-workflow";
const VERSION = "1.2.3";
const DIGEST = "e".repeat(128);
const ORG = "org-store-payload";
const USER = "user-store-payload";

// The proven stub from the dashboard-extension-install integration suite —
// parses through the real sidecar chain (profile 1.0 → compile → template-valid).
const STUB_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:cinatra="http://cinatra.ai/schema/bpmn/profile-1.0" id="d">
  <bpmn:process id="store-payload-stub" name="Store Payload Stub" isExecutable="false">
    <bpmn:documentation>Stub workflow for the runtime-store payload unit test.</bpmn:documentation>
    <bpmn:extensionElements><cinatra:workflowMeta name="Store Payload Stub Def" /></bpmn:extensionElements>
    <bpmn:startEvent id="s"/>
    <bpmn:manualTask id="m" name="Do it"/>
    <bpmn:endEvent id="e"/>
    <bpmn:sequenceFlow id="f0" sourceRef="s" targetRef="m"/>
    <bpmn:sequenceFlow id="f1" sourceRef="m" targetRef="e"/>
  </bpmn:process>
</bpmn:definitions>`;

const STUB_DASHBOARD = JSON.stringify({
  apiVersion: "v1.2",
  scopeLevel: "project",
  portlets: [{ instanceId: "list", kind: "object-list", version: "1.0.0", slot: "fixed", config: { typeId: "blog-post" } }],
});

/** Write a package payload (package.json + cinatra/workflow.bpmn [+ dashboard]) into `dir`. */
async function stagePackagePayload(dir: string, opts: { dashboard?: boolean; version?: string } = {}): Promise<void> {
  await mkdir(join(dir, "cinatra"), { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: PKG,
      version: opts.version ?? VERSION,
      private: true,
      cinatra: { apiVersion: "cinatra.ai/v1", kind: "workflow", workflowVersion: 1 },
    }),
    "utf8",
  );
  await writeFile(join(dir, "cinatra", "workflow.bpmn"), STUB_BPMN, "utf8");
  if (opts.dashboard) await writeFile(join(dir, "cinatra", "dashboard.json"), STUB_DASHBOARD, "utf8");
}

let tmpRoot: string;
/** A store-shaped digest dir: <root>/workflow/@scope/name/<digest>/ */
let storeDigestDir: string;
const savedRuntimeMode = process.env.CINATRA_RUNTIME_MODE;

beforeAll(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "wf-store-payload-"));
  storeDigestDir = join(tmpRoot, "data-root", "workflow", "@cinatra-ai", "store-payload-stub-workflow", DIGEST);
  await stagePackagePayload(storeDigestDir, { dashboard: true });
});

afterAll(async () => {
  if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
  if (savedRuntimeMode === undefined) delete process.env.CINATRA_RUNTIME_MODE;
  else process.env.CINATRA_RUNTIME_MODE = savedRuntimeMode;
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CINATRA_RUNTIME_MODE = "production";
});

describe("installWorkflowExtension — unified runtime-store payload resolution (cinatra#794)", () => {
  it("prod: installs from the finalized store digest dir (no dev tree anywhere)", async () => {
    vi.mocked(resolveFinalizedStorePayload).mockResolvedValue({
      storeDir: storeDigestDir,
      digest: DIGEST,
      version: VERSION,
      registryUrl: "https://registry.example",
    });

    const r = await installWorkflowExtension({ packageName: PKG, version: VERSION }, { userId: USER, orgId: ORG });

    expect(r.templateId).toBe("tpl-store-payload-1");
    expect(r.dashboardMaterialized).toBe(true);
    // The seam is consulted with the workflow kind binding + the actor's org.
    expect(resolveFinalizedStorePayload).toHaveBeenCalledWith({
      packageName: PKG,
      orgId: ORG,
      expectedKind: "workflow",
    });
    expect(materializeTemplateFromManifest).toHaveBeenCalledTimes(1);
    expect(materializeExtensionTemplate).toHaveBeenCalledTimes(1);
    expect(restoreExtensionDashboards).toHaveBeenCalledTimes(1);
  });

  it("prod: a payload without a dashboard.json installs the template only", async () => {
    const noDashDir = join(tmpRoot, "data-root", "workflow", "@cinatra-ai", "store-payload-stub-workflow", "f".repeat(128));
    await stagePackagePayload(noDashDir, { dashboard: false });
    vi.mocked(resolveFinalizedStorePayload).mockResolvedValue({
      storeDir: noDashDir,
      digest: "f".repeat(128),
      version: VERSION,
      registryUrl: null,
    });

    const r = await installWorkflowExtension({ packageName: PKG }, { userId: USER, orgId: ORG });
    expect(r.dashboardMaterialized).toBe(false);
    expect(materializeExtensionTemplate).not.toHaveBeenCalled();
  });

  it("prod: fails closed (PACKAGE_ROOT_UNRESOLVED) when no finalized payload exists — no dev-tree scan", async () => {
    vi.mocked(resolveFinalizedStorePayload).mockResolvedValue(null);
    await expect(
      installWorkflowExtension({ packageName: PKG }, { userId: USER, orgId: ORG }),
    ).rejects.toMatchObject({ code: "PACKAGE_ROOT_UNRESOLVED" });
  });

  it("prod: a finalized payload pinned to another version is VERSION_MISMATCH, not unresolved", async () => {
    vi.mocked(resolveFinalizedStorePayload).mockResolvedValue({
      storeDir: storeDigestDir,
      digest: DIGEST,
      version: VERSION,
      registryUrl: null,
    });
    await expect(
      installWorkflowExtension({ packageName: PKG, version: "9.9.9" }, { userId: USER, orgId: ORG }),
    ).rejects.toMatchObject({ code: "VERSION_MISMATCH" });
  });

  it("prod: a legacy anchor (null payload version) defers to the extracted-manifest version guard", async () => {
    vi.mocked(resolveFinalizedStorePayload).mockResolvedValue({
      storeDir: storeDigestDir,
      digest: DIGEST,
      version: null,
      registryUrl: null,
    });
    // storeDigestDir's package.json is VERSION → a different requested version
    // must still fail closed via the manifest guard.
    await expect(
      installWorkflowExtension({ packageName: PKG, version: "9.9.9" }, { userId: USER, orgId: ORG }),
    ).rejects.toMatchObject({ code: "VERSION_MISMATCH" });
    // ...and the matching version installs.
    const r = await installWorkflowExtension({ packageName: PKG, version: VERSION }, { userId: USER, orgId: ORG });
    expect(r.templateId).toBe("tpl-store-payload-1");
  });

  it("dev: falls back to the <cwd>/extensions authoring tree when no finalized payload exists", async () => {
    process.env.CINATRA_RUNTIME_MODE = "development";
    vi.mocked(resolveFinalizedStorePayload).mockResolvedValue(null);

    const devCwd = join(tmpRoot, "dev-cwd");
    await stagePackagePayload(join(devCwd, "extensions", "cinatra-ai", "store-payload-stub-workflow"), { dashboard: false });
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(devCwd);
    try {
      const r = await installWorkflowExtension({ packageName: PKG }, { userId: USER, orgId: ORG });
      expect(r.templateId).toBe("tpl-store-payload-1");
      expect(resolveFinalizedStorePayload).toHaveBeenCalledTimes(1);
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it("explicit extensionsRoot override never consults the store seam (hermetic contract)", async () => {
    const extRoot = join(tmpRoot, "explicit-root");
    await stagePackagePayload(join(extRoot, "cinatra-ai", "store-payload-stub-workflow"), { dashboard: false });

    const r = await installWorkflowExtension({ packageName: PKG }, { userId: USER, orgId: ORG }, {}, { extensionsRoot: extRoot });
    expect(r.templateId).toBe("tpl-store-payload-1");
    expect(resolveFinalizedStorePayload).not.toHaveBeenCalled();
  });

  it("explicit extensionsRoot miss stays PACKAGE_ROOT_UNRESOLVED (no store fall-through)", async () => {
    const emptyRoot = join(tmpRoot, "empty-root");
    await mkdir(emptyRoot, { recursive: true });
    await expect(
      installWorkflowExtension({ packageName: PKG }, { userId: USER, orgId: ORG }, {}, { extensionsRoot: emptyRoot }),
    ).rejects.toMatchObject({ code: "PACKAGE_ROOT_UNRESOLVED" });
    expect(resolveFinalizedStorePayload).not.toHaveBeenCalled();
  });
});

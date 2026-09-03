/**
 * The D2 attestation is VERIFIED SERVER-SIDE, and a re-upload does not silently
 * claim a scope it did not apply (cinatra#3204, convergence round).
 *
 * Two things this pins.
 *
 * (1) THE DIGEST. The Upload screen computes a content digest in the browser
 *     and sends it with the archive. Writing that value down unchecked would
 *     attest nothing: the sender chose both halves, and the server action is
 *     reachable by anything that can speak to it. The screen also does not send
 *     the tree it previewed — it sends the canonical repack — so a recorded
 *     preview digest would describe a file set the server never held. The
 *     server therefore recomputes the digest over the archive in its own hands,
 *     refuses a mismatch BEFORE importing, and records only what it computed.
 *
 * (2) THE RE-UPLOAD ANCHOR. A re-upload of an already-registered package is a
 *     template upsert; the canonical row is not rewritten and keeps the anchor
 *     it was first installed at. When the operator picked a different scope this
 *     time, the screen must not imply the row moved.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/upload-digest-and-anchor.test.ts
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const requireAdminSession = vi.fn();
const importAgentTemplateCore = vi.fn();
const publishAgentTemplateAndBindVersion = vi.fn();
const logAuditEvent = vi.fn();
const setExtensionInstaller = vi.fn();
const saveExtensionAccessPolicy = vi.fn();
const addExtensionCoOwner = vi.fn();
const readAgentTemplateById = vi.fn();
const readInstalledExtensionsByPackageName = vi.fn();
const installExtensionManifest = vi.fn();
const setExtensionInstallAccess = vi.fn();
const authorizeUploadInstallScope = vi.fn();

vi.mock("@/lib/auth-session", () => ({
  requireAdminSession: (...a: unknown[]) => requireAdminSession(...a),
}));
vi.mock("@/lib/authz", () => ({ logAuditEvent: (...a: unknown[]) => logAuditEvent(...a) }));
vi.mock("@/lib/authz/actor-context", () => ({ POLICY_VERSION: "test-policy" }));
vi.mock("../store", () => ({
  createAgentTemplate: vi.fn(),
  createAgentVersion: vi.fn(),
  readAgentTemplateById: (...a: unknown[]) => readAgentTemplateById(...a),
  deleteAgentTemplate: vi.fn(),
}));
vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  readInstalledExtensionsByPackageName: (...a: unknown[]) =>
    readInstalledExtensionsByPackageName(...a),
}));
vi.mock("@cinatra-ai/extensions/lifecycle-primitive", () => ({
  installExtensionManifest: (...a: unknown[]) => installExtensionManifest(...a),
}));
vi.mock("@cinatra-ai/extensions/install-access-contract", () => ({
  setExtensionInstallAccess: (...a: unknown[]) => setExtensionInstallAccess(...a),
}));
vi.mock("../import-agent-core", () => ({
  importAgentTemplateCore: (...a: unknown[]) => importAgentTemplateCore(...a),
}));
vi.mock("../publish-template", () => ({
  publishAgentTemplateAndBindVersion: (...a: unknown[]) =>
    publishAgentTemplateAndBindVersion(...a),
}));
vi.mock("@cinatra-ai/extensions/permissions-actions", () => ({
  setExtensionInstaller: (...a: unknown[]) => setExtensionInstaller(...a),
  saveExtensionAccessPolicy: (...a: unknown[]) => saveExtensionAccessPolicy(...a),
  addExtensionCoOwner: (...a: unknown[]) => addExtensionCoOwner(...a),
}));
vi.mock("../upload-install-authorization", () => ({
  authorizeUploadInstallScope: (...a: unknown[]) => authorizeUploadInstallScope(...a),
}));

import { computeExtensionTreeDigest } from "@cinatra-ai/extensions/extension-package-digest";
import { importAgentTemplate } from "../import-export-actions";
import { verifyReceivedArchiveDigest } from "../received-package-digest";
import { createZipBuffer } from "../zip-helpers";

const te = new TextEncoder();

const CANONICAL_FILES = [
  { name: "agent.json", content: JSON.stringify({ component_type: "Flow", name: "Fixture" }) },
  { name: "package.json", content: JSON.stringify({ name: "@e2e/fixture-agent" }) },
];

const zipBase64 = createZipBuffer(CANONICAL_FILES).toString("base64");

async function digestOfSentTree(files = CANONICAL_FILES): Promise<string> {
  return computeExtensionTreeDigest(
    files.map(({ name, content }) => [name, te.encode(content)] as const),
  );
}

const WORKSPACE_ANCHOR = { ownerLevel: "workspace", ownerId: null, organizationId: null };

beforeEach(() => {
  vi.clearAllMocks();
  requireAdminSession.mockResolvedValue({
    user: { id: "admin-1" },
    session: { activeOrganizationId: "org-1" },
  });
  importAgentTemplateCore.mockResolvedValue({ templateId: "tpl-1", upserted: false });
  publishAgentTemplateAndBindVersion.mockResolvedValue({
    record: { id: "tpl-1", status: "published" },
    version: { id: "ver-1" },
  });
  logAuditEvent.mockResolvedValue(undefined);
  setExtensionInstaller.mockResolvedValue({ ok: true });
  setExtensionInstallAccess.mockResolvedValue(undefined);
  readAgentTemplateById.mockResolvedValue({
    id: "tpl-1",
    status: "draft",
    packageName: "@e2e/fixture-agent",
    packageVersion: "0.1.0",
  });
  readInstalledExtensionsByPackageName.mockResolvedValue([]);
  installExtensionManifest.mockResolvedValue({ id: "iext-row-1", status: "active" });
  authorizeUploadInstallScope.mockResolvedValue({
    rowAnchor: WORKSPACE_ANCHOR,
    policy: undefined,
    target: { level: "workspace", id: "org-1" },
  });
});

// ---------------------------------------------------------------------------
// 1. The digest is recomputed, not relayed
// ---------------------------------------------------------------------------

describe("the recorded content digest is computed from the bytes that arrived", () => {
  it("recomputes the digest over the received archive and returns ITS OWN value", async () => {
    const stated = await digestOfSentTree();
    await expect(verifyReceivedArchiveDigest(zipBase64, stated)).resolves.toBe(stated);
  });

  it("refuses a digest that does not describe the archive, naming both values", async () => {
    const other = await digestOfSentTree([
      { name: "agent.json", content: "{}" },
      { name: "package.json", content: "{}" },
    ]);
    await expect(verifyReceivedArchiveDigest(zipBase64, other)).rejects.toThrow(
      /does not match the one that was previewed/,
    );
  });

  it("writes the RECOMPUTED digest onto the canonical row's local provenance", async () => {
    const stated = await digestOfSentTree();
    await importAgentTemplate(zipBase64, undefined, {
      redirect: false,
      publishAndBind: true,
      packageContentDigest: stated,
    });
    const [row] = installExtensionManifest.mock.calls[0] as [Record<string, unknown>];
    expect(row.source).toMatchObject({ type: "local", contentDigest: stated });
  });

  it("installs NOTHING when the stated digest does not match the archive", async () => {
    const wrong = `sha256-${"0".repeat(64)}`;
    await expect(
      importAgentTemplate(zipBase64, undefined, {
        redirect: false,
        publishAndBind: true,
        packageContentDigest: wrong,
      }),
    ).rejects.toThrow(/does not match the one that was previewed/);
    // The refusal lands BEFORE the import — no template, no row, no go-live.
    expect(importAgentTemplateCore).not.toHaveBeenCalled();
    expect(installExtensionManifest).not.toHaveBeenCalled();
    expect(publishAgentTemplateAndBindVersion).not.toHaveBeenCalled();
  });

  it("leaves a caller that states no digest byte-unchanged", async () => {
    await importAgentTemplate(zipBase64, undefined, { redirect: false, publishAndBind: true });
    const [row] = installExtensionManifest.mock.calls[0] as [Record<string, unknown>];
    expect(row.source).not.toHaveProperty("contentDigest");
  });
});

// ---------------------------------------------------------------------------
// 2. A re-upload does not claim a scope it did not apply
// ---------------------------------------------------------------------------

describe("a re-upload at a different scope says so", () => {
  it("warns when the live row is anchored somewhere other than the chosen target", async () => {
    readInstalledExtensionsByPackageName.mockResolvedValue([
      { status: "active", ownerLevel: "organization", ownerId: "org-1", organizationId: "org-1" },
    ]);
    const result = await importAgentTemplate(zipBase64, undefined, {
      redirect: false,
      publishAndBind: true,
      installScope: { pickerValue: "workspace:org-1" },
    });
    expect(installExtensionManifest).not.toHaveBeenCalled();
    expect(result.warnings).toEqual([
      expect.stringContaining("already installed at a different scope"),
    ]);
  });

  it("stays silent when the live row is already at the chosen anchor", async () => {
    readInstalledExtensionsByPackageName.mockResolvedValue([
      { status: "active", ownerLevel: "workspace", ownerId: null, organizationId: null },
    ]);
    const result = await importAgentTemplate(zipBase64, undefined, {
      redirect: false,
      publishAndBind: true,
      installScope: { pickerValue: "workspace:org-1" },
    });
    expect(result.warnings).toEqual([]);
  });

  it("says nothing about anchors when no install scope was configured", async () => {
    readInstalledExtensionsByPackageName.mockResolvedValue([
      { status: "active", ownerLevel: "organization", ownerId: "org-1", organizationId: "org-1" },
    ]);
    const result = await importAgentTemplate(zipBase64, undefined, {
      redirect: false,
      publishAndBind: true,
    });
    expect(result.warnings).toEqual([]);
  });
});

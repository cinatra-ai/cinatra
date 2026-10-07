import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const ports = vi.hoisted(() => ({ bindings: vi.fn(), use: vi.fn(), row: vi.fn(), root: "" }));
vi.mock("../field-renderer-bindings.server", () => ({ getMergedFieldRendererBindings: ports.bindings }));
vi.mock("../agent-runtime-mount", () => ({ resolveDevExtensionSourceRoot: () => ports.root, resolveAgentRuntimeMountDir: () => ports.root }));
vi.mock("@/lib/connector-instance-write-authority", () => ({ createInstanceUseAuthority: () => ports.use }));
vi.mock("@/lib/connector-client-providers", () => ({ resolveWordPressInstanceAdmin: () => ({ readInstanceById: ports.row }) }));
import { projectHitlRenderInputs } from "../hitl-render-input-projection.server";
import { parseAgentHitlScreenState } from "../agent-hitl-screen";

const packageName = "@cinatra-ai/fixture-publish-agent";
const id = `${packageName}:confirm`;
const spec = { provider: "connector-destination-host", connectorKind: "wordpress", connectorPackage: "@cinatra-ai/wordpress-mcp-connector", instanceField: "wordpressInstanceId", identityFields: ["postArtifactId", "postRepresentationRevisionId"] };
const binding = { id, declaredBy: packageName, params: { renderInputs: { siteHost: spec } } };
const run = { id: "run-1", orgId: "org-1", inputParams: { wordpressInstanceId: "instance-1" } } as Parameters<typeof projectHitlRenderInputs>[0];
const gate = { reviewTaskId: "task-1", xRenderer: id, inputSchema: {}, currentValues: { wordpressInstanceId: "instance-1", postArtifactId: "artifact-1", postRepresentationRevisionId: "revision-1", siteHost: "forged.example" }, fieldName: null };
const who = { actor: { actorType: "human" as const, source: "ui" as const, userId: "viewer-1" }, roleHints: { actorOrganizationId: "org-1" } };
let manifest;
function persist() { const dir = join(ports.root, packageName); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "package.json"), JSON.stringify(manifest)); }
beforeEach(() => { ports.root = mkdtempSync(join(tmpdir(), "hitl-host-test-")); ports.bindings.mockReturnValue([binding]); ports.use.mockResolvedValue(undefined); ports.row.mockReturnValue({ id: "instance-1", orgId: "org-1", siteUrl: "https://user:secret@blog.acme.example/some/path?token=secret#fragment", username: "private", applicationPassword: "private" }); manifest = { name: packageName, cinatra: { fieldRenderers: [binding], dependencies: [{ packageName: spec.connectorPackage, kind: "connector", requirement: "required", edgeType: "runtime" }] } }; persist(); });
afterEach(() => { rmSync(ports.root, { recursive: true, force: true }); vi.clearAllMocks(); });

describe("authorized destination display only", () => {
  it("returns only the exact sanitized host after live USE for the SAME viewing actor", async () => { const before = JSON.stringify(gate); const result = await projectHitlRenderInputs(run, gate, who); expect(result).toEqual({ bindingId: id, reviewTaskId: "task-1", instanceField: "wordpressInstanceId", instanceId: "instance-1", identityValues: { postArtifactId: "artifact-1", postRepresentationRevisionId: "revision-1" }, siteHost: "blog.acme.example" }); expect(JSON.stringify(result)).not.toMatch(/secret|username|applicationPassword|some\/path/); expect(ports.use).toHaveBeenCalledWith(expect.objectContaining({ userId: "viewer-1", orgId: "org-1", actor: expect.objectContaining({ principalId: "viewer-1", organizationId: "org-1" }) }), { instanceId: "instance-1", primitiveName: "hitl_destination_host" }); expect(ports.use.mock.invocationCallOrder[0]).toBeLessThan(ports.row.mock.invocationCallOrder[0]); expect(JSON.stringify(gate)).toBe(before); });
  it.each(["http://127.0.0.1:3188/path", "https://[::1]:8443/path"])("preserves the stored host/port %s", async siteUrl => { ports.row.mockReturnValue({ id: "instance-1", orgId: "org-1", siteUrl }); expect((await projectHitlRenderInputs(run, gate, who))?.siteHost).toBe(new URL(siteUrl).host); });
  it("denied USE and thrown policy lookups never read destination metadata", async () => { ports.use.mockRejectedValue(new Error("denied")); expect(await projectHitlRenderInputs(run, gate, who)).toBeUndefined(); expect(ports.row).not.toHaveBeenCalled(); });
  it.each([{ actor: { actorType: "model", source: "agent" }, roleHints: { actorOrganizationId: "org-1" } }, { ...who, roleHints: { actorOrganizationId: "other" } }, { ...who, actor: { actorType: "human", source: "ui" } }])("untrusted/mismatched viewer cannot project %j", async viewer => { expect(await projectHitlRenderInputs(run, gate, viewer as typeof who)).toBeUndefined(); expect(ports.use).not.toHaveBeenCalled(); expect(ports.row).not.toHaveBeenCalled(); });
  it.each([{}, { wordpressInstanceId: "other" }])("legacy absent or conflicting persisted destination cannot trust interrupt %j", async inputParams => { expect(await projectHitlRenderInputs({ ...run, inputParams }, gate, who)).toBeUndefined(); expect(ports.use).not.toHaveBeenCalled(); });
  it.each([null, { id: "other", orgId: "org-1", siteUrl: "https://wrong.example" }, { id: "instance-1", orgId: "other", siteUrl: "https://wrong.example" }, { id: "instance-1", orgId: "org-1", siteUrl: "javascript:bad" }, { id: "instance-1", orgId: "org-1", siteUrl: "not a URL" }])("missing, wrong or malformed stored row gives no display %j", async row => { ports.row.mockReturnValue(row); expect(await projectHitlRenderInputs(run, gate, who)).toBeUndefined(); });
  it("unknown/undeclared renderer does not attempt USE or a lookup", async () => { ports.bindings.mockReturnValue([]); expect(await projectHitlRenderInputs(run, gate, who)).toBeUndefined(); ports.bindings.mockReturnValue([{ ...binding, params: {} }]); expect(await projectHitlRenderInputs(run, gate, who)).toBeUndefined(); expect(ports.use).not.toHaveBeenCalled(); });
  it("does not use an optional dependency or divergent manifest as a declaration", async () => { manifest.cinatra.dependencies[0].requirement = "optional"; persist(); expect(await projectHitlRenderInputs(run, gate, who)).toBeUndefined(); manifest.cinatra.dependencies[0].requirement = "required"; manifest.cinatra.fieldRenderers[0] = { ...binding, params: {} }; persist(); expect(await projectHitlRenderInputs(run, gate, who)).toBeUndefined(); expect(ports.use).not.toHaveBeenCalled(); });
  it("ignores malformed optional transport display without invalidating old gate", () => { const state = { state: "asking", runId: "run-1", gate: { ...gate, renderInputs: { bindingId: id, reviewTaskId: "task-1", siteHost: "user:secret@wrong.example" } } }; const parsed = parseAgentHitlScreenState(state); expect(parsed?.state).toBe("asking"); expect(parsed?.state === "asking" && parsed.gate.renderInputs).toBeUndefined(); expect(parsed?.state === "asking" && parsed.gate.currentValues).toEqual(gate.currentValues); });
});

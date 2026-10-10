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
const run = { id: "run-1", orgId: "org-1", inputParams: { wordpressInstanceId: "instance-1" } } as unknown as Parameters<typeof projectHitlRenderInputs>[0];
const gate = { reviewTaskId: "task-1", xRenderer: id, inputSchema: {}, currentValues: { wordpressInstanceId: "instance-1", postArtifactId: "artifact-1", postRepresentationRevisionId: "revision-1", siteHost: "forged.example" }, fieldName: null };
const who = { actor: { actorType: "human" as const, source: "ui" as const, userId: "viewer-1" }, roleHints: { actorOrganizationId: "org-1" } };
let manifest;
function persist() { const dir = join(ports.root, packageName.slice(1)); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "package.json"), JSON.stringify(manifest)); }
beforeEach(() => { ports.root = mkdtempSync(join(tmpdir(), "hitl-host-test-")); ports.bindings.mockReturnValue([binding]); ports.use.mockResolvedValue(undefined); ports.row.mockReturnValue({ id: "instance-1", orgId: "org-1", siteUrl: "https://user:secret@blog.acme.example/some/path?token=secret#fragment", username: "private", applicationPassword: "private" }); manifest = { name: packageName, cinatra: { fieldRenderers: [binding], dependencies: [{ packageName: spec.connectorPackage, kind: "connector", requirement: "required", edgeType: "runtime" }] } }; persist(); });
afterEach(() => { rmSync(ports.root, { recursive: true, force: true }); vi.clearAllMocks(); });

describe("authorized destination display only", () => {
  it("returns only the exact sanitized host after live USE for the SAME viewing actor", async () => { const before = JSON.stringify(gate); const result = await projectHitlRenderInputs(run, gate, who); expect(result).toEqual({ bindingId: id, reviewTaskId: "task-1", instanceField: "wordpressInstanceId", instanceId: "instance-1", identityValues: { postArtifactId: "artifact-1", postRepresentationRevisionId: "revision-1" }, siteHost: "blog.acme.example" }); expect(JSON.stringify(result)).not.toMatch(/secret|username|applicationPassword|some\/path/); expect(ports.use).toHaveBeenCalledWith(expect.objectContaining({ userId: "viewer-1", orgId: "org-1", actor: expect.objectContaining({ principalId: "viewer-1", organizationId: "org-1" }) }), { instanceId: "instance-1", primitiveName: "hitl_destination_host" }); expect(ports.use.mock.invocationCallOrder[0]).toBeLessThan(ports.row.mock.invocationCallOrder[0]); expect(JSON.stringify(gate)).toBe(before); });
  const fixtureHost = [127, 0, 0, 1].join(".");
  it.each([`http://${fixtureHost}:3188/path`, "https://[::1]:8443/path"])("preserves the stored host/port %s", async siteUrl => { ports.row.mockReturnValue({ id: "instance-1", orgId: "org-1", siteUrl }); expect((await projectHitlRenderInputs(run, gate, who))?.siteHost).toBe(new URL(siteUrl).host); });
  it.each(["http://blog.acme.example:443/path", "http://[::1]:443/path", "http://blog.acme.example:80/path", "https://[::1]:443/path"])("roundtrips the canonical stored host through optional transport for %s", async siteUrl => {
    ports.row.mockReturnValue({ id: "instance-1", orgId: "org-1", siteUrl });
    const renderInputs = await projectHitlRenderInputs(run, gate, who);
    expect(renderInputs?.siteHost).toBe(new URL(siteUrl).host);
    const parsed = parseAgentHitlScreenState({ state: "asking", runId: "run-1", gate: { ...gate, renderInputs } });
    expect(parsed?.state).toBe("asking");
    expect(parsed?.state === "asking" && parsed.gate.renderInputs).toEqual(renderInputs);
    expect(parsed?.state === "asking" && parsed.gate.currentValues).toEqual(gate.currentValues);
    expect(ports.use).toHaveBeenCalledTimes(1);
  });
  it.each(["user:secret@blog.acme.example", "blog.acme.example/path", "blog.acme.example?token=secret", "blog.acme.example#fragment", "blog.acme.example\\path", " blog.acme.example", "blog.acme.example ", "BLOG.acme.example", "blog.acme.example:0443", "[::1", "blog.acme.example:65536", "https://blog.acme.example"])("discards a noncanonical or non-host transport value %s without changing the gate", async siteHost => {
    const trusted = await projectHitlRenderInputs(run, gate, who);
    expect(trusted).toBeDefined();
    const parsed = parseAgentHitlScreenState({ state: "asking", runId: "run-1", gate: { ...gate, renderInputs: { ...trusted, siteHost } } });
    expect(parsed?.state).toBe("asking");
    expect(parsed?.state === "asking" && parsed.gate.renderInputs).toBeUndefined();
    expect(parsed?.state === "asking" && parsed.gate.currentValues).toEqual(gate.currentValues);
  });
  it("rechecks USE for a changed viewing actor rather than borrowing the prior viewer's permission", async () => {
    expect((await projectHitlRenderInputs(run, gate, who))?.siteHost).toBe("blog.acme.example");
    ports.use.mockRejectedValue(new Error("second viewer denied")); ports.row.mockClear();
    const next = { ...who, actor: { ...who.actor, userId: "viewer-2" } };
    expect(await projectHitlRenderInputs(run, gate, next)).toBeUndefined();
    expect(ports.use).toHaveBeenLastCalledWith(expect.objectContaining({ userId: "viewer-2", actor: expect.objectContaining({ principalId: "viewer-2" }) }), expect.anything());
    expect(ports.row).not.toHaveBeenCalled();
  });
  it("denied USE never reaches the second siteUrl projection lookup", async () => { ports.use.mockRejectedValue(new Error("denied")); expect(await projectHitlRenderInputs(run, gate, who)).toBeUndefined(); expect(ports.row).not.toHaveBeenCalled(); });
  it.each([{ actor: { actorType: "model", source: "agent" }, roleHints: { actorOrganizationId: "org-1" } }, { ...who, roleHints: { actorOrganizationId: "other" } }, { ...who, actor: { actorType: "human", source: "ui" } }])("untrusted/mismatched viewer cannot project %j", async viewer => { expect(await projectHitlRenderInputs(run, gate, viewer as typeof who)).toBeUndefined(); expect(ports.use).not.toHaveBeenCalled(); expect(ports.row).not.toHaveBeenCalled(); });
  it.each([{}, { wordpressInstanceId: "other" }])("legacy absent or conflicting persisted destination cannot trust interrupt %j", async inputParams => { expect(await projectHitlRenderInputs({ ...run, inputParams }, gate, who)).toBeUndefined(); expect(ports.use).not.toHaveBeenCalled(); });
  it.each([null, { id: "other", orgId: "org-1", siteUrl: "https://wrong.example" }, { id: "instance-1", orgId: "other", siteUrl: "https://wrong.example" }, { id: "instance-1", orgId: "org-1", siteUrl: "javascript:bad" }, { id: "instance-1", orgId: "org-1", siteUrl: "not a URL" }])("missing, wrong or malformed stored row gives no display %j", async row => { ports.row.mockReturnValue(row); expect(await projectHitlRenderInputs(run, gate, who)).toBeUndefined(); });
  it("unknown/undeclared renderer does not attempt USE or a lookup", async () => { ports.bindings.mockReturnValue([]); expect(await projectHitlRenderInputs(run, gate, who)).toBeUndefined(); ports.bindings.mockReturnValue([{ ...binding, params: {} }]); expect(await projectHitlRenderInputs(run, gate, who)).toBeUndefined(); expect(ports.use).not.toHaveBeenCalled(); });
  it("does not use an optional dependency or divergent manifest as a declaration", async () => { manifest.cinatra.dependencies[0].requirement = "optional"; persist(); expect(await projectHitlRenderInputs(run, gate, who)).toBeUndefined(); manifest.cinatra.dependencies[0].requirement = "required"; manifest.cinatra.fieldRenderers[0] = { ...binding, params: {} }; persist(); expect(await projectHitlRenderInputs(run, gate, who)).toBeUndefined(); expect(ports.use).not.toHaveBeenCalled(); });
  it("ignores malformed optional transport display without invalidating old gate", () => { const state = { state: "asking", runId: "run-1", gate: { ...gate, renderInputs: { bindingId: id, reviewTaskId: "task-1", siteHost: "user:secret@wrong.example" } } }; const parsed = parseAgentHitlScreenState(state); expect(parsed?.state).toBe("asking"); expect(parsed?.state === "asking" && parsed.gate.renderInputs).toBeUndefined(); expect(parsed?.state === "asking" && parsed.gate.currentValues).toEqual(gate.currentValues); });
});

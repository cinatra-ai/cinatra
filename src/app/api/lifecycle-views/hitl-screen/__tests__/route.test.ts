import { beforeEach, describe, expect, it, vi } from "vitest";
const ports = vi.hoisted(() => ({ caller: vi.fn(), owns: vi.fn(), read: vi.fn(), state: vi.fn() }));
vi.mock("@/lib/lifecycle/recommendation-hold-widget-branch", () => ({ resolveWidgetRecommendationCaller: ports.caller, widgetSessionOwnsRun: ports.owns }));
vi.mock("@cinatra-ai/agents/store", () => ({ readAgentRunById: ports.read }));
vi.mock("@cinatra-ai/agents/agent-hitl-screen-core", () => ({ agentHitlScreenStateForRun: ports.state }));
import { POST } from "../route";
const who = { actor: { actorType: "human", source: "mcp", userId: "widget-viewer" }, roleHints: { actorOrganizationId: "org-1" } };
const caller = { actorCtx: who, claims: { widgetSessionId: "session-1" } };
const run = { id: "run-1", orgId: "org-1" };
const request = (value: unknown) => new Request("https://app.example/api/lifecycle-views/hitl-screen", { method: "POST", body: JSON.stringify(value) });
beforeEach(() => { vi.clearAllMocks(); ports.caller.mockResolvedValue(caller); ports.read.mockResolvedValue(run); ports.owns.mockReturnValue(true); ports.state.mockResolvedValue({ state: "asking", runId: "run-1", gate: { renderInputs: { siteHost: "blog.acme.example" } } }); });
describe("widget screen display uses the same verified transport identity", () => {
  it("passes the verified widget viewer after BOTH current run gates", async () => { const response = await POST(request({ runId: "run-1" })); expect(response.status).toBe(200); expect(ports.read).toHaveBeenCalledWith("run-1", who.actor, who.roleHints); expect(ports.state).toHaveBeenCalledWith(run, who); expect(response.headers.get("Cache-Control")).toBe("no-store"); });
  it("no credential refuses before reading any run", async () => { ports.caller.mockResolvedValue(null); const response = await POST(request({ runId: "run-1" })); expect(response.status).toBe(401); expect(ports.read).not.toHaveBeenCalled(); expect(ports.state).not.toHaveBeenCalled(); });
  it("rejects client actor/instance injection in the strict body", async () => { expect((await POST(request({ runId: "run-1", userId: "forged", instanceId: "other" }))).status).toBe(400); expect(ports.read).not.toHaveBeenCalled(); });
  it.each(["no-run", "wrong-session"])("does not project an unauthorized gate %s", async reason => { if (reason === "no-run") ports.read.mockResolvedValue(null); else ports.owns.mockReturnValue(false); const response = await POST(request({ runId: "run-1" })); expect(await response.json()).toEqual({ state: "none" }); expect(ports.state).not.toHaveBeenCalled(); });
});

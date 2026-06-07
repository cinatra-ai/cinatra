import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The root vitest tsconfig path resolves @cinatra-ai/agents to the real
// (heavy) package barrel. Mock it so the resolver test never hits a DB and
// only the two store functions it calls are stubbed.
const readAgentRunById = vi.fn();
const readAgentTemplateById = vi.fn();

vi.mock("@cinatra-ai/agents", () => ({
  readAgentRunById: (...args: unknown[]) => readAgentRunById(...args),
  readAgentTemplateById: (...args: unknown[]) =>
    readAgentTemplateById(...args),
}));

// agent-run-href.ts lives in the package; its resolver is re-exported from the
// @cinatra-ai/notifications/server barrel. The vi.mock("@cinatra-ai/agents")
// above still intercepts the dynamic import inside the resolver.
import { resolveAgentRunHref } from "@cinatra-ai/notifications/server";

describe("resolveAgentRunHref", () => {
  beforeEach(() => {
    readAgentRunById.mockReset();
    readAgentTemplateById.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("resolves runId -> templateId -> packageName -> /agents/{vendor}/{pkg}/{runId}", async () => {
    readAgentRunById.mockResolvedValue({ id: "R1", templateId: "T1" });
    readAgentTemplateById.mockResolvedValue({
      id: "T1",
      packageName: "@cinatra-ai/foo",
    });

    const href = await resolveAgentRunHref({ runId: "R1" });

    expect(href).toBe("/agents/cinatra-ai/foo/R1");
  });

  it("calls readAgentRunById with the runId ONLY (no actor arg — skips the auth gate)", async () => {
    readAgentRunById.mockResolvedValue({ id: "R1", templateId: "T1" });
    readAgentTemplateById.mockResolvedValue({
      id: "T1",
      packageName: "@cinatra-ai/foo",
    });

    await resolveAgentRunHref({ runId: "R1" });

    expect(readAgentRunById).toHaveBeenCalledTimes(1);
    expect(readAgentRunById).toHaveBeenCalledWith("R1");
    // Exactly one positional arg — no actor / no roles.
    expect(readAgentRunById.mock.calls[0]).toHaveLength(1);
  });

  it("returns undefined for empty job data ({})", async () => {
    expect(await resolveAgentRunHref({})).toBeUndefined();
    expect(readAgentRunById).not.toHaveBeenCalled();
  });

  it("returns undefined for null job data", async () => {
    expect(await resolveAgentRunHref(null)).toBeUndefined();
    expect(readAgentRunById).not.toHaveBeenCalled();
  });

  it("returns undefined for an empty-string runId", async () => {
    expect(await resolveAgentRunHref({ runId: "" })).toBeUndefined();
    expect(await resolveAgentRunHref({ runId: "   " })).toBeUndefined();
    expect(readAgentRunById).not.toHaveBeenCalled();
  });

  it("returns undefined when readAgentRunById returns null (run missing)", async () => {
    readAgentRunById.mockResolvedValue(null);

    expect(await resolveAgentRunHref({ runId: "R1" })).toBeUndefined();
    expect(readAgentTemplateById).not.toHaveBeenCalled();
  });

  it("returns undefined when readAgentTemplateById returns null (template missing)", async () => {
    readAgentRunById.mockResolvedValue({ id: "R1", templateId: "T1" });
    readAgentTemplateById.mockResolvedValue(null);

    expect(await resolveAgentRunHref({ runId: "R1" })).toBeUndefined();
  });

  it("returns undefined when template.packageName is null (never builds /agents//R1)", async () => {
    readAgentRunById.mockResolvedValue({ id: "R1", templateId: "T1" });
    readAgentTemplateById.mockResolvedValue({ id: "T1", packageName: null });

    const href = await resolveAgentRunHref({ runId: "R1" });

    expect(href).toBeUndefined();
  });

  it("returns undefined when template.packageName is empty/whitespace", async () => {
    readAgentRunById.mockResolvedValue({ id: "R1", templateId: "T1" });
    readAgentTemplateById.mockResolvedValue({ id: "T1", packageName: "  " });

    expect(await resolveAgentRunHref({ runId: "R1" })).toBeUndefined();
  });

  it("returns undefined when template.packageName is undefined", async () => {
    readAgentRunById.mockResolvedValue({ id: "R1", templateId: "T1" });
    readAgentTemplateById.mockResolvedValue({ id: "T1" });

    expect(await resolveAgentRunHref({ runId: "R1" })).toBeUndefined();
  });

  it("swallows any thrown error inside resolution -> undefined (worker never breaks)", async () => {
    readAgentRunById.mockRejectedValue(new Error("db exploded"));

    const href = await resolveAgentRunHref({ runId: "R1" });

    expect(href).toBeUndefined();
  });

  it("resolves an unscoped package name to /agents/{pkg}/{runId}", async () => {
    readAgentRunById.mockResolvedValue({ id: "R2", templateId: "T2" });
    readAgentTemplateById.mockResolvedValue({
      id: "T2",
      packageName: "legacy-agent",
    });

    expect(await resolveAgentRunHref({ runId: "R2" })).toBe(
      "/agents/legacy-agent/R2",
    );
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../store", () => ({
  readAgentTemplateByPackageName: vi.fn(),
  readAllTemplateHitlSurfaces: vi.fn().mockResolvedValue([]),
  // Real (pure) predicate so the manifest resource's visibility gate works under mock.
  isAgentPubliclyDiscoverable: (t: { origin?: { visibility?: string | null } | null }) =>
    (t.origin?.visibility ?? "public") === "public",
}));
vi.mock("@/lib/mcp-instructions", () => ({
  CINATRA_MCP_INSTRUCTIONS: "TEST-INSTRUCTIONS-BODY",
  CINATRA_MCP_EXPERIMENTAL: { "io.cinatra.protocols": { protocolRevision: "1" } },
}));

type Resource = { name: string; uriOrTemplate: unknown; meta: any; cb: any };
type Prompt = { name: string; meta: any; cb: any };
const resources: Resource[] = [];
const prompts: Prompt[] = [];

function makeMockServer() {
  resources.length = 0;
  prompts.length = 0;
  return {
    registerTool: vi.fn(),
    registerResource: (name: string, uriOrTemplate: unknown, meta: any, cb: any) => {
      resources.push({ name, uriOrTemplate, meta, cb });
    },
    registerPrompt: (name: string, meta: any, cb: any) => {
      prompts.push({ name, meta, cb });
    },
    registerScreen: vi.fn(),
  } as any;
}

describe("registerAgentBuilderDiscovery", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("registers exactly 4 resources (3 static + 1 ResourceTemplate)", async () => {
    const { registerAgentBuilderDiscovery } = await import("../discovery");
    registerAgentBuilderDiscovery(makeMockServer());
    expect(resources).toHaveLength(4);
    const names = resources.map((r) => r.name).sort();
    expect(names).toEqual([
      "cinatra-agent-manifest",
      "cinatra-protocol-a2a",
      "cinatra-protocol-a2ui",
      "cinatra-protocol-agui",
    ]);
  });

  it("resources/list semantics: 3 static URI resources are strings (appear in resources/list)", async () => {
    const { registerAgentBuilderDiscovery } = await import("../discovery");
    registerAgentBuilderDiscovery(makeMockServer());
    const staticNames = ["cinatra-protocol-agui", "cinatra-protocol-a2ui", "cinatra-protocol-a2a"];
    for (const name of staticNames) {
      const r = resources.find((x) => x.name === name)!;
      expect(typeof r.uriOrTemplate).toBe("string");
    }
  });

  it("resources/templates/list semantics: cinatra-agent-manifest is a ResourceTemplate instance, NOT a string (appears in resources/templates/list ONLY)", async () => {
    const { registerAgentBuilderDiscovery } = await import("../discovery");
    registerAgentBuilderDiscovery(makeMockServer());
    const r = resources.find((x) => x.name === "cinatra-agent-manifest")!;
    // Per vendor/dist/index.mjs:1117-1125 — only ResourceTemplate registrations
    // with `listCallback` defined appear in `resources/list`. The manifest is
    // intentionally registered with `{ list: undefined }` so it surfaces ONLY
    // in `resources/templates/list`.
    expect(typeof r.uriOrTemplate).not.toBe("string");
    expect(r.uriOrTemplate).toBeDefined();
  });

  it("RES-01: ag-ui resource read returns markdown body containing AG-UI guide", async () => {
    const { registerAgentBuilderDiscovery } = await import("../discovery");
    registerAgentBuilderDiscovery(makeMockServer());
    const r = resources.find((x) => x.name === "cinatra-protocol-agui")!;
    expect(r.uriOrTemplate).toBe("cinatra://protocols/ag-ui");
    const out = await r.cb();
    expect(out.contents[0].mimeType).toBe("text/markdown");
    expect(out.contents[0].text).toMatch(/AG-UI/);
    expect(out.contents[0].text).toMatch(/RUN_STARTED/);
  });

  it("RES-02: a2ui resource queries readAllTemplateHitlSurfaces and lists surfaces", async () => {
    const store = await import("../../store");
    (store.readAllTemplateHitlSurfaces as any).mockResolvedValue([
      { packageName: "@cinatra-ai/email-outreach-agent", templateName: "Email Outreach", hitlScreens: ["email-sender:step-1:output"] },
    ]);
    const { registerAgentBuilderDiscovery } = await import("../discovery");
    registerAgentBuilderDiscovery(makeMockServer());
    const r = resources.find((x) => x.name === "cinatra-protocol-a2ui")!;
    expect(r.uriOrTemplate).toBe("cinatra://protocols/a2ui");
    const out = await r.cb();
    expect(store.readAllTemplateHitlSurfaces).toHaveBeenCalled();
    expect(out.contents[0].text).toMatch(/email-outreach/);
    expect(out.contents[0].text).toMatch(/email-sender:step-1:output/);
  });

  it("RES-03: a2a resource returns markdown referencing /api/a2a/agents/", async () => {
    const { registerAgentBuilderDiscovery } = await import("../discovery");
    registerAgentBuilderDiscovery(makeMockServer());
    const r = resources.find((x) => x.name === "cinatra-protocol-a2a")!;
    expect(r.uriOrTemplate).toBe("cinatra://protocols/a2a");
    const out = await r.cb();
    expect(out.contents[0].text).toMatch(/A2A/);
    expect(out.contents[0].text).toMatch(/\/api\/a2a\/agents\//);
  });

  it("RES-04: manifest registers as ResourceTemplate with uriTemplate string ({ list: undefined })", async () => {
    const { registerAgentBuilderDiscovery } = await import("../discovery");
    registerAgentBuilderDiscovery(makeMockServer());
    const r = resources.find((x) => x.name === "cinatra-agent-manifest")!;
    // Either the SDK ResourceTemplate exposes the template string via property/getter
    // or the constructor arg is preserved. Match either case.
    const uriTemplate =
      (r.uriOrTemplate as any)?.uriTemplate?.template ??
      (r.uriOrTemplate as any)?.uriTemplate ??
      String(r.uriOrTemplate);
    expect(String(uriTemplate)).toContain("cinatra://agents/{packageSlug}/manifest");
  });

  it("RES-04: manifest callback prepends @ when slug missing it AND manifest includes AG-UI eventTypes array", async () => {
    // buildAgentManifest uses the requested packageName so the vendor segment
    // is preserved instead of collapsed to the stored normalized form.
    const store = await import("../../store");
    (store.readAgentTemplateByPackageName as any).mockResolvedValue({
      packageName: "@cinatra/foo",
      name: "Foo",
      description: null,
      type: "leaf",
      status: "published",
      hitlScreens: ["foo:step-1:output"],
    });
    const { registerAgentBuilderDiscovery } = await import("../discovery");
    registerAgentBuilderDiscovery(makeMockServer());
    const r = resources.find((x) => x.name === "cinatra-agent-manifest")!;
    const out = await r.cb(new URL("cinatra://agents/cinatra-agents%2Ffoo/manifest"), { packageSlug: "cinatra-agents/foo" });
    // Multi-vendor agent layout: "cinatra-agents/foo" → "@cinatra-agents/foo"
    // (vendor segment preserved, not collapsed to "@cinatra/foo").
    expect(store.readAgentTemplateByPackageName).toHaveBeenCalledWith("@cinatra-agents/foo");
    expect(out.contents[0].mimeType).toBe("application/json");
    const parsed = JSON.parse(out.contents[0].text);
    expect(parsed.protocols.a2a.cardUrl).toBe("/api/a2a/agents/cinatra-agents/foo");
    expect(parsed.protocols.agUi.eventStreamUrl).toContain("/api/a2a?taskId=");
    // Manifest MUST include AG-UI eventTypes array.
    expect(Array.isArray(parsed.protocols.agUi.eventTypes)).toBe(true);
    expect(parsed.protocols.agUi.eventTypes.length).toBeGreaterThan(0);
    expect(parsed.protocols.agUi.eventTypes).toContain("RUN_STARTED");
    expect(parsed.protocols.a2ui.surfaceIds).toEqual(["foo:step-1:output"]);
  });

  it("RES-04: visibility — a PRIVATE agent's manifest is NOT returned by name (empty contents)", async () => {
    const store = await import("../../store");
    (store.readAgentTemplateByPackageName as any).mockResolvedValue({
      packageName: "@cinatra/secret",
      name: "Secret",
      status: "published",
      origin: { visibility: "private" },
      hitlScreens: [],
    });
    const { registerAgentBuilderDiscovery } = await import("../discovery");
    registerAgentBuilderDiscovery(makeMockServer());
    const r = resources.find((x) => x.name === "cinatra-agent-manifest")!;
    const out = await r.cb(new URL("cinatra://agents/cinatra%2Fsecret/manifest"), { packageSlug: "cinatra/secret" });
    expect(out.contents).toEqual([]);
  });

  it("RES-04: manifest callback does NOT double-prefix when slug already has @", async () => {
    const store = await import("../../store");
    (store.readAgentTemplateByPackageName as any).mockResolvedValue({
      packageName: "@cinatra/foo",
      name: "Foo",
      description: null,
      type: "leaf",
      status: "published",
      hitlScreens: [],
    });
    const { registerAgentBuilderDiscovery } = await import("../discovery");
    registerAgentBuilderDiscovery(makeMockServer());
    const r = resources.find((x) => x.name === "cinatra-agent-manifest")!;
    await r.cb(new URL("cinatra://agents/%40cinatra-agents%2Ffoo/manifest"), { packageSlug: "@cinatra/foo" });
    expect(store.readAgentTemplateByPackageName).toHaveBeenCalledWith("@cinatra/foo");
  });

  it("RES-04: returns empty contents when template not found", async () => {
    const store = await import("../../store");
    (store.readAgentTemplateByPackageName as any).mockResolvedValue(null);
    const { registerAgentBuilderDiscovery } = await import("../discovery");
    registerAgentBuilderDiscovery(makeMockServer());
    const r = resources.find((x) => x.name === "cinatra-agent-manifest")!;
    const out = await r.cb(new URL("cinatra://agents/missing/manifest"), { packageSlug: "missing" });
    expect(out.contents).toEqual([]);
  });

  it("RES-04: returns empty contents on empty packageSlug without hitting store", async () => {
    const store = await import("../../store");
    (store.readAgentTemplateByPackageName as any).mockClear();
    const { registerAgentBuilderDiscovery } = await import("../discovery");
    registerAgentBuilderDiscovery(makeMockServer());
    const r = resources.find((x) => x.name === "cinatra-agent-manifest")!;
    const out = await r.cb(new URL("cinatra://agents//manifest"), { packageSlug: "" });
    expect(out.contents).toEqual([]);
    expect(store.readAgentTemplateByPackageName).not.toHaveBeenCalled();
  });

  it("PROMPT-01: registers exactly 1 prompt named 'cinatra/getting-started'", async () => {
    const { registerAgentBuilderDiscovery } = await import("../discovery");
    registerAgentBuilderDiscovery(makeMockServer());
    expect(prompts).toHaveLength(1);
    expect(prompts[0].name).toBe("cinatra/getting-started");
  });

  it("PROMPT-01: prompt callback returns user-role text message with instructions body", async () => {
    const { registerAgentBuilderDiscovery } = await import("../discovery");
    registerAgentBuilderDiscovery(makeMockServer());
    const out = await prompts[0].cb();
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0].role).toBe("user");
    expect(out.messages[0].content.type).toBe("text");
    expect(out.messages[0].content.text).toBe("TEST-INSTRUCTIONS-BODY");
  });

  it("RES-04: manifest eventTypes set-equals canonical AG_UI_EVENT_TYPES (catches future divergence)", async () => {
    const { AG_UI_EVENT_TYPES: canonical } = await import("@cinatra-ai/agent-ui-protocol");
    const store = await import("../../store");
    (store.readAgentTemplateByPackageName as ReturnType<typeof vi.fn>).mockResolvedValue({
      packageName: "@cinatra/foo",
      name: "Foo",
      description: null,
      type: "leaf" as const,
      status: "published" as const,
      hitlScreens: [],
    });
    const { registerAgentBuilderDiscovery } = await import("../discovery");
    registerAgentBuilderDiscovery(makeMockServer());
    const r = resources.find((x) => x.name === "cinatra-agent-manifest")!;
    const out = await r.cb(new URL("cinatra://agents/foo/manifest"), { packageSlug: "foo" }) as Awaited<ReturnType<typeof r.cb>>;
    const parsed = JSON.parse((out.contents[0] as { text: string }).text) as {
      protocols: { agUi: { eventTypes: string[] } };
    };
    expect(new Set(parsed.protocols.agUi.eventTypes)).toEqual(new Set(canonical));
  });
});

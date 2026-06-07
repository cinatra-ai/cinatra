// True-IoC: the dynamic published-agent MCP tool surface consumes the
// canonical install/lifecycle gate. Only agents with an `active|locked`
// `installed_extension` manifest are registered as tools; archived /
// uninstalled / never-installed published agents are NOT. The gate is
// lifecycle-only (NOT per-actor visibility) — public AND private published
// agents with a live manifest both register at this global, actor-less boundary.
//
// These tests inject the gate directly via the `opts.getLiveAgentPackageNames`
// param (production wires the same provider once via setLiveAgentManifestProvider).

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@cinatra-ai/llm/actor-context", () => ({ getActorContext: vi.fn() }));
vi.mock("../store", () => ({
  readPublishedAgentTemplates: vi.fn(),
  createAgentRun: vi.fn(),
  readAgentRunById: vi.fn(),
  // Real (pure) predicate so the visibility gate behaves correctly under mock.
  isAgentPubliclyDiscoverable: (t: { origin?: { visibility?: string | null } | null }) =>
    (t.origin?.visibility ?? "public") === "public",
}));

import type { McpRuntimeToolServer } from "@cinatra-ai/mcp-server";
import {
  registerPublishedAgentTools,
  setLiveAgentManifestProvider,
  sanitizePackageNameToToolName,
} from "../mcp/agent-tools-registry";
import { readPublishedAgentTemplates } from "../store";

// A fake server that records the tool names that get registered.
function buildRecordingServer(): { server: McpRuntimeToolServer; names: () => string[] } {
  const registered: string[] = [];
  const server = {
    registerTool(name: string) {
      registered.push(name);
      return undefined as unknown;
    },
    registerResource: () => undefined as unknown,
    registerPrompt: () => undefined as unknown,
    registerScreen: () => undefined,
  } as unknown as McpRuntimeToolServer;
  return { server, names: () => registered };
}

function tpl(packageName: string, over: Record<string, unknown> = {}) {
  return {
    id: `id-${packageName}`,
    name: packageName,
    packageName,
    description: `Run ${packageName}`,
    ...over,
  };
}

// The set of package names the registered tool names map back to.
function toolNameFor(pkg: string) {
  return sanitizePackageNameToToolName(pkg);
}

describe("registerPublishedAgentTools — canonical install/lifecycle gate (IoC)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setLiveAgentManifestProvider(null); // ensure no globalThis provider leaks across tests
  });

  it("registers ONLY published agents whose package is in the live manifest set (drops orphans)", async () => {
    vi.mocked(readPublishedAgentTemplates).mockResolvedValue([
      tpl("@x/installed-agent"),
      tpl("@x/orphan-never-installed"), // published but NO manifest row
    ] as never);
    const { server, names } = buildRecordingServer();

    await registerPublishedAgentTools(server, {
      getLiveAgentPackageNames: async () => new Set(["@x/installed-agent"]),
    });

    expect(names()).toEqual([toolNameFor("@x/installed-agent")]);
    expect(names()).not.toContain(toolNameFor("@x/orphan-never-installed"));
  });

  it("visibility policy: PRIVATE published agents are NOT registered; public ones are", async () => {
    // Visibility filtering: this global, actor-less surface must not advertise
    // private agents' tool defs.
    vi.mocked(readPublishedAgentTemplates).mockResolvedValue([
      tpl("@public/agent", { origin: { visibility: "public" } }),
      tpl("@private/agent", { origin: { visibility: "private", scope: "@private" } }),
    ] as never);
    const { server, names } = buildRecordingServer();

    await registerPublishedAgentTools(server, {
      getLiveAgentPackageNames: async () => new Set(["@public/agent", "@private/agent"]),
    });

    expect(names()).toEqual([toolNameFor("@public/agent")]);
    expect(names()).not.toContain(toolNameFor("@private/agent"));
  });

  it("a LOCKED (required-in-prod) manifest still registers — locked is a discoverable status", async () => {
    // readActiveManifestsFromStore includes active AND locked, so the host
    // provider's set contains locked packages; a locked agent must still appear
    // as a tool (locked blocks archive/uninstall, not discovery/registration).
    vi.mocked(readPublishedAgentTemplates).mockResolvedValue([
      tpl("@x/locked-required-agent"),
    ] as never);
    const { server, names } = buildRecordingServer();

    await registerPublishedAgentTools(server, {
      getLiveAgentPackageNames: async () => new Set(["@x/locked-required-agent"]),
    });

    expect(names()).toEqual([toolNameFor("@x/locked-required-agent")]);
  });

  it("visibility: a PRIVATE published agent is NOT registered even with a live manifest", async () => {
    vi.mocked(readPublishedAgentTemplates).mockResolvedValue([
      tpl("@x/public-agent", { origin: { visibility: "public" } }),
      tpl("@x/private-agent", { origin: { visibility: "private" } }),
      tpl("@x/grandfathered-agent", { origin: null }), // null origin -> public (grandfather)
    ] as never);
    const { server, names } = buildRecordingServer();
    await registerPublishedAgentTools(server, {
      getLiveAgentPackageNames: async () =>
        new Set(["@x/public-agent", "@x/private-agent", "@x/grandfathered-agent"]),
    });
    expect(names().sort()).toEqual(
      [toolNameFor("@x/public-agent"), toolNameFor("@x/grandfathered-agent")].sort(),
    );
    expect(names()).not.toContain(toolNameFor("@x/private-agent"));
  });

  it("an archived/inactive manifest (package absent from the live set) does NOT register", async () => {
    vi.mocked(readPublishedAgentTemplates).mockResolvedValue([
      tpl("@x/archived-but-published"),
    ] as never);
    const { server, names } = buildRecordingServer();

    await registerPublishedAgentTools(server, {
      getLiveAgentPackageNames: async () => new Set<string>(), // nothing live
    });

    expect(names()).toEqual([]);
  });

  it("INERT gate when no provider is wired (null) — every published agent registers (pre-gate fallback)", async () => {
    vi.mocked(readPublishedAgentTemplates).mockResolvedValue([
      tpl("@x/a"),
      tpl("@x/b"),
    ] as never);
    const { server, names } = buildRecordingServer();

    // No opts, no globalThis provider set -> gate inert.
    await registerPublishedAgentTools(server);

    expect(names().sort()).toEqual([toolNameFor("@x/a"), toolNameFor("@x/b")].sort());
  });

  it("fails OPEN when the gate provider THROWS — registers all rather than dropping the whole surface", async () => {
    vi.mocked(readPublishedAgentTemplates).mockResolvedValue([
      tpl("@x/a"),
      tpl("@x/b"),
    ] as never);
    const { server, names } = buildRecordingServer();

    await registerPublishedAgentTools(server, {
      getLiveAgentPackageNames: async () => {
        throw new Error("canonical store unreachable");
      },
    });

    expect(names().sort()).toEqual([toolNameFor("@x/a"), toolNameFor("@x/b")].sort());
  });

  it("a provider that returns null is treated as inert (register all)", async () => {
    vi.mocked(readPublishedAgentTemplates).mockResolvedValue([tpl("@x/a")] as never);
    const { server, names } = buildRecordingServer();

    await registerPublishedAgentTools(server, {
      getLiveAgentPackageNames: async () => null,
    });

    expect(names()).toEqual([toolNameFor("@x/a")]);
  });

  it("the host-wired globalThis provider is used when no opts override is passed", async () => {
    vi.mocked(readPublishedAgentTemplates).mockResolvedValue([
      tpl("@x/live"),
      tpl("@x/dead"),
    ] as never);
    const { server, names } = buildRecordingServer();

    setLiveAgentManifestProvider(async () => new Set(["@x/live"]));
    await registerPublishedAgentTools(server); // no opts -> falls back to globalThis provider

    expect(names()).toEqual([toolNameFor("@x/live")]);
    setLiveAgentManifestProvider(null);
  });

  it("opts override takes precedence over the globalThis provider", async () => {
    vi.mocked(readPublishedAgentTemplates).mockResolvedValue([
      tpl("@x/one"),
      tpl("@x/two"),
    ] as never);
    const { server, names } = buildRecordingServer();

    setLiveAgentManifestProvider(async () => new Set(["@x/one"]));
    await registerPublishedAgentTools(server, {
      getLiveAgentPackageNames: async () => new Set(["@x/two"]),
    });

    expect(names()).toEqual([toolNameFor("@x/two")]);
    setLiveAgentManifestProvider(null);
  });
});

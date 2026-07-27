import { describe, expect, it, vi } from "vitest";
import {
  CATALOG_DEFAULT_SERVER_ID,
  buildFirstClassSnapshot,
  composeSortedCatalog,
  createInMemoryConnectorInstanceCatalogCache,
  expandTriadCatalog,
  resolveToolAcrossServers,
  type CatalogServerSnapshot,
} from "@/lib/connector-instance-catalog-cache";
import {
  TRIAD_DISCOVER_ABILITIES,
  TRIAD_GET_ABILITY_INFO,
} from "@/lib/connector-instance-mcp-transport";

// cinatra#2017 S2 slice K5 — catalog cache: triad expansion, routing, sort (§3).

describe("expandTriadCatalog — discover → get-info → row (inner annotations, A2 fields)", () => {
  it("enumerates abilities and hydrates schema + annotations from get-ability-info", async () => {
    const callWireTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === TRIAD_DISCOVER_ABILITIES) {
        return { abilities: [{ name: "ewpa/create-post" }, { name: "core/get-site-info" }] };
      }
      if (name === TRIAD_GET_ABILITY_INFO) {
        return {
          name: args.ability_name,
          label: `L:${args.ability_name}`,
          description: `D:${args.ability_name}`,
          input_schema: { type: "object" },
          output_schema: { type: "object" },
          meta: { annotations: args.ability_name === "ewpa/create-post" ? { destructiveHint: true } : { readOnlyHint: true } },
        };
      }
      return {};
    });
    const snap = await expandTriadCatalog({ callWireTool, serverId: CATALOG_DEFAULT_SERVER_ID, revision: "rev-1", now: 0 });
    expect(snap.exposureMode).toBe("triad-only");
    expect(snap.tools).toHaveLength(2);
    const create = snap.tools.find((t) => t.name === "ewpa/create-post")!;
    expect(create.inputSchema).toEqual({ type: "object" });
    expect(create.outputSchema).toEqual({ type: "object" });
    expect(create.label).toBe("L:ewpa/create-post");
    expect(create.rawAnnotations).toEqual({ destructiveHint: true }); // INNER ability annotations
  });
});

describe("buildFirstClassSnapshot", () => {
  it("passes native tools through with annotations + schema", () => {
    const snap = buildFirstClassSnapshot({
      serverId: "fixturelabs",
      tools: [{ name: "note_read", inputSchema: { type: "object" }, annotations: { readOnlyHint: true }, description: "d" }],
      revision: "r",
      now: 0,
    });
    expect(snap.exposureMode).toBe("first-class");
    expect(snap.tools[0]).toMatchObject({ name: "note_read", rawAnnotations: { readOnlyHint: true }, description: "d" });
  });
});

describe("resolveToolAcrossServers — presence + duplicate-name routing (§3.6)", () => {
  const mk = (serverId: string, names: string[]): CatalogServerSnapshot => ({
    serverId,
    exposureMode: "triad-only",
    tools: names.map((name) => ({ name, serverId, inputSchema: {}, rawAnnotations: {} })),
    catalogRevision: "r",
    fetchedAtMs: 0,
  });

  it("unique name → resolved deterministically", () => {
    const r = resolveToolAcrossServers([mk("a", ["x", "y"])], "x");
    expect(r).toMatchObject({ ok: true, serverId: "a", name: "x" });
  });
  it("absent name → tool_not_found", () => {
    expect(resolveToolAcrossServers([mk("a", ["x"])], "z")).toEqual({ ok: false, reason: "tool_not_found" });
  });
  it("non-unique across servers, no serverId → ambiguous_tool with candidate serverIds", () => {
    const r = resolveToolAcrossServers([mk("a", ["dup"]), mk("b", ["dup"])], "dup");
    expect(r).toMatchObject({ ok: false, reason: "ambiguous_tool", candidateServerIds: ["a", "b"] });
  });
  it("non-unique but serverId narrows → resolved", () => {
    const r = resolveToolAcrossServers([mk("a", ["dup"]), mk("b", ["dup"])], "dup", "b");
    expect(r).toMatchObject({ ok: true, serverId: "b" });
  });
});

describe("composeSortedCatalog — stable sort key (serverId, name), slash-safe", () => {
  it("sorts by serverId then name including slash-bearing abilities", () => {
    const s = composeSortedCatalog([
      {
        serverId: "b",
        exposureMode: "triad-only",
        tools: [{ name: "z", serverId: "b", inputSchema: {}, rawAnnotations: {} }],
        catalogRevision: "r",
        fetchedAtMs: 0,
      },
      {
        serverId: "a",
        exposureMode: "triad-only",
        tools: [
          { name: "ewpa/create-post", serverId: "a", inputSchema: {}, rawAnnotations: {} },
          { name: "core/get-site-info", serverId: "a", inputSchema: {}, rawAnnotations: {} },
        ],
        catalogRevision: "r",
        fetchedAtMs: 0,
      },
    ]);
    expect(s.map((t) => `${t.serverId}:${t.name}`)).toEqual([
      "a:core/get-site-info",
      "a:ewpa/create-post",
      "b:z",
    ]);
  });
});

describe("in-memory cache", () => {
  it("stores + lists + invalidates per (instance, server)", () => {
    const cache = createInMemoryConnectorInstanceCatalogCache();
    const snap: CatalogServerSnapshot = {
      serverId: CATALOG_DEFAULT_SERVER_ID,
      exposureMode: "triad-only",
      tools: [],
      catalogRevision: "r",
      fetchedAtMs: 0,
    };
    cache.set("i1", snap);
    expect(cache.get("i1", CATALOG_DEFAULT_SERVER_ID)).toBe(snap);
    expect(cache.listForInstance("i1")).toHaveLength(1);
    cache.invalidate("i1");
    expect(cache.listForInstance("i1")).toHaveLength(0);
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createExtensionHostContext,
  createNonDefaultVersionHostContext,
} from "@/lib/extension-host-context";
import {
  beginVersionKeyedRegistration,
  __resetVersionKeyedServingForTests,
} from "@/lib/extension-version-keyed-serving";
import { _resetExtensionMcpForTests } from "@/lib/extension-mcp-registry";

// cinatra#4894 — `ctx.mcp.callPrimitive` refuses a host primitive the calling
// pack does not declare in `cinatra.consumes`. The fixture packs below are
// made up; the generated compiled-in map is replaced with a fixture map, and the
// host self-invoker is a stub that records what reached it.

const DECLARING = "@example-org/sample-agent";
const NO_CONSUMES = "@example-org/quiet-connector";
const MALFORMED = "@example-org/broken-agent";
const UNKNOWN = "@example-org/never-generated";

const reached: string[] = [];
vi.mock("@/lib/extension-self-mcp", () => ({
  callHostPrimitive: vi.fn(async (name: string) => {
    reached.push(name);
    return name === "object_history_list" ? { items: [{ version: 1 }] } : { called: name };
  }),
}));
vi.mock("@/lib/extension-host-actor", () => ({
  resolveExtensionActorContext: vi.fn(async () => null),
  resolveExtensionActorSummary: vi.fn(async () => null),
  requireExtensionOrganizationId: vi.fn(async () => "org-1"),
}));
vi.mock("@/lib/generated/extensions.server", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  GENERATED_EXTENSION_CONSUMES_DECLARATIONS: {
    "@example-org/sample-agent": {
      consumes: [
        { primitive: "sample_record_get", requirement: "required" },
        { primitive: "sample_record_list", requirement: "optional" },
      ],
    },
    "@example-org/quiet-connector": {},
    "@example-org/broken-agent": { consumes: null },
  },
}));

beforeEach(() => {
  reached.length = 0;
  __resetVersionKeyedServingForTests();
  _resetExtensionMcpForTests();
});

describe("ctx.mcp.callPrimitive — a compiled-in pack (the generated declaration map)", () => {
  it("refuses a primitive the pack does not declare, naming the package, the primitive and cinatra.consumes", async () => {
    const ctx = createExtensionHostContext(DECLARING, ["mcp"]);
    const call = ctx.mcp.callPrimitive("sample_record_delete", {});
    await expect(call).rejects.toThrow(/@example-org\/sample-agent/);
    await expect(ctx.mcp.callPrimitive("sample_record_delete", {})).rejects.toThrow(/"sample_record_delete"/);
    await expect(ctx.mcp.callPrimitive("sample_record_delete", {})).rejects.toThrow(
      /not declared in the package's cinatra\.consumes/,
    );
    expect(reached).toEqual([]);
  });

  it("refuses a primitive named by a computed string (the check is on the run-time value)", async () => {
    const ctx = createExtensionHostContext(DECLARING, ["mcp"]);
    const name = ["sample", "record", "delete"].join("_");
    await expect(ctx.mcp.callPrimitive(name, {})).rejects.toThrow(/not declared in the package's cinatra\.consumes/);
    expect(reached).toEqual([]);
  });

  it("a declared (required) primitive reaches the host handler", async () => {
    const ctx = createExtensionHostContext(DECLARING, ["mcp"]);
    await expect(ctx.mcp.callPrimitive("sample_record_get", {})).resolves.toEqual({ called: "sample_record_get" });
    expect(reached).toEqual(["sample_record_get"]);
  });

  it("an optional entry counts as declared", async () => {
    const ctx = createExtensionHostContext(DECLARING, ["mcp"]);
    await expect(ctx.mcp.callPrimitive("sample_record_list", {})).resolves.toEqual({ called: "sample_record_list" });
    expect(reached).toEqual(["sample_record_list"]);
  });

  it("a pack with no cinatra.consumes is refused (deny by default)", async () => {
    const ctx = createExtensionHostContext(NO_CONSUMES, ["mcp"]);
    await expect(ctx.mcp.callPrimitive("sample_record_get", {})).rejects.toThrow(
      /not declared in the package's cinatra\.consumes/,
    );
    expect(reached).toEqual([]);
  });

  it("a malformed cinatra.consumes is refused: the declared set cannot be determined", async () => {
    const ctx = createExtensionHostContext(MALFORMED, ["mcp"]);
    await expect(ctx.mcp.callPrimitive("sample_record_get", {})).rejects.toThrow(/cannot be determined/);
    expect(reached).toEqual([]);
  });

  it("a pack absent from the generated map, with no declaration handed over, is refused", async () => {
    const ctx = createExtensionHostContext(UNKNOWN, ["mcp"]);
    await expect(ctx.mcp.callPrimitive("sample_record_get", {})).rejects.toThrow(/cannot be determined/);
    expect(reached).toEqual([]);
  });
});

describe("ctx.mcp.callPrimitive — a declaration handed over by the loader (the runtime-store road)", () => {
  const storeDeclaration = { consumes: [{ primitive: "store_item_read", requirement: "required" }] };

  it("the handed-over declaration decides, not the generated map", async () => {
    const ctx = createExtensionHostContext(DECLARING, ["mcp"], {}, { consumesDeclaration: storeDeclaration });
    await expect(ctx.mcp.callPrimitive("store_item_read", {})).resolves.toEqual({ called: "store_item_read" });
    // Declared by the compiled-in map, but not by this loaded version's manifest.
    await expect(ctx.mcp.callPrimitive("sample_record_get", {})).rejects.toThrow(
      /not declared in the package's cinatra\.consumes/,
    );
    expect(reached).toEqual(["store_item_read"]);
  });

  it("a loader that could not read the declaration (null) has every call refused", async () => {
    const ctx = createExtensionHostContext(UNKNOWN, ["mcp"], {}, { consumesDeclaration: null });
    await expect(ctx.mcp.callPrimitive("store_item_read", {})).rejects.toThrow(/cannot be determined/);
    expect(reached).toEqual([]);
  });

  it("the committed non-default version ctx applies its own declaration", async () => {
    const sink = beginVersionKeyedRegistration(UNKNOWN, "0.1.0");
    const ctx = createNonDefaultVersionHostContext(UNKNOWN, ["mcp"], {}, sink, {
      version: "0.1.0",
      isDefault: false,
      consumesDeclaration: storeDeclaration,
    });
    sink.commit();
    await expect(ctx.mcp.callPrimitive("store_item_read", {})).resolves.toEqual({ called: "store_item_read" });
    await expect(ctx.mcp.callPrimitive("store_item_write", {})).rejects.toThrow(
      /not declared in the package's cinatra\.consumes/,
    );
    expect(reached).toEqual(["store_item_read"]);
  });
});

describe("core's own internal primitive calls are not the pack's calls", () => {
  it("ctx.objects.history still reaches object_history_list for a pack that declares nothing", async () => {
    const ctx = createExtensionHostContext(NO_CONSUMES, ["objects"]);
    await expect(ctx.objects.history("sample-type", "obj-1")).resolves.toEqual([{ version: 1 }]);
    expect(reached).toEqual(["object_history_list"]);
  });
});

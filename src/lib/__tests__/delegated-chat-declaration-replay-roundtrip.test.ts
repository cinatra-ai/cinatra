import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The declaration ROUND TRIP, as behaviour (cinatra#2771).
//
// `delegated-chat-declaration-plumbing.test.ts` covers most hops directly, but
// two of them — the replay's freshly-rebuilt `registerTool` config, and the
// self-primitive capture that reads it back — sit inside `registerAllCapabilities`
// / `buildHostSelfPrimitiveHandlers`, which need the whole connector graph and a
// database. Those two were pinned only as SOURCE STRINGS, which proves a line
// exists and proves nothing about what it does.
//
// Both are now pure exported seams, so this file closes the loop for real:
//
//   REGISTER   a real `ctx.mcp.registerTool` extension registration, through
//              the real registry and its real structural normalizer.
//   REPLAY     the real `buildReplayedExtensionToolConfig` — the from-scratch
//              config the per-request server build puts on the wire.
//   CAPTURE    the real `createSelfPrimitiveRecordingServer`, reading that
//              config back with the policy's own reader.
//   CALL TIME  the real `callHostPrimitive` decision over the captured entry.
//
// What fails here that a source ratchet could not: drop the declaration at
// EITHER hop and the class the call-time lookup sees stops matching the class
// the registration wrote — silently, in the direction of exposure.

const capturedHandlers = new Map<string, unknown>();

// Only the DB-bound module walk is replaced: `buildHostSelfPrimitiveHandlers`
// returns the map THIS FILE built through the real seams, which are imported
// from `@/lib/mcp-declaration-replay` — a module with no connector/DB graph —
// so every hop under test is real code.
vi.mock("@/lib/mcp-server", () => ({
  buildHostSelfPrimitiveHandlers: async () => capturedHandlers,
}));

// A delegated-chat request frame. The declaration is only ever consulted inside
// one, and always AFTER host admission — which stays the REAL policy below.
let delegatedRestricted = true;
vi.mock("@cinatra-ai/mcp-server", async () => {
  const policy = await vi.importActual<
    typeof import("@cinatra-ai/mcp-server/delegated-chat-tool-policy")
  >("@cinatra-ai/mcp-server/delegated-chat-tool-policy");
  return {
    mcpRequestContextStorage: {
      getStore: () => ({ delegatedRestricted }),
      run: (_ctx: unknown, fn: () => unknown) => fn(),
    },
    isDelegatedChatMcpToolAllowed: policy.isDelegatedChatMcpToolAllowed,
  };
});

// Not under test here — the deny-by-default boundary has its own suites, and
// leaving it open is what lets a declaration refusal be observed on its own.
vi.mock("@/lib/authz/mcp-boundary", () => ({
  enforceMcpBoundary: async () => ({ allowed: true }),
}));

import {
  buildReplayedExtensionToolConfig,
  createSelfPrimitiveRecordingServer,
  type CapturedHostPrimitive,
} from "@/lib/mcp-declaration-replay";
import {
  registerExtensionMcpTool,
  listExtensionMcpTools,
  _resetExtensionMcpForTests,
} from "@/lib/extension-mcp-registry";
import { callHostPrimitive, __resetHostSelfPrimitiveHandlers } from "@/lib/extension-self-mcp";
import {
  interimDelegatedChatClassFor,
  type DelegatedChatToolClass,
} from "@cinatra-ai/mcp-server/delegated-chat-tool-policy";

const PKG = "@cinatra-ai/acme";
const handler = async () => ({ structuredContent: { ok: true } });

/**
 * Drive one registration all the way to the captured entry the call-time lookup
 * reads, through the real replay and capture seams.
 */
function roundTrip(name: string, declared?: DelegatedChatToolClass): CapturedHostPrimitive {
  registerExtensionMcpTool(PKG, {
    name,
    handler,
    ...(declared === undefined ? {} : { delegatedChat: declared }),
  });
  const registration = listExtensionMcpTools().find((t) => t.name === name)!;

  const handlers = new Map<string, CapturedHostPrimitive>();
  const recording = createSelfPrimitiveRecordingServer(handlers);
  (recording.registerTool as (...a: unknown[]) => unknown)(
    name,
    // The REPLAY hop: a config rebuilt from scratch.
    buildReplayedExtensionToolConfig(name, registration),
    handler,
  );

  capturedHandlers.clear();
  for (const [k, v] of handlers) capturedHandlers.set(k, v);
  __resetHostSelfPrimitiveHandlers();
  return handlers.get(name)!;
}

beforeEach(() => {
  delegatedRestricted = true;
  _resetExtensionMcpForTests();
  capturedHandlers.clear();
  __resetHostSelfPrimitiveHandlers();
});
afterEach(() => {
  _resetExtensionMcpForTests();
  __resetHostSelfPrimitiveHandlers();
});

describe("declaration round trip: register → replay → capture", () => {
  it("the captured entry carries the class the registration declared", () => {
    for (const cls of ["read", "discovery", "dispatch", "none"] as const) {
      _resetExtensionMcpForTests();
      expect(roundTrip("acme_thing_list", cls).delegatedChat).toBe(cls);
    }
  });

  it("normalizes a malformed declaration once, and it survives both hops", () => {
    const captured = roundTrip(
      "acme_thing_list",
      // @ts-expect-error — a connector shipping an off-enum value is the case
      "superuser",
    );
    expect(captured.delegatedChat).toBe("none");
  });

  it("preserves ABSENCE as absence, distinct from a declared `none`", () => {
    // Load-bearing: the interim shim fills in for an ABSENT declaration and
    // must not for an explicit `none`. A hop that collapsed the two would make
    // a connector's deliberate opt-out indistinguishable from silence.
    expect(roundTrip("acme_thing_list").delegatedChat).toBeUndefined();
  });
});

describe("declaration round trip: the call-time lookup sees the SAME class", () => {
  it("refuses a delegated-chat self-invocation of a primitive declaring `none`", async () => {
    roundTrip("agent_list", "none");
    await expect(callHostPrimitive("agent_list", {})).rejects.toThrow(
      /declines the delegated chat surface \(delegatedChat: "none"\)/,
    );
  });

  it("refuses one whose declaration was MALFORMED, reporting the normalized class", async () => {
    roundTrip(
      "agent_list",
      // @ts-expect-error — off-enum value
      "superuser",
    );
    await expect(callHostPrimitive("agent_list", {})).rejects.toThrow(
      /declines the delegated chat surface \(delegatedChat: "none"\)/,
    );
  });

  it("allows one declaring a chat-eligible class", async () => {
    for (const cls of ["read", "discovery", "dispatch"] as const) {
      _resetExtensionMcpForTests();
      roundTrip("agent_list", cls);
      await expect(callHostPrimitive("agent_list", {})).resolves.toEqual({ ok: true });
    }
  });

  it("allows an UNDECLARED primitive the legacy allowlist admits, via the interim class", async () => {
    // Since the owner's ruling an absent declaration means `none`, so this
    // only passes because the call-time lookup resolves through the same
    // interim shim the choke point uses. If it read the captured value raw,
    // every undeclared primitive would be refused here — which is the failure
    // the shim exists to prevent, observed end to end rather than argued.
    expect(interimDelegatedChatClassFor("agent_list")).toBe("discovery");
    roundTrip("agent_list");
    await expect(callHostPrimitive("agent_list", {})).resolves.toEqual({ ok: true });
  });

  it("refuses an UNDECLARED primitive the legacy allowlist does NOT admit", async () => {
    // The other half, and the reason the previous test is not a fail-open: an
    // extension's own primitive is not on the interim allowlist, so no class is
    // in force. It loses at admission first — the declaration check never even
    // decides it — which is the AND ordering this whole channel rests on.
    expect(interimDelegatedChatClassFor("acme_thing_list")).toBeUndefined();
    roundTrip("acme_thing_list");
    await expect(callHostPrimitive("acme_thing_list", {})).rejects.toThrow(
      /is not available to delegated chat MCP requests/,
    );
  });

  it("leaves an UNRESTRICTED (non-chat) frame untouched by any declaration", async () => {
    // The declaration is a delegated-chat channel only. An operator's own MCP
    // client or an agent run must not lose a primitive because a connector
    // declined the CHAT surface.
    delegatedRestricted = false;
    roundTrip("acme_thing_list", "none");
    await expect(callHostPrimitive("acme_thing_list", {})).resolves.toEqual({ ok: true });
  });
});

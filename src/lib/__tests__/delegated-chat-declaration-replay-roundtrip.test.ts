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
// returns the map THIS FILE built through the real seams, which live alongside
// the extension registry — a module with no connector/DB graph — so every hop
// under test is real code.
vi.mock("@/lib/mcp-server", () => ({
  buildHostSelfPrimitiveHandlers: async () => capturedHandlers,
}));

// A delegated-chat request frame. The declaration is only ever consulted inside
// one, and always AFTER host admission — which stays the REAL policy below.
let delegatedRestricted = true;
vi.mock("@cinatra-ai/mcp-server", () => ({
  mcpRequestContextStorage: {
    getStore: () => ({ delegatedRestricted }),
    run: (_ctx: unknown, fn: () => unknown) => fn(),
  },
}));

// The REQUEST'S ADMISSION SNAPSHOT (cinatra#2817). Held here so a case can put
// a REVIEWED admission for the extension under test into it and observe the
// primitive becoming callable end to end — the extensibility outcome the whole
// issue is for — without a database.
let snapshotRecords: unknown[] = [];
vi.mock("@/lib/delegated-chat-admission-store", async () => {
  const admission = await vi.importActual<
    typeof import("@cinatra-ai/mcp-server/delegated-chat-admission")
  >("@cinatra-ai/mcp-server/delegated-chat-admission");
  return {
    loadDelegatedChatAdmissionSnapshot: async () =>
      admission.createDelegatedChatAdmissionSnapshot({
        rawRecords: snapshotRecords,
        activationGeneration: 0,
        admissionGeneration: 0,
      }),
  };
});

// The caller has no resolved edges, so the self-invoker's caller-bound identity
// resolution lands on the DEFAULT version — the registration's own.
vi.mock("@/lib/extension-edge-bound-serving", () => ({
  resolveEdgeBoundExtensionVersion: async () => ({ kind: "none" }),
}));

// Not under test here — the deny-by-default boundary has its own suites, and
// leaving it open is what lets a declaration refusal be observed on its own.
vi.mock("@/lib/authz/mcp-boundary", () => ({
  enforceMcpBoundary: async () => ({ allowed: true }),
}));

import {
  buildReplayedExtensionToolConfig,
  createSelfPrimitiveRecordingServer,
  registerExtensionMcpTool,
  listExtensionMcpTools,
  _resetExtensionMcpForTests,
  type CapturedHostPrimitive,
} from "@/lib/extension-mcp-registry";
import { callHostPrimitive, __resetHostSelfPrimitiveHandlers } from "@/lib/extension-self-mcp";
import type { DelegatedChatToolClass } from "@cinatra-ai/mcp-server/delegated-chat-tool-policy";
import { admissionRecordFor } from "@cinatra-ai/mcp-server/delegated-chat-admission";

const PKG = "@cinatra-ai/acme";
const PKG_VERSION = "2.4.0";
const handler = async () => ({ structuredContent: { ok: true } });

/**
 * Drive one registration all the way to the captured entry the call-time lookup
 * reads, through the real replay and capture seams.
 */
function roundTrip(name: string, declared?: DelegatedChatToolClass): CapturedHostPrimitive {
  registerExtensionMcpTool(
    PKG,
    {
      name,
      handler,
      ...(declared === undefined ? {} : { delegatedChat: declared }),
    },
    { resolvedVersion: PKG_VERSION },
  );
  const registration = listExtensionMcpTools().find((t) => t.name === name)!;

  const handlers = new Map<string, CapturedHostPrimitive>();
  const recording = createSelfPrimitiveRecordingServer(handlers);
  (recording.registerTool as (...a: unknown[]) => unknown)(
    name,
    // The REPLAY hop: a config rebuilt from scratch, carrying the declaration
    // AND the host-written provenance the choke point plans the identity from.
    buildReplayedExtensionToolConfig(name, registration, {
      ownerPackage: PKG,
      resolvedVersion: registration.resolvedVersion,
      dispatchTarget: {
        kind: "extension-default",
        packageName: PKG,
        version: PKG_VERSION,
        name,
      },
    }),
    handler,
  );

  capturedHandlers.clear();
  for (const [k, v] of handlers) capturedHandlers.set(k, v);
  __resetHostSelfPrimitiveHandlers();
  return handlers.get(name)!;
}

beforeEach(() => {
  delegatedRestricted = true;
  snapshotRecords = [];
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
      expect(roundTrip("acme_thing_list", cls).planned.declaredClass).toBe(cls);
    }
  });

  it("normalizes a malformed declaration once, and it survives both hops", () => {
    const captured = roundTrip(
      "acme_thing_list",
      // @ts-expect-error — a connector shipping an off-enum value is the case
      "superuser",
    );
    expect(captured.planned.declaredClass).toBe("none");
  });

  it("preserves ABSENCE as absence, distinct from a declared `none`", () => {
    // Load-bearing: the interim shim fills in for an ABSENT declaration and
    // must not for an explicit `none`. A hop that collapsed the two would make
    // a connector's deliberate opt-out indistinguishable from silence.
    expect(roundTrip("acme_thing_list").planned.declaredClass).toBeUndefined();
  });
});

describe("call time: the SAME shared evaluator, over the SAME planned identity", () => {
  /** Put a REVIEWED admission for this registration into the request snapshot. */
  function review(name: string, declaredClass: "read" | "discovery" | "dispatch") {
    snapshotRecords = [
      admissionRecordFor({
        ownerPackage: PKG,
        resolvedVersion: PKG_VERSION,
        primitiveName: name,
        declaredClass,
      }),
    ];
  }

  it("THE EXTENSIBILITY OUTCOME: a REVIEWED connector primitive becomes callable", async () => {
    // The defect #2817 exists to remove, observed rather than argued: a
    // hot-installed connector's primitive, declaring `read` and admitted for its
    // exact package at its exact version, is reachable from a delegated-chat
    // frame with no core-name edit anywhere.
    roundTrip("acme_thing_list", "read");
    review("acme_thing_list", "read");
    await expect(callHostPrimitive("acme_thing_list", {})).resolves.toEqual({ ok: true });
  });

  it("refuses the SAME primitive at a DIFFERENT version — an admission does not cross versions", async () => {
    roundTrip("acme_thing_list", "read");
    snapshotRecords = [
      admissionRecordFor({
        ownerPackage: PKG,
        resolvedVersion: "9.9.9",
        primitiveName: "acme_thing_list",
        declaredClass: "read",
      }),
    ];
    await expect(callHostPrimitive("acme_thing_list", {})).rejects.toThrow(/stale_version/);
  });

  it("refuses when the SAME name is admitted for a DIFFERENT owner — collisions do not transfer", async () => {
    roundTrip("acme_thing_list", "read");
    snapshotRecords = [
      admissionRecordFor({
        ownerPackage: "@evil/acme",
        resolvedVersion: PKG_VERSION,
        primitiveName: "acme_thing_list",
        declaredClass: "read",
      }),
    ];
    await expect(callHostPrimitive("acme_thing_list", {})).rejects.toThrow(/collision_lost/);
  });

  it("refuses a REVOKED admission", async () => {
    roundTrip("acme_thing_list", "read");
    review("acme_thing_list", "read");
    snapshotRecords = snapshotRecords.map((r) => ({
      ...(r as Record<string, unknown>),
      revoked: true,
    }));
    await expect(callHostPrimitive("acme_thing_list", {})).rejects.toThrow(/revoked/);
  });

  it("refuses a primitive whose registration declares `none`, even when reviewed", async () => {
    roundTrip("acme_thing_list", "none");
    review("acme_thing_list", "read");
    await expect(callHostPrimitive("acme_thing_list", {})).rejects.toThrow(
      /declaration_declines_chat/,
    );
  });

  it("refuses one whose declaration was MALFORMED", async () => {
    roundTrip(
      "acme_thing_list",
      // @ts-expect-error — off-enum value
      "superuser",
    );
    review("acme_thing_list", "read");
    await expect(callHostPrimitive("acme_thing_list", {})).rejects.toThrow(
      /declaration_declines_chat|malformed_declaration/,
    );
  });

  it("refuses an UNDECLARED primitive, whatever the store holds", async () => {
    roundTrip("acme_thing_list");
    review("acme_thing_list", "read");
    await expect(callHostPrimitive("acme_thing_list", {})).rejects.toThrow(/undeclared/);
  });

  it("refuses a SELF-CLASSIFIED-ONLY primitive — declaring is not being reviewed", async () => {
    roundTrip("acme_thing_list", "read");
    snapshotRecords = [];
    await expect(callHostPrimitive("acme_thing_list", {})).rejects.toThrow(
      /self_classified_only/,
    );
  });

  it("refuses when the ADMISSION STORE is unavailable", async () => {
    const admission = await vi.importActual<
      typeof import("@cinatra-ai/mcp-server/delegated-chat-admission")
    >("@cinatra-ai/mcp-server/delegated-chat-admission");
    const store = await import("@/lib/delegated-chat-admission-store");
    const spy = vi
      .spyOn(store, "loadDelegatedChatAdmissionSnapshot")
      .mockResolvedValue(
        admission.unavailableDelegatedChatAdmissionSnapshot({
          reason: "simulated",
          activationGeneration: 0,
          admissionGeneration: 0,
        }),
      );
    roundTrip("acme_thing_list", "read");
    review("acme_thing_list", "read");
    await expect(callHostPrimitive("acme_thing_list", {})).rejects.toThrow(
      /admission_store_unavailable/,
    );
    spy.mockRestore();
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

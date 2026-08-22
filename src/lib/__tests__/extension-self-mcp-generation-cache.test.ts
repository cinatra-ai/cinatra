import { describe, it, expect, vi, beforeEach } from "vitest";

// The self-MCP handler cache is keyed on the extension control-plane generation
// (#310): it rebuilds the host primitive map iff the generation it was built at
// differs from the current generation. We prove that by counting how many times
// the (mocked) `buildHostSelfPrimitiveHandlers` is invoked across calls, bumping
// the generation between them.

const buildSpy = vi.fn();

// Mock the heavy MCP server module — we only need the build function + a no-op
// AsyncLocalStorage-shaped request-context store + the delegated-chat allowlist so
// `callHostPrimitive` runs without pulling the real transport.
vi.mock("@/lib/mcp-server", () => ({
  buildHostSelfPrimitiveHandlers: () => {
    buildSpy();
    // A map with one always-allowed primitive that echoes its input. The map
    // now holds `{ handler, delegatedChat }` per name (cinatra#2771): the
    // typed delegated-chat declaration travels WITH the handler so a
    // delegated-restricted self-invocation can apply the same narrow-only rule
    // the live transport applies at registration. Undeclared here — neutral.
    return new Map<string, { handler: (...args: unknown[]) => unknown; planned: unknown }>([
      [
        "echo_primitive",
        {
          handler: (input: unknown) => ({ structuredContent: input }),
          // cinatra#2817 slice 1 — the capture carries the PLANNED identity, so
          // this stub carries one too: the self-invoker reads the class off the
          // planned entry rather than off a bare declaration field.
          planned: {
            name: "echo_primitive",
            registeredName: "echo_primitive",
            order: 0,
            declaredClass: undefined,
            ownerPackage: "@cinatra-ai/host",
            resolvedVersion: "2817.1.0",
            capabilityKey: null,
            dispatchTarget: {
              kind: "host",
              packageName: "@cinatra-ai/host",
              version: "2817.1.0",
              name: "echo_primitive",
            },
            identityFailure: null,
            reserved: false,
          },
        },
      ],
    ]);
  },
}));

vi.mock("@cinatra-ai/mcp-server", () => ({
  mcpRequestContextStorage: {
    getStore: () => undefined,
    run: (_ctx: unknown, fn: () => unknown) => fn(),
  },
}));

// The SECOND cache axis (cinatra#2817 slice 2/3). The map is keyed by the
// activation generation AND the admission snapshot's identity, so this test
// drives both: `admissionGeneration` stands in for a review/revocation landing.
let admissionGeneration = 0;
vi.mock("@/lib/delegated-chat-admission-store", async () => {
  const admission = await vi.importActual<
    typeof import("@cinatra-ai/mcp-server/delegated-chat-admission")
  >("@cinatra-ai/mcp-server/delegated-chat-admission");
  return {
    loadDelegatedChatAdmissionSnapshot: async () =>
      admission.createDelegatedChatAdmissionSnapshot({
        rawRecords: [],
        activationGeneration: 0,
        admissionGeneration,
      }),
  };
});

// Boundary always allows for this test (we're testing cache keying, not authz).
vi.mock("@/lib/authz/mcp-boundary", () => ({
  enforceMcpBoundary: async () => ({ allowed: true }),
}));

import { callHostPrimitive, __resetHostSelfPrimitiveHandlers } from "@/lib/extension-self-mcp";
import {
  bumpActivationGeneration,
  __resetActivationGenerationForTests,
} from "@/lib/extension-activation-generation";

beforeEach(() => {
  buildSpy.mockClear();
  admissionGeneration = 0;
  __resetHostSelfPrimitiveHandlers();
  __resetActivationGenerationForTests();
});

describe("self-MCP handler cache keyed by control-plane AND admission generation", () => {
  it("builds the handler map ONCE while the generation is unchanged", async () => {
    await callHostPrimitive("echo_primitive", { a: 1 });
    await callHostPrimitive("echo_primitive", { a: 2 });
    await callHostPrimitive("echo_primitive", { a: 3 });
    expect(buildSpy).toHaveBeenCalledTimes(1);
  });

  it("REBUILDS the handler map after the generation is bumped (a lifecycle transition)", async () => {
    await callHostPrimitive("echo_primitive", { a: 1 });
    expect(buildSpy).toHaveBeenCalledTimes(1);

    // A lifecycle transition (e.g. an activate) bumps the generation.
    bumpActivationGeneration("activate", "@cinatra-ai/foo");

    await callHostPrimitive("echo_primitive", { a: 2 });
    expect(buildSpy).toHaveBeenCalledTimes(2);

    // No further transition → no further rebuild.
    await callHostPrimitive("echo_primitive", { a: 3 });
    expect(buildSpy).toHaveBeenCalledTimes(2);
  });

  it("REBUILDS after an ADMISSION-POLICY change, with no lifecycle transition", async () => {
    // The axis a single activation-keyed cache MISSES. A marketplace revocation
    // moves no lifecycle transition at all, so a map keyed on activation alone
    // would keep serving a revoked primitive's captured handler until something
    // unrelated happened to be installed.
    await callHostPrimitive("echo_primitive", { a: 1 });
    expect(buildSpy).toHaveBeenCalledTimes(1);

    admissionGeneration += 1; // a review lands, or an admission is revoked

    await callHostPrimitive("echo_primitive", { a: 2 });
    expect(buildSpy).toHaveBeenCalledTimes(2);

    // No further admission change → no further rebuild.
    await callHostPrimitive("echo_primitive", { a: 3 });
    expect(buildSpy).toHaveBeenCalledTimes(2);
  });

  it("returns the primitive's structuredContent through the cached handler", async () => {
    const out = await callHostPrimitive("echo_primitive", { hello: "world" });
    expect(out).toEqual({ hello: "world" });
  });
});

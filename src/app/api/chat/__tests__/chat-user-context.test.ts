/**
 * Chat user-context capability consumption tests.
 *
 * The chat runner's connector-owned user-context sections (send-as
 * addresses, appointment schedules, ...) resolve REGISTRATION-DRIVEN from the
 * generic capability registry (`chat-user-context`) — the runner imports no
 * connector package. These tests exercise the consumer against the REAL
 * cross-compilation registry:
 *   - sections from registered providers, in deterministic packageName order;
 *   - fail-soft isolation (a throwing provider never fails the turn);
 *   - shape validation (non-array results / non-string sections dropped);
 *   - idempotent re-registration by packageName (the transitional host-boot
 *     bridge and a connector's own register(ctx) registering the SAME record
 *     must collapse to ONE provider — no duplicated sections);
 *   - empty registry -> no sections.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  registerCapabilityProvider,
  __resetCapabilityRegistry,
} from "@/lib/extension-capabilities-registry";
import { CHAT_USER_CONTEXT_CAPABILITY_ID } from "@cinatra-ai/sdk-extensions/internal";
import { buildChatUserContextSections } from "../chat-user-context";

afterEach(() => {
  __resetCapabilityRegistry();
  vi.restoreAllMocks();
});

describe("buildChatUserContextSections", () => {
  it("returns [] when no provider is registered", async () => {
    expect(await buildChatUserContextSections("user-1")).toEqual([]);
  });

  it("collects sections from providers in deterministic packageName order", async () => {
    registerCapabilityProvider(CHAT_USER_CONTEXT_CAPABILITY_ID, {
      packageName: "@test/zeta-connector",
      impl: { buildSections: () => ["zeta section"] },
    });
    registerCapabilityProvider(CHAT_USER_CONTEXT_CAPABILITY_ID, {
      packageName: "@test/alpha-connector",
      impl: { buildSections: async () => ["alpha section A", "alpha section B"] },
    });
    expect(await buildChatUserContextSections("user-1")).toEqual([
      "alpha section A",
      "alpha section B",
      "zeta section",
    ]);
  });

  it("passes the current userId to each provider", async () => {
    const buildSections = vi.fn(() => [] as string[]);
    registerCapabilityProvider(CHAT_USER_CONTEXT_CAPABILITY_ID, {
      packageName: "@test/alpha-connector",
      impl: { buildSections },
    });
    await buildChatUserContextSections("user-42");
    expect(buildSections).toHaveBeenCalledWith({ userId: "user-42" });
  });

  it("isolates a throwing provider (other sections still delivered)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerCapabilityProvider(CHAT_USER_CONTEXT_CAPABILITY_ID, {
      packageName: "@test/alpha-connector",
      impl: {
        buildSections: () => {
          throw new Error("deps not wired");
        },
      },
    });
    registerCapabilityProvider(CHAT_USER_CONTEXT_CAPABILITY_ID, {
      packageName: "@test/beta-connector",
      impl: { buildSections: () => ["beta section"] },
    });
    expect(await buildChatUserContextSections("user-1")).toEqual(["beta section"]);
    expect(warn).toHaveBeenCalled();
  });

  it("isolates a rejecting async provider", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    registerCapabilityProvider(CHAT_USER_CONTEXT_CAPABILITY_ID, {
      packageName: "@test/alpha-connector",
      impl: { buildSections: async () => Promise.reject(new Error("boom")) },
    });
    expect(await buildChatUserContextSections("user-1")).toEqual([]);
  });

  it("drops malformed providers and non-string sections", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    registerCapabilityProvider(CHAT_USER_CONTEXT_CAPABILITY_ID, {
      packageName: "@test/alpha-connector",
      impl: {},
    });
    registerCapabilityProvider(CHAT_USER_CONTEXT_CAPABILITY_ID, {
      packageName: "@test/beta-connector",
      impl: { buildSections: () => ({ not: "an array" }) as unknown as string[] },
    });
    registerCapabilityProvider(CHAT_USER_CONTEXT_CAPABILITY_ID, {
      packageName: "@test/gamma-connector",
      impl: {
        buildSections: () => ["ok section", 42 as unknown as string, "", "another ok"],
      },
    });
    expect(await buildChatUserContextSections("user-1")).toEqual([
      "ok section",
      "another ok",
    ]);
  });

  it("collapses re-registration by packageName (bridge + register(ctx) dedupe)", async () => {
    const record = {
      packageName: "@test/alpha-connector",
      impl: { buildSections: () => ["alpha section"] },
    };
    // Transitional host-boot bridge registers the record...
    registerCapabilityProvider(CHAT_USER_CONTEXT_CAPABILITY_ID, record);
    // ...and the connector's own register(ctx) registers the SAME record.
    registerCapabilityProvider(CHAT_USER_CONTEXT_CAPABILITY_ID, record);
    expect(await buildChatUserContextSections("user-1")).toEqual(["alpha section"]);
  });
});

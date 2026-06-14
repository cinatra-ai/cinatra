/**
 * Capability-surface consumption tests for the packages/agents connector
 * edges (cinatra#151 Stage 4): the agent-builder list picker, the HITL
 * field-renderer-context loader, and the CTA appointment-schedules action
 * resolve connector-registered capability surfaces (`crm-list-reader`,
 * `email-sender-identities`, `appointment-schedules`) from the REAL
 * cross-compilation registry — never by value-importing crm/gmail/
 * google-calendar connector packages.
 *
 * Pinned here:
 *   - empty registry -> null reader / empty contributions (the connectors are
 *     acquirable-on-demand, NOT required — absence is a normal state);
 *   - structural validation (non-conforming impls skipped; malformed rows
 *     dropped);
 *   - per-provider failure isolation + deterministic packageName ordering
 *     (the chat-user-context consumer contract);
 *   - the userId is forwarded to each provider.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  registerCapabilityProvider,
  __resetCapabilityRegistry,
} from "@/lib/extension-capabilities-registry";
import {
  CRM_LIST_READER_CAPABILITY_ID,
  EMAIL_SENDER_IDENTITIES_CAPABILITY_ID,
  APPOINTMENT_SCHEDULES_CAPABILITY_ID,
} from "@cinatra-ai/sdk-extensions/internal";
import { resolveCrmListReader } from "@/lib/crm-integration-providers";
import { listEmailSenderIdentities } from "@/lib/email-sender-identities";
import { listAppointmentSchedules } from "@/lib/appointment-schedules";

afterEach(() => {
  __resetCapabilityRegistry();
  vi.restoreAllMocks();
});

describe("resolveCrmListReader", () => {
  it("returns null when no provider is registered (connector absent — degraded, not an error)", () => {
    expect(resolveCrmListReader()).toBeNull();
  });

  it("returns the registered reader and skips non-conforming impls", () => {
    registerCapabilityProvider(CRM_LIST_READER_CAPABILITY_ID, {
      packageName: "@test/broken-connector",
      impl: { notSearchLists: true },
    });
    const searchLists = vi.fn(async () => []);
    registerCapabilityProvider(CRM_LIST_READER_CAPABILITY_ID, {
      packageName: "@test/crm-ish-connector",
      impl: { searchLists },
    });
    const reader = resolveCrmListReader();
    expect(reader).not.toBeNull();
    void reader?.searchLists({ query: "", objectType: "contact" });
    expect(searchLists).toHaveBeenCalledWith({ query: "", objectType: "contact" });
  });
});

describe("listEmailSenderIdentities", () => {
  it("returns [] when no provider is registered", async () => {
    expect(await listEmailSenderIdentities("user-1")).toEqual([]);
  });

  it("aggregates per-app identities in deterministic packageName order, forwards userId, omits empty apps", async () => {
    const getZeta = vi.fn(() => [{ email: "z@example.com" }]);
    registerCapabilityProvider(EMAIL_SENDER_IDENTITIES_CAPABILITY_ID, {
      packageName: "@test/zeta-connector",
      impl: { app: "zeta-mail", getSenderIdentities: getZeta },
    });
    registerCapabilityProvider(EMAIL_SENDER_IDENTITIES_CAPABILITY_ID, {
      packageName: "@test/alpha-connector",
      impl: {
        app: "alpha-mail",
        getSenderIdentities: async () => [
          { email: "a@example.com", displayName: "Ada" },
        ],
      },
    });
    registerCapabilityProvider(EMAIL_SENDER_IDENTITIES_CAPABILITY_ID, {
      packageName: "@test/empty-connector",
      impl: { app: "empty-mail", getSenderIdentities: () => [] },
    });
    const result = await listEmailSenderIdentities("user-42");
    expect(result).toEqual([
      { app: "alpha-mail", identities: [{ email: "a@example.com", displayName: "Ada" }] },
      { app: "zeta-mail", identities: [{ email: "z@example.com" }] },
    ]);
    expect(getZeta).toHaveBeenCalledWith({ userId: "user-42" });
  });

  it("isolates a throwing provider and drops malformed identity rows", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerCapabilityProvider(EMAIL_SENDER_IDENTITIES_CAPABILITY_ID, {
      packageName: "@test/throwing-connector",
      impl: {
        app: "boom-mail",
        getSenderIdentities: () => {
          throw new Error("host service not registered");
        },
      },
    });
    registerCapabilityProvider(EMAIL_SENDER_IDENTITIES_CAPABILITY_ID, {
      packageName: "@test/messy-connector",
      impl: {
        app: "messy-mail",
        getSenderIdentities: () => [
          { email: "ok@example.com" },
          { email: 42 },
          "not-an-object",
        ],
      },
    });
    registerCapabilityProvider(EMAIL_SENDER_IDENTITIES_CAPABILITY_ID, {
      packageName: "@test/non-conforming",
      impl: { app: "", getSenderIdentities: () => [] },
    });
    expect(await listEmailSenderIdentities("user-1")).toEqual([
      { app: "messy-mail", identities: [{ email: "ok@example.com" }] },
    ]);
    expect(warn).toHaveBeenCalled();
  });
});

describe("listAppointmentSchedules", () => {
  it("returns [] when no provider is registered", async () => {
    expect(await listAppointmentSchedules("user-1")).toEqual([]);
  });

  it("collects schedules in deterministic provider order, forwards userId, drops malformed rows, isolates failures", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerCapabilityProvider(APPOINTMENT_SCHEDULES_CAPABILITY_ID, {
      packageName: "@test/zeta-calendar",
      impl: {
        getSchedules: () => [
          { title: "Z call", bookingPageUrl: "https://z.example/book" },
          { title: 42, bookingPageUrl: null },
        ],
      },
    });
    const getSchedules = vi.fn(async () => [
      { title: "A call", bookingPageUrl: "https://a.example/book" },
    ]);
    registerCapabilityProvider(APPOINTMENT_SCHEDULES_CAPABILITY_ID, {
      packageName: "@test/alpha-calendar",
      impl: { getSchedules },
    });
    registerCapabilityProvider(APPOINTMENT_SCHEDULES_CAPABILITY_ID, {
      packageName: "@test/broken-calendar",
      impl: {
        getSchedules: () => {
          throw new Error("host service not registered");
        },
      },
    });
    expect(await listAppointmentSchedules("user-42")).toEqual([
      { title: "A call", bookingPageUrl: "https://a.example/book" },
      { title: "Z call", bookingPageUrl: "https://z.example/book" },
    ]);
    expect(getSchedules).toHaveBeenCalledWith({ userId: "user-42" });
    expect(warn).toHaveBeenCalled();
  });
});

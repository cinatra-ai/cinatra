import { describe, it, expect, vi, beforeEach } from "vitest";

// Transport-registration cutover: the enricher no longer imports any provider package — the host injects
// the `email-send` capability providers through the EnrichmentContext. These
// tests drive the injected-resolver contract: per-user aliases come from each
// provider's OPTIONAL `listFromAddresses`; provider failures degrade.
import {
  enrichSchemaWithResolvedData,
  GMAIL_SEND_AS_DATA_SOURCE,
  SEND_AS_DATA_SOURCE,
  type EnrichmentContext,
} from "../schema-enricher";
import type { EmailConnector } from "@cinatra-ai/sdk-extensions";

const ALIAS_USER_A = [
  { email: "alice@acme.com", displayName: "Alice" },
  { email: "alice+sales@acme.com", displayName: "Alice Sales" },
];
const ALIAS_USER_B = [{ email: "bob@example.com", displayName: "Bob" }];

const listFromAddresses = vi.fn(async (_opts?: { userId?: string }) => ALIAS_USER_A);

function fakeEmailProvider(
  impl: (opts?: { userId?: string }) => Promise<Array<{ email: string; displayName?: string }>>,
  id = "mailbox",
): EmailConnector {
  return {
    definition: { connectorId: id, name: id, slug: id, description: "", settingsHref: "" },
    send: async () => ({ providerId: id, providerMessageId: "m", sentAt: "" }),
    findReply: async () => null,
    getStatus: async () => ({ status: "connected" as const }),
    listFromAddresses: impl,
  };
}

function ctxFor(userId: string | null, providers?: EmailConnector[]): EnrichmentContext {
  return {
    userId,
    resolveEmailSendProviders: () => providers ?? [fakeEmailProvider(listFromAddresses)],
  };
}

function senderEmailSchema() {
  return {
    type: "object" as const,
    properties: {
      senderEmail: { type: "string", title: "Sender Email" },
      subject: { type: "string", title: "Subject" },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listFromAddresses.mockImplementation(async () => ALIAS_USER_A);
});

describe("enrichSchemaWithResolvedData", () => {
  it("infers sender enum from whitelisted field", async () => {
    const result = await enrichSchemaWithResolvedData(senderEmailSchema(), ctxFor("user-a"));
    const sender = (result as any).properties.senderEmail;
    expect(sender.enum).toEqual(["alice@acme.com", "alice+sales@acme.com"]);
    expect(sender["x-enum-titles"]).toEqual(["Alice <alice@acme.com>", "Alice Sales <alice+sales@acme.com>"]);
  });

  it("explicit LEGACY x-data-source wins over whitelist", async () => {
    const schema = {
      type: "object",
      properties: {
        anyName: {
          type: "string",
          title: "Pick One",
          "x-data-source": GMAIL_SEND_AS_DATA_SOURCE,
        },
      },
    };
    const result = await enrichSchemaWithResolvedData(schema, ctxFor("user-a"));
    expect((result as any).properties.anyName.enum).toEqual(["alice@acme.com", "alice+sales@acme.com"]);
    expect(listFromAddresses).toHaveBeenCalledTimes(1);
  });

  it("the provider-neutral x-data-source id is recognized too", async () => {
    const schema = {
      type: "object",
      properties: {
        anyName: {
          type: "string",
          title: "Pick One",
          "x-data-source": SEND_AS_DATA_SOURCE,
        },
      },
    };
    const result = await enrichSchemaWithResolvedData(schema, ctxFor("user-a"));
    expect((result as any).properties.anyName.enum).toEqual(["alice@acme.com", "alice+sales@acme.com"]);
  });

  it("omits enum when no aliases", async () => {
    listFromAddresses.mockImplementation(async () => []);
    const result = await enrichSchemaWithResolvedData(senderEmailSchema(), ctxFor("user-a"));
    const sender = (result as any).properties.senderEmail;
    expect(sender.enum).toBeUndefined();
    expect(sender["x-enum-titles"]).toBeUndefined();
  });

  it("omits enum when no resolver is injected (graceful no-provider degradation)", async () => {
    const result = await enrichSchemaWithResolvedData(senderEmailSchema(), { userId: "user-a" });
    expect((result as any).properties.senderEmail.enum).toBeUndefined();
  });

  it("skips providers without the optional listFromAddresses and survives a throwing provider", async () => {
    const noAliases = fakeEmailProvider(undefined as never, "instance-transport");
    delete (noAliases as { listFromAddresses?: unknown }).listFromAddresses;
    const throwing = fakeEmailProvider(async () => {
      throw new Error("api down");
    }, "broken");
    const good = fakeEmailProvider(async () => ALIAS_USER_B, "mailbox");
    const result = await enrichSchemaWithResolvedData(
      senderEmailSchema(),
      ctxFor("user-b", [noAliases, throwing, good]),
    );
    expect((result as any).properties.senderEmail.enum).toEqual(["bob@example.com"]);
  });

  it("merges aliases across providers, first occurrence of an email wins", async () => {
    const p1 = fakeEmailProvider(async () => [{ email: "a@x.y", displayName: "First" }], "one");
    const p2 = fakeEmailProvider(
      async () => [{ email: "a@x.y", displayName: "Second" }, { email: "b@x.y" }],
      "two",
    );
    const result = await enrichSchemaWithResolvedData(senderEmailSchema(), ctxFor("u", [p1, p2]));
    const sender = (result as any).properties.senderEmail;
    expect(sender.enum).toEqual(["a@x.y", "b@x.y"]);
    expect(sender["x-enum-titles"][0]).toBe("First <a@x.y>");
  });

  it("no-op when no relevant fields", async () => {
    const schema = { type: "object", properties: { unrelated: { type: "string", title: "Other" } } };
    const before = JSON.stringify(schema);
    const result = await enrichSchemaWithResolvedData(schema, ctxFor("user-a"));
    expect(JSON.stringify(result)).toBe(before);
    expect(listFromAddresses).not.toHaveBeenCalled();
  });

  it("no-op when userId is null", async () => {
    const result = await enrichSchemaWithResolvedData(senderEmailSchema(), ctxFor(null));
    expect((result as any).properties.senderEmail.enum).toBeUndefined();
    expect(listFromAddresses).not.toHaveBeenCalled();
  });

  it("does not mutate input schema", async () => {
    const input = senderEmailSchema();
    const snapshot = JSON.stringify(input);
    await enrichSchemaWithResolvedData(input, ctxFor("user-a"));
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("user A enum does not leak into user B", async () => {
    listFromAddresses.mockImplementation(async (opts?: { userId?: string }) => {
      if (opts?.userId === "user-a") return ALIAS_USER_A;
      if (opts?.userId === "user-b") return ALIAS_USER_B;
      return [];
    });
    const a = await enrichSchemaWithResolvedData(senderEmailSchema(), ctxFor("user-a"));
    const b = await enrichSchemaWithResolvedData(senderEmailSchema(), ctxFor("user-b"));
    expect((a as any).properties.senderEmail.enum).toEqual(["alice@acme.com", "alice+sales@acme.com"]);
    expect((b as any).properties.senderEmail.enum).toEqual(["bob@example.com"]);
  });

  it("writes enum only when type is string", async () => {
    const schema = {
      type: "object",
      properties: { senderEmail: { type: "object", title: "Sender Email" } },
    };
    const result = await enrichSchemaWithResolvedData(schema, ctxFor("user-a"));
    expect((result as any).properties.senderEmail.enum).toBeUndefined();
  });

  it("passes through other property fields unchanged", async () => {
    const schema = {
      type: "object",
      properties: {
        senderEmail: {
          type: "string",
          title: "Sender Email",
          description: "Pick one",
          format: "email",
          "x-renderer": "@cinatra-ai/email-outreach-agent:gmail-sender",
          "x-hidden": false,
        },
      },
    };
    const result = await enrichSchemaWithResolvedData(schema, ctxFor("user-a"));
    const sender = (result as any).properties.senderEmail;
    expect(sender.description).toBe("Pick one");
    expect(sender.format).toBe("email");
    expect(sender["x-renderer"]).toBe("@cinatra-ai/email-outreach-agent:gmail-sender");
    expect(sender["x-hidden"]).toBe(false);
    expect(sender.enum).toEqual(["alice@acme.com", "alice+sales@acme.com"]);
  });

  it("handles schema without properties key gracefully", async () => {
    const schema = { type: "object" };
    const result = await enrichSchemaWithResolvedData(schema, ctxFor("user-a"));
    expect(result).toEqual(schema);
  });
});

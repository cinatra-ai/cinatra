import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@cinatra-ai/gmail-connector", () => ({
  getStoredGmailSendAsAddresses: vi.fn(),
}));

// The imports below are the entire reason this file is RED — schema-enricher does not exist yet.
import {
  enrichSchemaWithResolvedData,
  GMAIL_SEND_AS_DATA_SOURCE,
} from "../schema-enricher";
import { getStoredGmailSendAsAddresses } from "@cinatra-ai/gmail-connector";

const ALIAS_USER_A = [
  { email: "alice@acme.com", displayName: "Alice" },
  { email: "alice+sales@acme.com", displayName: "Alice Sales" },
];
const ALIAS_USER_B = [{ email: "bob@example.com", displayName: "Bob" }];

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
});

describe("enrichSchemaWithResolvedData", () => {
  it("infers Gmail enum from whitelisted field", async () => {
    (getStoredGmailSendAsAddresses as unknown as { mockReturnValue: Function }).mockReturnValue({ aliases: ALIAS_USER_A });
    const result = await enrichSchemaWithResolvedData(senderEmailSchema(), { userId: "user-a" });
    const sender = (result as any).properties.senderEmail;
    expect(sender.enum).toEqual(["alice@acme.com", "alice+sales@acme.com"]);
    expect(sender["x-enum-titles"]).toEqual(["Alice <alice@acme.com>", "Alice Sales <alice+sales@acme.com>"]);
  });

  it("explicit x-data-source wins over whitelist", async () => {
    (getStoredGmailSendAsAddresses as unknown as { mockReturnValue: Function }).mockReturnValue({ aliases: ALIAS_USER_A });
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
    const result = await enrichSchemaWithResolvedData(schema, { userId: "user-a" });
    expect((result as any).properties.anyName.enum).toEqual(["alice@acme.com", "alice+sales@acme.com"]);
    expect((getStoredGmailSendAsAddresses as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1);
  });

  it("omits enum when no aliases", async () => {
    (getStoredGmailSendAsAddresses as unknown as { mockReturnValue: Function }).mockReturnValue({ aliases: [] });
    const result = await enrichSchemaWithResolvedData(senderEmailSchema(), { userId: "user-a" });
    const sender = (result as any).properties.senderEmail;
    expect(sender.enum).toBeUndefined();
    expect(sender["x-enum-titles"]).toBeUndefined();
  });

  it("no-op when no relevant fields", async () => {
    const schema = { type: "object", properties: { unrelated: { type: "string", title: "Other" } } };
    const before = JSON.stringify(schema);
    const result = await enrichSchemaWithResolvedData(schema, { userId: "user-a" });
    expect(JSON.stringify(result)).toBe(before);
    expect((getStoredGmailSendAsAddresses as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(0);
  });

  it("no-op when userId is null", async () => {
    const result = await enrichSchemaWithResolvedData(senderEmailSchema(), { userId: null });
    expect((result as any).properties.senderEmail.enum).toBeUndefined();
    expect((getStoredGmailSendAsAddresses as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(0);
  });

  it("does not mutate input schema", async () => {
    (getStoredGmailSendAsAddresses as unknown as { mockReturnValue: Function }).mockReturnValue({ aliases: ALIAS_USER_A });
    const input = senderEmailSchema();
    const snapshot = JSON.stringify(input);
    await enrichSchemaWithResolvedData(input, { userId: "user-a" });
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("user A enum does not leak into user B", async () => {
    (getStoredGmailSendAsAddresses as unknown as { mockImplementation: Function }).mockImplementation((uid: string) => {
      if (uid === "user-a") return { aliases: ALIAS_USER_A };
      if (uid === "user-b") return { aliases: ALIAS_USER_B };
      return { aliases: [] };
    });
    const a = await enrichSchemaWithResolvedData(senderEmailSchema(), { userId: "user-a" });
    const b = await enrichSchemaWithResolvedData(senderEmailSchema(), { userId: "user-b" });
    expect((a as any).properties.senderEmail.enum).toEqual(["alice@acme.com", "alice+sales@acme.com"]);
    expect((b as any).properties.senderEmail.enum).toEqual(["bob@example.com"]);
  });

  it("writes enum only when type is string", async () => {
    (getStoredGmailSendAsAddresses as unknown as { mockReturnValue: Function }).mockReturnValue({ aliases: ALIAS_USER_A });
    const schema = {
      type: "object",
      properties: { senderEmail: { type: "object", title: "Sender Email" } },
    };
    const result = await enrichSchemaWithResolvedData(schema, { userId: "user-a" });
    expect((result as any).properties.senderEmail.enum).toBeUndefined();
  });

  it("passes through other property fields unchanged", async () => {
    (getStoredGmailSendAsAddresses as unknown as { mockReturnValue: Function }).mockReturnValue({ aliases: ALIAS_USER_A });
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
    const result = await enrichSchemaWithResolvedData(schema, { userId: "user-a" });
    const sender = (result as any).properties.senderEmail;
    expect(sender.description).toBe("Pick one");
    expect(sender.format).toBe("email");
    expect(sender["x-renderer"]).toBe("@cinatra-ai/email-outreach-agent:gmail-sender");
    expect(sender["x-hidden"]).toBe(false);
    expect(sender.enum).toEqual(["alice@acme.com", "alice+sales@acme.com"]);
  });

  it("handles schema without properties key gracefully", async () => {
    const schema = { type: "object" };
    const result = await enrichSchemaWithResolvedData(schema, { userId: "user-a" });
    expect(result).toEqual(schema);
  });
});

import { describe, it, expect } from "vitest";
import { Webhook } from "standardwebhooks";
import { signOutbound } from "../sign";
import { verifyInbound, WebhookVerifyFailedError } from "../verify";
import { mintWebhookSecret } from "../secret-service";

// Build a Fetch Headers instance from the Standard-Webhooks header map so we
// exercise the SAME normalization the route relies on (a Headers instance, not
// a plain object).
function headersFrom(map: Record<string, string>): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(map)) h.set(k, v);
  return h;
}

describe("sign → verify round-trip (one signing convention)", () => {
  it("verifies a payload signed by signOutbound", () => {
    const secret = mintWebhookSecret();
    const payload = { event: "post.published", id: 42 };
    const signed = signOutbound(secret, "msg_1", new Date(), payload);

    const verified = verifyInbound(
      Buffer.from(signed.body, "utf8"),
      headersFrom(signed.headers),
      [secret],
    );
    expect(verified.messageId).toBe("msg_1");
    expect(verified.payload).toEqual(payload);
    expect(verified.timestamp).toBeInstanceOf(Date);
  });

  it("mintWebhookSecret produces a whsec_-prefixed base64 Standard-Webhooks secret", () => {
    const secret = mintWebhookSecret();
    expect(secret.startsWith("whsec_")).toBe(true);
    // The library accepts it (constructs without throwing).
    expect(() => new Webhook(secret)).not.toThrow();
  });

  it("rejects a tampered body", () => {
    const secret = mintWebhookSecret();
    const signed = signOutbound(secret, "msg_2", new Date(), { a: 1 });
    expect(() =>
      verifyInbound(Buffer.from(JSON.stringify({ a: 2 }), "utf8"), headersFrom(signed.headers), [
        secret,
      ]),
    ).toThrow(WebhookVerifyFailedError);
  });

  it("rejects when no candidate secret is supplied", () => {
    const signed = signOutbound(mintWebhookSecret(), "msg_3", new Date(), {});
    expect(() => verifyInbound(Buffer.from(signed.body), headersFrom(signed.headers), [])).toThrow(
      /no candidate secret/,
    );
  });

  it("normalizes a Headers instance (does NOT mis-read as missing headers)", () => {
    const secret = mintWebhookSecret();
    const signed = signOutbound(secret, "msg_4", new Date(), { ok: true });
    // A Headers instance (uppercased entry) must still verify.
    const h = new Headers();
    h.set("Webhook-Id", signed.headers["webhook-id"]);
    h.set("Webhook-Timestamp", signed.headers["webhook-timestamp"]);
    h.set("Webhook-Signature", signed.headers["webhook-signature"]);
    const verified = verifyInbound(Buffer.from(signed.body), h, [secret]);
    expect(verified.payload).toEqual({ ok: true });
  });
});

describe("dual-secret rotation window", () => {
  it("verifies under the PREVIOUS secret while it is still a candidate, fails when only the new one is offered", () => {
    const previous = mintWebhookSecret();
    const current = mintWebhookSecret();
    // A message signed under the OLD secret (in flight during rotation).
    const signed = signOutbound(previous, "msg_rot", new Date(), { x: 1 });

    // During the window the route offers [current, previous] → verifies.
    expect(
      verifyInbound(Buffer.from(signed.body), headersFrom(signed.headers), [current, previous])
        .payload,
    ).toEqual({ x: 1 });

    // After the window the route offers only [current] → fails closed.
    expect(() =>
      verifyInbound(Buffer.from(signed.body), headersFrom(signed.headers), [current]),
    ).toThrow(WebhookVerifyFailedError);
  });
});

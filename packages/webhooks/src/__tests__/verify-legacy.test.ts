import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyLegacyHmac } from "../verify";

// cinatra#343 legacy single-shared-secret HMAC bridge (D3c option A). The
// in-field WordPress plugin signs the raw body with `X-Cinatra-Sig-256:
// sha256=<hmac-hex>`; verifyLegacyHmac is the host's constant-time check.

const SECRET = "shared-legacy-secret-abc123";

function sign(body: Buffer | string, secret = SECRET): string {
  const buf = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  return "sha256=" + createHmac("sha256", secret).update(buf).digest("hex");
}

describe("verifyLegacyHmac", () => {
  it("accepts a correct sha256= signature over the exact bytes", () => {
    const body = Buffer.from(JSON.stringify({ event: "post_published", postId: 7 }), "utf8");
    expect(verifyLegacyHmac(body, sign(body), SECRET)).toBe(true);
  });

  it("rejects a signature computed under a different secret", () => {
    const body = Buffer.from('{"a":1}', "utf8");
    expect(verifyLegacyHmac(body, sign(body, "a-different-secret"), SECRET)).toBe(false);
  });

  it("rejects when the body was tampered after signing", () => {
    const signed = Buffer.from('{"amount":1}', "utf8");
    const sig = sign(signed);
    const tampered = Buffer.from('{"amount":9}', "utf8");
    expect(verifyLegacyHmac(tampered, sig, SECRET)).toBe(false);
  });

  it("rejects a header without the sha256= prefix", () => {
    const body = Buffer.from('{"a":1}', "utf8");
    const hex = createHmac("sha256", SECRET).update(body).digest("hex");
    // Same hex, wrong (missing) prefix → reject.
    expect(verifyLegacyHmac(body, hex, SECRET)).toBe(false);
    expect(verifyLegacyHmac(body, "sha1=" + hex, SECRET)).toBe(false);
  });

  it("rejects a null/absent header (the route 401s)", () => {
    const body = Buffer.from('{"a":1}', "utf8");
    expect(verifyLegacyHmac(body, null, SECRET)).toBe(false);
  });

  it("rejects a truncated/length-mismatched signature without throwing", () => {
    const body = Buffer.from('{"a":1}', "utf8");
    const full = sign(body);
    const truncated = full.slice(0, full.length - 4);
    expect(verifyLegacyHmac(body, truncated, SECRET)).toBe(false);
  });

  it("rejects an empty signature value", () => {
    const body = Buffer.from('{"a":1}', "utf8");
    expect(verifyLegacyHmac(body, "", SECRET)).toBe(false);
    expect(verifyLegacyHmac(body, "sha256=", SECRET)).toBe(false);
  });

  it("is byte-exact: a body with a trailing newline does not match the newline-free signature", () => {
    const canonical = Buffer.from('{"a":1}', "utf8");
    const sig = sign(canonical);
    const withNewline = Buffer.from('{"a":1}\n', "utf8");
    expect(verifyLegacyHmac(withNewline, sig, SECRET)).toBe(false);
    expect(verifyLegacyHmac(canonical, sig, SECRET)).toBe(true);
  });
});

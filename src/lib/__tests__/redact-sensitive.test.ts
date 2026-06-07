// RED tests for the structural log-redaction helper.
//
// Behaviors under test:
//   1. Redacts `Authorization` (capital-A spelling) at top level.
//   2. Deep-walks objects: redacts `authorization` and `token` at any depth.
//   3. Redacts both `requestSecret` (camelCase) and `request_secret` (snake_case);
//      passes through other keys.
//   4. Walks arrays.
//   5. Primitives round-trip unchanged.
//   6. Cycle-safety — self-referential structures do not infinite-loop.
//   7. String-content scrub: a string value containing
//      "Authorization: Bearer abc-secret" has the bearer portion replaced.
//   8. String-content scrub does NOT over-scrub generic strings.
//   9. Error.message is coerced through scrubString; stack is
//      replaced with "[REDACTED]".

import { describe, expect, it } from "vitest";
import { redactSensitive } from "@/lib/redact-sensitive";

describe("redactSensitive — structural", () => {
  it("redacts top-level Authorization key with capital A", () => {
    expect(redactSensitive({ Authorization: "Bearer abc" })).toEqual({
      Authorization: "[REDACTED]",
    });
  });

  it("deep-walks objects, redacting authorization and token at any depth", () => {
    expect(
      redactSensitive({
        headers: { authorization: "Bearer xyz" },
        body: { token: "tok-123" },
      }),
    ).toEqual({
      headers: { authorization: "[REDACTED]" },
      body: { token: "[REDACTED]" },
    });
  });

  it("redacts both camelCase and snake_case spellings of requestSecret", () => {
    expect(
      redactSensitive({
        data: {
          requestSecret: "rs-1",
          request_secret: "rs-2",
          other: "ok",
        },
      }),
    ).toEqual({
      data: {
        requestSecret: "[REDACTED]",
        request_secret: "[REDACTED]",
        other: "ok",
      },
    });
  });

  it("walks arrays", () => {
    expect(redactSensitive([{ token: "a" }, { token: "b" }])).toEqual([
      { token: "[REDACTED]" },
      { token: "[REDACTED]" },
    ]);
  });

  it("returns primitive number, boolean, null, undefined unchanged", () => {
    expect(redactSensitive(42)).toBe(42);
    expect(redactSensitive(true)).toBe(true);
    expect(redactSensitive(null)).toBeNull();
    expect(redactSensitive(undefined)).toBeUndefined();
  });

  it("does not infinite-loop on a self-referential object", () => {
    const obj: Record<string, unknown> = { token: "tok-1", other: "ok" };
    obj.self = obj;
    // Must not throw or recurse forever.
    const result = redactSensitive(obj) as Record<string, unknown>;
    expect(result.token).toBe("[REDACTED]");
    expect(result.other).toBe("ok");
    // The cycle field should resolve (either to the redacted parent or the marker).
    expect(result.self).toBeDefined();
  });
});

describe("redactSensitive — string-content scrub", () => {
  it("scrubs Authorization: Bearer <token> inside a string value", () => {
    const result = redactSensitive({ message: "Authorization: Bearer abc-secret" }) as {
      message: string;
    };
    expect(result.message).toContain("Authorization");
    expect(result.message).toContain("[redacted]");
    expect(result.message).not.toContain("abc-secret");
  });

  it("scrubs bare 'Bearer <token>' inside a string value", () => {
    const result = redactSensitive("prefix Bearer secret-token-xyz suffix") as string;
    expect(result).toContain("[redacted]");
    expect(result).not.toContain("secret-token-xyz");
  });

  it("does NOT over-scrub a generic string with no Bearer/Authorization pattern", () => {
    expect(redactSensitive({ message: "Operation succeeded" })).toEqual({
      message: "Operation succeeded",
    });
    expect(redactSensitive("just a plain string")).toBe("just a plain string");
  });
});

describe("redactSensitive — Error coercion", () => {
  it("coerces error.message through the string scrubber and stack to [REDACTED]", () => {
    const err = new Error("Authorization: Bearer abc-secret");
    const result = redactSensitive(err) as {
      name?: string;
      message?: string;
      stack?: string;
    };
    expect(result.name).toBe("Error");
    expect(result.message).toContain("Authorization");
    expect(result.message).toContain("[redacted]");
    expect(result.message).not.toContain("abc-secret");
    expect(result.stack).toBe("[REDACTED]");
  });

  it("walks the cause chain when present", () => {
    const inner = new Error("inner with token=xyz");
    const outer = new Error("outer", { cause: { Authorization: "Bearer foo" } });
    void inner;
    const result = redactSensitive(outer) as { cause?: unknown };
    expect((result.cause as { Authorization?: string }).Authorization).toBe("[REDACTED]");
  });
});

describe("redactSensitive — non-mutation", () => {
  it("does not mutate the input object", () => {
    const input = { Authorization: "Bearer abc" };
    const result = redactSensitive(input);
    expect(input.Authorization).toBe("Bearer abc");
    expect(result).not.toBe(input);
  });
});

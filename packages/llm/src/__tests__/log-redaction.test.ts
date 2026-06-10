// Canary regression for the Anthropic writer chokepoint.
//
// Asserts that a unique canary token placed in every Authorization-bearing
// location does NOT survive redaction. The Anthropic writer
// (telemetry.ts::writeAnthropicLogFile) has exactly one redaction step:
// `const content = redactAuthorizationDeep(rawContent)`. The pure-redactor
// canary below is the binding regression gate.
//
// NOTE: writeAnthropicLogFile itself cannot be imported here because telemetry.ts
// imports `writeOpenAILogFile` from @cinatra-ai/connector-openai, whose
// chain pulls @cinatra-ai/skills -> google-oauth-connection ->
// mcp-client-connector, which is not resolvable in this package's
// vitest sandbox. Testing the pure helper the writer calls IS the direct test
// of the redaction logic, and is symmetric with the connector-openai copy's test.

import { describe, expect, it } from "vitest";

import { redactAuthorizationDeep } from "../log-redaction";

const CANARY = `CANARY_TOKEN_${Math.random().toString(36).slice(2)}_DO_NOT_LEAK`;

describe("redactAuthorizationDeep (llm copy)", () => {
  it("replaces Authorization headers anywhere in the tree with [REDACTED] and leaves the canary nowhere", () => {
    const body = {
      model: "claude",
      tools: [{ type: "mcp", headers: { Authorization: `Bearer ${CANARY}` } }],
      mcp_servers: [
        { name: "x", authorization_token: CANARY },
        { name: "y", headers: { authorization: `Bearer ${CANARY}` } },
      ],
      nested: { deep: { Authorization: CANARY } },
    };

    const redacted = redactAuthorizationDeep(body);
    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain(CANARY);
    expect(serialized).toContain("[REDACTED]");
    expect((redacted as { model: string }).model).toBe("claude");
  });

  it("redacts mixed-case Authorization keys (case-insensitive regex)", () => {
    const redacted = redactAuthorizationDeep({
      a: { AUTHORIZATION: CANARY },
      b: { authorization: CANARY },
      c: { Authorization: CANARY },
      d: { authorization_token: CANARY },
    });
    expect(JSON.stringify(redacted)).not.toContain(CANARY);
  });

  it("is a no-op for primitives / non-authorization keys", () => {
    expect(redactAuthorizationDeep("hello")).toBe("hello");
    expect(redactAuthorizationDeep(42)).toBe(42);
    expect(redactAuthorizationDeep(null)).toBe(null);
    expect(redactAuthorizationDeep([1, 2, 3])).toEqual([1, 2, 3]);
    expect(redactAuthorizationDeep({ foo: "bar" })).toEqual({ foo: "bar" });
  });
});

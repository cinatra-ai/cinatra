/**
 * The MCP server log redaction set.
 *
 * An enabled MCP server log writes every request header to a file on disk. Any
 * header that carries a credential must therefore be redacted, and the set is
 * pinned HERE rather than by reading the module: a credential that is added to
 * the product and forgotten in that set is a secret persisted in plain text.
 */
import { describe, expect, it } from "vitest";

import { redactMcpLogValue } from "@/lib/mcp-logging";
import { DEV_LOCAL_TOKEN_HEADER } from "@cinatra-ai/mcp-server/dev-admin-bypass";

const SECRET = "a".repeat(64);

describe("redactMcpLogValue", () => {
  it("redacts the development admin bypass's per-boot local credential", () => {
    const logged = redactMcpLogValue({
      headers: { [DEV_LOCAL_TOKEN_HEADER]: SECRET },
    });
    expect(JSON.stringify(logged)).not.toContain(SECRET);
    expect(logged).toEqual({ headers: { [DEV_LOCAL_TOKEN_HEADER]: "[REDACTED]" } });
  });

  it("redacts it whatever case the header arrived in, and at any depth", () => {
    const logged = redactMcpLogValue({
      body: [{ headers: { "X-Cinatra-Dev-Local-Token": SECRET } }],
    });
    expect(JSON.stringify(logged)).not.toContain(SECRET);
  });

  it("still redacts the credentials it already carried, and leaves the rest alone", () => {
    const logged = redactMcpLogValue({
      headers: {
        authorization: "Bearer " + SECRET,
        cookie: SECRET,
        "x-api-key": SECRET,
        "x-cinatra-a2a-token": SECRET,
        "x-cinatra-bridge-token": SECRET,
        "content-type": "application/json",
      },
    });
    expect(JSON.stringify(logged)).not.toContain(SECRET);
    expect(logged).toEqual({
      headers: {
        authorization: "[REDACTED]",
        cookie: "[REDACTED]",
        "x-api-key": "[REDACTED]",
        "x-cinatra-a2a-token": "[REDACTED]",
        "x-cinatra-bridge-token": "[REDACTED]",
        "content-type": "application/json",
      },
    });
  });
});

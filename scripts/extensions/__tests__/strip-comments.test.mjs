import { describe, it, expect } from "vitest";
import { stripComments } from "../inventory.mjs";

// Locks the fix: comment prose must NOT be scanned as imports.
describe("stripComments (import-scan false-positive guard)", () => {
  it("removes a line comment that mentions a backtick @/ import (the resend-connector case)", () => {
    const src = "// The package must NOT import `@/lib/database` or `@/lib/instance-secrets`\nexport const x = 1;\n";
    const out = stripComments(src);
    expect(out).not.toContain("@/lib/database");
    expect(out).toContain("export const x = 1;");
  });
  it("removes block comments", () => {
    expect(stripComments("/* import `@/lib/foo` */\nconst y = 2;")).not.toContain("@/lib/foo");
  });
  it("preserves https:// URLs inside string literals", () => {
    const src = 'const u = "https://example.com/x";\n';
    expect(stripComments(src)).toContain("https://example.com/x");
  });
  it("preserves a real import after stripping a trailing comment", () => {
    const src = 'import { a } from "@cinatra-ai/email-connector"; // a real edge\n';
    const out = stripComments(src);
    expect(out).toContain('from "@cinatra-ai/email-connector"');
    expect(out).not.toContain("a real edge");
  });
});

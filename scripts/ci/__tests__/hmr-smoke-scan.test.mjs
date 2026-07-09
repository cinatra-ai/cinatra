// scanForHmrSignatures — the pure core of hmr-smoke-scan.mjs (cinatra#1093).
import { describe, expect, it } from "vitest";

import { scanForHmrSignatures } from "../hmr-smoke-scan.mjs";

describe("scanForHmrSignatures", () => {
  it("is clean on a normal dev-server log (no false positives)", () => {
    const log = [
      "  ▲ Next.js 15.5.0 (Turbopack)",
      "  - Local:   http://localhost:3000",
      " ✓ Ready in 3.2s",
      " ✓ Compiled /connectors in 1.1s",
      " GET /connectors 200 in 240ms",
      " ✓ Compiled /connectors/openai/openai/setup in 0.9s",
      " GET /agents 200 in 88ms",
    ].join("\n");
    expect(scanForHmrSignatures(log)).toEqual([]);
  });

  it("catches the exact cinatra#1068 $$typeof redefine stack", () => {
    const log = [
      " ✓ Compiled in 420ms",
      " ⨯ TypeError: Cannot redefine property: $$typeof",
      "     at Function.defineProperty (<anonymous>)",
      "     at registerServerReference (.../server-reference.js:12:20)",
      " GET /connectors/openai/openai/setup 500 in 610ms",
    ].join("\n");
    const hits = scanForHmrSignatures(log);
    expect(hits.map((h) => h.id)).toContain("redefine-$$typeof");
    expect(hits[0].line).toMatch(/Cannot redefine property: \$\$typeof/);
  });

  it("catches the __esModule framework-lock variant", () => {
    const hits = scanForHmrSignatures("TypeError: Cannot redefine property: __esModule");
    expect(hits.map((h) => h.id)).toContain("redefine-__esModule");
  });

  it("catches a server-reference redefine when the message names the machinery", () => {
    const hits = scanForHmrSignatures(
      "at registerServerReference (x) ... Cannot redefine property: foo",
    );
    expect(hits.map((h) => h.id)).toContain("server-reference-redefine-reverse");
  });

  it("does NOT fire on an unrelated 500 or a generic error line", () => {
    const log = [
      " ⨯ Error: connect ECONNREFUSED 127.0.0.1:5432",
      " GET /api/agents 500 in 30ms",
      " ⨯ Error: Something else entirely happened",
    ].join("\n");
    expect(scanForHmrSignatures(log)).toEqual([]);
  });

  it("dedups repeated identical stacks into a single hit", () => {
    const line = "TypeError: Cannot redefine property: $$typeof";
    const hits = scanForHmrSignatures([line, line, line].join("\n"));
    expect(hits.filter((h) => h.id === "redefine-$$typeof")).toHaveLength(1);
  });
});

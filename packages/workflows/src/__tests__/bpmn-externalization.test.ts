import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// BPMN-01 guardrail drift guard: bpmn-moddle + its moddle / moddle-xml deps are
// ESM-only XML parsers used server-side; they must stay in next.config.ts
// serverExternalPackages so Turbopack never bundles them into the client/edge graph.
describe("bpmn-moddle externalization (BPMN-01 guardrail)", () => {
  const nextConfig = readFileSync(path.resolve(__dirname, "../../../../next.config.ts"), "utf8");

  for (const pkg of ["bpmn-moddle", "moddle", "moddle-xml"]) {
    it(`${pkg} is declared in serverExternalPackages`, () => {
      expect(nextConfig).toContain(`"${pkg}"`);
    });
  }
});

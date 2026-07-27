/**
 * Structural guard on the email-drafting-agent flow: it must not carry an
 * inlined `auditor-subflow` copy or any auditor-prefixed control-flow wiring.
 *
 * ORIGINALLY this guarded a boundary against the auditor agent's own package.
 * After the cinatra#1796 / #2047-row-8 retirement that package does not exist,
 * so the guard is absolute: auditor nodes or edges may never reappear in this
 * flow. (The unused source-of-truth path const was dropped with the package —
 * this test only ever read the email-drafting OAS.)
 *
 * Run: cd packages/agent-builder && pnpm exec vitest run src/__tests__/auditor-subflow-parity.test.ts
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const INLINED_PATH = path.join(
  REPO_ROOT,
  "extensions/cinatra-ai/email-drafting-agent/cinatra/oas.json",
);

interface OasShape {
  control_flow_connections?: Array<{
    from_node?: { $component_ref?: string };
    to_node?: { $component_ref?: string };
    branch?: string;
  }>;
  $referenced_components?: Record<
    string,
    {
      component_type?: string;
      id?: string;
      control_flow_connections?: Array<{
        from_node?: { $component_ref?: string };
        to_node?: { $component_ref?: string };
        branch?: string;
      }>;
      nodes?: Array<{ $component_ref?: string }>;
    }
  >;
}

const PREFIX = "auditor-";

function strip(id: string | undefined): string | undefined {
  if (!id) return id;
  return id.startsWith(PREFIX) ? id.slice(PREFIX.length) : id;
}

// The email-drafting-agent flow intentionally has no inlined auditor subflow.
// These assertions surface regressions that reintroduce auditor nodes or edge
// wiring. cinatra#1796 / #2047 row 8: there is no auditor package to hold a
// source-of-truth flow any more, so "absent here" is now "absent everywhere".
describe("auditor-subflow is absent from the email-drafting-agent flow", () => {
  void strip;
  const inlined = JSON.parse(fs.readFileSync(INLINED_PATH, "utf8")) as OasShape;
  const subflow = inlined.$referenced_components?.["auditor-subflow"];

  it("inlined auditor-subflow is not present in email-drafting-agent", () => {
    expect(subflow).toBeUndefined();
  });

  it("no auditor-prefixed nodes remain in email-drafting-agent's referenced components", () => {
    const refKeys = Object.keys(inlined.$referenced_components ?? {});
    const auditorKeys = refKeys.filter((k) => k.startsWith(PREFIX));
    expect(auditorKeys).toEqual([]);
  });

  it("no top-level control-flow edge references an auditor-prefixed node", () => {
    const edges = inlined.control_flow_connections ?? [];
    const referencesAuditor = edges.some(
      (e) =>
        e.from_node?.$component_ref?.startsWith(PREFIX) ||
        e.to_node?.$component_ref?.startsWith(PREFIX),
    );
    expect(referencesAuditor).toBe(false);
  });
});

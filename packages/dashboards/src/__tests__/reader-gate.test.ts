// ALL-READER liveness/status gate — pure predicates (cinatra#1628, S11a).
//
// The gate is the FAIL-SAFE that stops orphaned/archived extension dashboards
// from rendering everywhere (the /dashboards list + detail routes, the blog
// deep-link, the MCP readers). These tests pin the pure predicate contract
// (the app injects the real liveness oracle); the negative cases are the
// recovery-floor guarantee.
import { describe, it, expect } from "vitest";
import {
  isExtensionDashboardRow,
  isDashboardRowLive,
  isDashboardRowRenderable,
  filterRenderableDashboards,
} from "../store/extension-dashboard-reads";

type Row = { extensionId: string | null; status: string };
const operatorRow = (status = "published"): Row => ({ extensionId: null, status });
const extRow = (extensionId: string, status = "published"): Row => ({ extensionId, status });

// A liveness oracle where only `@cinatra-ai/live-agent` is installed+active.
const oracle = (id: string) => id === "@cinatra-ai/live-agent";
const denyAll = () => false; // fail-closed / transient-loader-failure oracle

describe("reader-gate — isExtensionDashboardRow", () => {
  it("true iff the row carries an extension_id", () => {
    expect(isExtensionDashboardRow(operatorRow())).toBe(false);
    expect(isExtensionDashboardRow(extRow("@cinatra-ai/x"))).toBe(true);
  });
});

describe("reader-gate — liveness half", () => {
  it("an operator-authored row is ALWAYS live (oracle never consulted)", () => {
    expect(isDashboardRowLive(operatorRow(), denyAll)).toBe(true);
  });
  it("an extension row is live only when the oracle confirms its package", () => {
    expect(isDashboardRowLive(extRow("@cinatra-ai/live-agent"), oracle)).toBe(true);
    expect(isDashboardRowLive(extRow("@cinatra-ai/blog-content-workflow"), oracle)).toBe(false);
  });
  it("FAIL-CLOSED: a deny-all oracle (transient loader failure) hides every extension row", () => {
    expect(isDashboardRowLive(extRow("@cinatra-ai/live-agent"), denyAll)).toBe(false);
    // …but never an operator row (user state is never hidden by the gate).
    expect(isDashboardRowLive(operatorRow(), denyAll)).toBe(true);
  });
});

describe("reader-gate — full renderable gate (status + liveness, EXTENSION-scoped)", () => {
  it("NEVER hides an operator-authored row — even archived (no operator-state regression)", () => {
    // The fail-safe targets extension orphans; an operator's own archived
    // dashboard stays reachable exactly as before this slice.
    expect(isDashboardRowRenderable(operatorRow(), oracle)).toBe(true);
    expect(isDashboardRowRenderable(operatorRow("archived"), oracle)).toBe(true);
    expect(isDashboardRowRenderable(operatorRow(), denyAll)).toBe(true);
  });
  it("denies an ARCHIVED extension row (orphan-swept / lifecycle-archived)", () => {
    expect(isDashboardRowRenderable(extRow("@cinatra-ai/live-agent", "archived"), oracle)).toBe(false);
  });
  it("denies a published-but-ORPHANED extension row (the live leak this closes)", () => {
    expect(isDashboardRowRenderable(extRow("@cinatra-ai/blog-content-workflow"), oracle)).toBe(false);
  });
  it("renders a published LIVE extension row", () => {
    expect(isDashboardRowRenderable(extRow("@cinatra-ai/live-agent"), oracle)).toBe(true);
  });
});

describe("reader-gate — filterRenderableDashboards (list surface)", () => {
  it("drops archived + orphaned EXTENSION rows; keeps operator rows + live-extension rows", () => {
    const rows: Row[] = [
      operatorRow(),
      operatorRow("archived"), // operator state — kept (its own status handling governs)
      extRow("@cinatra-ai/live-agent"),
      extRow("@cinatra-ai/blog-content-workflow"), // orphan — dropped
      extRow("@cinatra-ai/live-agent", "archived"), // archived extension — dropped
    ];
    const kept = filterRenderableDashboards(rows, oracle);
    expect(kept).toEqual([operatorRow(), operatorRow("archived"), extRow("@cinatra-ai/live-agent")]);
  });
  it("FAIL-CLOSED oracle drops every extension row but keeps operator rows", () => {
    const rows: Row[] = [operatorRow(), operatorRow("archived"), extRow("@cinatra-ai/live-agent")];
    expect(filterRenderableDashboards(rows, denyAll)).toEqual([operatorRow(), operatorRow("archived")]);
  });
});

// cinatra#659 — the runtime-lifecycle gate shared by the four non-connector
// AGENT consumer surfaces (agent_run, the workflow agent_task executor + probe,
// the /agents/run picker, and the agent_list MCP primitive).
//
// Mirrors `packages/extensions/src/__tests__/connector-installed-predicate.test.ts`
// (the #657 connector predicate's direct unit test): the rule is small but
// load-bearing, so the PURE decision + the host wrapper's fail-open/CG-1 handling
// are unit-tested here (this package's `vitest run` auto-includes the file — it is
// NOT the `@cinatra-ai/extensions` explicit `test:invariants` list).

import { describe, it, expect } from "vitest";
import {
  isAgentRuntimeRunnable,
  resolveRunnableAgentPackageNames,
} from "../runtime-install-gate";

describe("isAgentRuntimeRunnable (pure runtime-lifecycle decision)", () => {
  it("a null/undefined packageName is always runnable (untracked legacy template)", () => {
    expect(isAgentRuntimeRunnable({ packageName: null, effectiveStatus: undefined })).toBe(true);
    expect(isAgentRuntimeRunnable({ packageName: undefined, effectiveStatus: "archived" })).toBe(true);
  });

  it("an 'active' canonical row is runnable (runtime source of truth: live)", () => {
    expect(isAgentRuntimeRunnable({ packageName: "@x/a", effectiveStatus: "active" })).toBe(true);
  });

  it("an 'archived' canonical row is NOT runnable (fail-CLOSED on runtime archive)", () => {
    expect(isAgentRuntimeRunnable({ packageName: "@x/a", effectiveStatus: "archived" })).toBe(false);
  });

  it("CG-1: NO canonical row (undefined) is runnable — the bundled/ungoverned floor", () => {
    // A bundled/legacy/ungoverned agent the canonical store does not track must
    // NOT be blanked by the fail-closed flip (the load-bearing CG-1 invariant).
    expect(isAgentRuntimeRunnable({ packageName: "@x/bundled", effectiveStatus: undefined })).toBe(true);
  });

  it("an archived row is NOT resurrected by the bundled floor (archive beats no-row)", () => {
    // The ONLY case the bundled floor applies is NO row. A present archived row
    // is an explicit operator disable and must stay refused.
    expect(isAgentRuntimeRunnable({ packageName: "@x/a", effectiveStatus: "archived" })).toBe(false);
  });
});

describe("resolveRunnableAgentPackageNames (host wrapper: read + gate)", () => {
  it("keeps active + no-row (CG-1) and drops archived", async () => {
    const readStatus = async (names: string[]) => {
      expect(names).toContain("@x/active");
      const m = new Map<string, "active" | "archived">();
      m.set("@x/active", "active");
      m.set("@x/archived", "archived");
      // "@x/norow" intentionally absent → CG-1 floor.
      return m;
    };
    const runnable = await resolveRunnableAgentPackageNames(
      ["@x/active", "@x/archived", "@x/norow"],
      { readStatus },
    );
    expect(runnable.has("@x/active")).toBe(true);
    expect(runnable.has("@x/norow")).toBe(true); // CG-1: no row → runnable
    expect(runnable.has("@x/archived")).toBe(false); // fail-closed
  });

  it("de-dupes and ignores null/empty inputs", async () => {
    const readStatus = async (names: string[]) => {
      // null / "" / duplicates must be stripped before the read.
      expect(names).toEqual(["@x/a"]);
      return new Map<string, "active" | "archived">([["@x/a", "active"]]);
    };
    const runnable = await resolveRunnableAgentPackageNames(
      ["@x/a", "@x/a", null, undefined, ""],
      { readStatus },
    );
    expect([...runnable]).toEqual(["@x/a"]);
  });

  it("fail-OPEN on a canonical-store OUTAGE: every input is runnable (never invent an archive)", async () => {
    const readStatus = async () => {
      throw new Error("canonical store down");
    };
    const runnable = await resolveRunnableAgentPackageNames(
      ["@x/a", "@x/b"],
      { readStatus },
    );
    // A degraded status store must not block discovery/execution — the
    // ownership/tenancy/project gates at each call site are the real authz.
    expect(runnable.has("@x/a")).toBe(true);
    expect(runnable.has("@x/b")).toBe(true);
  });

  it("returns an empty set when there are no named packages (no read)", async () => {
    let called = false;
    const readStatus = async () => {
      called = true;
      return new Map<string, "active" | "archived">();
    };
    const runnable = await resolveRunnableAgentPackageNames([null, undefined, ""], { readStatus });
    expect(runnable.size).toBe(0);
    expect(called).toBe(false);
  });
});

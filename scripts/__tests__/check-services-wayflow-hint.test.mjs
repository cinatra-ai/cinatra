// scripts/lib/wayflow-down-hint.mjs — WayFlow downHint guidance.
//
// WHY THIS EXISTS
// `pnpm check:services` is where a fresh dev install first learns WayFlow
// never auto-starts. An earlier guidance fix pointed at `cinatra instance
// wayflow start`, a subcommand that is not on every released cinatra-cli
// yet, and its docker fallback omitted `-p cinatra_cinatra` — which forks a
// SEPARATE compose project that can't see the live stack's network — and
// omitted the gen-wayflow-env.mjs prerequisite the wayflow container needs
// to boot at all.
//
// The hint text lives in scripts/lib/wayflow-down-hint.mjs (pure, no
// import-time side effects) precisely so it can be asserted on directly
// here, rather than sliced out of check-services.mjs's raw source —
// check-services.mjs runs top-level probing + process.exit on import, so
// it isn't unit-importable itself.

import { describe, it, expect } from "vitest";
import { WAYFLOW_DOWN_HINT } from "../lib/wayflow-down-hint.mjs";

describe("WAYFLOW_DOWN_HINT", () => {
  it("caveats the CLI command instead of asserting it unconditionally", () => {
    expect(WAYFLOW_DOWN_HINT).toContain("cinatra instance wayflow start");
    // Not every released cinatra-cli has the subcommand — the hint must say
    // so rather than name a phantom command as if it always works.
    expect(WAYFLOW_DOWN_HINT).toContain("if your cinatra-cli has it");
  });

  it("gives a complete, project-pinned docker fallback", () => {
    // Pinned to the live stack's compose project — an unpinned invocation
    // defaults to the checkout-dir basename and forks a separate project.
    expect(WAYFLOW_DOWN_HINT).toContain("-p cinatra_cinatra");
    expect(WAYFLOW_DOWN_HINT).toContain("docker-compose.yml");
    expect(WAYFLOW_DOWN_HINT).toContain("docker-compose.dev.yml");
    expect(WAYFLOW_DOWN_HINT).toContain("--profile wayflow");
  });

  it("names the gen-wayflow-env prerequisite the wayflow container needs to boot", () => {
    expect(WAYFLOW_DOWN_HINT).toContain(
      "gen-wayflow-env.mjs --require-bridge-token",
    );
  });
});

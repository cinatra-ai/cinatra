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
// The hint also needs to match what THIS install recorded in
// CINATRA_WAYFLOW_RUNTIME (local|off|external, the same key `cinatra doctor`
// reads) — telling an operator who deliberately opted out, or who points at
// an external runtime, to "start" a local container they never own is wrong
// guidance too.
//
// The hint logic lives in scripts/lib/wayflow-down-hint.mjs (pure, no
// import-time side effects) precisely so it can be asserted on directly
// here, rather than sliced out of check-services.mjs's raw source —
// check-services.mjs runs top-level probing + process.exit on import, so
// it isn't unit-importable itself.

import { describe, it, expect } from "vitest";
import {
  WAYFLOW_DOWN_HINT,
  wayflowDownHint,
  normalizeWayflowRuntimeMode,
} from "../lib/wayflow-down-hint.mjs";

describe("wayflowDownHint — mode: local (default/legacy)", () => {
  it("caveats the CLI command instead of asserting it unconditionally", () => {
    const hint = wayflowDownHint("local");
    expect(hint).toContain("cinatra instance wayflow start");
    // Not every released cinatra-cli has the subcommand — the hint must say
    // so rather than name a phantom command as if it always works.
    expect(hint).toContain("if your cinatra-cli has it");
  });

  it("gives a complete, project-pinned docker fallback", () => {
    const hint = wayflowDownHint("local");
    // Pinned to the live stack's compose project — an unpinned invocation
    // defaults to the checkout-dir basename and forks a separate project.
    expect(hint).toContain("-p cinatra_cinatra");
    expect(hint).toContain("docker-compose.yml");
    expect(hint).toContain("docker-compose.dev.yml");
    expect(hint).toContain("--profile wayflow");
  });

  it("names the gen-wayflow-env prerequisite the wayflow container needs to boot", () => {
    expect(wayflowDownHint("local")).toContain(
      "gen-wayflow-env.mjs --require-bridge-token",
    );
  });

  it("an unset/unknown mode reads the same as local (default-on, never silently excused)", () => {
    expect(wayflowDownHint(undefined)).toBe(wayflowDownHint("local"));
    expect(wayflowDownHint("banana")).toBe(wayflowDownHint("local"));
  });

  it("the WAYFLOW_DOWN_HINT constant is the local-mode hint (back-compat)", () => {
    expect(WAYFLOW_DOWN_HINT).toBe(wayflowDownHint("local"));
  });
});

describe("wayflowDownHint — mode: off", () => {
  const hint = wayflowDownHint("off");

  it("says the runtime is disabled for this install, not that it broke", () => {
    expect(hint).toContain("CINATRA_WAYFLOW_RUNTIME=off");
    expect(hint).toContain("--no-wayflow");
  });

  it("still gives the complete, project-pinned compose fallback", () => {
    expect(hint).toContain("-p cinatra_cinatra");
    expect(hint).toContain("--profile wayflow");
    expect(hint).toContain("gen-wayflow-env.mjs --require-bridge-token");
  });
});

describe("wayflowDownHint — mode: external", () => {
  const hint = wayflowDownHint("external");

  it("names the env key that points at the external runtime", () => {
    expect(hint).toContain("CINATRA_WAYFLOW_RUNTIME=external");
    expect(hint).toContain("WAYFLOW_BASE_URL");
  });

  it("never tells the operator to start a local container this install doesn't own", () => {
    expect(hint).not.toContain("cinatra instance wayflow start");
    expect(hint).not.toContain("docker compose");
  });
});

describe("normalizeWayflowRuntimeMode", () => {
  it("passes through the three valid modes, case/whitespace tolerant", () => {
    expect(normalizeWayflowRuntimeMode("local")).toBe("local");
    expect(normalizeWayflowRuntimeMode(" OFF \n")).toBe("off");
    expect(normalizeWayflowRuntimeMode("external")).toBe("external");
  });

  it("falls back to local for absent/unknown values", () => {
    expect(normalizeWayflowRuntimeMode(undefined)).toBe("local");
    expect(normalizeWayflowRuntimeMode("")).toBe("local");
    expect(normalizeWayflowRuntimeMode("banana")).toBe("local");
  });
});

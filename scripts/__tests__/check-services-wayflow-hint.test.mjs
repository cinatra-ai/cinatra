// check-services.mjs — WayFlow downHint guidance.
//
// WHY THIS EXISTS
// `pnpm check:services` is where a fresh dev install first learns WayFlow
// never auto-starts (#2654). The fix for #2654 named a guidance string that
// was itself wrong (cinatra#2731): it pointed at `cinatra instance wayflow
// start`, a subcommand that only exists on unreleased cinatra-cli main (the
// released v0.1.8 lacks it), and its docker fallback omitted `-p
// cinatra_cinatra` — which forks a SEPARATE compose project that can't see
// the live stack's network — and omitted the gen-wayflow-env.mjs prerequisite
// the wayflow container needs to boot at all.
//
// check-services.mjs runs top-level probing/process.exit side effects on
// import, so it isn't unit-importable here. These are lightweight
// string-assertion tests against the source text, pinning exactly the
// substrings the WayFlow downHint must contain going forward.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_SRC = path.join(__dirname, "..", "check-services.mjs");

function readWayflowDownHintSource() {
  const src = fs.readFileSync(SCRIPT_SRC, "utf8");
  const start = src.indexOf('name: "WayFlow"');
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf("},", start);
  return src.slice(start, end);
}

describe("check-services.mjs WayFlow downHint (cinatra#2731)", () => {
  it("caveats the CLI command instead of asserting it unconditionally", () => {
    const block = readWayflowDownHintSource();
    expect(block).toContain("cinatra instance wayflow start");
    // Released cinatra-cli (v0.1.8) lacks the subcommand — the hint must say
    // so rather than name a phantom command as if it always works.
    expect(block).toContain("newer than v0.1.8");
  });

  it("gives a complete, project-pinned docker fallback", () => {
    const block = readWayflowDownHintSource();
    // Pinned to the live stack's compose project — an unpinned invocation
    // defaults to the checkout-dir basename and forks a separate project.
    expect(block).toContain("-p cinatra_cinatra");
    expect(block).toContain("docker-compose.yml");
    expect(block).toContain("docker-compose.dev.yml");
    expect(block).toContain("--profile wayflow");
  });

  it("names the gen-wayflow-env prerequisite the wayflow container needs to boot", () => {
    const block = readWayflowDownHintSource();
    expect(block).toContain("gen-wayflow-env.mjs --require-bridge-token");
  });
});

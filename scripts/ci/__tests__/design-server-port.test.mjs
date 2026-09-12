// ONE PORT PER RUNNER SLOT (cinatra#3416) — the derivation the pixel-diff job
// of design-visual-verify reads before it builds.
//
// The property under test is not "a port is produced". It is the INVARIANT
// that makes the design job safe on a machine that hosts more than one runner
// process: two jobs that overlap in time are always on different runner slots,
// so two different runner slots must never be handed the same port. While the
// port was one fixed literal they were, and the later job's port reclaim
// killed the earlier job's live server — after which the earlier job's
// Playwright step spoke to a server belonging to another run, whose per-run
// seed capability differs, and the seed POST was refused at the presented-
// capability fence with the bare 404 the fence contract requires.
import { describe, expect, it } from "vitest";

import {
  DESIGN_SERVER_PORT_BASE,
  DESIGN_SERVER_PORT_SLOTS,
  designServerPort,
  runnerSlotIndex,
} from "../design-server-port.mjs";

/** Runner slots as a self-hosted fleet names them: one trailing index each. */
const SLOTS = ["runner-1", "runner-2", "runner-3", "runner-4", "runner-5", "runner-6"];

describe("one port per runner slot", () => {
  it("never hands two runner slots the same port", () => {
    const ports = SLOTS.map((name) => designServerPort({ RUNNER_NAME: name }));
    expect(new Set(ports).size).toBe(SLOTS.length);
  });

  it("is DETERMINISTIC for a slot — the port is knowable before the build", () => {
    const first = designServerPort({ RUNNER_NAME: "runner-4" });
    const second = designServerPort({ RUNNER_NAME: "runner-4" });
    expect(second).toBe(first);
  });

  it("keeps every derived port inside the documented window", () => {
    for (const name of [...SLOTS, "runner-0", "runner-63", "runner-9999"]) {
      const port = designServerPort({ RUNNER_NAME: name });
      expect(port).toBeGreaterThanOrEqual(DESIGN_SERVER_PORT_BASE);
      expect(port).toBeLessThan(DESIGN_SERVER_PORT_BASE + DESIGN_SERVER_PORT_SLOTS);
    }
  });

  it("reads the trailing index however the slot is named", () => {
    expect(runnerSlotIndex("a-fleet-runner-7")).toBe(7);
    expect(runnerSlotIndex("GitHub Actions 3")).toBe(3);
    expect(runnerSlotIndex("  runner-2  ")).toBe(2);
  });
});

describe("a runner name that carries no index", () => {
  // A hosted runner gets a whole machine to itself, so any port is free there
  // and the base is the right answer — never a throw that would fail the job.
  it("falls back to the base port", () => {
    expect(designServerPort({ RUNNER_NAME: "hosted" })).toBe(DESIGN_SERVER_PORT_BASE);
    expect(designServerPort({})).toBe(DESIGN_SERVER_PORT_BASE);
    expect(designServerPort({ RUNNER_NAME: undefined })).toBe(DESIGN_SERVER_PORT_BASE);
  });
});

describe("the window itself", () => {
  it("starts at the port the job has always used", () => {
    expect(DESIGN_SERVER_PORT_BASE).toBe(3101);
  });

  it("is wide enough for every runner slot a machine realistically hosts", () => {
    expect(DESIGN_SERVER_PORT_SLOTS).toBeGreaterThanOrEqual(16);
  });
});

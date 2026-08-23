/**
 * THE PRODUCER INVENTORY (cinatra#2928, epic #2926 W2a).
 *
 * "Every way of creating an agent run goes through launch" is the runner's
 * whole claim, and a claim nobody can walk is a claim. This suite walks it, off
 * the real tree:
 *
 *   · every producer the coordinator's inventory names EXISTS, in the module it
 *     names, and really creates a run there;
 *   · every producer it names as ROUTED calls `launchAgentRun` in that module —
 *     read off the source, not asserted;
 *   · every producer it names as UNROUTED still creates a run directly, and
 *     names the slice that routes it. A row that goes stale in either direction
 *     is red the same day;
 *   · the two lists agree with the creation FENCE, which is the mechanical half:
 *     a module that creates a run outside the coordinator and is on neither list
 *     fails the fence, so the inventory cannot quietly miss one.
 *
 * The point of reading the tree rather than a registry is that a new producer
 * cannot be added by editing this list — it has to survive the fence too.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  RUN_PRODUCERS,
  UNROUTED_PRODUCERS,
} from "../lifecycle-coordinator";
import {
  CREATE_ALLOWLIST,
  OWED_BY_ADAPTER,
  PENDING_INPUT_CALLERS,
  // The gate is a plain `.mjs` module with no declarations; the three imports
  // above are data, and reading them HERE is the point — the suite compares the
  // gate's own lists with the runner's rather than a copy of either.
} from "../../../../scripts/audit/run-creation-fence.mjs";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf8");

/**
 * Read only lines that RUN.
 *
 * The same rule the fence applies: a module that EXPLAINS the creation seam in
 * prose is not creating a run, and a scan that could not tell the two apart
 * would fail every module that documents itself.
 */
function executable(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
}

/** Does this module create an agent run at all — by either creator? */
function createsARun(raw: string): boolean {
  const source = executable(raw);
  return (
    /(?<![A-Za-z0-9_.])createAgentRun\s*\(/.test(source) ||
    /(?<![A-Za-z0-9_.])createAgentRunPendingInput\s*\(/.test(source)
  );
}

/** Does this module reach the coordinator's launch entry? */
function callsLaunch(raw: string): boolean {
  return /(?<![A-Za-z0-9_.])launchAgentRun\s*\(/.test(executable(raw));
}

describe("the run-producer inventory", () => {
  it("names every producer exactly once", () => {
    const keys = RUN_PRODUCERS.map((p) => p.key);
    expect(new Set(keys).size, `duplicate producer key: ${keys.join(", ")}`).toBe(keys.length);
    expect(keys.length).toBeGreaterThan(0);
  });

  it.each(RUN_PRODUCERS.map((p) => [p.key, p] as const))(
    "%s: its module really starts runs",
    (_key, producer) => {
      const source = read(producer.module);
      expect(
        createsARun(source) || callsLaunch(source),
        `${producer.module} neither creates a run nor launches one — the inventory row is stale`,
      ).toBe(true);
    },
  );

  it.each(RUN_PRODUCERS.filter((p) => p.routed).map((p) => [p.key, p] as const))(
    "%s: a ROUTED producer creates through launch",
    (_key, producer) => {
      const source = read(producer.module);
      expect(
        callsLaunch(source),
        `${producer.module} is recorded as routed but never calls launchAgentRun`,
      ).toBe(true);
      // …and it does NOT still create around it. The coordinator and the store
      // are the two modules where the creators may be named at all.
      if (!CREATE_ALLOWLIST.has(producer.module)) {
        expect(
          createsARun(source),
          `${producer.module} is recorded as routed but still creates a run directly`,
        ).toBe(false);
      }
    },
  );

  it.each(UNROUTED_PRODUCERS.map((p) => [p.key, p] as const))(
    "%s: an UNROUTED producer still creates directly, and names its owner",
    (_key, producer) => {
      const source = read(producer.module);
      expect(
        createsARun(source),
        `${producer.module} is recorded as unrouted but no longer creates a run — strike the row`,
      ).toBe(true);
      expect(producer.tracking ?? "").not.toEqual("");
      expect(
        (producer.tracking ?? "").length,
        "an obligation with no named owner is indistinguishable from a waiver",
      ).toBeGreaterThan(20);
    },
  );

  it("agrees with the creation fence about which modules are owed", () => {
    // The two lists are written for different readers — one for a person
    // reading the runner, one for the gate — so this is what stops them
    // drifting apart.
    expect([...UNROUTED_PRODUCERS.map((p) => p.module)].sort()).toEqual(
      Object.keys(OWED_BY_ADAPTER).sort(),
    );
  });

  it("keeps the pre-dispatch creator's callers enumerated", () => {
    // The second creator is not banned outright, so the only thing standing
    // between it and a silent second road is this enumeration. Every recorded
    // caller must really call it.
    for (const rel of Object.keys(PENDING_INPUT_CALLERS)) {
      if (rel.startsWith("scripts/")) continue;
      expect(
        /(?<![A-Za-z0-9_.])createAgentRunPendingInput\s*\(/.test(executable(read(rel))),
        `${rel} is recorded as a pre-dispatch creator caller but no longer calls it`,
      ).toBe(true);
    }
  });

  it("routes every producer that is not explicitly owed", () => {
    const owed = new Set(Object.keys(OWED_BY_ADAPTER));
    for (const producer of RUN_PRODUCERS) {
      if (producer.routed) continue;
      expect(
        owed.has(producer.module),
        `${producer.module} is unrouted but the fence does not know it — an unowned bypass`,
      ).toBe(true);
    }
  });
});

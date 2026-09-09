/**
 * THE BROKER'S PUBLISHED PORT IS DRAWN WITHOUT BIAS, AND THE PER-JOB NAMES KEEP
 * THEIR ALPHABET (cinatra#3327).
 *
 * The sibling files `exec-stack-network-naming.test.ts` and
 * `exec-stack-compose-project-naming.test.ts` pin the names themselves. This
 * one pins the two things those leave open, both of which a later edit could
 * undo without any of their assertions noticing:
 *
 *  1. The published host port is a HOST-wide object, so the harness draws one
 *     per stack out of a fixed range. Reducing a random 16-bit word into that
 *     range with a modulo does NOT spread it evenly: the range is 12000 wide
 *     and 65536 is five of those with 5536 left over, so the first 5536 ports
 *     of the range come up six times where the rest come up five — 1.2 times
 *     as often, a fifth more. A port drawn more
 *     often is a port two concurrent stacks pick together more often, which is
 *     precisely the collision the range was introduced to end. The draw must be
 *     uniform across the whole range.
 *
 *  2. The random tail every derived name ends with has a fixed alphabet and a
 *     fixed length. Docker and compose both restrict what a name may carry, and
 *     a tail that grew a character outside [0-9a-f] — or lost its length — would
 *     pass "the two names differ" while making a name the daemon rejects.
 *
 * The statistical assertions below are written with margins so wide that their
 * chance of failing on a correct draw is far below any rate that could be met
 * in practice: they assert only that both halves of the range are reached and
 * that the draw is not a constant. The bias itself is pinned by shape, the way
 * the sibling files pin their rules, because a lean of a fifth cannot be told
 * from luck in a test that must not flake.
 *
 * The harness is imported as a NAMESPACE for the same reason the siblings do
 * it: a file that names an export the previous head does not have fails to
 * load there, and a suite that cannot load reports one collection error instead
 * of the several failures that say WHICH part of the rule is missing.
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as execStack from "./e2e/support/exec-stack";

/** The range the harness draws the published port out of. */
const RANGE_START = 20_000;
const RANGE_END = 31_999;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const HARNESS_PATH = path.join(
  REPO_ROOT,
  "packages/execution-plane/src/__tests__/e2e/support/exec-stack.ts",
);

const harnessSource = (): string => readFileSync(HARNESS_PATH, "utf8");

/** The random tail `jobScopedName` ends every derived name with. */
const RUN_DISCRIMINATOR = /-([0-9a-f]+)$/;

describe("the published broker port is drawn without bias", () => {
  it("draws inside the range, every time", () => {
    for (let i = 0; i < 2_000; i += 1) {
      const port = execStack.brokerHostPortFor({});
      expect(Number.isInteger(port)).toBe(true);
      expect(port).toBeGreaterThanOrEqual(RANGE_START);
      expect(port).toBeLessThanOrEqual(RANGE_END);
    }
  });

  it("reaches both halves of the range", () => {
    // A draw that collapsed onto one part of the range — the failure mode a
    // broken reduction produces — would leave one of these two counts at zero.
    // The margin is enormous compared with sampling noise on 4000 draws, so
    // the chance of this failing on a correct draw is vanishing; what it cannot
    // see is a lean of a fifth, which is why the rule itself is pinned by shape
    // below.
    const middle = (RANGE_START + RANGE_END) / 2;
    let low = 0;
    let high = 0;
    for (let i = 0; i < 4_000; i += 1) {
      if (execStack.brokerHostPortFor({}) <= middle) low += 1;
      else high += 1;
    }
    expect(low).toBeGreaterThan(1_000);
    expect(high).toBeGreaterThan(1_000);
  });

  it("gives two stacks of ONE job two different ports", () => {
    // Two legs of a matrix share run id, job and attempt, so the job identity
    // alone would publish both stacks on one loopback port and turn the second
    // `up` away. Over 200 draws a repeat of a single value is expected; what
    // must not happen is a constant.
    const drawn = new Set<number>();
    for (let i = 0; i < 200; i += 1) drawn.add(execStack.brokerHostPortFor({}));
    expect(drawn.size).toBeGreaterThan(100);
  });

  it("honours an explicit pin, so an operator can still name the port", () => {
    expect(execStack.brokerHostPortFor({ CINATRA_EXEC_BROKER_HOST_PORT: "4100" })).toBe(4100);
    expect(execStack.brokerHostPortFor({ CINATRA_EXEC_BROKER_HOST_PORT: "  4100  " })).toBe(4100);
  });

  it("refuses a pin that is not a TCP port", () => {
    expect(() => execStack.brokerHostPortFor({ CINATRA_EXEC_BROKER_HOST_PORT: "0" })).toThrow(
      /between 1 and 65535/,
    );
    expect(() => execStack.brokerHostPortFor({ CINATRA_EXEC_BROKER_HOST_PORT: "65536" })).toThrow(
      /between 1 and 65535/,
    );
    expect(() => execStack.brokerHostPortFor({ CINATRA_EXEC_BROKER_HOST_PORT: "http" })).toThrow(
      /between 1 and 65535/,
    );
    expect(() => execStack.brokerHostPortFor({ CINATRA_EXEC_BROKER_HOST_PORT: "4100.5" })).toThrow(
      /between 1 and 65535/,
    );
  });

  it("resolves the harness constant to a port of this run's own", () => {
    expect(Number.isInteger(execStack.BROKER_HOST_PORT)).toBe(true);
    if (!process.env.CINATRA_EXEC_BROKER_HOST_PORT) {
      expect(execStack.BROKER_HOST_PORT).toBeGreaterThanOrEqual(RANGE_START);
      expect(execStack.BROKER_HOST_PORT).toBeLessThanOrEqual(RANGE_END);
      // The container port never moves; only the host side does.
      expect(execStack.BROKER_HOST_PORT).not.toBe(execStack.BROKER_HOST_PORT_BASE);
    }
  });
});

describe("the rule the harness must keep for the port", () => {
  it("reduces no random word into the range with a modulo", () => {
    const source = harnessSource();
    // The exact shape the biased draw had, and the general one it belongs to.
    expect(source).not.toMatch(/readUInt16BE\([^)]*\)\s*%/);
    expect(source).not.toMatch(/randomBytes\([^)]*\)\s*\.\s*read[A-Za-z0-9]+\([^)]*\)\s*%/);
  });

  it("draws the port with a primitive that is uniform by construction", () => {
    const source = harnessSource();
    expect(source).toMatch(/import \{[^}]*\brandomInt\b[^}]*\} from "node:crypto";/);
    expect(source).toMatch(
      /randomInt\(\s*BROKER_HOST_PORT_RANGE_START\s*,\s*BROKER_HOST_PORT_RANGE_END\s*\+\s*1\s*,?\s*\)/,
    );
  });

  it("keeps the range and the container port exactly where they were", () => {
    const source = harnessSource();
    expect(source).toMatch(/const BROKER_HOST_PORT_RANGE_START = 20_000;/);
    expect(source).toMatch(/const BROKER_HOST_PORT_RANGE_END = 31_999;/);
    expect(source).toMatch(/export const BROKER_HOST_PORT_BASE = 4100;/);
  });
});

describe("the random tail of every derived name keeps its alphabet and length", () => {
  it("ends each derived name with exactly eight lower-case hex characters", () => {
    for (const name of [
      execStack.sandboxNetworkNameFor({}),
      execStack.egressNetworkNameFor({}),
      execStack.appNetworkNameFor({}),
      execStack.composeProjectNameFor({}),
    ]) {
      const tail = RUN_DISCRIMINATOR.exec(name)?.[1];
      expect(tail).toBeDefined();
      expect(tail).toHaveLength(8);
      // Lower case and digits only — what docker and compose both accept, and
      // what the compose project name in particular is REJECTED without.
      expect(tail).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  it("keeps the tail eight hex characters when the job identity is present too", () => {
    const job = { GITHUB_RUN_ID: "17512345678", GITHUB_JOB: "batteries", GITHUB_RUN_ATTEMPT: "2" };
    for (const name of [
      execStack.sandboxNetworkNameFor({ ...job }),
      execStack.egressNetworkNameFor({ ...job }),
      execStack.appNetworkNameFor({ ...job }),
      execStack.composeProjectNameFor({ ...job }),
    ]) {
      expect(RUN_DISCRIMINATOR.exec(name)?.[1]).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  it("draws that tail from four whole random bytes, never from a reduction", () => {
    const source = harnessSource();
    expect(source).toMatch(/const discriminator = randomBytes\(4\)\.toString\("hex"\);/);
  });
});

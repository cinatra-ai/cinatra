// Workers per family of the design suite (cinatra#3770).
//
// ONE number decides how many workers the functional-acceptance family gets.
// The Playwright configuration (tests/e2e/config/design.config.ts) reads it for
// that family's project and for the run's cap on workers, and the design suite
// selector (scripts/ci/design-select.mjs) reads it for the line the design job
// prints under its suite summary. Every other family keeps one worker and runs
// its tests in order, so the pixel comparisons stay serial.
//
// Why several workers, and why four. Measured over thirty design jobs on
// 2026-09-28: the suite took 35.6 to 47.7 minutes per job (median 39.7), and
// this one family held 448 of the 762 tests and 31.1 to 35.4 of those minutes.
// A separate job per family would build the app again every time (median 8.9
// minutes and about 26 GB of memory per build), so the family runs with several
// workers inside the one job, against the one build and the one server. During
// the suite phase a worker measured about 2 GB, so four workers hold about 8 GB,
// far below the memory the same runner already gives the build earlier in the
// same job. At best four workers cut the family to a quarter of its serial time,
// about 8 to 9 minutes, which is what a suite phase under 20 minutes needs; every
// worker is served by that one server process, so a larger number is not free.
// Change this number only on a measurement of the suite phase: its memory and
// the stability of its pixel comparisons.
//
// Dependency-free on purpose: the selector that prints the summary line runs
// without a dependency install.

/** The family that runs with several workers, named the way the selector names families. */
export const FUNCTIONAL_ACCEPTANCE_FAMILY =
  "tests/e2e/design/conformance/functional-acceptance.spec.ts";

/** Workers for the functional-acceptance family: THE one constant. */
export const FUNCTIONAL_ACCEPTANCE_WORKERS = 4;

/** Every other family: one worker, its tests in order. */
export const SERIAL_FAMILY_WORKERS = 1;

/**
 * The worker numbers of one run.
 *
 * `total` is the run's cap: the functional-acceptance family's number, and a
 * serial family takes one of those workers while it runs, so no more browsers
 * than that run at once. An opt-in partition (CINATRA_DESIGN_PARTITION, see
 * docs/internals/design-partition-validation.md) keeps one worker for every
 * family, as that facility documents.
 *
 * @param {{partitioned?: boolean}} [options]
 * @returns {{total: number, functionalAcceptance: number, serial: number}}
 */
export function designWorkers({ partitioned = false } = {}) {
  const functionalAcceptance = partitioned ? SERIAL_FAMILY_WORKERS : FUNCTIONAL_ACCEPTANCE_WORKERS;
  return { total: functionalAcceptance, functionalAcceptance, serial: SERIAL_FAMILY_WORKERS };
}

/**
 * The workers one family runs with.
 *
 * @param {string} spec  a family, as a repo-relative spec path
 * @param {{partitioned?: boolean}} [options]
 * @returns {number}
 */
export function workersForFamily(spec, options = {}) {
  const workers = designWorkers(options);
  return spec === FUNCTIONAL_ACCEPTANCE_FAMILY ? workers.functionalAcceptance : workers.serial;
}

/**
 * The line the design job prints under its suite summary: the workers of every
 * family the run starts, e.g.
 * "workers per family: tests/e2e/design/conformance/functional-acceptance.spec.ts 4; 16 other families 1 each".
 *
 * @param {string[]} specs  the families the run starts
 * @param {{partitioned?: boolean}} [options]
 * @returns {string}
 */
export function workersSummary(specs, options = {}) {
  const parallel = specs.filter((spec) => spec === FUNCTIONAL_ACCEPTANCE_FAMILY);
  const serial = specs.length - parallel.length;
  const parts = parallel.map((spec) => `${spec} ${workersForFamily(spec, options)}`);
  if (serial > 0) {
    const noun = serial === 1 ? "family" : "families";
    const which = parallel.length > 0 ? `${serial} other ${noun}` : `${serial} ${noun}`;
    parts.push(`${which} ${SERIAL_FAMILY_WORKERS} each`);
  }
  return `workers per family: ${parts.join("; ")}`;
}

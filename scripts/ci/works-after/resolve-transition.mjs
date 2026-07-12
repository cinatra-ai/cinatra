#!/usr/bin/env node
// works-after :: matrix-gate resolver (cinatra#1422 upgrade-from arm, developed
// as the coordinated pair with cinatra-cli#129's `cinatra instance db
// upgrade-major`).
//
// The upgrade-from fixtures and the CLI command must act on the SAME decision
// table: this thin entrypoint resolves a (serviceId, from, to) tuple through
// the repo's canonical consumption contract (scripts/lib/upgrade-matrix.mjs —
// loadUpgradeMatrix + assertMatrixRevision + resolveTransition, revision-
// checked fail-closed), exactly like the CLI's shipped copy pins the same
// revision (cinatra-cli src/upgrade-matrix.mjs AUTHORITATIVE_MATRIX_REVISION).
// A fixture whose modeled transition the matrix does not support FAILS — that
// is the gate: a stateful Postgres major cannot ride in without its matrix
// entry AND its upgrade-from proof moving together.
//
// Usage:  node scripts/ci/works-after/resolve-transition.mjs <serviceId> <from> <to>
// Env:    WA_MATRIX_PATH — alternate matrix file (tests only; default = the
//         canonical docs/architecture/upgrade-matrix.json).
// Exit:   0 = supported (transition or case exception; JSON verdict on stdout)
//         2 = misuse / unreadable matrix / revision-skew (fail closed)
//         3 = resolved but NOT supported (fail closed)

import { assertMatrixRevision, loadUpgradeMatrix, resolveTransition } from "../../lib/upgrade-matrix.mjs";

const [serviceId, from, to] = process.argv.slice(2);
if (!serviceId || !from || !to) {
  console.error("usage: resolve-transition.mjs <serviceId> <from> <to>");
  process.exit(2);
}

let matrix;
try {
  const path = process.env.WA_MATRIX_PATH;
  matrix = assertMatrixRevision(path ? loadUpgradeMatrix(path) : loadUpgradeMatrix());
} catch (err) {
  console.error(`resolve-transition: ${err.message}`);
  process.exit(2);
}

const verdict = resolveTransition(matrix, serviceId, String(from), String(to));
console.log(JSON.stringify({ service: serviceId, from: String(from), to: String(to), revision: matrix.revision, ...verdict }));
process.exit(verdict.supported ? 0 : 3);

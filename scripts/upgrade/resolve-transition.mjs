#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Fail-closed transition-eligibility CLI over the committed upgrade matrix
// (upgrade-paths epic cinatra#1419 / cinatra#1421).
//
// Thin executable wrapper around the shared consumption contract
// (scripts/lib/upgrade-matrix.mjs): loads the matrix, asserts the pinned
// revision (skew is fail-closed), resolves the (service, from, to) tuple, and
// prints the verdict as JSON. The guarded family paths
// (scripts/upgrade/*-upgrade-major.sh) call this BEFORE any mutation and treat
// anything but exit 0 as a refusal.
//
//   node scripts/upgrade/resolve-transition.mjs <serviceId> <from> <to> [--matrix <path>]
//   node scripts/upgrade/resolve-transition.mjs --image-repo <serviceId>   # baseline image repo only
//
// Exit codes:
//   0  supported transition (verdict JSON on stdout)
//   2  usage error
//   3  FAIL-CLOSED: unsupported/unknown tuple, unknown service, or matrix
//      revision/schema skew (verdict/diagnostic on stdout/stderr)
// ---------------------------------------------------------------------------

import process from "node:process";

import {
  assertMatrixRevision,
  getService,
  loadUpgradeMatrix,
  resolveTransition,
} from "../lib/upgrade-matrix.mjs";

function usage(msg) {
  console.error(`ERROR: ${msg}`);
  console.error("usage: resolve-transition.mjs <serviceId> <from> <to> [--matrix <path>] | --image-repo <serviceId>");
  process.exit(2);
}

// The image REPO component of an image ref (digest- and tag-aware):
//   redis:8-alpine@sha256:…      -> redis
//   valkey/valkey:7.2.11-alpine  -> valkey/valkey
function imageRepoOf(ref) {
  const noDigest = ref.split("@")[0];
  const lastColon = noDigest.lastIndexOf(":");
  return lastColon === -1 ? noDigest : noDigest.slice(0, lastColon);
}

const argv = process.argv.slice(2);

let matrixPath;
const positional = [];
let imageRepoService = null;
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === "--matrix") {
    matrixPath = argv[i + 1];
    if (!matrixPath) usage("missing value for --matrix");
    i += 1;
  } else if (argv[i] === "--image-repo") {
    imageRepoService = argv[i + 1];
    if (!imageRepoService) usage("missing value for --image-repo");
    i += 1;
  } else {
    positional.push(argv[i]);
  }
}

let matrix;
try {
  matrix = matrixPath ? loadUpgradeMatrix(matrixPath) : loadUpgradeMatrix();
  assertMatrixRevision(matrix);
} catch (err) {
  // Skew or unreadable matrix: fail CLOSED — a consumer must never act on a
  // matrix it was not validated against.
  console.error(`FAIL-CLOSED: ${err.message}`);
  process.exit(3);
}

if (imageRepoService) {
  const svc = getService(matrix, imageRepoService);
  if (!svc) {
    console.error(`FAIL-CLOSED: unknown matrix service '${imageRepoService}'.`);
    process.exit(3);
  }
  process.stdout.write(imageRepoOf(svc.baselinePin.image));
  process.exit(0);
}

if (positional.length !== 3) usage(`expected <serviceId> <from> <to>, got ${positional.length} argument(s)`);
const [serviceId, from, to] = positional;

const svc = getService(matrix, serviceId);
const verdict = resolveTransition(matrix, serviceId, from, to);
const out = {
  serviceId,
  from,
  to,
  ...verdict,
  service: svc
    ? {
        family: svc.family,
        composeService: svc.composeService,
        volume: svc.volume,
        stateClass: svc.stateClass,
        imageRepo: imageRepoOf(svc.baselinePin.image),
      }
    : null,
};
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
process.exit(verdict.supported ? 0 : 3);
